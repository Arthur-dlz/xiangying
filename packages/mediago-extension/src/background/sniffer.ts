import {
  DownloadType,
  matchPageUrl,
  matchRequestUrl,
  shouldSuppressRequestSource,
} from "@mediago/common";
import type {
  DetectedSource,
  PageContextChangedMessage,
} from "../shared/types";
import { inspectSources } from "./mediago-client";
import { loadSettings } from "./storage";
import { tabSourceService, type TabSourceService } from "./tab-sources";

export type SnifferErrorContext =
  | "request detection"
  | "inspection flush"
  | "tab update"
  | "tab removal";

export type SnifferErrorReporter = (
  context: SnifferErrorContext,
  error: unknown,
) => void;

const defaultErrorReporter: SnifferErrorReporter = (context, error) => {
  // eslint-disable-next-line no-console -- MV3 background failures need a diagnostic sink.
  console.error(`[MediaGo extension] ${context} failed`, error);
};

function reportAsyncFailure(
  context: SnifferErrorContext,
  operation: Promise<unknown>,
  reportError: SnifferErrorReporter,
): void {
  void operation.catch((error: unknown) => {
    try {
      reportError(context, error);
    } catch (reporterError) {
      // eslint-disable-next-line no-console -- Reporter failures must not become unhandled rejections.
      console.error(
        "[MediaGo extension] error reporter failed",
        reporterError,
        { context, error },
      );
    }
  });
}

/**
 * Turn `chrome.webRequest.HttpHeader[]` into the newline format accepted by
 * MediaGo Core and the desktop download form.
 */
function formatHeaders(
  headers: chrome.webRequest.HttpHeader[] | undefined,
): string | undefined {
  if (!headers || headers.length === 0) return undefined;
  const parts: string[] = [];
  for (const h of headers) {
    if (!h.name) continue;
    parts.push(`${h.name}:${h.value ?? ""}`);
  }
  return parts.join("\n");
}

const pendingInspections = new Map<number, Map<string, DetectedSource>>();
const inspectionTimers = new Map<number, ReturnType<typeof setTimeout>>();
const tabGenerations = new Map<number, number>();

function resetPendingInspections(tabId: number): void {
  tabGenerations.set(tabId, (tabGenerations.get(tabId) ?? 0) + 1);
  pendingInspections.delete(tabId);
  const timer = inspectionTimers.get(tabId);
  if (timer) clearTimeout(timer);
  inspectionTimers.delete(tabId);
}

function queueInspection(
  tabId: number,
  source: DetectedSource,
  sources: TabSourceService,
  reportError: SnifferErrorReporter,
): void {
  const pending = pendingInspections.get(tabId) ?? new Map();
  pending.set(source.url, source);
  pendingInspections.set(tabId, pending);
  if (inspectionTimers.has(tabId)) return;
  inspectionTimers.set(
    tabId,
    setTimeout(() => {
      inspectionTimers.delete(tabId);
      reportAsyncFailure(
        "inspection flush",
        flushInspections(tabId, sources),
        reportError,
      );
    }, 150),
  );
}

async function flushInspections(
  tabId: number,
  sources: TabSourceService,
): Promise<void> {
  const pending = [...(pendingInspections.get(tabId)?.values() ?? [])];
  pendingInspections.delete(tabId);
  if (pending.length === 0) return;

  const generation = tabGenerations.get(tabId) ?? 0;
  const settings = await loadSettings();
  const inspected = await inspectSources(settings, pending);
  if ((tabGenerations.get(tabId) ?? 0) !== generation) return;
  await sources.addSources(tabId, inspected);
}

/* --------------------- request-level (m3u8 / mp4) --------------------- */

/**
 * Called for every outbound request across all tabs. Matches against
 * the `matches` filters (pathname-based — `.m3u8`, `.mp4`, etc.) and
 * appends the detection to the per-tab source list.
 *
 * We use `onSendHeaders` (not `onBeforeRequest`) because it's the same
 * phase the Electron side sniffs on, so filter semantics stay identical.
 */
