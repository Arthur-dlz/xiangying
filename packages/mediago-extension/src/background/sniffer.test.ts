import { DownloadType } from "@mediago/common";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type {
  DetectedSource,
  PageContextChangedMessage,
} from "../shared/types";
import { inspectSources } from "./mediago-client";
import { registerSniffer } from "./sniffer";
import type { TabSourceService } from "./tab-sources";

vi.mock("./mediago-client", () => ({
  inspectSources: vi.fn(),
}));

type RequestListener = (
  details: chrome.webRequest.OnSendHeadersDetails,
) => unknown;
type UpdatedListener = (
  tabId: number,
  changeInfo: chrome.tabs.OnUpdatedInfo,
  tab: chrome.tabs.Tab,
) => unknown;
type RemovedListener = (tabId: number) => unknown;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settleAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function swallowReturnedRejection(value: unknown): void {
  if (value instanceof Promise) void value.catch(() => undefined);
}

function serviceDouble(): TabSourceService {
  return {
    pendingTabCount: 0,
    addSource: vi.fn(async () => []),
    addSources: vi.fn(async () => []),
    clear: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    ensureResolvedSource: vi.fn(),
  } as unknown as TabSourceService;
}

function installChromeDouble() {
  let requestListener: RequestListener | undefined;
  let updatedListener: UpdatedListener | undefined;
  let removedListener: RemovedListener | undefined;
  const sendMessage = vi.fn(async () => undefined);
  const storage = new Map<string, unknown>();

  vi.stubGlobal("chrome", {
    action: {
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setBadgeText: vi.fn(async () => undefined),
    },
    storage: {
      local: { get: vi.fn(async () => ({})) },
      session: {
        get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) {
            storage.set(key, value);
          }
        }),
        remove: vi.fn(async (key: string) => {
          storage.delete(key);
        }),
      },
    },
    tabs: {
      sendMessage,
      get: vi.fn(async (tabId: number) => ({
        id: tabId,
        url: "https://www.bilibili.com/video/BV1test",
        title: "Example page",
      })),
      onUpdated: {
        addListener: vi.fn((listener: UpdatedListener) => {
          updatedListener = listener;
        }),
      },
      onRemoved: {
        addListener: vi.fn((listener: RemovedListener) => {
          removedListener = listener;
        }),
      },
    },
    webRequest: {
      onSendHeaders: {
        addListener: vi.fn((listener: RequestListener) => {
          requestListener = listener;
        }),
      },
    },
  });

  return {
    sendMessage,
    requestListener: () => {
      if (!requestListener) throw new Error("request listener not registered");
      return requestListener;
    },
    updatedListener: () => {
      if (!updatedListener) throw new Error("updated listener not registered");
      return updatedListener;
    },
    removedListener: () => {
      if (!removedListener) throw new Error("removed listener not registered");
      return removedListener;
    },
  };
}

function tab(url: string): chrome.tabs.Tab {
  return { id: 11, url, title: "Video title", index: 0, pinned: false };
}

