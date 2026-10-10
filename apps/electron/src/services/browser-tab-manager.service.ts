import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { ElectronBlocker } from "@ghostery/adblocker-electron";
import { provide } from "@inversifyjs/binding-decorators";
import type {
  BridgeDiscoveryCompleteParams,
  BridgeDiscoveryRequest,
} from "@mediago/core-sdk";
import {
  type BrowserNavigationFailurePayload,
  type BrowserNavigationPayload,
  type BrowserSourceDetectedPayload,
  type BrowserTabSourceSnapshot,
  type BrowserTabSnapshot,
  type BrowserTabsSnapshot,
  DownloadType,
  type HLSMediaInfo,
  IpcEvent,
  mergeSniffedSource,
} from "@mediago/common";
import {
  app,
  type BrowserWindowConstructorOptions,
  type HandlerDetails,
  type RenderProcessGoneDetails,
  session,
  shell,
  WebContentsView,
} from "electron";
import isDev from "electron-is-dev";
import { inject, injectable } from "inversify";
import {
  mobileUA,
  PERSIST_WEBVIEW,
  PRIVACY_WEBVIEW,
  pluginUrl,
} from "../utils";
import ElectronLogger from "../vendor/ElectronLogger";
import BrowserWindow from "../windows/browser.window";
import MainWindow from "../windows/main.window";
import { AdBlockerLoader } from "./ad-blocker-loader";
import {
  type AdBlockerCacheValue,
  createAdBlockerCache,
  getAdBlockerCachePath,
} from "./ad-blocker-cache";
import {
  type DiscoveryBrowserExecutor,
  DiscoveryExecutorService,
} from "./discovery-executor.service";
import GoConfigCache from "./go-config-cache";
import {
  AgentCollectionError,
  type SniffingSourceEvent,
  SniffingHelper,
  type SourceParams,
} from "./sniffing-helper.service";
import { enableSessionProxy } from "./webview-proxy";
import { getBrowserRefreshShortcut } from "./browser-refresh-shortcut";
import {
  registerRemoteBrowserContents,
  unregisterRemoteBrowserContents,
} from "../core/trust-policy";

const require = createRequire(import.meta.url);
const preload = require.resolve("@mediago/electron-preload");

interface TabRuntime {
  attachedWindow: Electron.BrowserWindow | null;
  bounds: Electron.Rectangle | null;
  desktopUserAgent: string;
  isMobile: boolean;
  kind: "user" | "agent";
  openerTabId?: string;
  partition: string;
  tabId: string;
  view: WebContentsView;
}

const HTTPS_ONLY_HOSTS = [
  "x.com",
  "twitter.com",
  "google.com",
  "tiktok.com",
  "tiktokv.com",
  "douyin.com",
] as const;
const INTERNAL_BROWSER_PROTOCOLS = new Set(["http:", "https:"]);
const EXTERNAL_BROWSER_PROTOCOLS = new Set(["mailto:", "sms:", "tel:"]);
const ERR_ABORTED = -3;
const RENDER_PROCESS_GONE_ERROR_CODE = -1000;
const WEB_CONTENTS_DESTROYED_ERROR_CODE = -1001;
const UNSUPPORTED_PROTOCOL_ERROR_CODE = -1002;
const ELECTRON_USER_AGENT_TOKEN = /\sElectron\/[^\s]+/gi;
const MOBILE_VIEWPORT_WIDTH = 412;
const DISCOVERY_COMPLETION_MARGIN_MS = 250;

export function chromeCompatibleDesktopUserAgent(userAgent: string): string {
  return userAgent.replace(ELECTRON_USER_AGENT_TOKEN, "").trim();
}

function mobileBrowserBounds(bounds: Electron.Rectangle): Electron.Rectangle {
  const width = Math.min(bounds.width, MOBILE_VIEWPORT_WIDTH);
  return {
    ...bounds,
    x: bounds.x + Math.floor((bounds.width - width) / 2),
    width,
  };
}

export function isolatePagePluginSource(content: string): string {
  return `(() => {\n${content}\n})()`;
}

export function normalizeBrowserURL(value: string): string {
  const trimmed = value.trim();
  const normalized = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
    ? trimmed
    : trimmed.startsWith("//")
      ? `https:${trimmed}`
      : `https://${trimmed}`;

  try {
    const url = new URL(normalized);
    if (
      url.protocol === "http:" &&
      HTTPS_ONLY_HOSTS.some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    ) {
      url.protocol = "https:";
      return url.href;
    }
  } catch {
    return normalized;
  }

  return normalized;
}

function getURLProtocol(value: string): string | undefined {
  try {
    return new URL(value).protocol;
  } catch {
    return undefined;
  }
}

function isInternalBrowserURL(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      INTERNAL_BROWSER_PROTOCOLS.has(url.protocol) ||
      (url.protocol === "about:" && url.pathname === "blank")
    );
  } catch {
    return false;
  }
}

function isExternalBrowserURL(value: string): boolean {
  return EXTERNAL_BROWSER_PROTOCOLS.has(getURLProtocol(value) ?? "");
}

export interface CreateTabOptions {
  activate?: boolean;
  isMobile?: boolean;
  url?: string;
}

@injectable()
@provide()
export default class BrowserTabManagerService implements DiscoveryBrowserExecutor {
  private readonly tabs: BrowserTabSnapshot[] = [];
  private readonly runtimes = new Map<string, TabRuntime>();
  private readonly tabBounds = new Map<string, Electron.Rectangle>();
  private readonly agentTabs = new Map<string, string>();
  private activeTabId = "";
  private sourcePanelCollapsed = false;
  private defaultPartition = PERSIST_WEBVIEW;
  private blocker?: ElectronBlocker;
  private blockerExpiresAt = Number.POSITIVE_INFINITY;
  private readonly blockerLoader: AdBlockerLoader<ElectronBlocker>;
  private readonly blockingSessions = new Set<Electron.Session>();
  private blockingRequested: boolean;