async function handleRequest(
  details: chrome.webRequest.OnSendHeadersDetails,
  sources: TabSourceService,
  reportError: SnifferErrorReporter,
): Promise<void> {
  // tabId -1 means the request isn't tied to a tab (e.g. extension
  // itself, background fetch). Ignore — the user can't act on these.
  if (details.tabId < 0) return;

  const filter = matchRequestUrl(details.url);
  if (!filter) return;
  const generation = tabGenerations.get(details.tabId) ?? 0;

  let documentURL = details.initiator ?? "";
  let pageTitle = "";
  try {
    const tab = await chrome.tabs.get(details.tabId);
    documentURL = tab.url ?? documentURL;
    pageTitle = tab.title ?? "";
  } catch {
    /* tab might have closed between event and lookup; best-effort */
  }
  if ((tabGenerations.get(details.tabId) ?? 0) !== generation) return;
  if (shouldSuppressRequestSource(documentURL, filter.type)) return;

  const source: DetectedSource = {
    id: `${details.requestId}-${Date.now()}`,
    url: details.url,
    documentURL,
    name: pageTitle,
    type: filter.type,
    headers: formatHeaders(details.requestHeaders),
    detectedAt: Date.now(),
    mediaInfo:
      filter.type === DownloadType.m3u8
        ? {
            status: "inspecting",
            playlistType: "unknown",
            variants: [],
          }
        : undefined,
  };
  await sources.addSource(details.tabId, source);
  if (filter.type === DownloadType.m3u8) {
    queueInspection(details.tabId, source, sources, reportError);
  }
}

/* --------------------- page-level (bilibili / youtube) --------------------- */

/**
 * Called whenever a tab's URL settles (navigation complete). Matches
 * against the `hosts` filters — sites that don't expose a direct media
 * URL, but for which MediaGo dispatches a specialised extractor
 * (BBDown for Bilibili, yt-dlp for YouTube). The "source" we push is
 * the page URL itself; downstream the downloader handles resolution.
 *
 * Electron uses `checkPageInfo()` in sniffing-helper.service.ts for
 * the same purpose.
 */
async function checkPageInfo(
  tabId: number,
  tab: chrome.tabs.Tab,
  sources: TabSourceService,
): Promise<void> {
  const pageUrl = tab.url;
  if (!pageUrl) return;
  const filter = matchPageUrl(pageUrl);
  if (!filter) return;

  await sources.addSource(tabId, {
    id: `page-${tabId}-${Date.now()}`,
    url: pageUrl,
    documentURL: pageUrl,
    name: tab.title ?? pageUrl,
    type: filter.type,
    detectedAt: Date.now(),
  });
}

async function handleTabUpdated(
  tabId: number,
  changeInfo: chrome.tabs.OnUpdatedInfo,
  tab: chrome.tabs.Tab,
  sources: TabSourceService,
): Promise<void> {
  let generation = tabGenerations.get(tabId) ?? 0;
  // A top-level URL change = new page. Clear stale sources first so
  // sites with client-side routing (YouTube SPA navigation!) don't
  // leak detections from the previous video into the next one.
  if (changeInfo.url) {
    resetPendingInspections(tabId);
    generation = tabGenerations.get(tabId) ?? 0;
    await sources.clear(tabId);
    const message = {
      type: "PAGE_CONTEXT_CHANGED",
    } satisfies PageContextChangedMessage;
    try {
      await chrome.tabs.sendMessage(tabId, message);
    } catch {
      // Content scripts are not injected on every page. A missing
      // receiver must not prevent page-level detection after navigation.
    }
  }
  if ((tabGenerations.get(tabId) ?? 0) !== generation) return;
  // Emit the page-level detection when the title is known — waiting
  // for `status === "complete"` avoids capturing the empty title
  // shown during the initial navigation.
  if (changeInfo.status === "complete" || changeInfo.title) {
    await checkPageInfo(tabId, tab, sources);
  }
}

async function handleTabRemoved(
  tabId: number,
  sources: TabSourceService,
): Promise<void> {
  resetPendingInspections(tabId);
  await sources.remove(tabId);
}

/* --------------------------------------------------------------------- */

/**
 * Wire up all tab-level listeners. Must be called once at worker start;
 * MV3 service workers are re-spawned aggressively so we register at the
 * top level of background/index.ts, not lazily.
 */
export function registerSniffer(
  sources: TabSourceService = tabSourceService,
  reportError: SnifferErrorReporter = defaultErrorReporter,
): void {
  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      reportAsyncFailure(
        "request detection",
        handleRequest(details, sources, reportError),
        reportError,
      );
    },
    { urls: ["<all_urls>"] },
    ["requestHeaders", "extraHeaders"],
  );

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    reportAsyncFailure(
      "tab update",
      handleTabUpdated(tabId, changeInfo, tab, sources),
      reportError,
    );
  });

  // Tab closed → drop its entry so we don't accumulate stale data.
  chrome.tabs.onRemoved.addListener((tabId) => {
    reportAsyncFailure(
      "tab removal",
      handleTabRemoved(tabId, sources),
      reportError,
    );
  });
}
