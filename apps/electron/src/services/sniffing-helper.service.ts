import EventEmitter from "node:events";
import { provide } from "@inversifyjs/binding-decorators";
import type {
  BridgeDiscoveryCompleteParams,
  BridgeDiscoverySource,
} from "@mediago/core-sdk";
import {
  DownloadType,
  type HLSMediaInfo,
  isHLSContentType,
  matchPageUrl,
  matchRequestUrl,
  shouldSuppressRequestSource,
} from "@mediago/common";
import {
  type OnHeadersReceivedListenerDetails,
  type OnSendHeadersListenerDetails,
  session,
  type Session,
} from "electron";
import { inject, injectable } from "inversify";
import { formatHeaders } from "../utils";
import ElectronLogger from "../vendor/ElectronLogger";
import {
  formattedHeadersToArray,
  inspectionToMediaInfo,
  splitDiscoveryHeaders,
} from "../utils/source-inspection";
import { DownloaderServer } from "./downloader.server";

export interface SourceParams {
  url: string;
  documentURL: string;
  name: string;
  type: DownloadType;
  headers?: string;
  mediaInfo?: HLSMediaInfo;
}

export interface PageInfo {
  title: string;
  url: string;
}

export interface SniffingSourceEvent {
  tabId: string;
  source: SourceParams;
}

export interface RegisterSniffingContext {
  tabId: string;
  webContentsId: number;
  partition: string;
  kind: "user" | "agent";
  useSessionCookies?: boolean;
  initialPageInfo?: PageInfo;
}

export interface AgentCollectionOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

interface PendingInspection {
  generation: number;
  id: string;
  item: SourceParams;
  requireContentVerification: boolean;
}

interface PendingRequest {
  documentURL: string;
  generation: number;
  headers: string;
  name: string;
}

interface AgentCollector {
  cleanupAbort: () => void;
  hardTimer: ReturnType<typeof setTimeout>;
  quietTimer: ReturnType<typeof setTimeout> | null;
  reject: (reason: unknown) => void;
  resolve: (result: BridgeDiscoveryCompleteParams) => void;
  settled: boolean;
}

interface SniffingContext {
  agentSources: Map<string, BridgeDiscoverySource>;
  checkTimer: ReturnType<typeof setTimeout> | null;
  collector: AgentCollector | null;
  dedup: Set<string>;
  domReady: boolean;
  generation: number;
  inspectSequence: number;
  inspectTimer: ReturnType<typeof setTimeout> | null;
  inspectionsInFlight: number;
  kind: "user" | "agent";
  pageHeaders: Map<DownloadType, string>;
  pageInfo: PageInfo;
  partition: string;
  pendingInspections: Map<string, PendingInspection>;
  pendingRequests: Map<number, PendingRequest>;
  sourceSequence: number;
  tabId: string;
  useSessionCookies: boolean;
  webContentsId: number;
}

export class AgentCollectionError extends Error {
  constructor(
    readonly errorCode:
      | "discovery_timeout"
      | "discovery_cancelled"
      | "discovery_navigation_failed",
    message: string,
  ) {
    super(message);
    this.name = "AgentCollectionError";
  }
}

const PREPARE_DELAY_MS = 1_000;
const INSPECT_DELAY_MS = 150;
const NETWORK_QUIET_MS = 1_500;
const MAX_AGENT_SOURCES = 200;
const MAX_PENDING_REQUESTS = 500;
const INSPECTION_PUBLIC_HEADERS = new Set([
  "accept",
  "accept-language",
  "origin",
  "range",
  "referer",
  "user-agent",
]);
const INSPECTION_PRIVATE_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

function filterAllowedHeaders(
  headers: string[],
  allowlist: Set<string>,
): string[] {
  return headers.filter((header) => {
    const separator = header.indexOf(":");
    return (
      separator > 0 &&
      allowlist.has(header.slice(0, separator).trim().toLowerCase())
    );
  });
}

function headersForInspection(
  context: SniffingContext,
  rawHeaders?: string,
): string[] {
  const includePrivateHeaders =
    context.kind === "agent" && context.useSessionCookies;
  const { publicHeaders, privateHeaders } = splitDiscoveryHeaders(
    formattedHeadersToArray(rawHeaders),
    includePrivateHeaders,
  );
  const safePublicHeaders = filterAllowedHeaders(
    publicHeaders,
    INSPECTION_PUBLIC_HEADERS,
  );
  // Only ever forward the classic credential trio on explicit opt-in; other
  // sensitive headers (x-api-key, x-auth-token, ...) stay out of the RPC.
  const safePrivateHeaders = filterAllowedHeaders(
    privateHeaders,
    INSPECTION_PRIVATE_HEADERS,
  );
  return includePrivateHeaders
    ? [...safePublicHeaders, ...safePrivateHeaders]
    : safePublicHeaders;
}

