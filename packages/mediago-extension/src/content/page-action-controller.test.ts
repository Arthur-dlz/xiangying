// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from "vitest";

import type { ExtensionMessage, ExtensionResponse } from "../shared/types";
import {
  createPageActionController,
  isSupportedPageUrl,
  type PageActionControllerPorts,
  type RuntimeMessageListener,
  type StorageChangeListener,
} from "./page-action-controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createPorts(options?: {
  url?: string;
  stored?: Record<string, unknown>;
  sendMessage?: (message: ExtensionMessage) => Promise<ExtensionResponse>;
}) {
  let url = options?.url ?? "https://www.youtube.com/watch?v=video";
  let storageListener: StorageChangeListener | undefined;
  let runtimeListener: RuntimeMessageListener | undefined;
  const removeStorageListener = vi.fn();
  const removeRuntimeListener = vi.fn();
  const addStorageChangeListener = vi.fn((listener: StorageChangeListener) => {
    storageListener = listener;
    return removeStorageListener;
  });
  const addRuntimeMessageListener = vi.fn(
    (listener: RuntimeMessageListener) => {
      runtimeListener = listener;
      return removeRuntimeListener;
    },
  );
  const sendMessage = vi.fn(
    options?.sendMessage ??
      (async () => ({ type: "PAGE_ACTION_RESULT", ok: true }) as const),
  );
  const ports: PageActionControllerPorts = {
    document,
    currentUrl: () => url,
    loadStoredSettings: async () => options?.stored ?? {},
    iconUrl: "chrome-extension://id/public/icons/mediago-16.png",
    sendMessage,
    addStorageChangeListener,
    addRuntimeMessageListener,
  };
  return {
    ports,
    sendMessage,
    addStorageChangeListener,
    addRuntimeMessageListener,
    removeStorageListener,
    removeRuntimeListener,
    setUrl(next: string) {
      url = next;
    },
    changeSettings(next: Record<string, unknown>, area = "local") {
      storageListener?.({ "mediago.settings": { newValue: next } }, area);
    },
    sendRuntimeMessage(message: unknown) {
      return runtimeListener?.(message);
    },
  };
}

function pageActionButton(): HTMLButtonElement | null {
  return (
    document
      .querySelector<HTMLElement>("[data-mediago-page-action]")
      ?.shadowRoot?.querySelector("button") ?? null
  );
}

function installBilibiliCard(
  href = "/video/BV1card",
  title = "Card title",
): HTMLElement {
  document.head.innerHTML = '<base href="https://www.bilibili.com/">';
  document.body.innerHTML = `
    <main class="bili-feed4-layout">
      <article class="bili-video-card__wrap">
        <a class="bili-video-card__image--link" href="${href}"></a>
        <h3 class="bili-video-card__info--tit">${title}</h3>
      </article>
    </main>
  `;
  const card = document.querySelector<HTMLElement>(".bili-video-card__wrap");
  if (!card) throw new Error("Expected Bilibili card fixture");
  return card;
}

function installYoutubeCard(
  href = "/watch?v=youtube-card",
  title = "YouTube card title",
): HTMLElement {
  document.head.innerHTML = '<base href="https://www.youtube.com/">';
  document.body.innerHTML = `
    <ytd-app>
      <ytd-rich-item-renderer>
        <ytd-thumbnail>
          <a id="thumbnail" href="${href}"></a>
        </ytd-thumbnail>
        <a id="video-title-link" href="${href}">
          <span id="video-title" title="${title}">${title}</span>
        </a>
      </ytd-rich-item-renderer>
    </ytd-app>
  `;
  const thumbnail = document.querySelector<HTMLElement>("ytd-thumbnail");
  if (!thumbnail) throw new Error("Expected YouTube card fixture");
  return thumbnail;
}

function installTikTokCard(
  postID = "7480123456789012345",
  title = "TikTok card title",
): HTMLElement {
  document.head.innerHTML = '<base href="https://www.tiktok.com/">';
  document.body.innerHTML = `
    <article data-e2e="recommend-list-item-container">
      <section data-e2e="feed-video">
        <div id="xgwrapper-0-${postID}"><video></video></div>
        <a data-e2e="video-author-avatar" href="/@creator"></a>
        <p data-e2e="video-desc">${title}</p>
      </section>
    </article>
  `;
  const card = document.querySelector<HTMLElement>(
    '[data-e2e="recommend-list-item-container"]',
  );
  if (!card) throw new Error("Expected a TikTok card fixture");
  return card;
}

