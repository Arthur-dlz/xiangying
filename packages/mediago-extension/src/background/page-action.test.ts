import { DownloadType } from "@mediago/common";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { DetectedSource } from "../shared/types";
import {
  createPageActionHandler,
  type PageActionHandler,
  type PageActionPorts,
} from "./page-action";
import {
  createTabSourceService,
  type TabSourceServicePorts,
} from "./tab-sources";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function detectedSource(
  id: string,
  url = `https://media.example/${id}.mp4`,
): DetectedSource {
  return {
    id,
    url,
    documentURL: "https://page.example/video",
    name: id,
    type: DownloadType.direct,
    detectedAt: 99,
  };
}

function memorySourceService(initial: DetectedSource[] = []) {
  let stored = initial;
  const badges: number[] = [];
  const ports: TabSourceServicePorts = {
    load: vi.fn(async () => stored),
    save: vi.fn(async (_tabId, sources) => {
      stored = sources;
    }),
    clear: vi.fn(async () => {
      stored = [];
    }),
    setBadgeCount: vi.fn(async (_tabId, count) => {
      badges.push(count);
    }),
  };
  return {
    service: createTabSourceService(ports),
    sources: () => stored,
    badges,
    ports,
  };
}

function supportedTab(
  overrides: Partial<chrome.tabs.Tab> = {},
): chrome.tabs.Tab {
  return {
    id: 41,
    index: 0,
    pinned: false,
    active: true,
    windowId: 7,
    url: "https://www.bilibili.com/video/BV1test",
    title: "Video title",
    ...overrides,
  };
}

function pageActionPorts(
  tabs: chrome.tabs.Tab[],
  overrides: Partial<PageActionPorts> = {},
): PageActionPorts & {
  getTab: ReturnType<typeof vi.fn>;
  openPopup: ReturnType<typeof vi.fn>;
  reportPopupOpenFailure: ReturnType<typeof vi.fn>;
} {
  return {
    runtimeId: "extension-id",
    getTab: vi.fn(async () => {
      const next = tabs.shift();
      if (!next) throw new Error("unexpected tab lookup");
      return next;
    }),
    openPopup: vi.fn(async () => undefined),
    reportPopupOpenFailure: vi.fn(),
    now: vi.fn(() => 1_234),
    ...overrides,
  };
}

function trustedSender(
  overrides: Partial<chrome.runtime.MessageSender> = {},
): chrome.runtime.MessageSender {
  return {
    id: "extension-id",
    frameId: 0,
    tab: supportedTab(),
    url: supportedTab().url,
    ...overrides,
  };
}

const BILIBILI_HOMEPAGE_URL = "https://www.bilibili.com/";
const YOUTUBE_HOMEPAGE_URL = "https://www.youtube.com/";
const TIKTOK_HOMEPAGE_URL = "https://www.tiktok.com/foryou";
const XIAOHONGSHU_FEED_URL = "https://www.xiaohongshu.com/explore";

function homepageTab(
  overrides: Partial<chrome.tabs.Tab> = {},
): chrome.tabs.Tab {
  return supportedTab({
    url: BILIBILI_HOMEPAGE_URL,
    title: "Bilibili homepage",
    ...overrides,
  });
}

function pageCandidate(
  overrides: Partial<{
    name: string;
    type: DownloadType;
    url: string;
  }> = {},
) {
  return {
    name: "Card title",
    url: "https://www.bilibili.com/video/BV1card",
    type: DownloadType.bilibili,
    ...overrides,
  };
}

function homepageSender(
  overrides: Partial<chrome.runtime.MessageSender> = {},
): chrome.runtime.MessageSender {
  return trustedSender({
    tab: homepageTab(),
    url: BILIBILI_HOMEPAGE_URL,
    ...overrides,
  });
}

function youtubeHomepageTab(
  overrides: Partial<chrome.tabs.Tab> = {},
): chrome.tabs.Tab {
  return supportedTab({
    url: YOUTUBE_HOMEPAGE_URL,
    title: "YouTube homepage",
    ...overrides,
  });
}

function youtubeHomepageSender(
  overrides: Partial<chrome.runtime.MessageSender> = {},
): chrome.runtime.MessageSender {
  return trustedSender({
    tab: youtubeHomepageTab(),
    url: YOUTUBE_HOMEPAGE_URL,
    ...overrides,
  });
}

