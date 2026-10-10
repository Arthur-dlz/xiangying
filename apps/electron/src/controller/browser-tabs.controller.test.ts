import { DownloadType } from "@mediago/common";
import { describe, expect, it, vi } from "vitest";

vi.mock("../services/browser-tab-manager.service", () => ({
  default: class BrowserTabManagerService {},
}));

vi.mock("../core/system-language", () => ({
  getPreferredSystemLanguage: vi.fn(() => "en-US"),
}));

vi.mock("../utils", () => ({
  exePath: "/app/mediago",
  workspace: "/workspace",
}));

vi.mock("../utils/binaryResolver", () => ({
  resolveExtensionDir: vi.fn(() => ({ extensionDir: "/extension" })),
}));

vi.mock("../services/downloader.server", () => ({
  DownloaderServer: class DownloaderServer {},
}));

vi.mock("../services/overlay-dialog.service", () => ({
  default: class OverlayDialogService {},
}));

vi.mock("../services/share-intent.service", () => ({
  default: class ShareIntentService {},
}));

vi.mock("../services/sniffing-helper.service", () => ({
  SniffingHelper: class SniffingHelper {},
}));

vi.mock("../vendor/ElectronUpdater", () => ({
  default: class ElectronUpdater {},
}));

vi.mock("../windows/browser.window", () => ({
  default: class BrowserWindow {},
}));

vi.mock("../windows/main.window", () => ({
  default: class MainWindow {},
}));

const { default: WebviewController } = await import("./webview.controller");
const { default: HomeController } = await import("./home.controller");

describe("tab-aware browser controllers", () => {
  it("routes tab-scoped browser commands and resolves legacy calls to the active tab", async () => {
    const tabs = createTabManager();
    const controller = new WebviewController(
      tabs as never,
      { getPageHeaders: vi.fn(), pluginReady: vi.fn() } as never,
      { hide: vi.fn(), show: vi.fn() } as never,
    );

    await controller.browserViewLoadUrl({} as never, {
      tabId: "tab-b",
      url: "https://example.com/b",
    });
    await controller.browserViewLoadUrl(
      {} as never,
      "https://example.com/legacy",
    );
    controller.setWebviewBounds({} as never, {
      tabId: "tab-b",
      bounds: { x: 1, y: 2, width: 3, height: 4 },
    });
    await controller.webviewChangeDeviceMode({} as never, {
      tabId: "tab-b",
      isMobile: true,
    });

    expect(tabs.loadURL).toHaveBeenNthCalledWith(
      1,
      "tab-b",
      "https://example.com/b",
    );
    expect(tabs.loadURL).toHaveBeenNthCalledWith(
      2,
      "tab-active",
      "https://example.com/legacy",
    );
    expect(tabs.setBounds).toHaveBeenCalledWith("tab-b", {
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
    expect(tabs.setDeviceMode).toHaveBeenCalledWith("tab-b", true);
  });

  it("uses headers from the same tab when opening its download dialog", async () => {
    const tabs = createTabManager();
    const overlay = { hide: vi.fn(), show: vi.fn() };
    const sniffing = {
      getPageHeaders: vi.fn(() => "Referer: https://example.com/tab-b"),
      pluginReady: vi.fn(),
    };
    const controller = new WebviewController(
      tabs as never,
      sniffing as never,
      overlay as never,
    );
    const task = {
      name: "video.mp4",
      type: DownloadType.direct,
      url: "https://cdn.example.com/video.mp4",
    };

    await controller.showDownloadDialog({} as never, {
      tabId: "tab-b",
      data: [task as never],
    });

    expect(sniffing.getPageHeaders).toHaveBeenCalledWith(
      "tab-b",
      DownloadType.direct,
    );
    expect(tabs.withSessionCookies).toHaveBeenCalledWith(
      "tab-b",
      expect.objectContaining({
        headers: "Referer: https://example.com/tab-b",
      }),
    );
    expect(overlay.show).toHaveBeenCalledOnce();
  });

  it("uses the manager snapshot as shared state and reparents on window moves", async () => {
    const tabs = createTabManager();
    const browserWindow = {
      hideWindow: vi.fn(),
      showWindow: vi.fn(),
    };
    const client = { setConfigKey: vi.fn(async () => undefined) };
    const controller = new HomeController(
      {} as never,
      browserWindow as never,
      {} as never,
      { getClient: vi.fn(() => client) } as never,
      { drain: vi.fn(() => []) } as never,
      tabs as never,
    );
    const snapshot = tabs.getSnapshot();

    expect(controller.getSharedState()).toBe(snapshot);
    expect(controller.setSharedState({} as never, snapshot)).toBe(snapshot);
    await controller.showBrowserWindow();
    await controller.combineToHomePage({} as never, snapshot);

    expect(tabs.restoreSnapshot).toHaveBeenCalledTimes(2);
    expect(browserWindow.showWindow).toHaveBeenCalledOnce();
    expect(browserWindow.hideWindow).toHaveBeenCalledOnce();
    expect(tabs.reparentActiveView).toHaveBeenCalledTimes(2);
    expect(client.setConfigKey).toHaveBeenNthCalledWith(
      1,
      "openInNewWindow",
      true,
    );
    expect(client.setConfigKey).toHaveBeenNthCalledWith(
      2,
      "openInNewWindow",
      false,
    );
  });
});

function createTabManager() {
  const snapshot = {
    tabs: [],
    activeTabId: "tab-active",
    sourcePanelCollapsed: false,
  };
  return {
    activateTab: vi.fn(),
    clearCache: vi.fn(),
    closeTab: vi.fn(),
    createTab: vi.fn(),
    getActiveTabId: vi.fn(() => "tab-active"),
    getSnapshot: vi.fn(() => snapshot),
    goBack: vi.fn(),
    goHome: vi.fn(),
    hide: vi.fn(),
    loadURL: vi.fn(async () => undefined),
    reload: vi.fn(),
    reparentActiveView: vi.fn(),
    restoreSnapshot: vi.fn(() => snapshot),
    setBounds: vi.fn(),
    setDeviceMode: vi.fn(),
    show: vi.fn(),
    withSessionCookies: vi.fn(async (_tabId, task) => task),
  };
}

function downloaderServer() {
  return {
    getClient: vi.fn(() => ({ setConfigKey: vi.fn(async () => undefined) })),
  };
}