function installDouyinJingxuanCard(
  postID = "7673896622496959771",
  title = "抖音精选标题",
): HTMLElement {
  document.head.innerHTML = '<base href="https://www.douyin.com/jingxuan">';
  document.body.innerHTML = `
    <div class="discover-video-card-item" data-aweme-id="${postID}">
      <div class="waterfall-videoCardContainer jingxuanVideoCard">
        <div class="videoImage">
          <img class="discover-video-card-img" alt="${title}" />
        </div>
      </div>
    </div>
  `;
  const card = document.querySelector<HTMLElement>("[data-aweme-id]");
  if (!card) throw new Error("Expected a Douyin jingxuan card fixture");
  return card;
}

function installXiaohongshuCard(
  noteID = "66f00abc1234567890abcdef",
  title = "小红书列表标题",
): HTMLElement {
  document.head.innerHTML = '<base href="https://www.xiaohongshu.com/explore">';
  document.body.innerHTML = `
    <main class="feeds-container">
      <section class="note-item">
        <a class="cover" href="/explore/${noteID}?xsec_token=feed-token&xsec_source=pc_feed">
          <img alt="${title}" />
          <span class="play-icon"></span>
        </a>
        <div class="footer"><a class="title">${title}</a></div>
      </section>
    </main>
  `;
  const card = document.querySelector<HTMLElement>("section.note-item");
  if (!card) throw new Error("Expected a Xiaohongshu card fixture");
  return card;
}

function cardButton(card: HTMLElement): HTMLElement | null {
  return (
    card
      .querySelector<HTMLElement>("mediago-download-button")
      ?.shadowRoot?.querySelector<HTMLElement>(".mg-button") ?? null
  );
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement
    .querySelectorAll("[data-mediago-page-action]")
    .forEach((element) => element.remove());
});

describe("supported page URL matching", () => {
  test.each([
    "https://www.bilibili.com/video/BV1xx411c7mD",
    "http://bilibili.com/video/BV1xx411c7mD?p=2",
    "https://youtube.com/watch?v=abc",
    "https://www.youtube.com/shorts/abc",
    "https://m.youtube.com/live/abc",
    "https://music.youtube.com/embed/abc",
    "https://youtu.be/abc",
    "https://x.com/openai/status/1234567890",
    "https://twitter.com/openai/status/1234567890",
    "https://www.tiktok.com/@creator/video/7480123456789012345",
    "https://vm.tiktok.com/ZTR45GpSF/",
    "https://www.douyin.com/video/7480123456789012345",
    "https://v.douyin.com/iF123AbC/",
    "https://www.xiaohongshu.com/explore/66f00abc1234567890abcdef?xsec_token=token",
    "https://www.xiaohongshu.com/discovery/item/66f00abc1234567890abcdef?xsec_token=token",
    "https://xhslink.com/a1B2c3D4",
  ])("accepts canonical directly supported route %s", (url) => {
    expect(isSupportedPageUrl(url)).toBe(true);
  });

  test.each([
    "https://www.bilibili.com/",
    "https://www.bilibili.com/bangumi/play/ep1",
    "https://www.youtube.com/",
    "https://www.youtube.com/feed/subscriptions",
    "https://x.com/home",
    "https://twitter.com/search?q=video",
    "https://www.tiktok.com/@creator/live",
    "https://www.douyin.com/user/example",
    "https://www.xiaohongshu.com/explore",
    "https://www.xiaohongshu.com/search_result?keyword=video",
    "https://example.com/video/1",
  ])("rejects route without a canonical page rule %s", (url) => {
    expect(isSupportedPageUrl(url)).toBe(false);
  });
});