function tiktokHomepageTab(
  overrides: Partial<chrome.tabs.Tab> = {},
): chrome.tabs.Tab {
  return supportedTab({
    url: TIKTOK_HOMEPAGE_URL,
    title: "TikTok feed",
    ...overrides,
  });
}

function tiktokHomepageSender(
  overrides: Partial<chrome.runtime.MessageSender> = {},
): chrome.runtime.MessageSender {
  return trustedSender({
    tab: tiktokHomepageTab(),
    url: TIKTOK_HOMEPAGE_URL,
    ...overrides,
  });
}

function xiaohongshuFeedTab(
  overrides: Partial<chrome.tabs.Tab> = {},
): chrome.tabs.Tab {
  return supportedTab({
    url: XIAOHONGSHU_FEED_URL,
    title: "Xiaohongshu feed",
    ...overrides,
  });
}

function xiaohongshuFeedSender(
  overrides: Partial<chrome.runtime.MessageSender> = {},
): chrome.runtime.MessageSender {
  return trustedSender({
    tab: xiaohongshuFeedTab(),
    url: XIAOHONGSHU_FEED_URL,
    ...overrides,
  });
}

function handleCurrentPage(
  handle: PageActionHandler,
  sender: chrome.runtime.MessageSender = trustedSender(),
) {
  return handle(sender, { type: "ADD_CURRENT_PAGE_TO_POPUP" });
}

