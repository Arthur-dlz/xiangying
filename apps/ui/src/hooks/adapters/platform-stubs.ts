import type { PlatformApi } from "@mediago/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noop = async (..._args: unknown[]): Promise<any> => {};
const desktopLibraryOnly = async (): Promise<never> => {
  throw new Error("本地片库仅支持 Windows 桌面版，请在乡映软件中打开");
};

/**
 * Web/server mode stubs for PlatformApi.
 * All Electron-native operations are no-ops in web mode.
 */
export const webPlatformStubs: PlatformApi = {
  resourceSearch: {
    listProviders: async () => {
      throw new Error("资源接口搜索请在乡映桌面版中打开");
    },
    saveProviders: async () => {
      throw new Error("资源接口搜索请在乡映桌面版中打开");
    },
    search: async () => {
      throw new Error("资源接口搜索请在乡映桌面版中打开");
    },
    cancel: noop,
  },
  library: {
    list: desktopLibraryOnly,
    importFiles: desktopLibraryOnly,
    update: desktopLibraryOnly,
    remove: desktopLibraryOnly,
    scan: desktopLibraryOnly,
    play: desktopLibraryOnly,
    reveal: desktopLibraryOnly,
    exportFiles: desktopLibraryOnly,
  },
  browser: {
    createTab: async () => ({
      id: "web-tab",
      kind: "user",
      mode: "home",
      status: "default",
      isMobile: false,
      url: "",
      title: "",
      sources: [],
    }),
    activateTab: async (tabId) => emptyTabsSnapshot(tabId),
    closeTab: async () => emptyTabsSnapshot(),
    getTabs: async () => emptyTabsSnapshot(),
    loadURL: noop,
    back: async () => false,
    reload: noop,
    show: noop,
    hide: noop,
    home: noop,
    setBounds: noop,
    setDeviceMode: noop,
    clearCache: noop,
    pluginReady: noop,
    showDownloadDialog: noop,
    dismissOverlayDialog: noop,
  },
  app: {
    getEnvPath: async () => ({
      binPath: "",
      dbPath: "",
      workspace: "",
      platform: "",
      local: "",
      playerUrl: "",
      coreUrl: "",
    }),
    getPathForFile: async () => "",
    // Web/server mode has no local filesystem — the browser extension
    // is an Electron-only concept, and the Settings UI hides the
    // "Browser extension directory" button behind `isWeb`. The stub
    // just returns an empty string so type-wise the shared contract
    // holds.
    getExtensionDir: async () => "",
    getPreferredSystemLanguage: async () => {
      if (typeof navigator === "undefined") return "";
      return navigator.languages?.[0] ?? navigator.language;
    },
    getSharedState: async () => emptyTabsSnapshot(),
    setSharedState: noop,
    showBrowserWindow: noop,
    combineToHomePage: noop,
    drainShareIntents: async () => [],
  },
  dialog: {
    open: async () => [],
    save: async () => "",
  },
  shell: {
    open: async (target: string) => {
      const a = document.createElement("a");
      a.href = target;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.click();
    },
  },
  contextMenu: {
    show: async () => null,
  },
  cli: {
    getStatus: async () => ({
      installed: false,
      updateAvailable: false,
      inPath: false,
      binaryPath: "",
      configPath: "",
    }),
    install: async () => ({
      installed: false,
      updateAvailable: false,
      inPath: false,
      binaryPath: "",
      configPath: "",
    }),
  },
  update: {
    getState: async () => ({
      status: "idle",
      currentVersion: "",
      progress: 0,
      autoDownload: false,
      portable: false,
    }),
    check: async () => ({
      mode: "in-app",
      state: {
        status: "not-available",
        currentVersion: "",
        progress: 0,
        autoDownload: false,
        portable: false,
      },
    }),
    startDownload: async () => ({
      status: "idle",
      currentVersion: "",
      progress: 0,
      autoDownload: false,
      portable: false,
    }),
    install: async () => ({
      status: "idle",
      currentVersion: "",
      progress: 0,
      autoDownload: false,
      portable: false,
    }),
    openLogDirectory: async () => ({ opened: false }),
    getDiagnosticInfo: async () => "",
  },
  on: () => {},
  off: () => {},
};

function emptyTabsSnapshot(activeTabId = "") {
  return { tabs: [], activeTabId, sourcePanelCollapsed: false };
}