describe("page action controller", () => {
  test("shows by default for old partial settings on a supported page", async () => {
    const fixture = createPorts({ stored: { language: "en" } });

    const controller = await createPageActionController(fixture.ports);

    expect(pageActionButton()?.textContent).toContain("Add to MediaGo");
    controller.destroy();
  });

  test("lets a storage change during initial load win over the stale snapshot", async () => {
    const stored = deferred<Record<string, unknown>>();
    const fixture = createPorts();
    fixture.ports.loadStoredSettings = () => stored.promise;

    const pendingController = createPageActionController(fixture.ports);

    expect(fixture.addStorageChangeListener).toHaveBeenCalledTimes(1);
    expect(pageActionButton()).toBeNull();
    fixture.changeSettings({
      pageQuickActionEnabled: false,
      language: "zh",
    });
    stored.resolve({ pageQuickActionEnabled: true, language: "en" });

    const controller = await pendingController;
    expect(pageActionButton()).toBeNull();

    fixture.changeSettings({
      pageQuickActionEnabled: true,
      language: "zh",
    });
    expect(pageActionButton()?.textContent).toContain("添加到 MediaGo");
    expect(
      document.querySelectorAll("[data-mediago-page-action]"),
    ).toHaveLength(1);
    controller.destroy();
  });

  test("removes listeners when the initial settings load rejects", async () => {
    const fixture = createPorts();
    fixture.ports.loadStoredSettings = async () => {
      throw new Error("storage unavailable");
    };

    await expect(createPageActionController(fixture.ports)).rejects.toThrow(
      "storage unavailable",
    );

    expect(fixture.addStorageChangeListener).toHaveBeenCalledTimes(1);
    expect(fixture.addRuntimeMessageListener).toHaveBeenCalledTimes(1);
    expect(fixture.removeStorageListener).toHaveBeenCalledTimes(1);
    expect(fixture.removeRuntimeListener).toHaveBeenCalledTimes(1);
    fixture.changeSettings({ pageQuickActionEnabled: true, language: "zh" });
    expect(pageActionButton()).toBeNull();
  });

  test("does not show on unsupported pages or when explicitly disabled", async () => {
    const unsupported = createPorts({
      url: "https://www.youtube.com/feed/subscriptions",
    });
    const first = await createPageActionController(unsupported.ports);
    expect(pageActionButton()).toBeNull();
    first.destroy();

    const disabled = createPorts({ stored: { pageQuickActionEnabled: false } });
    const second = await createPageActionController(disabled.ports);
    expect(pageActionButton()).toBeNull();
    second.destroy();
  });

  test("sends only the page-action command and requires a successful result", async () => {
    const fixture = createPorts();
    const controller = await createPageActionController(fixture.ports);

    pageActionButton()?.click();

    expect(fixture.sendMessage).toHaveBeenCalledWith({
      type: "ADD_CURRENT_PAGE_TO_POPUP",
    });
    expect(Object.keys(fixture.sendMessage.mock.calls[0][0])).toEqual(["type"]);
    await vi.waitFor(() => {
      expect(pageActionButton()?.textContent).toContain("Add to MediaGo");
    });
    controller.destroy();
  });

  test.each([
    async () => ({ type: "OK" }) as const,
    async () =>
      ({
        type: "PAGE_ACTION_RESULT",
        ok: false,
        error: "POPUP_OPEN_FAILED",
      }) as const,
    async () => {
      throw new Error("worker unavailable");
    },
  ])(
    "turns unexpected or failed responses into a retry state",
    async (send) => {
      const fixture = createPorts({ sendMessage: send });
      const controller = await createPageActionController(fixture.ports);

      pageActionButton()?.click();

      await vi.waitFor(() => {
        expect(pageActionButton()?.disabled).toBe(false);
        expect(pageActionButton()?.textContent).toContain("Failed, try again");
      });
      controller.destroy();
    },
  );

  test("keeps programmatic rapid activations single-flight", async () => {
    const pending = deferred<ExtensionResponse>();
    const fixture = createPorts({ sendMessage: () => pending.promise });
    const controller = await createPageActionController(fixture.ports);
    const button = pageActionButton();

    button?.dispatchEvent(new MouseEvent("click"));
    button?.dispatchEvent(new MouseEvent("click"));

    expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
    pending.resolve({ type: "PAGE_ACTION_RESULT", ok: true });
    await pending.promise;
    await Promise.resolve();
    controller.destroy();
  });

  test("applies toggle and language storage changes immediately", async () => {
    const fixture = createPorts({ stored: { language: "en" } });
    const controller = await createPageActionController(fixture.ports);

    fixture.changeSettings({ pageQuickActionEnabled: false, language: "en" });
    expect(pageActionButton()).toBeNull();

    fixture.changeSettings({ pageQuickActionEnabled: true, language: "zh" });
    expect(pageActionButton()?.textContent).toContain("添加到 MediaGo");

    fixture.changeSettings(
      { pageQuickActionEnabled: false, language: "it" },
      "sync",
    );
    expect(pageActionButton()?.textContent).toContain("添加到 MediaGo");
    controller.destroy();
  });

  test("re-evaluates the current URL after a page context change", async () => {
    const fixture = createPorts();
    const controller = await createPageActionController(fixture.ports);
    expect(pageActionButton()).not.toBeNull();

    fixture.setUrl("https://www.youtube.com/feed/subscriptions");
    expect(
      fixture.sendRuntimeMessage({ type: "PAGE_CONTEXT_CHANGED" }),
    ).toBeUndefined();
    expect(pageActionButton()).toBeNull();

    fixture.setUrl("https://www.bilibili.com/video/BV1xx411c7mD");
    fixture.sendRuntimeMessage({ type: "PAGE_CONTEXT_CHANGED" });
    expect(pageActionButton()).not.toBeNull();
    controller.destroy();
  });

  test("cleanup removes listeners and UI and prevents late initialization", async () => {
    const fixture = createPorts();
    const controller = await createPageActionController(fixture.ports);

    controller.destroy();
    controller.destroy();

    expect(pageActionButton()).toBeNull();
    expect(fixture.removeStorageListener).toHaveBeenCalledTimes(1);
    expect(fixture.removeRuntimeListener).toHaveBeenCalledTimes(1);

    const settings = deferred<Record<string, unknown>>();
    const delayed = createPorts();
    delayed.ports.loadStoredSettings = () => settings.promise;
    const pendingController = createPageActionController(delayed.ports);
    // A controller can only be destroyed once initialization returns, so
    // detach its environment first and verify no duplicate host survives.
    settings.resolve({ pageQuickActionEnabled: false });
    (await pendingController).destroy();
    expect(pageActionButton()).toBeNull();
  });
});