@injectable()
@provide()
export class SniffingHelper extends EventEmitter {
  private readonly contexts = new Map<string, SniffingContext>();
  private readonly contextsByWebContents = new Map<number, SniffingContext>();
  private readonly listenedPartitions = new Set<string>();
  private readonly listenedSessions = new Map<string, Session>();

  constructor(
    @inject(ElectronLogger)
    private readonly logger: ElectronLogger,
    @inject(DownloaderServer)
    private readonly downloaderServer: DownloaderServer,
  ) {
    super();
  }

  register(options: RegisterSniffingContext): void {
    this.unregister(options.tabId);
    const conflicting = this.contextsByWebContents.get(options.webContentsId);
    if (conflicting) this.unregister(conflicting.tabId);
    this.ensureSessionListener(options.partition);
    const context: SniffingContext = {
      agentSources: new Map(),
      checkTimer: null,
      collector: null,
      dedup: new Set(),
      domReady: false,
      generation: 0,
      inspectSequence: 0,
      inspectTimer: null,
      inspectionsInFlight: 0,
      kind: options.kind,
      pageHeaders: new Map(),
      pageInfo: options.initialPageInfo ?? { title: "", url: "" },
      partition: options.partition,
      pendingInspections: new Map(),
      pendingRequests: new Map(),
      sourceSequence: 0,
      tabId: options.tabId,
      useSessionCookies: options.useSessionCookies === true,
      webContentsId: options.webContentsId,
    };
    this.contexts.set(options.tabId, context);
    this.contextsByWebContents.set(options.webContentsId, context);
  }

  unregister(tabId: string): void {
    const context = this.contexts.get(tabId);
    if (!context) return;
    this.clearContextTimers(context);
    this.rejectCollector(
      context,
      new AgentCollectionError(
        "discovery_cancelled",
        "browser discovery cancelled",
      ),
    );
    context.generation += 1;
    context.domReady = false;
    context.pendingInspections.clear();
    context.pendingRequests.clear();
    context.agentSources.clear();
    this.contexts.delete(tabId);
    if (this.contextsByWebContents.get(context.webContentsId) === context) {
      this.contextsByWebContents.delete(context.webContentsId);
    }
  }

  close(): void {
    for (const tabId of this.contexts.keys()) this.unregister(tabId);
    for (const viewSession of this.listenedSessions.values()) {
      viewSession.webRequest.onSendHeaders(null);
      viewSession.webRequest.onHeadersReceived(null);
    }
    this.listenedSessions.clear();
    this.listenedPartitions.clear();
    this.removeAllListeners();
  }

  pluginReady(_tabId?: string): void {
    // Reserved for page-plugin coordination.
  }

  getPageHeaders(tabId: string, type: DownloadType): string | undefined {
    return this.contexts.get(tabId)?.pageHeaders.get(type);
  }

  update(tabId: string, pageInfo: PageInfo): void {
    const context = this.contexts.get(tabId);
    if (!context) return;
    const pageChanged = pageInfo.url !== context.pageInfo.url;
    context.pageInfo = pageInfo;
    this.clearTimer(context, "checkTimer");
    if (!pageChanged) return;

    context.generation += 1;
    context.pendingInspections.clear();
    context.pendingRequests.clear();
    context.agentSources.clear();
    context.pageHeaders.clear();
    context.dedup.clear();
    this.clearTimer(context, "inspectTimer");
    this.clearQuietTimer(context);
  }

  markDomReady(tabId: string): void {
    const context = this.contexts.get(tabId);
    if (!context) return;
    context.domReady = true;
    this.scheduleQuietCompletion(context);
  }

  checkPageInfo(tabId: string): void {
    const context = this.contexts.get(tabId);
    if (!context) return;
    this.clearTimer(context, "checkTimer");
    const generation = context.generation;
    const pageInfo = { ...context.pageInfo };
    context.checkTimer = setTimeout(() => {
      context.checkTimer = null;
      if (!this.isCurrentContext(context, generation)) return;
      const filter = matchPageUrl(pageInfo.url);
      if (!filter) return;
      this.send(context.tabId, {
        url: pageInfo.url,
        documentURL: pageInfo.url,
        name: pageInfo.title,
        type: filter.type,
        headers: context.pageHeaders.get(filter.type),
      });
    }, PREPARE_DELAY_MS);
  }