  constructor(
    @inject(MainWindow)
    private readonly mainWindow: MainWindow,
    @inject(ElectronLogger)
    private readonly logger: ElectronLogger,
    @inject(BrowserWindow)
    private readonly browserWindow: BrowserWindow,
    @inject(GoConfigCache)
    private readonly configCache: GoConfigCache,
    @inject(SniffingHelper)
    private readonly sniffingHelper: SniffingHelper,
    @inject(DiscoveryExecutorService)
    private readonly discoveryExecutor: DiscoveryExecutorService,
  ) {
    this.blockingRequested = Boolean(this.configCache.get("blockAds"));
    const blockerCache = createAdBlockerCache(
      getAdBlockerCachePath(app.getPath("userData")),
      () => this.logger.error("[AdBlocker] list load failed"),
    );
    this.blockerLoader = new AdBlockerLoader(
      async () => {
        const result = await blockerCache.load();
        this.blockerExpiresAt = result.refresh
          ? Number.POSITIVE_INFINITY
          : result.expiresAt;
        if (result.refresh) this.observeBlockerRefresh(result.refresh);
        return result.blocker;
      },
      () => this.logger.error("[AdBlocker] list load failed"),
    );

    this.defaultPartition = this.configCache.get("privacy")
      ? PRIVACY_WEBVIEW
      : PERSIST_WEBVIEW;
    this.sniffingHelper.on("source", this.onSource);
    this.discoveryExecutor.setBrowser(this);
    this.createTab();
    const { useProxy, proxy } = this.configCache.store;
    this.setProxy(useProxy, proxy);
  }

  getSnapshot(): BrowserTabsSnapshot {
    return structuredClone({
      tabs: this.tabs,
      activeTabId: this.activeTabId,
      sourcePanelCollapsed: this.sourcePanelCollapsed,
    });
  }

  getActiveTabId(): string {
    return this.activeTabId;
  }

  restoreSnapshot(snapshot: BrowserTabsSnapshot): BrowserTabsSnapshot {
    if (
      !snapshot ||
      !Array.isArray(snapshot.tabs) ||
      snapshot.tabs.length === 0
    ) {
      return this.getSnapshot();
    }
    for (const runtime of this.runtimes.values()) {
      if (runtime.kind === "user") this.destroyRuntime(runtime.tabId);
    }
    this.tabBounds.clear();
    this.tabs.splice(
      0,
      this.tabs.length,
      ...snapshot.tabs
        .filter((tab) => tab.kind === "user" && typeof tab.id === "string")
        .map((tab) => this.sanitizeTabSnapshot(tab)),
    );
    if (this.tabs.length === 0) this.tabs.push(this.createHomeSnapshot());
    this.activeTabId = this.tabs.some((tab) => tab.id === snapshot.activeTabId)
      ? snapshot.activeTabId
      : this.tabs[0].id;
    this.sourcePanelCollapsed = snapshot.sourcePanelCollapsed === true;
    this.emitSnapshot();
    return this.getSnapshot();
  }

  createTab(options: CreateTabOptions = {}): BrowserTabSnapshot {
    const tab = this.createHomeSnapshot(options.url, options.isMobile);
    this.tabs.push(tab);
    if (options.activate !== false || !this.activeTabId) {
      this.activateTab(tab.id);
    }
    this.emitSnapshot();
    return structuredClone(tab);
  }

  activateTab(tabId: string): BrowserTabsSnapshot {
    this.requireTab(tabId);
    if (this.activeTabId !== tabId) {
      this.detachRuntime(this.runtimes.get(this.activeTabId));
      this.activeTabId = tabId;
    }
    this.attachRuntime(this.runtimes.get(tabId));
    this.emitSnapshot();
    return this.getSnapshot();
  }

  closeTab(tabId: string): BrowserTabsSnapshot {
    if (!this.tabs.some((tab) => tab.id === tabId)) return this.getSnapshot();
    this.destroyRuntime(tabId);
    this.removeTabSnapshot(tabId);
    return this.getSnapshot();
  }

  private removeTabSnapshot(
    tabId: string,
    preferredActiveTabId?: string,
  ): void {
    const index = this.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return;
    const wasActive = this.activeTabId === tabId;
    this.tabs.splice(index, 1);
    this.tabBounds.delete(tabId);
    if (this.tabs.length === 0) {
      const replacement = this.createHomeSnapshot();
      this.tabs.push(replacement);
      this.activeTabId = replacement.id;
    } else if (wasActive) {
      const preferredTab = preferredActiveTabId
        ? this.tabs.find((tab) => tab.id === preferredActiveTabId)
        : undefined;
      this.activeTabId =
        preferredTab?.id ?? this.tabs[Math.min(index, this.tabs.length - 1)].id;
    }
    this.attachRuntime(this.runtimes.get(this.activeTabId));
    this.emitSnapshot();
  }