describe("site card runtime controller", () => {
  test("starts the shared runtime by default on the Bilibili homepage", async () => {
    const card = installBilibiliCard();
    const fixture = createPorts({ url: "https://www.bilibili.com/" });

    const controller = await createPageActionController(fixture.ports);

    expect(pageActionButton()).toBeNull();
    expect(cardButton(card)?.textContent).toBe("下载");
    expect(card.getAttribute("data-mg-injected")).toBe("true");
    controller.destroy();
  });

  test("removes, restarts, and removes the shared runtime with the global setting", async () => {
    const card = installBilibiliCard();
    const fixture = createPorts({ url: "https://www.bilibili.com/" });
    const controller = await createPageActionController(fixture.ports);
    const firstButton = cardButton(card);

    fixture.changeSettings({ pageQuickActionEnabled: false });
    expect(cardButton(card)).toBeNull();
    expect(card.hasAttribute("data-mg-injected")).toBe(false);

    fixture.changeSettings({ pageQuickActionEnabled: true });
    expect(cardButton(card)).not.toBeNull();
    expect(cardButton(card)).not.toBe(firstButton);

    controller.destroy();
    expect(cardButton(card)).toBeNull();
    expect(card.hasAttribute("data-mg-injected")).toBe(false);
  });

  test("sends only the extracted candidate command when a real card button is clicked", async () => {
    const card = installBilibiliCard(
      "/video/BV1current?from=feed",
      " Current card title ",
    );
    const fixture = createPorts({ url: "https://www.bilibili.com/" });
    const controller = await createPageActionController(fixture.ports);

    cardButton(card)?.click();

    await vi.waitFor(() => {
      expect(fixture.sendMessage).toHaveBeenCalledOnce();
    });
    expect(fixture.sendMessage).toHaveBeenCalledWith({
      type: "ADD_PAGE_CANDIDATE_TO_POPUP",
      candidate: {
        name: "Current card title",
        url: "https://www.bilibili.com/video/BV1current?from=feed",
        type: "bilibili",
      },
    });
    controller.destroy();
  });

  test("shows and activates a download button on YouTube homepage cards", async () => {
    const card = installYoutubeCard(
      "/watch?v=current-video&list=feed",
      " Current YouTube title ",
    );
    const fixture = createPorts({ url: "https://www.youtube.com/" });
    const controller = await createPageActionController(fixture.ports);

    expect(pageActionButton()).toBeNull();
    expect(cardButton(card)?.textContent).toBe("下载");
    cardButton(card)?.click();

    await vi.waitFor(() => {
      expect(fixture.sendMessage).toHaveBeenCalledOnce();
    });
    expect(fixture.sendMessage).toHaveBeenCalledWith({
      type: "ADD_PAGE_CANDIDATE_TO_POPUP",
      candidate: {
        name: "Current YouTube title",
        url: "https://www.youtube.com/watch?v=current-video&list=feed",
        type: "youtube",
      },
    });
    controller.destroy();
  });

  test("shows and activates a download button on current TikTok recommendation cards", async () => {
    const card = installTikTokCard(
      "7480123456789012345",
      " Current TikTok title ",
    );
    const fixture = createPorts({ url: "https://www.tiktok.com/" });
    const controller = await createPageActionController(fixture.ports);

    expect(pageActionButton()).toBeNull();
    expect(cardButton(card)?.textContent).toBe("下载");
    cardButton(card)?.click();

    await vi.waitFor(() => {
      expect(fixture.sendMessage).toHaveBeenCalledOnce();
    });
    expect(fixture.sendMessage).toHaveBeenCalledWith({
      type: "ADD_PAGE_CANDIDATE_TO_POPUP",
      candidate: {
        name: "Current TikTok title",
        url: "https://www.tiktok.com/@creator/video/7480123456789012345",
        type: "youtube",
      },
    });
    controller.destroy();
  });

  test("shows and activates a download button on current Douyin jingxuan cards", async () => {
    const card = installDouyinJingxuanCard(
      "7673896622496959771",
      "当前抖音精选标题",
    );
    const fixture = createPorts({
      url: "https://www.douyin.com/jingxuan",
    });
    const controller = await createPageActionController(fixture.ports);

    expect(pageActionButton()).toBeNull();
    expect(cardButton(card)?.textContent).toBe("下载");
    cardButton(card)?.click();

    await vi.waitFor(() => {
      expect(fixture.sendMessage).toHaveBeenCalledOnce();
    });
    expect(fixture.sendMessage).toHaveBeenCalledWith({
      type: "ADD_PAGE_CANDIDATE_TO_POPUP",
      candidate: {
        name: "当前抖音精选标题",
        url: "https://www.douyin.com/video/7673896622496959771",
        type: "youtube",
      },
    });
    controller.destroy();
  });

  test("shows and activates the same download button on Xiaohongshu cards", async () => {
    const card = installXiaohongshuCard(
      "66f00abc1234567890abcdef",
      "当前小红书列表标题",
    );
    const fixture = createPorts({
      url: "https://www.xiaohongshu.com/explore",
    });
    const controller = await createPageActionController(fixture.ports);

    expect(pageActionButton()).toBeNull();
    expect(cardButton(card)?.textContent).toBe("下载");
    cardButton(card)?.click();

    await vi.waitFor(() => {
      expect(fixture.sendMessage).toHaveBeenCalledOnce();
    });
    expect(fixture.sendMessage).toHaveBeenCalledWith({
      type: "ADD_PAGE_CANDIDATE_TO_POPUP",
      candidate: {
        name: "当前小红书列表标题",
        url: "https://www.xiaohongshu.com/explore/66f00abc1234567890abcdef?xsec_token=feed-token&xsec_source=pc_feed",
        type: "xiaohongshu",
      },
    });
    controller.destroy();
  });

  test("contains a rejected candidate response without leaving an unhandled rejection", async () => {
    const card = installBilibiliCard();
    const fixture = createPorts({
      url: "https://www.bilibili.com/",
      sendMessage: async () => {
        throw new Error("worker unavailable");
      },
    });
    const controller = await createPageActionController(fixture.ports);

    cardButton(card)?.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(fixture.sendMessage).toHaveBeenCalledOnce();
    controller.destroy();
  });

  test("does not start a card runtime when no shared adapter matches", async () => {
    const card = installBilibiliCard();
    const fixture = createPorts({
      url: "https://example.com/video/1",
    });

    const controller = await createPageActionController(fixture.ports);

    expect(cardButton(card)).toBeNull();
    expect(card.hasAttribute("data-mg-injected")).toBe(false);
    expect(pageActionButton()).toBeNull();
    controller.destroy();
  });
});
