import {
  IPC,
  type PlatformApi,
  type EnvPath,
  type DownloadTask,
  type BrowserStore,
  type BrowserTabSnapshot,
  type BrowserTabsSnapshot,
  type CreateBrowserTabInput,
  type DialogOpenOptions,
  type DialogSaveOptions,
  type ContextMenuItem,
  type CLIInstallOptions,
  type LibraryApi,
} from "@mediago/common";
import { contextBridge, ipcRenderer, webUtils } from "electron";

const apiKey = "electron";

/**
 * Only platform-specific methods are exposed via IPC.
 * Data/CRUD operations (GoApi) go directly to Go Core HTTP from the renderer.
 *
 * getEnvPath is a special case: it's in GoApi but also needed before Go adapter
 * is initialized (to discover coreUrl), so we keep it in the preload as well.
 */
const electronApi: PlatformApi = {
  browser: {
    createTab(options?: CreateBrowserTabInput): Promise<BrowserTabSnapshot> {
      return ipcRenderer.invoke(IPC.browser.createTab, options);
    },
    activateTab(tabId: string): Promise<BrowserTabsSnapshot> {
      return ipcRenderer.invoke(IPC.browser.activateTab, tabId);
    },
    closeTab(tabId: string): Promise<BrowserTabsSnapshot> {
      return ipcRenderer.invoke(IPC.browser.closeTab, tabId);
    },
    getTabs(): Promise<BrowserTabsSnapshot> {
      return ipcRenderer.invoke(IPC.browser.getTabs);
    },
    loadURL(tabIdOrUrl: string, url?: string): Promise<void> {
      return ipcRenderer.invoke(
        IPC.browser.loadURL,
        url === undefined
          ? { tabId: "", url: tabIdOrUrl }
          : { tabId: tabIdOrUrl, url },
      );
    },
    back(tabId?: string): Promise<boolean> {
      return ipcRenderer.invoke(IPC.browser.back, tabId);
    },
    reload(tabId?: string): Promise<void> {
      return ipcRenderer.invoke(IPC.browser.reload, tabId);
    },
    show(tabId?: string): Promise<void> {
      return ipcRenderer.invoke(IPC.browser.show, tabId);
    },
    hide(tabId?: string): Promise<void> {
      return ipcRenderer.invoke(IPC.browser.hide, tabId);
    },
    home(tabId?: string): Promise<void> {
      return ipcRenderer.invoke(IPC.browser.home, tabId);
    },
    setBounds(
      tabIdOrRect: string | Electron.Rectangle,
      rect?: Electron.Rectangle,
    ): Promise<void> {
      return ipcRenderer.invoke(
        IPC.browser.setBounds,
        typeof tabIdOrRect === "string"
          ? { tabId: tabIdOrRect, bounds: rect }
          : { tabId: "", bounds: tabIdOrRect },
      );
    },
    setDeviceMode(
      tabIdOrIsMobile: string | boolean,
      isMobile?: boolean,
    ): Promise<void> {
      return ipcRenderer.invoke(
        IPC.browser.setUserAgent,
        typeof tabIdOrIsMobile === "string"
          ? { tabId: tabIdOrIsMobile, isMobile: isMobile === true }
          : { tabId: "", isMobile: tabIdOrIsMobile },
      );
    },
    clearCache(): Promise<void> {
      return ipcRenderer.invoke(IPC.browser.clearCache);
    },
    pluginReady(tabId?: string): Promise<void> {
      return ipcRenderer.invoke(IPC.browser.pluginReady, tabId);
    },
    showDownloadDialog(
      tabIdOrData: string | Omit<DownloadTask, "id">[],
      data?: Omit<DownloadTask, "id">[],
    ): Promise<void> {
      return ipcRenderer.invoke(
        IPC.browser.showDownloadDialog,
        typeof tabIdOrData === "string"
          ? { tabId: tabIdOrData, data: data ?? [] }
          : { tabId: "", data: tabIdOrData },
      );
    },
    dismissOverlayDialog(): Promise<void> {
      return ipcRenderer.invoke(IPC.browser.dismissOverlayDialog);
    },
  },
  app: {
    getEnvPath(): Promise<EnvPath> {
      return ipcRenderer.invoke(IPC.app.getEnvPath);
    },
    async getPathForFile(file: File): Promise<string> {
      return webUtils.getPathForFile(file);
    },
    getExtensionDir(): Promise<string> {
      return ipcRenderer.invoke(IPC.app.getExtensionDir);
    },
    getPreferredSystemLanguage(): Promise<string> {
      return ipcRenderer.invoke(IPC.app.getPreferredSystemLanguage);
    },
    getSharedState(): Promise<BrowserTabsSnapshot> {
      return ipcRenderer.invoke(IPC.app.getSharedState);
    },
    setSharedState(state: unknown): Promise<void> {
      return ipcRenderer.invoke(IPC.app.setSharedState, state);
    },
    showBrowserWindow(): Promise<void> {
      return ipcRenderer.invoke(IPC.app.showBrowserWindow);
    },
    combineToHomePage(
      store?: BrowserTabsSnapshot | BrowserStore,
    ): Promise<void> {
      return ipcRenderer.invoke(IPC.app.combineToHomePage, store);
    },
    drainShareIntents() {
      return ipcRenderer.invoke(IPC.app.drainShareIntents);
    },
  },
  dialog: {
    open(options: DialogOpenOptions): Promise<string[]> {
      return ipcRenderer.invoke(IPC.dialog.open, options);
    },
    save(options: DialogSaveOptions): Promise<string> {
      return ipcRenderer.invoke(IPC.dialog.save, options);
    },
  },
  shell: {
    open(target: string): Promise<void> {
      return ipcRenderer.invoke(IPC.shell.open, target);
    },
  },
  contextMenu: {
    show(items: ContextMenuItem[]): Promise<string | null> {
      return ipcRenderer.invoke(IPC.contextMenu.show, items);
    },
  },
  cli: {
    getStatus() {
      return ipcRenderer.invoke(IPC.cli.getStatus);
    },
    install(options: CLIInstallOptions) {
      return ipcRenderer.invoke(IPC.cli.install, options);
    },
  },
  update: {
    getState() {
      return ipcRenderer.invoke(IPC.update.getState);
    },
    check() {
      return ipcRenderer.invoke(IPC.update.check);
    },
    startDownload() {
      return ipcRenderer.invoke(IPC.update.startDownload);
    },
    install() {
      return ipcRenderer.invoke(IPC.update.install);
    },
    openLogDirectory() {
      return ipcRenderer.invoke(IPC.update.openLogDirectory);
    },
    getDiagnosticInfo() {
      return ipcRenderer.invoke(IPC.update.getDiagnosticInfo);
    },
  },
  resourceSearch: {
    listProviders() {
      return ipcRenderer.invoke(IPC.resourceSearch.listProviders);
    },
    saveProviders(providers: import("@mediago/common").ResourceProvider[]) {
      return ipcRenderer.invoke(IPC.resourceSearch.saveProviders, providers);
    },
    search(keyword: string, page?: number) {
      return ipcRenderer.invoke(IPC.resourceSearch.search, keyword, page);
    },
    cancel() {
      return ipcRenderer.invoke(IPC.resourceSearch.cancel);
    },
  },
  library: {
    list() {
      return ipcRenderer.invoke(IPC.library.list);
    },
    importFiles(paths, source) {
      return ipcRenderer.invoke(IPC.library.importFiles, paths, source);
    },
    update(id, patch) {
      return ipcRenderer.invoke(IPC.library.update, id, patch);
    },
    remove(id) {
      return ipcRenderer.invoke(IPC.library.remove, id);
    },
    scan(id) {
      return ipcRenderer.invoke(IPC.library.scan, id);
    },
    play(id) {
      return ipcRenderer.invoke(IPC.library.play, id);
    },
    reveal(id) {
      return ipcRenderer.invoke(IPC.library.reveal, id);
    },
    exportFiles(ids) {
      return ipcRenderer.invoke(IPC.library.exportFiles, ids);
    },
  } satisfies LibraryApi,
  on(channel: string, listener: (...args: unknown[]) => void): void {
    ipcRenderer.on(channel, listener);
  },
  off(channel: string, listener: (...args: unknown[]) => void): void {
    ipcRenderer.removeListener(channel, listener);
  },
};