  async loadURL(tabId: string, url: string): Promise<void> {
    const navigationURL = normalizeBrowserURL(url);
    const tab = this.requireTab(tabId);
    if (isExternalBrowserURL(navigationURL)) {
      this.openExternalURL(navigationURL, "external protocol");
      this.emitSnapshot();
      return;
    }
    if (!isInternalBrowserURL(navigationURL)) {
      Object.assign(tab, {
        mode: "browser" as const,
        status: "failed" as const,
        url: navigationURL,
        title: navigationURL,
        favicon: undefined,
        errorCode: UNSUPPORTED_PROTOCOL_ERROR_CODE,
        errorMessage: "Unsupported browser URL protocol",
        sources: [],
      });
      this.emitSnapshot();
      throw new Error("Unsupported browser URL protocol");
    }
    const resetFavicon = tab.url !== navigationURL;
    tab.mode = "browser";
    tab.status = "loading";
    tab.url = navigationURL;
    if (resetFavicon) tab.favicon = undefined;
    tab.errorCode = undefined;
    tab.errorMessage = undefined;
    tab.sources = [];
    this.emitSnapshot();

    let runtime: TabRuntime;
    try {
      runtime = this.ensureUserRuntime(tabId);
    } catch {
      tab.status = "failed";
      tab.errorMessage = "Unable to allocate a browser tab";
      this.emitSnapshot();
      throw new Error("Unable to allocate a browser tab");
    }
    this.sniffingHelper.update(tabId, {
      title: tab.title,
      url: navigationURL,
    });
    this.blockingRequested = Boolean(this.configCache.get("blockAds"));
    if (this.blockingRequested) this.startBlocking(runtime.partition);
    runtime.view.webContents.stop();
    await runtime.view.webContents.loadURL(navigationURL);
  }

  async goBack(tabId: string): Promise<boolean> {
    const runtime = this.runtimes.get(tabId);
    if (!runtime) return false;
    if (runtime.view.webContents.navigationHistory.canGoBack()) {
      runtime.view.webContents.navigationHistory.goBack();
      return true;
    }
    await this.goHome(tabId);
    return false;
  }

  async reload(tabId: string, ignoreCache = false): Promise<void> {
    const runtime = this.runtimes.get(tabId);
    if (!runtime) throw new Error("Browser tab view not found");
    const tab = this.requireTab(tabId);
    Object.assign(tab, {
      status: "loading" as const,
      errorCode: undefined,
      errorMessage: undefined,
    });
    this.emitSnapshot();
    if (ignoreCache) runtime.view.webContents.reloadIgnoringCache();
    else runtime.view.webContents.reload();
  }

  reloadActiveVisibleTab(ignoreCache = false): boolean {
    const runtime = this.runtimes.get(this.activeTabId);
    if (!runtime || runtime.kind !== "user" || !runtime.attachedWindow) {
      return false;
    }
    void this.reload(runtime.tabId, ignoreCache);
    return true;
  }

  async goHome(tabId: string): Promise<void> {
    const tab = this.requireTab(tabId);
    this.destroyRuntime(tabId);
    Object.assign(tab, {
      mode: "home" as const,
      status: "default" as const,
      url: "",
      title: "",
      favicon: undefined,
      errorCode: undefined,
      errorMessage: undefined,
      sources: [],
    });
    this.emitSnapshot();
  }

  setBounds(tabId: string, bounds: Electron.Rectangle): void {
    if (!this.tabs.some((tab) => tab.id === tabId)) return;
    const nextBounds = { ...bounds };
    this.tabBounds.set(tabId, nextBounds);
    const runtime = this.runtimes.get(tabId);
    if (!runtime) return;
    runtime.bounds = nextBounds;
    this.attachRuntime(runtime);
  }

  show(tabId: string): void {
    if (tabId !== this.activeTabId) return;
    this.attachRuntime(this.runtimes.get(tabId));
  }

  hide(tabId: string): void {
    this.detachRuntime(this.runtimes.get(tabId));
  }

  reparentActiveView(): void {
    const runtime = this.runtimes.get(this.activeTabId);
    if (!runtime) return;
    this.detachRuntime(runtime);
    this.attachRuntime(runtime);
  }

  setSourcePanelCollapsed(collapsed: boolean): void {
    this.sourcePanelCollapsed = collapsed;
    this.emitSnapshot();
  }

  setAudioMuted(audioMuted?: boolean): void {
    for (const runtime of this.runtimes.values()) {
      runtime.view.webContents.setAudioMuted(audioMuted === true);
    }
  }

  setDeviceMode(tabId: string, isMobile: boolean): void {
    const tab = this.requireTab(tabId);
    const runtime = this.runtimes.get(tabId);
    const previousMode = tab.isMobile;
    const previousStatus = tab.status;

    try {
      if (runtime) this.applyDeviceMode(runtime, isMobile);
      tab.isMobile = isMobile;
      if (runtime && tab.mode === "browser") {
        tab.status = "loading";
        runtime.view.webContents.reloadIgnoringCache();
      }
      this.emitSnapshot();
    } catch (error) {
      tab.isMobile = previousMode;
      tab.status = previousStatus;
      if (runtime && !runtime.view.webContents.isDestroyed()) {
        try {
          this.applyDeviceMode(runtime, previousMode);
        } catch {
          this.logger.error("[BrowserTab] failed to roll back device mode");
        }
      }
      this.emitSnapshot();
      throw error;
    }
  }

  setProxy(useProxy: boolean, proxy: string): void {
    for (const partition of this.runtimePartitions(true)) {
      const targetSession = session.fromPartition(partition);
      if (useProxy) {
        enableSessionProxy(targetSession, this.logger, proxy);
      } else {
        void targetSession.setProxy({ mode: "system" });
      }
    }
  }

  setBlocking(enableBlocking: boolean): void {
    this.blockingRequested = enableBlocking;
    if (!enableBlocking) {
      this.disableBlocking();
      return;
    }
    for (const partition of this.runtimePartitions(true)) {
      this.startBlocking(partition);
    }
  }

  async clearCache(): Promise<void> {
    await Promise.all(
      [...this.runtimePartitions(true)].map(async (partition) => {
        const targetSession = session.fromPartition(partition);
        await targetSession.clearCache();
        await targetSession.clearStorageData();
      }),
    );
  }

