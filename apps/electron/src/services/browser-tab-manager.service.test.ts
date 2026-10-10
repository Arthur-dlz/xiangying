import { DownloadType, IpcEvent } from "@mediago/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentCollectionError } from "./sniffing-helper.service";

interface MockWebContentsViewOptions {
  webContents?: unknown;
  webPreferences?: { partition?: string; [key: string]: unknown };
}

const moduleMocks = vi.hoisted(() => ({
  resolve: vi.fn(() => "/tmp/preload.cjs"),
}));

const fileMocks = vi.hoisted(() => ({
  readFile: vi.fn(async () => "const mediagoPagePlugin = true;"),
}));

const electronMocks = vi.hoisted(() => ({
  failNextAllocation: false,
  nextWebContentsId: 1,
  openExternal: vi.fn(async () => undefined),
  sessions: new Map<string, ReturnType<typeof createMockSession>>(),
  views: [] as Array<{
    constructorOptions: MockWebContentsViewOptions | undefined;
    partition: string | undefined;
    setBounds: ReturnType<typeof vi.fn>;
    webContents: Record<string, any>;
  }>,
}));

const adBlockerCacheMocks = vi.hoisted(() => ({
  load: vi.fn(async () => ({
    blocker: undefined,
    expiresAt: Number.POSITIVE_INFINITY,
  })),
}));

vi.mock("./sniffing-helper.service", () => {
  class AgentCollectionError extends Error {
    constructor(
      readonly errorCode: string,
      message: string,
    ) {
      super(message);
      this.name = "AgentCollectionError";
    }
  }

  return {
    AgentCollectionError,
    SniffingHelper: class SniffingHelper {},
  };
});

vi.mock("node:module", () => ({
  createRequire: () =>
    Object.assign(vi.fn(), {
      resolve: moduleMocks.resolve,
    }),
}));

vi.mock("node:fs/promises", () => ({
  readFile: fileMocks.readFile,
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/user-data") },
  shell: { openExternal: electronMocks.openExternal },
  session: {
    fromPartition: vi.fn((partition: string) => {
      let target = electronMocks.sessions.get(partition);
      if (!target) {
        target = createMockSession();
        electronMocks.sessions.set(partition, target);
      }
      return target;
    }),
  },
  WebContentsView: class MockWebContentsView {
    constructorOptions: MockWebContentsViewOptions | undefined;
    partition: string | undefined;
    setBackgroundColor = vi.fn();
    setBounds = vi.fn();
    webContents: Record<string, any>;

    constructor(options?: MockWebContentsViewOptions) {
      if (electronMocks.failNextAllocation) {
        electronMocks.failNextAllocation = false;
        throw new Error("allocation failed");
      }
      this.constructorOptions = options;
      this.partition = options?.webPreferences?.partition;
      const handlers = new Map<string, Array<(...args: any[]) => void>>();
      let title = "Page";
      let url = "";
      let windowOpenHandler:
        | ((details: {
            disposition: string;
            features: string;
            frameName: string;
            referrer: { policy: string; url: string };
            url: string;
          }) => unknown)
        | undefined;
      const webContents = {
        id: electronMocks.nextWebContentsId++,
        capturePage: vi.fn(async () => null),
        close: vi.fn(),
        disableDeviceEmulation: vi.fn(),
        emit: (event: string, ...args: any[]) => {
          for (const handler of handlers.get(event) ?? []) handler(...args);
        },
        executeJavaScript: vi.fn(async () => undefined),
        enableDeviceEmulation: vi.fn(),
        getTitle: vi.fn(() => title),
        getURL: vi.fn(() => url),
        getUserAgent: vi.fn(
          () =>
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/150.0.7871.129 Electron/43.2.0 Safari/537.36",
        ),
        isDestroyed: vi.fn(() => false),
        loadURL: vi.fn(async (nextURL: string) => {
          url = nextURL;
        }),
        navigationHistory: {
          canGoBack: vi.fn(() => false),
          goBack: vi.fn(),
        },
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        }),
        openDevTools: vi.fn(),
        reload: vi.fn(),
        reloadIgnoringCache: vi.fn(),
        setAudioMuted: vi.fn(),
        setTitle: (nextTitle: string) => {
          title = nextTitle;
        },
        setURL: (nextURL: string) => {
          url = nextURL;
        },
        setUserAgent: vi.fn(),
        setWindowOpenHandler: vi.fn((handler: typeof windowOpenHandler) => {
          windowOpenHandler = handler;
        }),
        stop: vi.fn(),
        triggerWindowOpen: (nextURL: string, disposition = "foreground-tab") =>
          windowOpenHandler?.({
            disposition,
            features: "",
            frameName: "",
            referrer: { policy: "default", url },
            url: nextURL,
          }),
      };
      this.webContents = webContents;
      electronMocks.views.push(this);
    }
  },
}));

vi.mock("@ghostery/adblocker-electron", () => ({
  ElectronBlocker: {},
}));

vi.mock("./ad-blocker-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ad-blocker-cache")>();
  return {
    ...actual,
    createAdBlockerCache: () => ({ load: adBlockerCacheMocks.load }),
  };
});

vi.mock("../utils", () => ({
  isDeeplink: vi.fn(() => false),
  mobileUA: "mobile-user-agent",
  PERSIST_WEBVIEW: "persist:webview",
  PRIVACY_WEBVIEW: "privacy-webview",
  pluginUrl: "/missing/plugin.js",
}));