export type PreloadExposure = "trusted-app" | "remote-browser" | "none";

export function getPreloadExposure(
  value: string,
  isMainFrame: boolean,
  isDevelopment: boolean,
  appName: string,
): PreloadExposure {
  if (!isMainFrame) return "none";
  try {
    const url = new URL(value);
    if (isDevelopment) {
      return url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
        url.port === "8500" &&
        url.username === "" &&
        url.password === ""
        ? "trusted-app"
        : /^https?:$/.test(url.protocol)
          ? "remote-browser"
          : "none";
    }
    if (
      Boolean(appName) &&
      url.protocol === `${appName}:` &&
      url.hostname === "index.html" &&
      url.username === "" &&
      url.password === ""
    ) {
      return "trusted-app";
    }
    return /^https?:$/.test(url.protocol) ? "remote-browser" : "none";
  } catch {
    return "none";
  }
}

export function createRemoteBrowserApi() {
  return {
    browser: {
      showDownloadDialog(data: Omit<DownloadTask, "id">[]) {
        return ipcRenderer.invoke(IPC.browser.showDownloadDialog, data);
      },
    },
  };
}

const documentURL = globalThis.location?.href ?? "";
const exposure = getPreloadExposure(
  documentURL,
  process.isMainFrame,
  process.env.NODE_ENV === "development",
  process.env.APP_NAME || "",
);
if (exposure === "trusted-app") {
  contextBridge.exposeInMainWorld(apiKey, electronApi);
} else if (exposure === "remote-browser") {
  // Remote pages need only the explicit page-plugin download handoff.
  contextBridge.exposeInMainWorld(apiKey, createRemoteBrowserApi());
}

export { electronApi };
export type { PlatformApi };