describe("registerSniffer source delegation", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("request and page detections add through TabSourceService", async () => {
    const extension = installChromeDouble();
    const service = serviceDouble();
    registerSniffer(service);

    extension.requestListener()({
      tabId: 11,
      requestId: "request-1",
      url: "https://cdn.example/video.mp4",
      initiator: "https://www.bilibili.com",
      requestHeaders: [{ name: "Referer", value: "https://example.com" }],
    } as chrome.webRequest.OnSendHeadersDetails);

    await vi.waitFor(() =>
      expect(service.addSource).toHaveBeenCalledWith(
        11,
        expect.objectContaining({
          url: "https://cdn.example/video.mp4",
          type: "direct",
        }),
      ),
    );

    await Promise.resolve(
      extension.updatedListener()(
        11,
        { status: "complete" },
        tab("https://www.bilibili.com/video/BV1test"),
      ),
    );

    expect(service.addSource).toHaveBeenCalledWith(
      11,
      expect.objectContaining({
        url: "https://www.bilibili.com/video/BV1test",
        type: "bilibili",
      }),
    );
  });

  test("ignores generic media requests on X pages in favor of tweet candidates", async () => {
    const extension = installChromeDouble();
    const service = serviceDouble();
    vi.mocked(chrome.tabs.get).mockResolvedValue({
      id: 11,
      url: "https://x.com/home",
      title: "Home / X",
      index: 0,
      pinned: false,
    });
    registerSniffer(service);

    extension.requestListener()({
      tabId: 11,
      requestId: "request-x-mp4",
      url: "https://video.twimg.com/ext_tw_video/example/video.mp4",
      initiator: "https://x.com",
    } as chrome.webRequest.OnSendHeadersDetails);
    extension.requestListener()({
      tabId: 11,
      requestId: "request-x-hls",
      url: "https://video.twimg.com/amplify_video/example/playlist.m3u8",
      initiator: "https://x.com",
    } as chrome.webRequest.OnSendHeadersDetails);

    await settleAsyncWork();

    expect(service.addSource).not.toHaveBeenCalled();
    expect(inspectSources).not.toHaveBeenCalled();
  });

  test("inspected request batches add through TabSourceService", async () => {
    vi.useFakeTimers();
    const extension = installChromeDouble();
    const service = serviceDouble();
    const inspected: DetectedSource = {
      id: "inspected-master",
      url: "https://cdn.example/master.m3u8",
      documentURL: "https://www.bilibili.com/video/BV1test",
      name: "Inspected master",
      type: DownloadType.m3u8,
      detectedAt: 123,
      mediaInfo: {
        status: "ready",
        playlistType: "master",
        variants: [],
      },
    };
    vi.mocked(inspectSources).mockResolvedValueOnce([inspected]);
    registerSniffer(service);

    extension.requestListener()({
      tabId: 15,
      requestId: "request-master",
      url: inspected.url,
      initiator: "https://www.bilibili.com",
    } as chrome.webRequest.OnSendHeadersDetails);

    await vi.advanceTimersByTimeAsync(150);

    expect(service.addSource).toHaveBeenCalledWith(
      15,
      expect.objectContaining({ url: inspected.url }),
    );
    expect(service.addSources).toHaveBeenCalledWith(15, [inspected]);
  });

  test("navigation sends PAGE_CONTEXT_CHANGED only after queued clear resolves", async () => {
    const extension = installChromeDouble();
    const service = serviceDouble();
    const clearGate = deferred();
    vi.mocked(service.clear).mockReturnValueOnce(clearGate.promise);
    registerSniffer(service);

    const navigation = Promise.resolve(
      extension.updatedListener()(
        12,
        { url: "https://www.youtube.com/watch?v=next" },
        tab("https://www.youtube.com/watch?v=next"),
      ),
    );

    await vi.waitFor(() => expect(service.clear).toHaveBeenCalledWith(12));
    expect(extension.sendMessage).not.toHaveBeenCalled();

    clearGate.resolve();
    await navigation;

    const message = {
      type: "PAGE_CONTEXT_CHANGED",
    } satisfies PageContextChangedMessage;
    expect(extension.sendMessage).toHaveBeenCalledWith(12, message);
  });

  test("a missing content receiver does not reject navigation handling", async () => {
    const extension = installChromeDouble();
    extension.sendMessage.mockRejectedValueOnce(new Error("no receiver"));
    const service = serviceDouble();
    registerSniffer(service);

    await expect(
      Promise.resolve(
        extension.updatedListener()(
          13,
          {
            url: "https://www.youtube.com/watch?v=next",
            status: "complete",
          },
          tab("https://www.youtube.com/watch?v=next"),
        ),
      ),
    ).resolves.toBeUndefined();

    expect(service.clear).toHaveBeenCalledWith(13);
    expect(extension.sendMessage).toHaveBeenCalledWith(13, {
      type: "PAGE_CONTEXT_CHANGED",
    });
    expect(service.addSource).toHaveBeenCalledWith(
      13,
      expect.objectContaining({
        url: "https://www.youtube.com/watch?v=next",
        type: "youtube",
      }),
    );
  });

  test("does not add an older page after a newer navigation has cleared the tab", async () => {
    const extension = installChromeDouble();
    const service = serviceDouble();
    const firstContextMessage = deferred();
    extension.sendMessage
      .mockImplementationOnce(() => firstContextMessage.promise)
      .mockResolvedValueOnce(undefined);
    registerSniffer(service);

    extension.updatedListener()(
      16,
      {
        url: "https://www.bilibili.com/video/BV1old",
        status: "complete",
      },
      tab("https://www.bilibili.com/video/BV1old"),
    );
    await vi.waitFor(() =>
      expect(extension.sendMessage).toHaveBeenCalledOnce(),
    );

    extension.updatedListener()(
      16,
      {
        url: "https://www.bilibili.com/video/BV1new",
        status: "complete",
      },
      tab("https://www.bilibili.com/video/BV1new"),
    );
    await vi.waitFor(() =>
      expect(service.addSource).toHaveBeenCalledWith(
        16,
        expect.objectContaining({
          url: "https://www.bilibili.com/video/BV1new",
        }),
      ),
    );

    firstContextMessage.resolve();
    await settleAsyncWork();

    expect(service.addSource).toHaveBeenCalledTimes(1);
    expect(service.addSource).not.toHaveBeenCalledWith(
      16,
      expect.objectContaining({
        url: "https://www.bilibili.com/video/BV1old",
      }),
    );
  });

  test("tab removal delegates cleanup to TabSourceService", async () => {
    const extension = installChromeDouble();
    const service = serviceDouble();
    registerSniffer(service);

    await Promise.resolve(extension.removedListener()(14));

    expect(service.remove).toHaveBeenCalledWith(14);
    expect(service.clear).not.toHaveBeenCalled();
  });

  test("reports request add failures from a synchronously returning listener", async () => {
    const extension = installChromeDouble();
    const service = serviceDouble();
    const error = new Error("request add failed");
    vi.mocked(service.addSource).mockRejectedValueOnce(error);
    const reportError = vi.fn();
    registerSniffer(service, reportError);

    const returned = extension.requestListener()({
      tabId: 31,
      requestId: "request-failure",
      url: "https://cdn.example/failure.mp4",
    } as chrome.webRequest.OnSendHeadersDetails);

    expect(returned).toBeUndefined();
    await settleAsyncWork();
    expect(reportError).toHaveBeenCalledWith("request detection", error);
  });

  test("reports inspection flush failures without leaking a timer rejection", async () => {
    vi.useFakeTimers();
    const extension = installChromeDouble();
    const service = serviceDouble();
    const error = new Error("inspection failed");
    vi.mocked(inspectSources).mockRejectedValueOnce(error);
    const reportError = vi.fn();
    registerSniffer(service, reportError);

    const returned = extension.requestListener()({
      tabId: 32,
      requestId: "inspection-failure",
      url: "https://cdn.example/failure.m3u8",
    } as chrome.webRequest.OnSendHeadersDetails);

    expect(returned).toBeUndefined();
    await vi.advanceTimersByTimeAsync(150);
    expect(reportError).toHaveBeenCalledWith("inspection flush", error);
  });

  test("reports navigation clear failures from a synchronously returning listener", async () => {
    const extension = installChromeDouble();
    const service = serviceDouble();
    const error = new Error("navigation clear failed");
    vi.mocked(service.clear).mockRejectedValueOnce(error);
    const reportError = vi.fn();
    registerSniffer(service, reportError);

    const returned = extension.updatedListener()(
      33,
      { url: "https://www.youtube.com/watch?v=failed" },
      tab("https://www.youtube.com/watch?v=failed"),
    );
    swallowReturnedRejection(returned);

    expect(returned).toBeUndefined();
    await settleAsyncWork();
    expect(reportError).toHaveBeenCalledWith("tab update", error);
  });

  test("reports page add failures from a synchronously returning listener", async () => {
    const extension = installChromeDouble();
    const service = serviceDouble();
    const error = new Error("page add failed");
    vi.mocked(service.addSource).mockRejectedValueOnce(error);
    const reportError = vi.fn();
    registerSniffer(service, reportError);

    const returned = extension.updatedListener()(
      34,
      { status: "complete" },
      tab("https://www.bilibili.com/video/BV1failed"),
    );
    swallowReturnedRejection(returned);

    expect(returned).toBeUndefined();
    await settleAsyncWork();
    expect(reportError).toHaveBeenCalledWith("tab update", error);
  });

  test("reports tab removal failures from a synchronously returning listener", async () => {
    const extension = installChromeDouble();
    const service = serviceDouble();
    const error = new Error("tab removal failed");
    vi.mocked(service.remove).mockRejectedValueOnce(error);
    const reportError = vi.fn();
    registerSniffer(service, reportError);

    const returned = extension.removedListener()(35);
    swallowReturnedRejection(returned);

    expect(returned).toBeUndefined();
    await settleAsyncWork();
    expect(reportError).toHaveBeenCalledWith("tab removal", error);
  });
});