  setDefaultSession(isPrivacy = false, init = false): void {
    this.defaultPartition = isPrivacy ? PRIVACY_WEBVIEW : PERSIST_WEBVIEW;
    for (const runtime of this.runtimes.values()) {
      if (runtime.kind === "user") this.destroyRuntime(runtime.tabId);
    }
    for (const tab of this.tabs) {
      Object.assign(tab, {
        mode: "home" as const,
        status: "default" as const,
        url: "",
        title: "",
        sources: [],
        errorCode: undefined,
        errorMessage: undefined,
      });
    }
    const { useProxy, proxy } = this.configCache.store;
    this.setProxy(useProxy, proxy);
    this.emitSnapshot();
    if (!init) this.sendToCurrentWindow(IpcEvent.browser.privacyChanged);
  }

  async withSessionCookies<
    T extends Pick<SourceParams, "type" | "headers" | "url">,
  >(tabId: string, item: T): Promise<T> {
    if (hasCookieHeader(item.headers)) return item;
    const cookieURL = getSessionCookieURL(item);
    if (!cookieURL) return item;
    const partition =
      this.runtimes.get(tabId)?.partition ?? this.defaultPartition;
    const cookies = await session.fromPartition(partition).cookies.get({
      url: cookieURL,
    });
    if (cookies.length === 0) return item;
    const cookieHeader = cookies
      .map(({ name, value }) => `${name}=${value}`)
      .join("; ");
    return {
      ...item,
      headers: [item.headers, `Cookie:${cookieHeader}`]
        .filter(Boolean)
        .join("\n"),
    };
  }

  async captureView(tabId: string): Promise<Electron.NativeImage | null> {
    const runtime = this.runtimes.get(tabId);
    if (!runtime) throw new Error("Browser tab view not found");
    if (!runtime.attachedWindow) return null;
    return runtime.view.webContents.capturePage();
  }

  async discover(
    request: BridgeDiscoveryRequest,
    signal: AbortSignal,
  ): Promise<BridgeDiscoveryCompleteParams> {
    if (this.agentTabs.has(request.discoveryId)) {
      throw new Error("Discovery is already running");
    }
    const tabId = `agent-${request.discoveryId}`;
    const partition = request.input.useSessionCookies
      ? this.defaultPartition
      : `agent-${request.discoveryId}`;
    const runtime = this.createRuntime(
      tabId,
      "agent",
      partition,
      request.input.useSessionCookies,
      request.input.url,
    );
    this.agentTabs.set(request.discoveryId, tabId);
    const collection = this.sniffingHelper.collectAgent(tabId, {
      signal,
      // Finish just before Core's authoritative deadline so partial sources
      // have enough time to cross the bridge instead of losing the race to
      // Core's timeout transition.
      timeoutMs: Math.max(
        1,
        request.input.timeoutMs - DISCOVERY_COMPLETION_MARGIN_MS,
      ),
    });
    try {
      const navigation = runtime.view.webContents.loadURL(request.input.url);
      await Promise.race([navigation, collection.then(() => undefined)]);
      return await collection;
    } catch (error) {
      if (error instanceof AgentCollectionError) throw error;
      this.sniffingHelper.failAgent(tabId, "discovery_navigation_failed");
      await collection.catch(() => undefined);
      throw new AgentCollectionError(
        "discovery_navigation_failed",
        "browser navigation failed",
      );
    } finally {
      this.agentTabs.delete(request.discoveryId);
      this.destroyRuntime(tabId);
    }
  }

  async cancel(discoveryId: string): Promise<void> {
    const tabId = this.agentTabs.get(discoveryId);
    if (!tabId) return;
    this.sniffingHelper.cancelAgent(tabId);
    this.destroyRuntime(tabId);
    this.agentTabs.delete(discoveryId);
  }

  destroy(): void {
    this.discoveryExecutor.setBrowser(null);
    for (const tabId of this.runtimes.keys()) this.destroyRuntime(tabId);
    this.tabBounds.clear();
    this.sniffingHelper.off("source", this.onSource);
    this.disableBlocking();
  }

  private createHomeSnapshot(url = "", isMobile?: boolean): BrowserTabSnapshot {
    return {
      id: randomUUID(),
      kind: "user",
      mode: url ? "browser" : "home",
      status: url ? "loading" : "default",
      isMobile:
        typeof isMobile === "boolean"
          ? isMobile
          : this.configCache.get("isMobile") === true,
      url,
      title: "",
      sources: [],
    };
  }

  private sanitizeTabSnapshot(tab: BrowserTabSnapshot): BrowserTabSnapshot {
    return {
      id: tab.id,
      kind: "user",
      mode: tab.mode === "browser" ? "browser" : "home",
      status: ["loading", "loaded", "failed"].includes(tab.status)
        ? tab.status
        : "default",
      isMobile: tab.isMobile === true,
      url: typeof tab.url === "string" ? tab.url : "",
      title: typeof tab.title === "string" ? tab.title : "",
      favicon: typeof tab.favicon === "string" ? tab.favicon : undefined,
      errorCode: typeof tab.errorCode === "number" ? tab.errorCode : undefined,
      errorMessage:
        typeof tab.errorMessage === "string" ? tab.errorMessage : undefined,
      sources: Array.isArray(tab.sources)
        ? tab.sources.map((source) => this.sanitizeSourceSnapshot(source))
        : [],
    };
  }

  private sanitizeSourceSnapshot(
    source: BrowserTabSourceSnapshot,
  ): BrowserTabSourceSnapshot {
    const mediaInfo: HLSMediaInfo | undefined = source.mediaInfo
      ? {
          status: source.mediaInfo.status,
          playlistType: source.mediaInfo.playlistType,
          maxQuality: source.mediaInfo.maxQuality,
          variants: source.mediaInfo.variants.map((variant) => ({
            url: variant.url,
            quality: variant.quality,
            width: variant.width,
            height: variant.height,
            bandwidth: variant.bandwidth,
            codecs: variant.codecs,
          })),
        }
      : undefined;
    return {
      id: source.id,
      url: source.url,
      documentURL: source.documentURL,
      name: source.name,
      type: source.type,
      mediaInfo,
    };
  }