vi.mock("../windows/browser.window", () => ({
  default: class BrowserWindow {},
}));

vi.mock("../windows/main.window", () => ({
  default: class MainWindow {},
}));

vi.mock("../vendor/ElectronLogger", () => ({
  default: class ElectronLogger {},
}));

vi.mock("./go-config-cache", () => ({
  default: class GoConfigCache {},
}));

vi.mock("electron-is-dev", () => ({ default: false }));

const {
  chromeCompatibleDesktopUserAgent,
  default: BrowserTabManagerService,
  isolatePagePluginSource,
} = await import("./browser-tab-manager.service");

beforeEach(() => {
  vi.clearAllMocks();
  fileMocks.readFile.mockReset();
  fileMocks.readFile.mockResolvedValue("const mediagoPagePlugin = true;");
  electronMocks.failNextAllocation = false;
  electronMocks.nextWebContentsId = 1;
  electronMocks.sessions.clear();
  electronMocks.views.length = 0;
});

describe("BrowserTabManagerService", () => {
  it("removes Electron's product token from the desktop UA", () => {
    expect(
      chromeCompatibleDesktopUserAgent(
        "Mozilla/5.0 Chrome/150.0.7871.129 Electron/43.2.0 Safari/537.36",
      ),
    ).toBe("Mozilla/5.0 Chrome/150.0.7871.129 Safari/537.36");
  });

  it("isolates the page plugin from globals defined by the website", () => {
    expect(isolatePagePluginSource("const controller = true;")).toBe(
      "(() => {\nconst controller = true;\n})()",
    );
  });

  it("creates tabs lazily and has no fixed tab-count limit", () => {
    const { service } = createHarness();

    for (let index = 0; index < 30; index += 1) service.createTab();

    expect(service.getSnapshot().tabs).toHaveLength(31);
    expect(electronMocks.views).toHaveLength(0);
  });

  it("keeps one view per loaded tab and only attaches the active one", async () => {
    const { mainNativeWindow, service } = createHarness();
    const first = service.getSnapshot().activeTabId;
    await service.loadURL(first, "https://example.com/first");
    service.setBounds(first, { x: 0, y: 40, width: 900, height: 600 });
    const firstView = electronMocks.views[0];

    const second = service.createTab();
    await service.loadURL(second.id, "https://example.com/second");
    service.setBounds(second.id, { x: 0, y: 40, width: 900, height: 600 });
    const secondView = electronMocks.views[1];

    expect(mainNativeWindow.contentView.removeChildView).toHaveBeenCalledWith(
      firstView,
    );
    expect(mainNativeWindow.contentView.addChildView).toHaveBeenLastCalledWith(
      secondView,
    );

    service.activateTab(first);
    expect(
      mainNativeWindow.contentView.removeChildView,
    ).toHaveBeenLastCalledWith(secondView);
    expect(mainNativeWindow.contentView.addChildView).toHaveBeenLastCalledWith(
      firstView,
    );
    expect(electronMocks.views).toHaveLength(2);
  });

  it("preserves tab state when allocating a view fails", async () => {
    const { service } = createHarness();
    const tabId = service.getSnapshot().activeTabId;
    electronMocks.failNextAllocation = true;

    await expect(
      service.loadURL(tabId, "https://example.com/failure"),
    ).rejects.toThrow("Unable to allocate a browser tab");

    const tab = service.getSnapshot().tabs[0];
    expect(tab.id).toBe(tabId);
    expect(tab.status).toBe("failed");
    expect(tab.url).toBe("https://example.com/failure");
  });

  it("normalizes schemeless navigation to HTTPS", async () => {
    const { service } = createHarness();
    const tabId = service.getSnapshot().activeTabId;

    await service.loadURL(tabId, "x.com/example/status/123");

    expect(electronMocks.views[0].webContents.loadURL).toHaveBeenCalledWith(
      "https://x.com/example/status/123",
    );
    expect(service.getSnapshot().tabs[0].url).toBe(
      "https://x.com/example/status/123",
    );
  });

  it.each([
    "http://www.tiktok.com/@creator/video/7480123456789012345",
    "http://www.douyin.com/video/7480123456789012345",
  ])("upgrades known short-video navigation to HTTPS: %s", async (url) => {
    const { service } = createHarness();
    const tabId = service.getSnapshot().activeTabId;

    await service.loadURL(tabId, url);

    expect(electronMocks.views[0].webContents.loadURL).toHaveBeenCalledWith(
      url.replace("http://", "https://"),
    );
  });

  it("routes safe external protocols without replacing the current tab", async () => {
    const { service } = createHarness();
    const tabId = service.getSnapshot().activeTabId;
    await service.loadURL(tabId, "https://example.com/current");

    await service.loadURL(tabId, "mailto:hello@example.com");

    expect(electronMocks.openExternal).toHaveBeenCalledWith(
      "mailto:hello@example.com",
    );
    expect(service.getSnapshot().tabs[0].url).toBe(
      "https://example.com/current",
    );
  });

  it("rejects unsafe browser protocols", async () => {
    const { service } = createHarness();
    const tabId = service.getSnapshot().activeTabId;

    await expect(
      service.loadURL(tabId, "file:///tmp/private.txt"),
    ).rejects.toThrow("Unsupported browser URL protocol");

    expect(electronMocks.views).toHaveLength(0);
    expect(service.getSnapshot().tabs[0]).toMatchObject({
      status: "failed",
      url: "file:///tmp/private.txt",
    });
  });

  it("selects the right neighbor, then the left, and always keeps a home tab", () => {
    const { service } = createHarness();
    const first = service.getSnapshot().activeTabId;
    const second = service.createTab().id;
    const third = service.createTab().id;

    service.activateTab(second);
    expect(service.closeTab(second).activeTabId).toBe(third);
    expect(service.closeTab(third).activeTabId).toBe(first);
    const replacement = service.closeTab(first);

    expect(replacement.tabs).toHaveLength(1);
    expect(replacement.tabs[0].mode).toBe("home");
    expect(replacement.tabs[0].id).not.toBe(first);
  });

  it("opens page popups in a new managed tab", async () => {
    const { service } = createHarness();
    const first = service.getSnapshot().activeTabId;
    await service.loadURL(first, "https://example.com");

    const result = electronMocks.views[0].webContents.triggerWindowOpen(
      "https://example.com/popup",
    );

    expect(result).toMatchObject({ action: "allow", outlivesOpener: true });
    expect(electronMocks.views).toHaveLength(1);
    expect(result?.createWindow({ webPreferences: { sandbox: true } })).toBe(
      electronMocks.views[1].webContents,
    );
    expect(service.getSnapshot().tabs).toHaveLength(2);
    expect(service.getSnapshot().tabs[1].url).toBe("https://example.com/popup");
    expect(electronMocks.views[1].webContents.loadURL).not.toHaveBeenCalled();
    expect(
      electronMocks.views[1].webContents.setUserAgent,
    ).toHaveBeenCalledWith(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/150.0.7871.129 Safari/537.36",
    );
  });

  it("keeps background-tab popups in the background", async () => {
    const { service } = createHarness();
    const first = service.getSnapshot().activeTabId;
    await service.loadURL(first, "https://example.com");

    const result = electronMocks.views[0].webContents.triggerWindowOpen(
      "https://example.com/background",
      "background-tab",
    );

    expect(result).toMatchObject({ action: "allow" });
    expect(electronMocks.views).toHaveLength(1);
    expect(result?.createWindow({})).toBe(electronMocks.views[1].webContents);
    expect(service.getSnapshot().activeTabId).toBe(first);
    expect(service.getSnapshot().tabs).toHaveLength(2);
    expect(electronMocks.views[1].webContents.loadURL).toHaveBeenCalledWith(
      "https://example.com/background",
    );
  });

  it("opens safe external protocols outside the embedded browser", async () => {
    const { service } = createHarness();
    const tabId = service.getSnapshot().activeTabId;
    await service.loadURL(tabId, "https://example.com");

    const result = electronMocks.views[0].webContents.triggerWindowOpen(
      "mailto:hello@example.com",
    );

    expect(result).toEqual({ action: "deny" });
    expect(electronMocks.openExternal).toHaveBeenCalledWith(
      "mailto:hello@example.com",
    );
    expect(service.getSnapshot().tabs).toHaveLength(1);
  });

  it("blocks non-web top-level navigation and delegates safe protocols", async () => {
    const { service } = createHarness();
    const tabId = service.getSnapshot().activeTabId;
    await service.loadURL(tabId, "https://example.com");
    const view = electronMocks.views[0];
    const mailEvent = {
      preventDefault: vi.fn(),
      url: "mailto:hello@example.com",
    };
    const fileEvent = {
      preventDefault: vi.fn(),
      url: "file:///tmp/private.txt",
    };
    const webEvent = {
      preventDefault: vi.fn(),
      url: "https://example.com/next",
    };

    view.webContents.emit("will-navigate", mailEvent);
    view.webContents.emit("will-navigate", fileEvent);
    view.webContents.emit("will-navigate", webEvent);

    expect(mailEvent.preventDefault).toHaveBeenCalledOnce();
    expect(fileEvent.preventDefault).toHaveBeenCalledOnce();
    expect(webEvent.preventDefault).not.toHaveBeenCalled();
    expect(electronMocks.openExternal).toHaveBeenCalledWith(
      "mailto:hello@example.com",
    );
    expect(electronMocks.openExternal).not.toHaveBeenCalledWith(
      "file:///tmp/private.txt",
    );
  });

  it("keeps Google authentication popups in the managed browser session and restores the opener", async () => {
    const { service, sniffingHelper } = createHarness();
    const first = service.getSnapshot().activeTabId;
    await service.loadURL(first, "https://x.com/i/flow/login");

    const authURL = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x";
    const result =
      electronMocks.views[0].webContents.triggerWindowOpen(authURL);
    const pendingWebContents = { id: "google-auth-popup" };

    expect(result).toMatchObject({ action: "allow", outlivesOpener: true });
    expect(electronMocks.views).toHaveLength(1);
    expect(
      result?.createWindow({
        webContents: pendingWebContents,
        webPreferences: {
          partition: "untrusted-partition",
          preload: "/untrusted-preload.cjs",
          contextIsolation: false,
          nodeIntegration: true,
          webSecurity: false,
          sandbox: false,
        },
      }),
    ).toBe(electronMocks.views[1].webContents);
    expect(electronMocks.openExternal).not.toHaveBeenCalled();
    expect(service.getSnapshot().tabs).toHaveLength(2);
    expect(service.getSnapshot().tabs[1].url).toBe(authURL);
    expect(electronMocks.views[1].constructorOptions).toMatchObject({
      webContents: pendingWebContents,
      webPreferences: {
        partition: "persist:webview",
        preload: "/tmp/preload.cjs",
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        sandbox: true,
      },
    });
    expect(electronMocks.views.map((view) => view.partition)).toEqual([
      "persist:webview",
      "persist:webview",
    ]);

    const popupTabId = service.getSnapshot().tabs[1].id;
    electronMocks.views[1].webContents.emit("destroyed");

    expect(sniffingHelper.unregister).toHaveBeenCalledWith(popupTabId);
    expect(service.getSnapshot()).toMatchObject({
      activeTabId: first,
      tabs: [
        {
          errorCode: undefined,
          id: first,
          url: "https://x.com/i/flow/login",
        },
      ],
    });
  });

  it("reparents the active view when the browser window changes", async () => {
    const { browserWindow, browserNativeWindow, mainNativeWindow, service } =
      createHarness();
    const tabId = service.getSnapshot().activeTabId;
    await service.loadURL(tabId, "https://example.com");
    service.setBounds(tabId, { x: 0, y: 0, width: 800, height: 500 });
    const view = electronMocks.views[0];

    browserWindow.window = browserNativeWindow;
    service.reparentActiveView();

    expect(mainNativeWindow.contentView.removeChildView).toHaveBeenCalledWith(
      view,
    );
    expect(browserNativeWindow.contentView.addChildView).toHaveBeenCalledWith(
      view,
    );
  });

  it("scopes navigation and source events to a tab without persisting headers", async () => {
    const { mainNativeWindow, service, sniffingHelper } = createHarness();
    const tabId = service.getSnapshot().activeTabId;
    await service.loadURL(tabId, "https://example.com/video");
    service.setBounds(tabId, { x: 0, y: 0, width: 800, height: 500 });
    const view = electronMocks.views[0];

    view.webContents.emit("dom-ready");
    const onSource = sniffingHelper.on.mock.calls.find(
      ([event]) => event === "source",
    )?.[1];
    const source = {
      documentURL: "https://example.com/video",
      headers: "Cookie: private\nReferer: https://example.com/video",
      name: "video.mp4",
      type: DownloadType.direct,
      url: "https://cdn.example.com/video.mp4",
    };
    await onSource({
      tabId,
      source,
    });

    expect(mainNativeWindow.webContents.send).toHaveBeenCalledWith(
      IpcEvent.browser.domReady,
      expect.objectContaining({ tabId }),
    );
    expect(mainNativeWindow.webContents.send).toHaveBeenCalledWith(
      IpcEvent.browser.sourceDetected,
      expect.objectContaining({
        tabId,
        source: expect.objectContaining({
          headers: "Referer: https://example.com/video",
        }),
      }),
    );
    expect(source.headers).toBe(
      "Cookie: private\nReferer: https://example.com/video",
    );
    expect(
      electronMocks.sessions.get("persist:webview")?.cookies.get,
    ).not.toHaveBeenCalled();
    const detectedPayload = mainNativeWindow.webContents.send.mock.calls.find(
      ([event]) => event === IpcEvent.browser.sourceDetected,
    )?.[1];
    expect(JSON.stringify(detectedPayload)).not.toContain("Cookie: private");
    expect(JSON.stringify(service.getSnapshot())).not.toContain("Cookie");

    service.restoreSnapshot({
      ...service.getSnapshot(),
      tabs: [
        {
          ...service.getSnapshot().tabs[0],
          sources: [
            {
              documentURL: "https://example.com/video",
              headers: "Authorization: private",
              id: 1,
              name: "video.mp4",
              type: DownloadType.direct,
              url: "https://cdn.example.com/video.mp4",
            },
          ],
        },
      ],
    } as never);
    expect(JSON.stringify(service.getSnapshot())).not.toContain(
      "Authorization",
    );
  });

  it("does not read or publish session cookies in a default sniff event", async () => {
    const { mainNativeWindow, service, sniffingHelper } = createHarness();
    const tabId = service.getSnapshot().activeTabId;
    await service.loadURL(tabId, "https://www.youtube.com/watch?v=fixture");
    const targetSession = electronMocks.sessions.get("persist:webview");
    targetSession?.cookies.get.mockResolvedValue([
      { name: "closure_cookie", value: "default-sniff-secret" },
    ]);
    const source = {
      documentURL: "https://www.youtube.com/watch?v=fixture",
      headers: "Accept: video/mp4\nAuthorization: Bearer source-auth-secret",
      name: "fixture.mp4",
      type: DownloadType.youtube,
      url: "https://cdn.youtube.com/fixture.mp4",
    };
    const onSource = sniffingHelper.on.mock.calls.find(
      ([event]) => event === "source",
    )?.[1];
    await onSource({ tabId, source });

    const detectedPayload = mainNativeWindow.webContents.send.mock.calls.find(
      ([event]) => event === IpcEvent.browser.sourceDetected,
    )?.[1];
    expect(targetSession?.cookies.get).not.toHaveBeenCalled();
    expect(source.headers).toBe(
      "Accept: video/mp4\nAuthorization: Bearer source-auth-secret",
    );
    expect(detectedPayload).toEqual(
      expect.objectContaining({
        tabId,
        source: expect.objectContaining({
          headers: "Accept: video/mp4",
        }),
      }),
    );
    expect(JSON.stringify(detectedPayload)).not.toContain("source-auth-secret");
    expect(JSON.stringify(detectedPayload)).not.toContain(
      "default-sniff-secret",
    );
  });

  it("tracks main-frame navigation and clears resources from the previous page", async () => {
    const { service, sniffingHelper } = createHarness();
    const tabId = service.getSnapshot().activeTabId;
    await service.loadURL(tabId, "https://example.com/first");
    const view = electronMocks.views[0];
    view.webContents.emit("did-stop-loading");
    view.webContents.emit("page-favicon-updated", {}, [
      "https://example.com/favicon.ico",
    ]);
    const onSource = sniffingHelper.on.mock.calls.find(
      ([event]) => event === "source",
    )?.[1];
    await onSource({
      tabId,
      source: {
        documentURL: "https://example.com/first",
        name: "first.mp4",
        type: DownloadType.direct,
        url: "https://cdn.example.com/first.mp4",
      },
    });

    view.webContents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
      url: "https://example.com/second",
    });

    let tab = service.getSnapshot().tabs[0];
    expect(tab).toMatchObject({
      status: "loading",
      url: "https://example.com/second",
      sources: [],
    });
    expect(tab.favicon).toBeUndefined();

    view.webContents.setURL("https://example.com/second");
    view.webContents.setTitle("Second page");
    view.webContents.emit("did-navigate");
    expect(service.getSnapshot().tabs[0].status).toBe("loading");
    view.webContents.emit("did-stop-loading");
    tab = service.getSnapshot().tabs[0];
    expect(tab).toMatchObject({
      status: "loaded",
      title: "Second page",
      url: "https://example.com/second",
    });
  });

  it("injects the page plugin inside an isolated function scope", async () => {
    const { service } = createHarness();
    const tabId = service.getSnapshot().activeTabId;
    await service.loadURL(tabId, "https://www.douyin.com/jingxuan");
    const view = electronMocks.views[0];

    view.webContents.emit("did-navigate");

    await vi.waitFor(() =>
      expect(view.webContents.executeJavaScript).toHaveBeenCalledWith(
        "(() => {\nconst mediagoPagePlugin = true;\n})()",
      ),
    );
  });

  it("logs page plugin injection failures", async () => {
    const { logger, service } = createHarness();
    const tabId = service.getSnapshot().activeTabId;
    await service.loadURL(tabId, "https://www.douyin.com/jingxuan");
    const view = electronMocks.views[0];
    const injectionError = new Error("identifier collision");
    view.webContents.executeJavaScript.mockRejectedValueOnce(injectionError);

    view.webContents.emit("did-navigate");

    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith(
        "[BrowserTab] page plugin injection failed",
        injectionError,
      ),
    );
  });

  it("preserves the favicon when reloading the current page", async () => {
    const { service } = createHarness();
    const tabId = service.getSnapshot().activeTabId;
    await service.loadURL(tabId, "https://www.baidu.com/");
    const view = electronMocks.views[0];
    view.webContents.emit("did-stop-loading");
    view.webContents.emit("page-favicon-updated", {}, [
      "https://www.baidu.com/favicon.ico",
    ]);

    await service.reload(tabId);
    view.webContents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
      url: "https://www.baidu.com/",
    });
    view.webContents.emit("did-stop-loading");

    expect(service.getSnapshot().tabs[0]).toMatchObject({
      favicon: "https://www.baidu.com/favicon.ico",
      status: "loaded",
      url: "https://www.baidu.com/",
    });
  });

  it("ignores subframe and cancelled load failures", async () => {
    const { service } = createHarness();
    const tabId = service.getSnapshot().activeTabId;
    await service.loadURL(tabId, "https://example.com");
    const view = electronMocks.views[0];
    view.webContents.emit("did-stop-loading");

    view.webContents.emit(
      "did-fail-load",
      {},
      -105,
      "NAME_NOT_RESOLVED",
      "https://iframe.example.invalid",
      false,
    );
    view.webContents.emit(
      "did-fail-load",
      {},
      -3,
      "ABORTED",
      "https://example.com",
      true,
    );
    expect(service.getSnapshot().tabs[0].status).toBe("loaded");

    view.webContents.emit(
      "did-fail-load",
      {},
      -105,
      "NAME_NOT_RESOLVED",
      "https://failed.example.invalid",
      true,
    );
    expect(service.getSnapshot().tabs[0]).toMatchObject({
      errorCode: -105,
      status: "failed",
      url: "https://failed.example.invalid",
    });
  });

  it("ignores in-page navigation events from subframes", async () => {
    const { service, sniffingHelper } = createHarness();
    const tabId = service.getSnapshot().activeTabId;
    await service.loadURL(tabId, "https://example.com/main");
    const view = electronMocks.views[0];
    const updatesBefore = sniffingHelper.update.mock.calls.length;

    view.webContents.emit(
      "did-navigate-in-page",
      {},
      "https://iframe.example.com/#next",
      false,
    );

    expect(service.getSnapshot().tabs[0].url).toBe("https://example.com/main");
    expect(sniffingHelper.update).toHaveBeenCalledTimes(updatesBefore);
  });

  it("turns renderer crashes into a recoverable tab failure", async () => {
    const { service } = createHarness();
    const tabId = service.getSnapshot().activeTabId;
    await service.loadURL(tabId, "https://example.com");
    const crashedView = electronMocks.views[0];

    crashedView.webContents.emit(
      "render-process-gone",
      {},
      {
        exitCode: 1,
        reason: "crashed",
      },
    );

    expect(service.getSnapshot().tabs[0]).toMatchObject({
      errorCode: -1000,
      status: "failed",
    });
    expect(crashedView.webContents.close).toHaveBeenCalledOnce();

    await service.loadURL(tabId, "https://example.com/recovered");
    expect(electronMocks.views).toHaveLength(2);
    expect(service.getSnapshot().tabs[0]).toMatchObject({
      status: "loading",
      url: "https://example.com/recovered",
    });
  });

  it("releases unexpectedly destroyed web contents", async () => {
    const { service, sniffingHelper } = createHarness();
    const tabId = service.getSnapshot().activeTabId;
    await service.loadURL(tabId, "https://example.com");

    electronMocks.views[0].webContents.emit("destroyed");

    expect(sniffingHelper.unregister).toHaveBeenCalledWith(tabId);
    expect(service.getSnapshot().tabs[0]).toMatchObject({
      errorCode: -1001,
      status: "failed",
    });
    await service.loadURL(tabId, "https://example.com/recovered");
    expect(electronMocks.views).toHaveLength(2);
  });

  it("keeps Agent discovery views hidden and destroys them after collection", async () => {
    const collection = deferred<{ sources: []; partial: boolean }>();
    const { mainNativeWindow, service, sniffingHelper } = createHarness();
    sniffingHelper.collectAgent.mockReturnValue(collection.promise);
    const controller = new AbortController();
    const result = service.discover(
      discoveryRequest("job-hidden"),
      controller.signal,
    );

    await vi.waitFor(() => expect(sniffingHelper.register).toHaveBeenCalled());
    expect(sniffingHelper.collectAgent).toHaveBeenCalledWith(
      "agent-job-hidden",
      expect.objectContaining({ timeoutMs: 19_750 }),
    );
    const registration = sniffingHelper.register.mock.calls[0][0];
    expect(registration.kind).toBe("agent");
    expect(registration.partition).toBe("agent-job-hidden");
    expect(mainNativeWindow.contentView.addChildView).not.toHaveBeenCalled();

    collection.resolve({ sources: [], partial: false });
    await expect(result).resolves.toEqual({ sources: [], partial: false });
    expect(sniffingHelper.unregister).toHaveBeenCalledWith("agent-job-hidden");
    expect(electronMocks.views[0].webContents.close).toHaveBeenCalledOnce();
  });

  it("cancels and cleans up a running Agent discovery", async () => {
    const collection = deferred<{ sources: []; partial: boolean }>();
    const { service, sniffingHelper } = createHarness();
    sniffingHelper.collectAgent.mockReturnValue(collection.promise);
    sniffingHelper.cancelAgent.mockImplementation((tabId: string) => {
      collection.reject(
        new AgentCollectionError("discovery_cancelled", `cancelled ${tabId}`),
      );
    });
    const result = service.discover(
      discoveryRequest("job-cancel"),
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(sniffingHelper.register).toHaveBeenCalled());

    await service.cancel("job-cancel");

    await expect(result).rejects.toMatchObject({
      errorCode: "discovery_cancelled",
    });
    expect(sniffingHelper.cancelAgent).toHaveBeenCalledWith("agent-job-cancel");
    expect(sniffingHelper.unregister).toHaveBeenCalledWith("agent-job-cancel");
  });

  it("propagates runtime configuration and closes every view on destroy", async () => {
    const { discoveryExecutor, service } = createHarness();
    const first = service.getSnapshot().activeTabId;
    await service.loadURL(first, "https://example.com/first");
    const second = service.createTab().id;
    await service.loadURL(second, "https://example.com/second");

    service.setAudioMuted(true);
    service.setDeviceMode(first, true);
    service.setProxy(true, "http://127.0.0.1:7890");
    service.destroy();

    for (const view of electronMocks.views) {
      expect(view.webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
      expect(view.webContents.close).toHaveBeenCalledOnce();
    }
    expect(discoveryExecutor.setBrowser).toHaveBeenLastCalledWith(null);
  });

  it("uses a Chrome-compatible desktop UA and a centered mobile viewport", async () => {
    const { service } = createHarness();
    const tabId = service.getSnapshot().activeTabId;
    await service.loadURL(tabId, "https://x.com");
    service.setBounds(tabId, { x: 10, y: 20, width: 900, height: 600 });
    const view = electronMocks.views[0];
    const webContents = electronMocks.views[0].webContents;

    expect(webContents.setUserAgent).toHaveBeenNthCalledWith(
      1,
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/150.0.7871.129 Safari/537.36",
    );

    service.setDeviceMode(tabId, true);
    service.setDeviceMode(tabId, false);

    expect(webContents.setUserAgent).toHaveBeenNthCalledWith(
      2,
      "mobile-user-agent",
    );
    expect(webContents.setUserAgent).toHaveBeenNthCalledWith(
      3,
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/150.0.7871.129 Safari/537.36",
    );
    expect(view.setBounds).toHaveBeenNthCalledWith(2, {
      x: 254,
      y: 20,
      width: 412,
      height: 600,
    });
    expect(view.setBounds).toHaveBeenNthCalledWith(3, {
      x: 10,
      y: 20,
      width: 900,
      height: 600,
    });
    expect(webContents.enableDeviceEmulation).not.toHaveBeenCalled();
    expect(webContents.disableDeviceEmulation).not.toHaveBeenCalled();
    expect(webContents.reloadIgnoringCache).toHaveBeenCalledTimes(2);
    expect(service.getSnapshot().tabs[0].isMobile).toBe(false);
  });

  it("keeps device mode isolated per tab", async () => {
    const { service } = createHarness();
    const first = service.getSnapshot().activeTabId;
    await service.loadURL(first, "https://example.com/first");
    const second = service.createTab().id;
    await service.loadURL(second, "https://example.com/second");

    service.setDeviceMode(first, true);

    const snapshot = service.getSnapshot();
    expect(snapshot.tabs.find((tab) => tab.id === first)?.isMobile).toBe(true);
    expect(snapshot.tabs.find((tab) => tab.id === second)?.isMobile).toBe(
      false,
    );
    expect(
      electronMocks.views[0].webContents.setUserAgent,
    ).toHaveBeenLastCalledWith("mobile-user-agent");
    expect(
      electronMocks.views[1].webContents.setUserAgent,
    ).not.toHaveBeenCalledWith("mobile-user-agent");
    expect(
      electronMocks.views[0].webContents.enableDeviceEmulation,
    ).not.toHaveBeenCalled();
    expect(
      electronMocks.views[1].webContents.enableDeviceEmulation,
    ).not.toHaveBeenCalled();
    expect(
      electronMocks.views[0].webContents.reloadIgnoringCache,
    ).toHaveBeenCalledOnce();
    expect(
      electronMocks.views[1].webContents.reloadIgnoringCache,
    ).not.toHaveBeenCalled();
  });

  it("rolls back the tab when its user agent cannot be changed", async () => {
    const { service } = createHarness();
    const tabId = service.getSnapshot().activeTabId;
    await service.loadURL(tabId, "https://example.com");
    const webContents = electronMocks.views[0].webContents;
    webContents.setUserAgent.mockImplementationOnce(() => {
      throw new Error("user agent failed");
    });

    expect(() => service.setDeviceMode(tabId, true)).toThrow(
      "user agent failed",
    );

    expect(service.getSnapshot().tabs[0]).toMatchObject({
      isMobile: false,
      status: "loading",
    });
    expect(webContents.setUserAgent).toHaveBeenLastCalledWith(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/150.0.7871.129 Safari/537.36",
    );
    expect(webContents.enableDeviceEmulation).not.toHaveBeenCalled();
    expect(webContents.disableDeviceEmulation).not.toHaveBeenCalled();
    expect(webContents.reloadIgnoringCache).not.toHaveBeenCalled();
  });

  it("does not mutate device state after the tab contents are destroyed", async () => {
    const { service } = createHarness();
    const tabId = service.getSnapshot().activeTabId;
    await service.loadURL(tabId, "https://example.com");
    const webContents = electronMocks.views[0].webContents;
    webContents.isDestroyed.mockReturnValue(true);

    expect(() => service.setDeviceMode(tabId, true)).toThrow(
      "Browser tab contents were destroyed",
    );

    expect(service.getSnapshot().tabs[0].isMobile).toBe(false);
    expect(webContents.reloadIgnoringCache).not.toHaveBeenCalled();
  });

  it("safely loads a favorite when mobile mode and bounds precede runtime creation", async () => {
    const { mainNativeWindow, service } = createHarness({ isMobile: true });
    const tabId = service.getSnapshot().activeTabId;
    service.setBounds(tabId, { x: 0, y: 80, width: 1000, height: 700 });

    await service.loadURL(tabId, "https://example.com/mobile");

    expect(service.getSnapshot().tabs[0].isMobile).toBe(true);
    expect(mainNativeWindow.contentView.addChildView).toHaveBeenCalledWith(
      electronMocks.views[0],
    );
    expect(
      mainNativeWindow.contentView.addChildView.mock.invocationCallOrder[0],
    ).toBeLessThan(
      electronMocks.views[0].setBounds.mock.invocationCallOrder[0],
    );
    expect(electronMocks.views[0].setBounds).toHaveBeenCalledWith({
      x: 294,
      y: 80,
      width: 412,
      height: 700,
    });
    expect(
      electronMocks.views[0].webContents.setUserAgent,
    ).toHaveBeenCalledWith("mobile-user-agent");
    expect(
      electronMocks.views[0].webContents.enableDeviceEmulation,
    ).not.toHaveBeenCalled();
    expect(
      electronMocks.views[0].webContents.disableDeviceEmulation,
    ).not.toHaveBeenCalled();
  });

  it("reloads only the active browser view while it is visible", async () => {
    const { service } = createHarness();
    const tabId = service.getSnapshot().activeTabId;
    await service.loadURL(tabId, "https://example.com");
    const webContents = electronMocks.views[0].webContents;
    service.setBounds(tabId, { x: 0, y: 80, width: 900, height: 600 });
    webContents.emit("did-stop-loading");

    expect(service.reloadActiveVisibleTab()).toBe(true);
    expect(webContents.reload).toHaveBeenCalledOnce();
    expect(service.getSnapshot().tabs[0].status).toBe("loading");

    service.hide(tabId);

    expect(service.reloadActiveVisibleTab()).toBe(false);
    expect(webContents.reload).toHaveBeenCalledOnce();
  });

  it("keeps refresh shortcuts inside the focused browser view", async () => {
    const { service } = createHarness();
    const tabId = service.getSnapshot().activeTabId;
    await service.loadURL(tabId, "https://example.com");
    const webContents = electronMocks.views[0].webContents;
    const event = { preventDefault: vi.fn() };

    webContents.emit("before-input-event", event, {
      alt: false,
      control: false,
      key: "r",
      meta: true,
      shift: true,
      type: "keyDown",
    });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(webContents.reloadIgnoringCache).toHaveBeenCalledOnce();
    expect(webContents.reload).not.toHaveBeenCalled();
  });

  it("uses the operating system proxy when manual proxy is disabled", () => {
    createHarness();

    expect(
      electronMocks.sessions.get("persist:webview")?.setProxy,
    ).toHaveBeenCalledWith({ mode: "system" });
  });

  it("adds current X session cookies to an explicit yt-dlp task", async () => {
    const { service } = createHarness();
    const tabId = service.getSnapshot().activeTabId;
    await service.loadURL(tabId, "https://x.com/openai/status/1234567890");
    const targetSession = electronMocks.sessions.get("persist:webview");
    targetSession?.cookies.get.mockResolvedValue([
      { name: "auth_token", value: "session-token" },
      { name: "ct0", value: "csrf-token" },
    ]);

    const result = await service.withSessionCookies(tabId, {
      headers: "Referer:https://x.com/",
      type: DownloadType.youtube,
      url: "https://x.com/openai/status/1234567890",
    });

    expect(targetSession?.cookies.get).toHaveBeenCalledWith({
      url: "https://x.com",
    });
    expect(result.headers).toContain("Referer:https://x.com/");
    expect(result.headers).toContain(
      "Cookie:auth_token=session-token; ct0=csrf-token",
    );
  });

  it("does not attach browser cookies to an unrelated yt-dlp URL", async () => {
    const { service } = createHarness();
    const tabId = service.getSnapshot().activeTabId;

    const result = await service.withSessionCookies(tabId, {
      type: DownloadType.youtube,
      url: "https://example.com/video/1",
    });

    expect(result.headers).toBeUndefined();
    expect(
      electronMocks.sessions.get("persist:webview")?.cookies.get,
    ).not.toHaveBeenCalled();
  });

  it.each([
    {
      cookieURL: "https://www.tiktok.com",
      name: "sessionid",
      url: "https://www.tiktok.com/@creator/video/7480123456789012345",
      type: DownloadType.youtube,
    },
    {
      cookieURL: "https://www.douyin.com",
      name: "s_v_web_id",
      url: "https://www.douyin.com/video/7480123456789012345",
      type: DownloadType.youtube,
    },
    {
      cookieURL: "https://www.xiaohongshu.com",
      name: "web_session",
      url: "https://www.xiaohongshu.com/explore/66f00abc1234567890abcdef?xsec_token=token",
      type: DownloadType.xiaohongshu,
    },
  ])("adds current $cookieURL cookies to explicit downloads", async (test) => {
    const { service } = createHarness();
    const tabId = service.getSnapshot().activeTabId;
    const targetSession = electronMocks.sessions.get("persist:webview");
    targetSession?.cookies.get.mockResolvedValue([
      { name: test.name, value: "short-video-session" },
    ]);

    const result = await service.withSessionCookies(tabId, {
      type: test.type,
      url: test.url,
    });

    expect(targetSession?.cookies.get).toHaveBeenCalledWith({
      url: test.cookieURL,
    });
    expect(result.headers).toBe(`Cookie:${test.name}=short-video-session`);
  });
});