  send(tabId: string, item: SourceParams): void {
    this.sendCandidate(tabId, item, false);
  }

  private sendCandidate(
    tabId: string,
    item: SourceParams,
    requireContentVerification: boolean,
  ): void {
    const context = this.contexts.get(tabId);
    if (!context) return;
    const cacheKey = `${item.type}:${item.url}`;
    if (context.dedup.has(cacheKey)) return;
    context.dedup.add(cacheKey);

    if (item.type !== DownloadType.m3u8) {
      this.emitSource(context, item);
      return;
    }

    const id = `hls-${context.webContentsId}-${++context.inspectSequence}`;
    if (context.kind === "user" && !requireContentVerification) {
      this.emitSource(context, {
        ...item,
        mediaInfo: {
          status: "inspecting",
          playlistType: "unknown",
          variants: [],
        },
      });
    }
    context.pendingInspections.set(item.url, {
      generation: context.generation,
      id,
      item,
      requireContentVerification:
        requireContentVerification || context.kind === "agent",
    });
    this.clearQuietTimer(context);
    if (!context.inspectTimer) {
      context.inspectTimer = setTimeout(() => {
        context.inspectTimer = null;
        void this.flushInspections(context);
      }, INSPECT_DELAY_MS);
    }
  }

  collectAgent(
    tabId: string,
    options: AgentCollectionOptions,
  ): Promise<BridgeDiscoveryCompleteParams> {
    const context = this.contexts.get(tabId);
    if (!context || context.kind !== "agent") {
      return Promise.reject(
        new Error(`Agent sniffing context ${tabId} is not registered`),
      );
    }
    if (context.collector) {
      return Promise.reject(
        new Error(`Agent sniffing context ${tabId} is already collecting`),
      );
    }

    return new Promise((resolve, reject) => {
      const hardTimer = setTimeout(
        () => {
          if (context.agentSources.size > 0) {
            this.resolveCollector(context, true);
          } else {
            this.rejectCollector(
              context,
              new AgentCollectionError(
                "discovery_timeout",
                "browser discovery timed out",
              ),
            );
          }
        },
        Math.max(1, options.timeoutMs),
      );
      const abort = () => {
        this.rejectCollector(
          context,
          new AgentCollectionError(
            "discovery_cancelled",
            "browser discovery cancelled",
          ),
        );
      };
      context.collector = {
        cleanupAbort: () => options.signal?.removeEventListener("abort", abort),
        hardTimer,
        quietTimer: null,
        reject,
        resolve,
        settled: false,
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  }

  cancelAgent(tabId: string): void {
    const context = this.contexts.get(tabId);
    if (!context) return;
    this.rejectCollector(
      context,
      new AgentCollectionError(
        "discovery_cancelled",
        "browser discovery cancelled",
      ),
    );
  }

  failAgent(tabId: string, errorCode: "discovery_navigation_failed"): void {
    const context = this.contexts.get(tabId);
    if (!context) return;
    this.rejectCollector(
      context,
      new AgentCollectionError(errorCode, "browser navigation failed"),
    );
  }

  private ensureSessionListener(partition: string): void {
    if (this.listenedPartitions.has(partition)) return;
    const viewSession = session.fromPartition(partition);
    viewSession.webRequest.onSendHeaders(this.onSendHeaders);
    viewSession.webRequest.onHeadersReceived(this.onHeadersReceived);
    this.listenedSessions.set(partition, viewSession);
    this.listenedPartitions.add(partition);
  }

  private readonly onSendHeaders = (
    details: OnSendHeadersListenerDetails,
  ): void => {
    if (typeof details.webContentsId !== "number") return;
    const context = this.contextsByWebContents.get(details.webContentsId);
    if (!context) return;
    const { url, requestHeaders } = details;
    const { title, url: documentURL } = context.pageInfo;
    const headers = formatHeaders(requestHeaders);

    if (typeof details.id === "number") {
      if (context.pendingRequests.size >= MAX_PENDING_REQUESTS) {
        const oldest = context.pendingRequests.keys().next().value;
        if (typeof oldest === "number") context.pendingRequests.delete(oldest);
      }
      context.pendingRequests.set(details.id, {
        documentURL,
        generation: context.generation,
        headers,
        name: title,
      });
    }

    const cookieBackedType = getCookieBackedType(url);
    if (cookieBackedType && hasHeader(requestHeaders, "cookie")) {
      context.pageHeaders.set(cookieBackedType, headers);
    }

    const filter = matchRequestUrl(url);
    if (filter && !shouldSuppressRequestSource(documentURL, filter.type)) {
      this.send(context.tabId, {
        url,
        documentURL,
        name: title,
        type: filter.type,
        headers,
      });
    }
  };

  private readonly onHeadersReceived = (
    details: OnHeadersReceivedListenerDetails,
    callback: (response: Electron.HeadersReceivedResponse) => void,
  ): void => {
    try {
      if (typeof details.webContentsId !== "number") return;
      const context = this.contextsByWebContents.get(details.webContentsId);
      if (!context) return;
      const pending = context.pendingRequests.get(details.id);
      context.pendingRequests.delete(details.id);
      if (pending && pending.generation !== context.generation) return;
      if (!responseHasHLSContentType(details.responseHeaders)) return;

      const documentURL = pending?.documentURL ?? context.pageInfo.url;
      if (shouldSuppressRequestSource(documentURL, DownloadType.m3u8)) return;
      this.sendCandidate(
        context.tabId,
        {
          url: details.url,
          documentURL,
          name: pending?.name ?? context.pageInfo.title,
          type: DownloadType.m3u8,
          headers: pending?.headers,
        },
        true,
      );
    } finally {
      callback({});
    }
  };

  private emitSource(context: SniffingContext, item: SourceParams): void {
    this.logger.info(
      `[SniffingHelper] source detected for ${context.tabId} (${item.type})`,
    );
    if (context.kind === "user") {
      this.emit("source", { tabId: context.tabId, source: item });
      return;
    }
    this.collectAgentSource(context, item);
  }

  private collectAgentSource(
    context: SniffingContext,
    item: SourceParams,
  ): void {
    if (context.agentSources.size >= MAX_AGENT_SOURCES) return;
    const mediaInfo = item.mediaInfo;
    const { publicHeaders, privateHeaders } = splitDiscoveryHeaders(
      formattedHeadersToArray(item.headers),
      context.useSessionCookies,
    );
    const existing = context.agentSources.get(item.url);
    const source: BridgeDiscoverySource = {
      id: existing?.id ?? `source-${++context.sourceSequence}`,
      url: item.url,
      pageUrl: item.documentURL || context.pageInfo.url || item.url,
      title: item.name || context.pageInfo.title || item.url,
      type: item.type,
      playlistType: mediaInfo?.playlistType,
      maxQuality: mediaInfo?.maxQuality,
      variants: mediaInfo?.variants,
      detectedAt: existing?.detectedAt ?? new Date().toISOString(),
      headers: [...publicHeaders, ...privateHeaders],
    };
    context.agentSources.set(item.url, source);
    this.scheduleQuietCompletion(context);
  }

  private async flushInspections(context: SniffingContext): Promise<void> {
    const pending = [...context.pendingInspections.values()];
    context.pendingInspections.clear();
    if (pending.length === 0) return;

    const generation = context.generation;
    // Mark the context busy before the first await so a concurrent
    // collectAgentSource/markDomReady cannot arm the quiet timer and resolve
    // the collector while these inspections are still in flight.
    context.inspectionsInFlight += 1;
    try {
      const client = this.downloaderServer.getClient();
      const inputs = pending.map(({ id, item }) => ({
        id,
        url: item.url,
        headers: headersForInspection(context, item.headers),
      }));
      const responses = await Promise.all(
        Array.from({ length: Math.ceil(inputs.length / 20) }, (_, index) =>
          client.inspectSources({
            sources: inputs.slice(index * 20, index * 20 + 20),
          }),
        ),
      );
      const inspections = new Map(
        responses.flatMap((response) =>
          response.data.sources.map(
            (inspection) => [inspection.id, inspection] as const,
          ),
        ),
      );
      if (!this.isCurrentContext(context, generation)) return;
      for (const pendingItem of pending) {
        if (pendingItem.generation !== generation) continue;
        const inspection = inspections.get(pendingItem.id);
        if (
          pendingItem.requireContentVerification &&
          inspection?.errorCode === "not_hls"
        ) {
          continue;
        }
        this.emitSource(context, {
          ...pendingItem.item,
          mediaInfo: inspectionToMediaInfo(inspection),
        });
      }
    } catch {
      this.logger.warn("Failed to inspect sniffed HLS sources");
      if (!this.isCurrentContext(context, generation)) return;
      for (const pendingItem of pending) {
        if (pendingItem.generation !== generation) continue;
        this.emitSource(context, {
          ...pendingItem.item,
          mediaInfo: inspectionToMediaInfo(),
        });
      }
    } finally {
      context.inspectionsInFlight -= 1;
      if (this.isCurrentContext(context, generation)) {
        this.scheduleQuietCompletion(context);
      }
    }
  }

  private scheduleQuietCompletion(context: SniffingContext): void {
    const collector = context.collector;
    if (!collector || collector.settled) return;
    if (!context.domReady) return;
    if (
      context.pendingInspections.size > 0 ||
      context.inspectTimer ||
      context.inspectionsInFlight > 0
    )
      return;
    this.clearQuietTimer(context);
    collector.quietTimer = setTimeout(() => {
      collector.quietTimer = null;
      if (context.collector !== collector || collector.settled) return;
      this.resolveCollector(context);
    }, NETWORK_QUIET_MS);
  }

  private resolveCollector(context: SniffingContext, partial = false): void {
    const collector = context.collector;
    if (!collector || collector.settled) return;
    collector.settled = true;
    collector.cleanupAbort();
    clearTimeout(collector.hardTimer);
    if (collector.quietTimer) clearTimeout(collector.quietTimer);
    context.collector = null;
    collector.resolve({
      sources: [...context.agentSources.values()],
      partial,
    });
  }

  private rejectCollector(context: SniffingContext, reason: unknown): void {
    const collector = context.collector;
    if (!collector || collector.settled) return;
    collector.settled = true;
    collector.cleanupAbort();
    clearTimeout(collector.hardTimer);
    if (collector.quietTimer) clearTimeout(collector.quietTimer);
    context.collector = null;
    collector.reject(reason);
  }

  private isCurrentContext(
    context: SniffingContext,
    generation: number,
  ): boolean {
    return (
      this.contexts.get(context.tabId) === context &&
      context.generation === generation
    );
  }

  private clearContextTimers(context: SniffingContext): void {
    this.clearTimer(context, "checkTimer");
    this.clearTimer(context, "inspectTimer");
    this.clearQuietTimer(context);
  }

  private clearQuietTimer(context: SniffingContext): void {
    const collector = context.collector;
    if (!collector?.quietTimer) return;
    clearTimeout(collector.quietTimer);
    collector.quietTimer = null;
  }

  private clearTimer(
    context: SniffingContext,
    key: "checkTimer" | "inspectTimer",
  ): void {
    const timer = context[key];
    if (timer) clearTimeout(timer);
    context[key] = null;
  }
}

function responseHasHLSContentType(
  headers?: Record<string, string[]>,
): boolean {
  if (!headers) return false;
  for (const [name, values] of Object.entries(headers)) {
    if (name.toLowerCase() !== "content-type") continue;
    return values.some(isHLSContentType);
  }
  return false;
}

export function hasHeader(
  headers: Record<string, string>,
  name: string,
): boolean {
  return Object.keys(headers).some(
    (headerName) => headerName.toLowerCase() === name.toLowerCase(),
  );
}

export function getCookieBackedType(url: string): DownloadType | undefined {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname === "bilibili.com" || hostname.endsWith(".bilibili.com")) {
      return DownloadType.bilibili;
    }
    if (
      hostname === "youtu.be" ||
      hostname === "youtube.com" ||
      hostname.endsWith(".youtube.com") ||
      hostname === "x.com" ||
      hostname.endsWith(".x.com") ||
      hostname === "twitter.com" ||
      hostname.endsWith(".twitter.com") ||
      hostname === "tiktok.com" ||
      hostname.endsWith(".tiktok.com") ||
      hostname === "tiktokv.com" ||
      hostname.endsWith(".tiktokv.com") ||
      hostname === "douyin.com" ||
      hostname.endsWith(".douyin.com")
    ) {
      return DownloadType.youtube;
    }
    if (
      hostname === "xiaohongshu.com" ||
      hostname.endsWith(".xiaohongshu.com") ||
      hostname === "xhslink.com" ||
      hostname.endsWith(".xhslink.com")
    ) {
      return DownloadType.xiaohongshu;
    }
  } catch {
    // Ignore malformed request URLs.
  }
  return undefined;
}