  private requireTab(tabId: string): BrowserTabSnapshot {
    const tab = this.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error(`Browser tab ${tabId} was not found`);
    return tab;
  }

  private ensureUserRuntime(
    tabId: string,
    windowOptions?: BrowserWindowConstructorOptions,
    openerTabId?: string,
  ): TabRuntime {
    const existing = this.runtimes.get(tabId);
    if (existing) return existing;
    return this.createRuntime(
      tabId,
      "user",
      this.defaultPartition,
      true,
      "",
      windowOptions,
      openerTabId,
    );
  }

  private applyDeviceMode(runtime: TabRuntime, isMobile: boolean): void {
    const { webContents } = runtime.view;
    if (webContents.isDestroyed()) {
      throw new Error("Browser tab contents were destroyed");
    }

    webContents.setUserAgent(isMobile ? mobileUA : runtime.desktopUserAgent);
    runtime.isMobile = isMobile;
    this.applyRuntimeBounds(runtime);
  }

  private createRuntime(
    tabId: string,
    kind: "user" | "agent",
    partition: string,
    useSessionCookies: boolean,
    initialURL = "",
    windowOptions?: BrowserWindowConstructorOptions,
    openerTabId?: string,
  ): TabRuntime {
    const viewOptions: BrowserWindowConstructorOptions = windowOptions ?? {};
    viewOptions.webPreferences = {
      ...viewOptions.webPreferences,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      sandbox: true,
      partition,
      preload,
    };
    const view = new WebContentsView(viewOptions);
    const desktopUserAgent = chromeCompatibleDesktopUserAgent(
      view.webContents.getUserAgent(),
    );
    const runtime: TabRuntime = {
      attachedWindow: null,
      bounds: kind === "user" ? (this.tabBounds.get(tabId) ?? null) : null,
      desktopUserAgent,
      isMobile:
        kind === "user"
          ? this.tabs.find((tab) => tab.id === tabId)?.isMobile === true
          : false,
      kind,
      openerTabId,
      partition,
      tabId,
      view,
    };
    this.runtimes.set(tabId, runtime);
    registerRemoteBrowserContents(view.webContents.id, tabId, kind === "user");
    this.sniffingHelper.register({
      initialPageInfo: { title: "", url: initialURL },
      kind,
      partition,
      tabId,
      useSessionCookies,
      webContentsId: view.webContents.id,
    });
    this.bindRuntime(runtime);
    view.setBackgroundColor("#fff");
    view.webContents.setAudioMuted(this.configCache.get("audioMuted") === true);
    view.webContents.setUserAgent(
      runtime.isMobile ? mobileUA : runtime.desktopUserAgent,
    );
    this.applyProxyToPartition(partition);
    if (this.blockingRequested) this.startBlocking(partition);
    if (isDev && process.env.OPEN_DEVTOOLS === "true" && kind === "user") {
      view.webContents.openDevTools();
    }
    if (kind === "user" && tabId === this.activeTabId)
      this.attachRuntime(runtime);
    return runtime;
  }

  private bindRuntime(runtime: TabRuntime): void {
    const { webContents } = runtime.view;
    webContents.on("before-input-event", (event, input) => {
      const shortcut = getBrowserRefreshShortcut(input);
      if (!shortcut) return;
      event.preventDefault();
      void this.reload(runtime.tabId, shortcut === "force-reload");
    });
    webContents.on("dom-ready", () => this.onDomReady(runtime));
    webContents.on("did-start-navigation", (details) =>
      this.onDidStartNavigation(runtime, details),
    );
    webContents.on("did-stop-loading", () => this.onDidStopLoading(runtime));
    webContents.on("did-navigate", () => void this.onDidNavigate(runtime));
    webContents.on("did-navigate-in-page", (_event, url, isMainFrame) =>
      this.onDidNavigateInPage(runtime, url, isMainFrame),
    );
    webContents.on(
      "did-fail-load",
      (_event, code, description, validatedURL, isMainFrame) =>
        this.onDidFailLoad(
          runtime,
          code,
          description,
          validatedURL,
          isMainFrame,
        ),
    );
    webContents.on("page-title-updated", () =>
      this.onPageTitleUpdated(runtime),
    );
    webContents.on("page-favicon-updated", (_event, favicons: string[]) =>
      this.onFaviconUpdated(runtime, favicons),
    );
    webContents.on("render-process-gone", (_event, details) => {
      this.onRenderProcessGone(runtime, details);
    });
    webContents.on("destroyed", () => {
      unregisterRemoteBrowserContents(webContents.id);
      this.onWebContentsDestroyed(runtime);
    });
    webContents.on("will-navigate", (event) => {
      if (isInternalBrowserURL(event.url)) return;
      event.preventDefault();
      if (runtime.kind === "user" && isExternalBrowserURL(event.url)) {
        this.openExternalURL(event.url, "external protocol");
      }
    });
    webContents.setWindowOpenHandler((details: HandlerDetails) => {
      const { disposition, url } = details;
      if (runtime.kind !== "user") return { action: "deny" };
      if (!isInternalBrowserURL(url)) {
        if (isExternalBrowserURL(url)) {
          this.openExternalURL(url, "external protocol");
        }
        return { action: "deny" };
      }

      const tab = this.createTab({
        activate: disposition !== "background-tab",
        isMobile: runtime.isMobile,
        url,
      });
      return {
        action: "allow",
        createWindow: (options: BrowserWindowConstructorOptions) => {
          try {
            const childRuntime = this.ensureUserRuntime(
              tab.id,
              options,
              runtime.tabId,
            );
            if (disposition === "background-tab") {
              void childRuntime.view.webContents.loadURL(url);
            }
            return childRuntime.view.webContents;
          } catch (error) {
            this.closeTab(tab.id);
            this.logger.error("[BrowserTab] popup view allocation failed");
            throw error;
          }
        },
        outlivesOpener: true,
      };
    });
  }

