import { DownloadType, IPC } from "@mediago/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async () => undefined),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  webUtils: { getPathForFile: vi.fn(() => "/tmp/file") },
}));

const { electronApi, getPreloadExposure, createRemoteBrowserApi } =
  await import("./index");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Electron preload tab API", () => {
  it("keeps resource search in the trusted app and maps its IPC calls", async () => {
    expect(createRemoteBrowserApi()).not.toHaveProperty("resourceSearch");
    const providers = [
      {
        id: "example",
        name: "测试来源",
        apiUrl: "https://example.com/api",
        enabled: true,
      },
    ];
    await electronApi.resourceSearch.listProviders();
    await electronApi.resourceSearch.saveProviders(providers);
    await electronApi.resourceSearch.search("动画", 2);
    await electronApi.resourceSearch.cancel();
    expect(electronMocks.invoke.mock.calls).toEqual([
      [IPC.resourceSearch.listProviders],
      [IPC.resourceSearch.saveProviders, providers],
      [IPC.resourceSearch.search, "动画", 2],
      [IPC.resourceSearch.cancel],
    ]);
  });

  it("gives remote top frames only the page-plugin bridge", async () => {
    expect(
      getPreloadExposure(
        "https://media.example/watch",
        true,
        false,
        "xiangying",
      ),
    ).toBe("remote-browser");
    expect(
      getPreloadExposure(
        "http://localhost:8500/browser",
        true,
        true,
        "xiangying",
      ),
    ).toBe("trusted-app");
    expect(
      getPreloadExposure(
        "http://localhost.evil:8500/",
        true,
        true,
        "xiangying",
      ),
    ).toBe("remote-browser");
    expect(
      getPreloadExposure(
        "https://media.example/frame",
        false,
        false,
        "xiangying",
      ),
    ).toBe("none");

    const remoteApi = createRemoteBrowserApi();
    expect(Object.keys(remoteApi)).toEqual(["browser"]);
    expect(Object.keys(remoteApi.browser)).toEqual(["showDownloadDialog"]);
    await remoteApi.browser.showDownloadDialog([
      {
        name: "video",
        url: "https://media.example/video.mp4",
        type: DownloadType.direct,
      },
    ]);
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC.browser.showDownloadDialog,
      [
        {
          name: "video",
          url: "https://media.example/video.mp4",
          type: DownloadType.direct,
        },
      ],
    );
  });

  it("exposes tab lifecycle commands", async () => {
    await electronApi.browser.createTab({ url: "https://example.com" });
    await electronApi.browser.activateTab("tab-a");
    await electronApi.browser.closeTab("tab-a");
    await electronApi.browser.getTabs();

    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      1,
      IPC.browser.createTab,
      { url: "https://example.com" },
    );
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      2,
      IPC.browser.activateTab,
      "tab-a",
    );
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      3,
      IPC.browser.closeTab,
      "tab-a",
    );
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      4,
      IPC.browser.getTabs,
    );
  });

  it("sends tab ids with browser operations while retaining legacy calls", async () => {
    await electronApi.browser.loadURL("tab-a", "https://example.com/a");
    await electronApi.browser.setBounds("tab-a", {
      x: 0,
      y: 1,
      width: 2,
      height: 3,
    });
    await electronApi.browser.showDownloadDialog("tab-a", []);
    await electronApi.browser.loadURL("https://example.com/legacy");

    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      1,
      IPC.browser.loadURL,
      { tabId: "tab-a", url: "https://example.com/a" },
    );
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      2,
      IPC.browser.setBounds,
      {
        tabId: "tab-a",
        bounds: { x: 0, y: 1, width: 2, height: 3 },
      },
    );
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      3,
      IPC.browser.showDownloadDialog,
      { tabId: "tab-a", data: [] },
    );
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      4,
      IPC.browser.loadURL,
      { tabId: "", url: "https://example.com/legacy" },
    );
  });

  it("maps the trusted library API to library IPC channels", async () => {
    await electronApi.library.list();
    await electronApi.library.importFiles(["C:/video.mp4"], "import");
    await electronApi.library.update("item-1", { screened: true });
    await electronApi.library.remove("item-1");
    await electronApi.library.scan("item-1");
    await electronApi.library.play("item-1");
    await electronApi.library.reveal("item-1");
    await electronApi.library.exportFiles(["item-1"]);

    expect(electronMocks.invoke).toHaveBeenNthCalledWith(1, IPC.library.list);
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      2,
      IPC.library.importFiles,
      ["C:/video.mp4"],
      "import",
    );
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      3,
      IPC.library.update,
      "item-1",
      { screened: true },
    );
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      4,
      IPC.library.remove,
      "item-1",
    );
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      5,
      IPC.library.scan,
      "item-1",
    );
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      6,
      IPC.library.play,
      "item-1",
    );
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      7,
      IPC.library.reveal,
      "item-1",
    );
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      8,
      IPC.library.exportFiles,
      ["item-1"],
    );
  });
});