function handlePageCandidate(
  handle: PageActionHandler,
  sender: chrome.runtime.MessageSender,
  candidate: unknown,
) {
  return handle(sender, {
    type: "ADD_PAGE_CANDIDATE_TO_POPUP",
    candidate,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("page action command", () => {
  test("resolves the live page inside ensure, stores its exact source, then opens the latest window popup", async () => {
    const memory = memorySourceService();
    const first = supportedTab({ windowId: 7 });
    const second = supportedTab({ windowId: 9 });
    const ports = pageActionPorts([first, second]);
    const handle = createPageActionHandler(memory.service, ports);

    await expect(handleCurrentPage(handle)).resolves.toEqual({
      type: "PAGE_ACTION_RESULT",
      ok: true,
    });

    expect(ports.getTab).toHaveBeenNthCalledWith(1, 41);
    expect(ports.getTab).toHaveBeenNthCalledWith(2, 41);
    expect(memory.sources()).toEqual([
      {
        id: "page-action-41-1234",
        url: first.url,
        documentURL: first.url,
        name: "Video title",
        type: DownloadType.bilibili,
        detectedAt: 1_234,
      },
    ]);
    expect(memory.badges).toEqual([1]);
    expect(ports.openPopup).toHaveBeenCalledWith({ windowId: 9 });
  });

  test.each([
    ["wrong extension id", { id: "another-extension" }],
    ["missing extension id", { id: undefined }],
    ["missing frame id", { frameId: undefined }],
    ["subframe", { frameId: 2 }],
    ["missing document URL", { url: undefined }],
    ["missing tab id", { tab: supportedTab({ id: undefined }) }],
    ["non-finite tab id", { tab: supportedTab({ id: Number.NaN }) }],
    ["negative tab id", { tab: supportedTab({ id: -1 }) }],
  ] satisfies Array<[string, Partial<chrome.runtime.MessageSender>]>)(
    "rejects %s without reading or mutating tab state",
    async (_label, senderOverrides) => {
      const memory = memorySourceService();
      const ports = pageActionPorts([]);
      const handle = createPageActionHandler(memory.service, ports);

      await expect(
        handleCurrentPage(handle, trustedSender(senderOverrides)),
      ).resolves.toEqual({
        type: "PAGE_ACTION_RESULT",
        ok: false,
        error: "INVALID_SENDER",
      });

      expect(ports.getTab).not.toHaveBeenCalled();
      expect(memory.ports.load).not.toHaveBeenCalled();
      expect(memory.ports.save).not.toHaveBeenCalled();
      expect(memory.badges).toEqual([]);
      expect(ports.openPopup).not.toHaveBeenCalled();
    },
  );

  test.each([
    [
      "a sender URL that no longer matches the live tab",
      trustedSender({
        url: "https://www.bilibili.com/video/BV1stale",
      }),
      supportedTab(),
      "PAGE_CHANGED",
    ],
    [
      "an inactive first live tab",
      trustedSender(),
      supportedTab({ active: false }),
      "TAB_INACTIVE",
    ],
    [
      "a first live tab without a window",
      trustedSender(),
      supportedTab({ windowId: undefined }),
      "WINDOW_UNAVAILABLE",
    ],
  ] as const)(
    "rejects %s before reading or mutating source state",
    async (_label, sender, liveTab, error) => {
      const memory = memorySourceService();
      const ports = pageActionPorts([liveTab, supportedTab()]);
      const handle = createPageActionHandler(memory.service, ports);

      await expect(handleCurrentPage(handle, sender)).resolves.toEqual({
        type: "PAGE_ACTION_RESULT",
        ok: false,
        error,
      });

      expect(memory.ports.load).not.toHaveBeenCalled();
      expect(memory.ports.save).not.toHaveBeenCalled();
      expect(memory.badges).toEqual([]);
      expect(ports.openPopup).not.toHaveBeenCalled();
    },
  );

  test.each([
    [
      "an unsupported URL",
      supportedTab({ url: "https://www.youtube.com/feed/subscriptions" }),
      "UNSUPPORTED_PAGE",
    ],
    ["a missing URL", supportedTab({ url: undefined }), "UNSUPPORTED_PAGE"],
  ] as const)(
    "rejects %s from the first live lookup without inserting or opening",
    async (_label, liveTab, error) => {
      const memory = memorySourceService();
      const ports = pageActionPorts([liveTab]);
      const handle = createPageActionHandler(memory.service, ports);

      await expect(handleCurrentPage(handle)).resolves.toEqual({
        type: "PAGE_ACTION_RESULT",
        ok: false,
        error,
      });

      expect(memory.ports.load).not.toHaveBeenCalled();
      expect(memory.ports.save).not.toHaveBeenCalled();
      expect(memory.badges).toEqual([]);
      expect(ports.openPopup).not.toHaveBeenCalled();
    },
  );

  test("turns a failed first live-tab lookup into a stable failure without side effects", async () => {
    const memory = memorySourceService();
    const ports = pageActionPorts([], {
      getTab: vi.fn(async () => {
        throw new Error("No tab with id: 41 and internal details");
      }),
    });
    const handle = createPageActionHandler(memory.service, ports);

    await expect(handleCurrentPage(handle)).resolves.toEqual({
      type: "PAGE_ACTION_RESULT",
      ok: false,
      error: "TAB_UNAVAILABLE",
    });

    expect(memory.ports.load).not.toHaveBeenCalled();
    expect(memory.ports.save).not.toHaveBeenCalled();
    expect(memory.badges).toEqual([]);
    expect(ports.openPopup).not.toHaveBeenCalled();
  });

  test.each([
    [
      "an unsupported URL",
      supportedTab({ url: "https://www.youtube.com/feed/subscriptions" }),
      "PAGE_CHANGED",
    ],
    [
      "a different supported URL",
      supportedTab({ url: "https://www.youtube.com/watch?v=next" }),
      "PAGE_CHANGED",
    ],
    ["an inactive tab", supportedTab({ active: false }), "TAB_INACTIVE"],
    [
      "a tab without a window",
      supportedTab({ windowId: undefined }),
      "WINDOW_UNAVAILABLE",
    ],
  ] as const)(
    "does not open for %s on the second lookup but retains the ensured item",
    async (_label, latestTab, error) => {
      const memory = memorySourceService();
      const first = supportedTab();
      const ports = pageActionPorts([first, latestTab]);
      const handle = createPageActionHandler(memory.service, ports);

      await expect(handleCurrentPage(handle)).resolves.toEqual({
        type: "PAGE_ACTION_RESULT",
        ok: false,
        error,
      });

      expect(memory.sources()).toHaveLength(1);
      expect(memory.sources()[0]?.url).toBe(first.url);
      expect(memory.badges).toEqual([1]);
      expect(ports.openPopup).not.toHaveBeenCalled();
    },
  );

  test("retains the ensured item when the second live-tab lookup fails", async () => {
    const memory = memorySourceService();
    const getTab = vi
      .fn<(tabId: number) => Promise<chrome.tabs.Tab>>()
      .mockResolvedValueOnce(supportedTab())
      .mockRejectedValueOnce(new Error("tab closed"));
    const ports = pageActionPorts([], { getTab });
    const handle = createPageActionHandler(memory.service, ports);

    await expect(handleCurrentPage(handle)).resolves.toEqual({
      type: "PAGE_ACTION_RESULT",
      ok: false,
      error: "TAB_UNAVAILABLE",
    });

    expect(memory.sources()).toHaveLength(1);
    expect(memory.badges).toEqual([1]);
    expect(ports.openPopup).not.toHaveBeenCalled();
  });

  test("keeps the exact existing item and its position when the page URL is already stored", async () => {
    const existing = {
      ...detectedSource(
        "existing-page",
        "https://www.bilibili.com/video/BV1test",
      ),
      name: "Original metadata",
      detectedAt: 88,
      type: DownloadType.bilibili,
    };
    const initial = [
      detectedSource("before"),
      existing,
      detectedSource("after"),
    ];
    const memory = memorySourceService(initial);
    const ports = pageActionPorts([supportedTab(), supportedTab()]);
    const handle = createPageActionHandler(memory.service, ports);

    await expect(handleCurrentPage(handle)).resolves.toEqual({
      type: "PAGE_ACTION_RESULT",
      ok: true,
    });

    expect(memory.sources()).toEqual(initial);
    expect(memory.sources()[1]).toBe(existing);
    expect(memory.ports.save).not.toHaveBeenCalled();
    expect(memory.badges).toEqual([3]);
    expect(ports.openPopup).toHaveBeenCalledOnce();
  });

  test("retains the ensured item and succeeds when opening the popup fails", async () => {
    const memory = memorySourceService();
    const popupError = new Error(
      "The popup cannot be opened with internal details",
    );
    const ports = pageActionPorts([supportedTab(), supportedTab()], {
      openPopup: vi.fn(async () => {
        throw popupError;
      }),
    });
    const handle = createPageActionHandler(memory.service, ports);

    await expect(handleCurrentPage(handle)).resolves.toEqual({
      type: "PAGE_ACTION_RESULT",
      ok: true,
    });

    expect(memory.sources()).toHaveLength(1);
    expect(memory.sources()[0]?.url).toBe(supportedTab().url);
    expect(memory.badges).toEqual([1]);
    expect(ports.reportPopupOpenFailure).toHaveBeenCalledWith(popupError);
  });

  test("does not perform the first live lookup until earlier work in the tab queue finishes", async () => {
    const memory = memorySourceService();
    const firstLoad = deferred<DetectedSource[]>();
    vi.mocked(memory.ports.load).mockImplementationOnce(
      () => firstLoad.promise,
    );
    const earlierAdd = memory.service.addSource(41, detectedSource("earlier"));
    const ports = pageActionPorts([supportedTab(), supportedTab()]);
    const handle = createPageActionHandler(memory.service, ports);

    const pageAction = handleCurrentPage(handle);
    await vi.waitFor(() => expect(memory.ports.load).toHaveBeenCalledOnce());
    expect(ports.getTab).not.toHaveBeenCalled();

    firstLoad.resolve([]);
    await earlierAdd;
    await expect(pageAction).resolves.toEqual({
      type: "PAGE_ACTION_RESULT",
      ok: true,
    });

    expect(ports.getTab).toHaveBeenCalledTimes(2);
    expect(memory.sources().map((source) => source.id)).toEqual([
      "earlier",
      "page-action-41-1234",
    ]);
  });

  test("uses the shared YouTube match type and falls back to the live URL for an empty title", async () => {
    const url = "https://www.youtube.com/watch?v=test";
    const memory = memorySourceService();
    const ports = pageActionPorts([
      supportedTab({ url, title: "" }),
      supportedTab({ url, title: "" }),
    ]);
    const handle = createPageActionHandler(memory.service, ports);

    await expect(
      handleCurrentPage(handle, trustedSender({ url })),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(memory.sources()[0]).toMatchObject({
      url,
      documentURL: url,
      name: url,
      type: DownloadType.youtube,
    });
  });

  test("reports a stable source-update failure without a second lookup or popup", async () => {
    const memory = memorySourceService();
    vi.mocked(memory.ports.save).mockRejectedValueOnce(
      new Error("storage internals"),
    );
    const ports = pageActionPorts([supportedTab()]);
    const handle = createPageActionHandler(memory.service, ports);

    await expect(handleCurrentPage(handle)).resolves.toEqual({
      type: "PAGE_ACTION_RESULT",
      ok: false,
      error: "SOURCE_UPDATE_FAILED",
    });

    expect(ports.getTab).toHaveBeenCalledOnce();
    expect(ports.openPopup).not.toHaveBeenCalled();
    expect(memory.sources()).toEqual([]);
    expect(memory.badges).toEqual([]);
  });
});

describe("page candidate command", () => {
  test.each([
    ["missing", undefined],
    ["null", null],
    ["false", false],
    ["zero", 0],
    ["empty string", ""],
    ["array", []],
    ["invalid object", { name: "missing URL" }],
  ])(
    "rejects a %s candidate payload without any tab or source side effect",
    async (_label, malformedCandidate) => {
      const memory = memorySourceService();
      const ports = pageActionPorts([supportedTab(), supportedTab()]);
      const handle = createPageActionHandler(memory.service, ports);

      await expect(
        handlePageCandidate(handle, trustedSender(), malformedCandidate),
      ).resolves.toMatchObject({
        type: "PAGE_ACTION_RESULT",
        ok: false,
      });

      expect(ports.getTab).not.toHaveBeenCalled();
      expect(memory.ports.load).not.toHaveBeenCalled();
      expect(memory.ports.save).not.toHaveBeenCalled();
      expect(memory.badges).toEqual([]);
      expect(ports.openPopup).not.toHaveBeenCalled();
    },
  );

  test("stores the exact Bilibili card source against the homepage document and opens the latest popup", async () => {
    const memory = memorySourceService();
    const ports = pageActionPorts([
      homepageTab({ windowId: 7 }),
      homepageTab({ windowId: 12 }),
    ]);
    const handle = createPageActionHandler(memory.service, ports);

    await expect(
      handlePageCandidate(handle, homepageSender(), pageCandidate()),
    ).resolves.toEqual({ type: "PAGE_ACTION_RESULT", ok: true });

    expect(memory.sources()).toEqual([
      {
        id: "page-action-41-1234",
        name: "Card title",
        url: "https://www.bilibili.com/video/BV1card",
        documentURL: BILIBILI_HOMEPAGE_URL,
        type: DownloadType.bilibili,
        detectedAt: 1_234,
      },
    ]);
    expect(memory.badges).toEqual([1]);
    expect(ports.openPopup).toHaveBeenCalledWith({ windowId: 12 });
  });

  test("accepts a YouTube card candidate from the YouTube homepage", async () => {
    const memory = memorySourceService();
    const ports = pageActionPorts([
      youtubeHomepageTab({ windowId: 7 }),
      youtubeHomepageTab({ windowId: 12 }),
    ]);
    const handle = createPageActionHandler(memory.service, ports);
    const candidate = pageCandidate({
      name: "YouTube card",
      url: "https://www.youtube.com/watch?v=card-video",
      type: DownloadType.youtube,
    });

    await expect(
      handlePageCandidate(handle, youtubeHomepageSender(), candidate),
    ).resolves.toEqual({ type: "PAGE_ACTION_RESULT", ok: true });

    expect(memory.sources()).toEqual([
      {
        id: "page-action-41-1234",
        name: "YouTube card",
        url: "https://www.youtube.com/watch?v=card-video",
        documentURL: YOUTUBE_HOMEPAGE_URL,
        type: DownloadType.youtube,
        detectedAt: 1_234,
      },
    ]);
    expect(memory.badges).toEqual([1]);
    expect(ports.openPopup).toHaveBeenCalledWith({ windowId: 12 });
  });

  test("accepts a TikTok card candidate from the TikTok feed", async () => {
    const memory = memorySourceService();
    const ports = pageActionPorts([
      tiktokHomepageTab({ windowId: 7 }),
      tiktokHomepageTab({ windowId: 12 }),
    ]);
    const handle = createPageActionHandler(memory.service, ports);
    const candidate = pageCandidate({
      name: "TikTok card",
      url: "https://www.tiktok.com/@creator/video/7480123456789012345",
      type: DownloadType.youtube,
    });

    await expect(
      handlePageCandidate(handle, tiktokHomepageSender(), candidate),
    ).resolves.toEqual({ type: "PAGE_ACTION_RESULT", ok: true });

    expect(memory.sources()).toEqual([
      {
        id: "page-action-41-1234",
        name: "TikTok card",
        url: "https://www.tiktok.com/@creator/video/7480123456789012345",
        documentURL: TIKTOK_HOMEPAGE_URL,
        type: DownloadType.youtube,
        detectedAt: 1_234,
      },
    ]);
    expect(memory.badges).toEqual([1]);
    expect(ports.openPopup).toHaveBeenCalledWith({ windowId: 12 });
  });

  test("accepts a Xiaohongshu card candidate from the Xiaohongshu feed", async () => {
    const memory = memorySourceService();
    const ports = pageActionPorts([
      xiaohongshuFeedTab({ windowId: 7 }),
      xiaohongshuFeedTab({ windowId: 12 }),
    ]);
    const handle = createPageActionHandler(memory.service, ports);
    const candidate = pageCandidate({
      name: "Xiaohongshu card",
      url: "https://www.xiaohongshu.com/explore/66f00abc1234567890abcdef?xsec_token=token&xsec_source=pc_feed",
      type: DownloadType.xiaohongshu,
    });

    await expect(
      handlePageCandidate(handle, xiaohongshuFeedSender(), candidate),
    ).resolves.toEqual({ type: "PAGE_ACTION_RESULT", ok: true });

    expect(memory.sources()).toEqual([
      {
        id: "page-action-41-1234",
        name: "Xiaohongshu card",
        url: candidate.url,
        documentURL: XIAOHONGSHU_FEED_URL,
        type: DownloadType.xiaohongshu,
        detectedAt: 1_234,
      },
    ]);
    expect(ports.openPopup).toHaveBeenCalledWith({ windowId: 12 });
  });

  test("keeps the exact existing item when the candidate URL is already stored", async () => {
    const existing = {
      ...detectedSource(
        "existing-card",
        "https://www.bilibili.com/video/BV1card",
      ),
      name: "Original metadata",
      type: DownloadType.bilibili,
    };
    const initial = [detectedSource("before"), existing];
    const memory = memorySourceService(initial);
    const ports = pageActionPorts([homepageTab(), homepageTab()]);
    const handle = createPageActionHandler(memory.service, ports);

    await expect(
      handlePageCandidate(
        handle,
        homepageSender(),
        pageCandidate({ name: "New metadata" }),
      ),
    ).resolves.toMatchObject({ ok: true });

    expect(memory.sources()).toEqual(initial);
    expect(memory.sources()[1]).toBe(existing);
    expect(memory.ports.save).not.toHaveBeenCalled();
    expect(memory.badges).toEqual([2]);
  });

  test.each([
    ["wrong extension", homepageSender({ id: "other" })],
    ["subframe", homepageSender({ frameId: 1 })],
    ["missing sender URL", homepageSender({ url: undefined })],
    ["missing tab", homepageSender({ tab: undefined })],
  ])(
    "rejects a candidate from an invalid %s without side effects",
    async (_label, sender) => {
      const memory = memorySourceService();
      const ports = pageActionPorts([]);
      const handle = createPageActionHandler(memory.service, ports);

      await expect(
        handlePageCandidate(handle, sender, pageCandidate()),
      ).resolves.toMatchObject({ type: "PAGE_ACTION_RESULT", ok: false });
      expect(ports.getTab).not.toHaveBeenCalled();
      expect(memory.ports.load).not.toHaveBeenCalled();
      expect(memory.ports.save).not.toHaveBeenCalled();
      expect(memory.badges).toEqual([]);
      expect(ports.openPopup).not.toHaveBeenCalled();
    },
  );

  test.each([
    [
      "sender/live URL mismatch",
      homepageSender(),
      homepageTab({ url: `${BILIBILI_HOMEPAGE_URL}?changed=1` }),
    ],
    ["inactive tab", homepageSender(), homepageTab({ active: false })],
    ["invalid window", homepageSender(), homepageTab({ windowId: undefined })],
    [
      "unsupported document host",
      homepageSender({
        url: "https://example.com/",
        tab: homepageTab({ url: "https://example.com/" }),
      }),
      homepageTab({ url: "https://example.com/" }),
    ],
  ])(
    "rejects a candidate for an %s before source storage",
    async (_label, sender, liveTab) => {
      const memory = memorySourceService();
      const ports = pageActionPorts([liveTab]);
      const handle = createPageActionHandler(memory.service, ports);

      await expect(
        handlePageCandidate(handle, sender, pageCandidate()),
      ).resolves.toMatchObject({ type: "PAGE_ACTION_RESULT", ok: false });
      expect(memory.ports.load).not.toHaveBeenCalled();
      expect(memory.ports.save).not.toHaveBeenCalled();
      expect(memory.badges).toEqual([]);
      expect(ports.openPopup).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["relative URL", pageCandidate({ url: "/video/BV1relative" })],
    [
      "unsupported URL",
      pageCandidate({ url: "https://www.youtube.com/feed/subscriptions" }),
    ],
    ["canonical type mismatch", pageCandidate({ type: DownloadType.youtube })],
  ])(
    "rejects an invalid candidate %s without tab or storage access",
    async (_label, candidate) => {
      const memory = memorySourceService();
      const ports = pageActionPorts([]);
      const handle = createPageActionHandler(memory.service, ports);

      await expect(
        handlePageCandidate(handle, homepageSender(), candidate),
      ).resolves.toMatchObject({ type: "PAGE_ACTION_RESULT", ok: false });
      expect(ports.getTab).not.toHaveBeenCalled();
      expect(memory.ports.load).not.toHaveBeenCalled();
      expect(memory.ports.save).not.toHaveBeenCalled();
      expect(memory.badges).toEqual([]);
    },
  );

  test("falls back to the candidate URL when its extracted title is empty", async () => {
    const memory = memorySourceService();
    const ports = pageActionPorts([homepageTab(), homepageTab()]);
    const handle = createPageActionHandler(memory.service, ports);

    await expect(
      handlePageCandidate(
        handle,
        homepageSender(),
        pageCandidate({ name: "" }),
      ),
    ).resolves.toMatchObject({ ok: true });

    expect(memory.sources()[0]?.name).toBe(
      "https://www.bilibili.com/video/BV1card",
    );
  });

  test("retains the candidate but does not open when the second live lookup races to another page", async () => {
    const memory = memorySourceService();
    const ports = pageActionPorts([
      homepageTab(),
      homepageTab({ url: `${BILIBILI_HOMEPAGE_URL}?next=1` }),
    ]);
    const handle = createPageActionHandler(memory.service, ports);

    await expect(
      handlePageCandidate(handle, homepageSender(), pageCandidate()),
    ).resolves.toMatchObject({ ok: false, error: "PAGE_CHANGED" });

    expect(memory.sources()).toHaveLength(1);
    expect(memory.badges).toEqual([1]);
    expect(ports.openPopup).not.toHaveBeenCalled();
  });

  test("retains the candidate and succeeds when opening the popup fails", async () => {
    const memory = memorySourceService();
    const popupError = new Error("popup unavailable");
    const ports = pageActionPorts([homepageTab(), homepageTab()], {
      openPopup: vi.fn(async () => {
        throw popupError;
      }),
    });
    const handle = createPageActionHandler(memory.service, ports);

    await expect(
      handlePageCandidate(handle, homepageSender(), pageCandidate()),
    ).resolves.toEqual({ type: "PAGE_ACTION_RESULT", ok: true });

    expect(memory.sources()).toHaveLength(1);
    expect(memory.badges).toEqual([1]);
    expect(ports.reportPopupOpenFailure).toHaveBeenCalledWith(popupError);
  });

  test("runs the first candidate live lookup inside the tab queue", async () => {
    const memory = memorySourceService();
    const firstLoad = deferred<DetectedSource[]>();
    vi.mocked(memory.ports.load).mockImplementationOnce(
      () => firstLoad.promise,
    );
    const earlierAdd = memory.service.addSource(41, detectedSource("earlier"));
    const ports = pageActionPorts([homepageTab(), homepageTab()]);
    const handle = createPageActionHandler(memory.service, ports);

    const candidateAction = handlePageCandidate(
      handle,
      homepageSender(),
      pageCandidate(),
    );
    await vi.waitFor(() => expect(memory.ports.load).toHaveBeenCalledOnce());
    expect(ports.getTab).not.toHaveBeenCalled();

    firstLoad.resolve([]);
    await earlierAdd;
    await expect(candidateAction).resolves.toMatchObject({ ok: true });

    expect(ports.getTab).toHaveBeenCalledTimes(2);
    expect(memory.sources().map((source) => source.id)).toEqual([
      "earlier",
      "page-action-41-1234",
    ]);
  });
});