  private onDidStartNavigation(
    runtime: TabRuntime,
    details: {
      isMainFrame: boolean;
      isSameDocument: boolean;
      url: string;
    },
  ): void {
    if (!details.isMainFrame || !this.isCurrentRuntime(runtime)) return;
    const title = runtime.view.webContents.getTitle();
    this.sniffingHelper.update(runtime.tabId, { title, url: details.url });
    if (runtime.kind !== "user") return;

    const tab = this.requireTab(runtime.tabId);
    const resetPageResources =
      !details.isSameDocument || tab.url !== details.url;
    const resetFavicon = tab.url !== details.url;
    Object.assign(tab, {
      mode: "browser" as const,
      status: "loading" as const,
      url: details.url,
      errorCode: undefined,
      errorMessage: undefined,
      ...(resetPageResources ? { sources: [] } : {}),
      ...(resetFavicon ? { favicon: undefined } : {}),
    });
    this.emitSnapshot();
  }

  private onDidStopLoading(runtime: TabRuntime): void {
    if (!this.isCurrentRuntime(runtime) || runtime.kind !== "user") return;
    const tab = this.requireTab(runtime.tabId);
    if (tab.status === "failed") return;
    Object.assign(tab, {
      ...this.pageInfo(runtime),
      status: "loaded" as const,
      errorCode: undefined,
      errorMessage: undefined,
    });
    this.emitSnapshot();
  }

  private onDomReady(runtime: TabRuntime): void {
    if (!this.isCurrentRuntime(runtime)) return;
    const pageInfo = this.pageInfo(runtime);
    this.sniffingHelper.update(runtime.tabId, pageInfo);
    this.sniffingHelper.markDomReady(runtime.tabId);
    if (runtime.kind === "user") {
      this.updateTabPage(runtime.tabId, pageInfo);
      this.sendRuntime(runtime, IpcEvent.browser.domReady, {
        tabId: runtime.tabId,
        ...pageInfo,
      } satisfies BrowserNavigationPayload);
    }
  }

  private async onDidNavigate(runtime: TabRuntime): Promise<void> {
    if (!this.isCurrentRuntime(runtime)) return;
    const pageInfo = this.pageInfo(runtime);
    this.sniffingHelper.update(runtime.tabId, pageInfo);
    if (runtime.kind === "user") {
      this.updateTabPage(runtime.tabId, pageInfo);
      this.sendRuntime(runtime, IpcEvent.browser.didNavigate, {
        tabId: runtime.tabId,
        ...pageInfo,
      } satisfies BrowserNavigationPayload);
    }
    try {
      const content = await readFile(pluginUrl, "utf-8");
      if (this.isCurrentRuntime(runtime)) {
        await runtime.view.webContents.executeJavaScript(
          isolatePagePluginSource(content),
        );
      }
    } catch (error) {
      this.logger.error("[BrowserTab] page plugin injection failed", error);
    }
    if (this.isCurrentRuntime(runtime)) {
      this.sniffingHelper.checkPageInfo(runtime.tabId);
    }
  }

  private onDidNavigateInPage(
    runtime: TabRuntime,
    url?: string,
    isMainFrame?: boolean,
  ): void {
    if (isMainFrame === false || !this.isCurrentRuntime(runtime)) return;
    const pageInfo = {
      title: runtime.view.webContents.getTitle(),
      url: url || runtime.view.webContents.getURL(),
    };
    this.sniffingHelper.update(runtime.tabId, pageInfo);
    this.sniffingHelper.checkPageInfo(runtime.tabId);
    if (runtime.kind === "user") {
      this.updateTabPage(runtime.tabId, pageInfo, "loaded");
      this.sendRuntime(runtime, IpcEvent.browser.didNavigateInPage, {
        tabId: runtime.tabId,
        ...pageInfo,
      } satisfies BrowserNavigationPayload);
    }
  }

  private onDidFailLoad(
    runtime: TabRuntime,
    errorCode: number,
    errorMessage: string,
    validatedURL?: string,
    isMainFrame?: boolean,
  ): void {
    if (
      isMainFrame === false ||
      errorCode === ERR_ABORTED ||
      !this.isCurrentRuntime(runtime)
    )
      return;
    if (runtime.kind === "agent") {
      this.sniffingHelper.failAgent(
        runtime.tabId,
        "discovery_navigation_failed",
      );
      return;
    }
    const currentPageInfo = this.pageInfo(runtime);
    const pageInfo = {
      title: currentPageInfo.title,
      url: validatedURL || currentPageInfo.url,
    };
    this.failUserRuntime(runtime, pageInfo, errorCode, errorMessage);
    this.logger.error(`[BrowserTab] load failed (${errorCode})`);
  }

  private onRenderProcessGone(
    runtime: TabRuntime,
    details: RenderProcessGoneDetails,
  ): void {
    if (!this.isCurrentRuntime(runtime)) return;
    if (runtime.kind === "agent") {
      this.sniffingHelper.failAgent(
        runtime.tabId,
        "discovery_navigation_failed",
      );
      this.destroyRuntime(runtime.tabId);
      return;
    }

    const pageInfo = this.pageInfo(runtime);
    this.destroyRuntime(runtime.tabId);
    this.failUserRuntime(
      runtime,
      pageInfo,
      RENDER_PROCESS_GONE_ERROR_CODE,
      `Renderer process exited: ${details.reason}`,
    );
  }