function createHarness(
  storeOverrides: Partial<{
    audioMuted: boolean;
    blockAds: boolean;
    isMobile: boolean;
    privacy: boolean;
    proxy: string;
    useProxy: boolean;
  }> = {},
) {
  const mainNativeWindow = createNativeWindow();
  const browserNativeWindow = createNativeWindow();
  const mainWindow = { window: mainNativeWindow };
  const browserWindow: {
    window: ReturnType<typeof createNativeWindow> | null;
  } = {
    window: null,
  };
  const logger = { error: vi.fn(), info: vi.fn() };
  const store = {
    audioMuted: false,
    blockAds: false,
    isMobile: false,
    privacy: false,
    proxy: "",
    useProxy: false,
    ...storeOverrides,
  };
  const configCache = {
    get: vi.fn((key: keyof typeof store) => store[key]),
    store,
  };
  const sniffingHelper = {
    cancelAgent: vi.fn(),
    checkPageInfo: vi.fn(),
    collectAgent: vi.fn(),
    failAgent: vi.fn(),
    getPageHeaders: vi.fn(),
    markDomReady: vi.fn(),
    off: vi.fn(),
    on: vi.fn(),
    pluginReady: vi.fn(),
    register: vi.fn(),
    unregister: vi.fn(),
    update: vi.fn(),
  };
  const discoveryExecutor = { setBrowser: vi.fn() };
  const service = new BrowserTabManagerService(
    mainWindow as never,
    logger as never,
    browserWindow as never,
    configCache as never,
    sniffingHelper as never,
    discoveryExecutor as never,
  );
  return {
    browserNativeWindow,
    browserWindow,
    discoveryExecutor,
    mainNativeWindow,
    logger,
    service,
    sniffingHelper,
    store,
  };
}

function createNativeWindow() {
  return {
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
    isDestroyed: vi.fn(() => false),
    webContents: { send: vi.fn() },
  };
}

function createMockSession() {
  return {
    clearCache: vi.fn(async () => undefined),
    clearStorageData: vi.fn(async () => undefined),
    cookies: { get: vi.fn(async () => []) },
    setProxy: vi.fn(async () => undefined),
  };
}

function discoveryRequest(discoveryId: string) {
  return {
    type: "discovery-requested" as const,
    discoveryId,
    input: {
      url: "https://example.com/private",
      mode: "browser" as const,
      timeoutMs: 20_000,
      useSessionCookies: false,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