  private onWebContentsDestroyed(runtime: TabRuntime): void {
    if (runtime.kind === "agent") {
      this.sniffingHelper.failAgent(
        runtime.tabId,
        "discovery_navigation_failed",
      );
      this.releaseRuntime(runtime);
      return;
    }
    if (!this.releaseRuntime(runtime)) return;
    if (runtime.openerTabId) {
      this.removeTabSnapshot(runtime.tabId, runtime.openerTabId);
      return;
    }
    const tab = this.requireTab(runtime.tabId);
    this.failUserRuntime(
      runtime,
      { title: tab.title, url: tab.url },
      WEB_CONTENTS_DESTROYED_ERROR_CODE,
      "Browser contents were destroyed unexpectedly",
    );
  }

  private failUserRuntime(
    runtime: TabRuntime,
    pageInfo: { title: string; url: string },
    errorCode: number,
    errorMessage: string,
  ): void {
    const tab = this.requireTab(runtime.tabId);
    Object.assign(tab, {
      status: "failed" as const,
      errorCode,
      errorMessage,
      ...pageInfo,
    });
    this.emitSnapshot();
    this.sendRuntime(runtime, IpcEvent.browser.didFailLoad, {
      tabId: runtime.tabId,
      ...pageInfo,
      errorCode,
      errorMessage,
    } satisfies BrowserNavigationFailurePayload);
  }

  private openExternalURL(url: string, purpose: string): void {
    void shell.openExternal(url).catch(() => {
      this.logger.error(`[BrowserTab] ${purpose} open failed`);
    });
  }

  private onPageTitleUpdated(runtime: TabRuntime): void {
    if (!this.isCurrentRuntime(runtime)) return;
    const pageInfo = this.pageInfo(runtime);
    this.sniffingHelper.update(runtime.tabId, pageInfo);
    if (runtime.kind === "user") this.updateTabPage(runtime.tabId, pageInfo);
  }

  private onFaviconUpdated(runtime: TabRuntime, favicons: string[]): void {
    if (runtime.kind !== "user" || !this.isCurrentRuntime(runtime)) return;
    const tab = this.requireTab(runtime.tabId);
    tab.favicon = favicons[0];
    this.emitSnapshot();
  }

  private readonly onSource = async ({
    tabId,
    source,
  }: SniffingSourceEvent): Promise<void> => {
    const runtime = this.runtimes.get(tabId);
    if (!runtime || runtime.kind !== "user") return;
    if (!this.isCurrentRuntime(runtime)) return;
    const tab = this.requireTab(tabId);
    const existing = tab.sources.find((item) => item.url === source.url);
    let nextID = 1;
    for (const item of tab.sources) nextID = Math.max(nextID, item.id + 1);
    const safeSource = {
      id: existing?.id ?? nextID,
      url: source.url,
      documentURL: source.documentURL,
      name: source.name,
      type: source.type,
      mediaInfo: source.mediaInfo,
    };
    tab.sources = mergeSniffedSource(tab.sources, safeSource);
    this.emitSnapshot();
    const headers = filterSafeSniffedHeaders(source.headers);
    this.sendRuntime(runtime, IpcEvent.browser.sourceDetected, {
      tabId,
      source: { ...safeSource, ...(headers ? { headers } : {}) },
    } satisfies BrowserSourceDetectedPayload);
  };

  private updateTabPage(
    tabId: string,
    pageInfo: { title: string; url: string },
    status?: BrowserTabSnapshot["status"],
  ): void {
    const tab = this.requireTab(tabId);
    tab.url = pageInfo.url;
    tab.title = pageInfo.title;
    if (status) tab.status = status;
    this.emitSnapshot();
  }

  private pageInfo(runtime: TabRuntime): { title: string; url: string } {
    return {
      title: runtime.view.webContents.getTitle(),
      url: runtime.view.webContents.getURL(),
    };
  }

  private attachRuntime(runtime?: TabRuntime): void {
    if (
      !runtime ||
      runtime.kind !== "user" ||
      runtime.tabId !== this.activeTabId ||
      !runtime.bounds ||
      runtime.bounds.width <= 0 ||
      runtime.bounds.height <= 0
    )
      return;
    const targetWindow = this.currentWindow;
    if (!targetWindow || targetWindow.isDestroyed()) return;
    if (runtime.attachedWindow !== targetWindow) {
      this.detachRuntime(runtime);
      targetWindow.contentView.addChildView(runtime.view);
      runtime.attachedWindow = targetWindow;
    }
    this.applyRuntimeBounds(runtime);
  }

  private applyRuntimeBounds(runtime: TabRuntime): void {
    if (!runtime.bounds || !runtime.attachedWindow) return;
    const bounds = runtime.isMobile
      ? mobileBrowserBounds(runtime.bounds)
      : runtime.bounds;
    runtime.view.setBounds(bounds);
  }

  private detachRuntime(runtime?: TabRuntime): void {
    if (!runtime?.attachedWindow) return;
    if (!runtime.attachedWindow.isDestroyed()) {
      runtime.attachedWindow.contentView.removeChildView(runtime.view);
    }
    runtime.attachedWindow = null;
  }

  private destroyRuntime(tabId: string): void {
    const runtime = this.runtimes.get(tabId);
    if (!runtime) return;
    if (!this.releaseRuntime(runtime)) return;
    runtime.view.webContents.close();
  }

  private releaseRuntime(runtime: TabRuntime): boolean {
    if (!this.isCurrentRuntime(runtime)) return false;
    this.runtimes.delete(runtime.tabId);
    this.detachRuntime(runtime);
    this.sniffingHelper.unregister(runtime.tabId);
    return true;
  }

  private isCurrentRuntime(runtime: TabRuntime): boolean {
    return this.runtimes.get(runtime.tabId) === runtime;
  }

  private sendRuntime(
    runtime: TabRuntime,
    channel: string,
    payload: unknown,
  ): void {
    const target = runtime.attachedWindow ?? this.currentWindow;
    if (!target || target.isDestroyed()) return;
    target.webContents.send(channel, payload);
  }

  private sendToCurrentWindow(channel: string, payload?: unknown): void {
    const target = this.currentWindow;
    if (!target || target.isDestroyed()) return;
    target.webContents.send(channel, payload);
  }

  private emitSnapshot(): void {
    this.sendToCurrentWindow(IpcEvent.browser.tabsChanged, this.getSnapshot());
  }

  private get currentWindow(): Electron.BrowserWindow | null {
    if (this.browserWindow.window) return this.browserWindow.window;
    return this.mainWindow.window;
  }

  private runtimePartitions(includeDefault = false): Set<string> {
    const partitions = new Set<string>();
    if (includeDefault) partitions.add(this.defaultPartition);
    for (const runtime of this.runtimes.values())
      partitions.add(runtime.partition);
    return partitions;
  }

  private applyProxyToPartition(partition: string): void {
    const { useProxy, proxy } = this.configCache.store;
    const targetSession = session.fromPartition(partition);
    if (useProxy) enableSessionProxy(targetSession, this.logger, proxy);
    else void targetSession.setProxy({ mode: "system" });
  }

  private startBlocking(partition: string): void {
    void this.enableBlocking(partition).catch(() => {
      this.logger.error("[AdBlocker] enable failed");
    });
  }

  private async enableBlocking(partition: string): Promise<void> {
    if (Date.now() >= this.blockerExpiresAt) {
      this.blockerExpiresAt = Number.POSITIVE_INFINITY;
      this.blockerLoader.invalidate();
    }
    const blocker = await this.blockerLoader.load();
    if (!blocker || !this.blockingRequested) return;
    if (this.blocker && this.blocker !== blocker) this.disableBlocking();
    this.blocker = blocker;
    const targetSession = session.fromPartition(partition);
    if (this.blockingSessions.has(targetSession)) return;
    if (!blocker.isBlockingEnabled(targetSession)) {
      blocker.enableBlockingInSession(targetSession);
    }
    this.blockingSessions.add(targetSession);
  }

  private disableBlocking(): void {
    if (!this.blocker) return;
    for (const targetSession of this.blockingSessions) {
      if (this.blocker.isBlockingEnabled(targetSession)) {
        this.blocker.disableBlockingInSession(targetSession);
      }
    }
    this.blockingSessions.clear();
  }

  private observeBlockerRefresh(
    refresh: Promise<AdBlockerCacheValue | undefined>,
  ): void {
    void refresh
      .then((result) => {
        if (!result) {
          this.blockerExpiresAt = 0;
          this.blockerLoader.invalidate();
          return;
        }
        this.disableBlocking();
        this.blocker = result.blocker;
        this.blockerExpiresAt = result.expiresAt;
        this.blockerLoader.replace(result.blocker);
        if (this.blockingRequested) {
          for (const partition of this.runtimePartitions(true)) {
            this.startBlocking(partition);
          }
        }
      })
      .catch(() => {
        this.blockerExpiresAt = 0;
        this.blockerLoader.invalidate();
        this.logger.error("[AdBlocker] list load failed");
      });
  }
}

function hasCookieHeader(headers?: string): boolean {
  if (!headers) return false;
  return headers
    .replace(/\r\n/g, "\n")
    .split("\n")
    .some((line) => line.split(":", 1)[0]?.trim().toLowerCase() === "cookie");
}

const safeSniffedHeaderNames = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "origin",
  "range",
  "referer",
  "user-agent",
]);

function filterSafeSniffedHeaders(headers?: string): string | undefined {
  if (!headers) return undefined;
  const safeHeaders = headers
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => {
      const separator = line.indexOf(":");
      if (separator <= 0) return false;
      return safeSniffedHeaderNames.has(
        line.slice(0, separator).trim().toLowerCase(),
      );
    })
    .map((line) => line.trim())
    .filter(Boolean);
  return safeHeaders.length > 0 ? safeHeaders.join("\n") : undefined;
}

function getSessionCookieURL(
  item: Pick<SourceParams, "type" | "url">,
): string | undefined {
  if (item.type === DownloadType.bilibili) {
    return "https://www.bilibili.com";
  }
  if (item.type === DownloadType.xiaohongshu) {
    return "https://www.xiaohongshu.com";
  }
  if (item.type !== DownloadType.youtube) return undefined;

  try {
    const hostname = new URL(item.url).hostname.toLowerCase();
    if (hostname === "x.com" || hostname.endsWith(".x.com")) {
      return "https://x.com";
    }
    if (hostname === "twitter.com" || hostname.endsWith(".twitter.com")) {
      return "https://twitter.com";
    }
    if (
      hostname === "tiktok.com" ||
      hostname.endsWith(".tiktok.com") ||
      hostname === "tiktokv.com" ||
      hostname.endsWith(".tiktokv.com")
    ) {
      return "https://www.tiktok.com";
    }
    if (hostname === "douyin.com" || hostname.endsWith(".douyin.com")) {
      return "https://www.douyin.com";
    }
    if (
      hostname === "youtu.be" ||
      hostname === "youtube.com" ||
      hostname.endsWith(".youtube.com")
    ) {
      return "https://www.youtube.com";
    }
  } catch {
    return undefined;
  }

  return undefined;
}
