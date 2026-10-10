// @vitest-environment happy-dom

import { DownloadType } from "@mediago/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findPageAdapter } from "../registry";
import {
  SHORT_VIDEO_PROCESSED_ATTRIBUTE,
  shortVideoPageAdapter,
} from "./adapter";

const cleanups: Array<() => void> = [];

function installTikTokCard(options?: {
  href?: string;
  description?: string;
  promoted?: boolean;
}) {
  document.head.innerHTML = '<base href="https://www.tiktok.com/foryou">';
  document.body.innerHTML = `
    <article data-e2e="recommend-list-item-container" ${options?.promoted ? 'data-ad="true"' : ""}>
      <a href="${options?.href ?? "/@creator/video/7480123456789012345?lang=en"}">post</a>
      <div data-e2e="video-player"><video></video></div>
      <div data-e2e="video-desc">${options?.description ?? " Example TikTok post "}</div>
    </article>
  `;
}

function installDouyinCard(options?: { href?: string; description?: string }) {
  document.head.innerHTML = '<base href="https://www.douyin.com/recommend">';
  document.body.innerHTML = `
    <article data-e2e="feed-item">
      <a href="${options?.href ?? "/video/7480123456789012345?previous_page=web_code_link"}">作品</a>
      <div data-e2e="video-player"><video></video></div>
      <p data-e2e="video-desc">${options?.description ?? " 示例抖音作品 "}</p>
    </article>
  `;
}

function installTikTokExploreCard() {
  document.head.innerHTML = '<base href="https://www.tiktok.com/explore">';
  document.body.innerHTML = `
    <div id="explore-item-list" data-e2e="explore-item-list">
      <div id="grid-item-container-0">
        <div data-e2e="explore-item">
          <a href="https://www.tiktok.com/@creator/video/7653810746874137877">
            <picture><img alt="Explore cover" /></picture>
          </a>
          <div data-e2e="explore-card-desc">Explore TikTok post</div>
        </div>
      </div>
    </div>
  `;
}

function installTikTokRecommendationCard() {
  document.head.innerHTML = '<base href="https://www.tiktok.com/">';
  document.body.innerHTML = `
    <article data-e2e="recommend-list-item-container">
      <section id="media-card-0" data-e2e="feed-video">
        <div id="xgwrapper-0-7668669836817337633">
          <video></video>
        </div>
        <a href="/@creator">Creator</a>
        <div data-e2e="video-desc">Recommendation TikTok post</div>
      </section>
    </article>
  `;
}

function installDouyinJingxuanCard() {
  document.head.innerHTML = '<base href="https://www.douyin.com/jingxuan">';
  document.body.innerHTML = `
    <div
      class="discover-video-card-item"
      data-aweme-id="7673896622496959771"
    >
      <div class="waterfall-videoCardContainer jingxuanVideoCard">
        <div class="videoImage">
          <img
            class="discover-video-card-img"
            alt="抖音精选真实卡片标题"
          />
        </div>
      </div>
    </div>
  `;
}

function installDouyinModal() {
  document.head.innerHTML =
    '<base href="https://www.douyin.com/jingxuan?modal_id=7673896622496959771">';
  document.body.innerHTML = `
    <div data-e2e="modal-video-container">
      <div data-e2e="feed-item">
        <div data-e2e="feed-active-video">
          <div class="slider-video"><video></video></div>
          <div data-e2e="video-info">
            <div data-e2e="video-desc">抖音详情弹层标题</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function getMount() {
  const mount = document.querySelector<HTMLElement>(
    '[data-e2e="video-player"]',
  );
  if (!mount) throw new Error("Expected a short-video mount");
  return mount;
}

async function flushMutations() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("TikTok/Douyin page adapter", () => {
  it.each([
    "tiktok.com",
    "www.tiktok.com",
    "m.tiktok.com",
    "douyin.com",
    "www.douyin.com",
  ])("is selected for %s", (hostname) => {
    expect(findPageAdapter({ hostname })).toBe(shortVideoPageAdapter);
  });

  it("extracts a canonical TikTok feed candidate", () => {
    installTikTokCard();
    const onCard = vi.fn((card: HTMLElement) => {
      shortVideoPageAdapter.markProcessed(card);
    });
    const cleanup = shortVideoPageAdapter.observe(document, onCard);
    cleanups.push(cleanup);

    const mount = getMount();
    expect(onCard).toHaveBeenCalledOnce();
    expect(shortVideoPageAdapter.extractCandidate(mount)).toEqual({
      name: "Example TikTok post",
      url: "https://www.tiktok.com/@creator/video/7480123456789012345",
      type: DownloadType.youtube,
    });
    expect(mount.getAttribute(SHORT_VIDEO_PROCESSED_ATTRIBUTE)).toBe("true");
  });

  it("extracts a canonical Douyin feed candidate", () => {
    installDouyinCard();
    const onCard = vi.fn((card: HTMLElement) => {
      shortVideoPageAdapter.markProcessed(card);
    });
    const cleanup = shortVideoPageAdapter.observe(document, onCard);
    cleanups.push(cleanup);

    expect(shortVideoPageAdapter.extractCandidate(getMount())).toEqual({
      name: "示例抖音作品",
      url: "https://www.douyin.com/video/7480123456789012345",
      type: DownloadType.youtube,
    });
  });

  it("extracts the current TikTok explore card structure", () => {
    installTikTokExploreCard();
    const onCard = vi.fn((card: HTMLElement) => {
      shortVideoPageAdapter.markProcessed(card);
    });
    const cleanup = shortVideoPageAdapter.observe(document, onCard);
    cleanups.push(cleanup);

    const mount = document.querySelector<HTMLElement>("picture")?.parentElement;
    if (!mount) throw new Error("Expected a TikTok explore mount");
    expect(onCard).toHaveBeenCalledOnce();
    expect(shortVideoPageAdapter.extractCandidate(mount)).toEqual({
      name: "Explore TikTok post",
      url: "https://www.tiktok.com/@creator/video/7653810746874137877",
      type: DownloadType.youtube,
    });
  });

  it("reconstructs a TikTok recommendation URL from the author and player id", () => {
    installTikTokRecommendationCard();
    const onCard = vi.fn((card: HTMLElement) => {
      shortVideoPageAdapter.markProcessed(card);
    });
    const cleanup = shortVideoPageAdapter.observe(document, onCard);
    cleanups.push(cleanup);

    const mount = document.querySelector<HTMLElement>(
      '[data-e2e="feed-video"]',
    );
    if (!mount) throw new Error("Expected a TikTok recommendation mount");
    expect(onCard).toHaveBeenCalledOnce();
    expect(shortVideoPageAdapter.extractCandidate(mount)).toEqual({
      name: "Recommendation TikTok post",
      url: "https://www.tiktok.com/@creator/video/7668669836817337633",
      type: DownloadType.youtube,
    });
  });

  it("extracts a Douyin jingxuan card from data-aweme-id", () => {
    installDouyinJingxuanCard();
    const onCard = vi.fn((card: HTMLElement) => {
      shortVideoPageAdapter.markProcessed(card);
    });
    const cleanup = shortVideoPageAdapter.observe(document, onCard);
    cleanups.push(cleanup);

    const mount = document.querySelector<HTMLElement>(".videoImage");
    if (!mount) throw new Error("Expected a Douyin jingxuan mount");
    expect(onCard).toHaveBeenCalledOnce();
    expect(shortVideoPageAdapter.extractCandidate(mount)).toEqual({
      name: "抖音精选真实卡片标题",
      url: "https://www.douyin.com/video/7673896622496959771",
      type: DownloadType.youtube,
    });
  });

  it("extracts a Douyin modal from its modal_id", () => {
    installDouyinModal();
    const onCard = vi.fn((card: HTMLElement) => {
      shortVideoPageAdapter.markProcessed(card);
    });
    const cleanup = shortVideoPageAdapter.observe(document, onCard);
    cleanups.push(cleanup);

    const mount = document.querySelector<HTMLElement>(".slider-video");
    if (!mount) throw new Error("Expected a Douyin modal mount");
    expect(onCard).toHaveBeenCalledOnce();
    expect(shortVideoPageAdapter.extractCandidate(mount)).toEqual({
      name: "抖音详情弹层标题",
      url: "https://www.douyin.com/video/7673896622496959771",
      type: DownloadType.youtube,
    });
  });

  it.each([
    [
      "https://www.tiktok.com/@creator/video/7480123456789012345",
      "TikTok detail description",
      "https://www.tiktok.com/@creator/video/7480123456789012345",
    ],
    [
      "https://www.douyin.com/video/7480123456789012345",
      "抖音详情描述",
      "https://www.douyin.com/video/7480123456789012345",
    ],
  ])(
    "extracts the current detail page without a post link",
    (base, name, url) => {
      document.head.innerHTML = `<base href="${base}">`;
      document.body.innerHTML = `
      <main>
        <div data-e2e="video-player"><video></video></div>
        <h1 data-e2e="video-desc">${name}</h1>
      </main>
    `;
      const onCard = vi.fn((card: HTMLElement) => {
        shortVideoPageAdapter.markProcessed(card);
      });
      const cleanup = shortVideoPageAdapter.observe(document, onCard);
      cleanups.push(cleanup);

      expect(onCard).toHaveBeenCalledOnce();
      expect(shortVideoPageAdapter.extractCandidate(getMount())).toEqual({
        name,
        url,
        type: DownloadType.youtube,
      });
    },
  );

  it("observes dynamically inserted feed cards once", async () => {
    document.head.innerHTML = '<base href="https://www.tiktok.com/foryou">';
    document.body.innerHTML = "<main></main>";
    const onCard = vi.fn((card: HTMLElement) => {
      shortVideoPageAdapter.markProcessed(card);
    });
    const cleanup = shortVideoPageAdapter.observe(document, onCard);
    cleanups.push(cleanup);

    document.querySelector("main")?.insertAdjacentHTML(
      "beforeend",
      `
        <article data-e2e="recommend-list-item-container">
          <a href="/@creator/video/7480123456789012345">post</a>
          <div data-e2e="video-player"><video></video></div>
        </article>
      `,
    );
    await flushMutations();
    await flushMutations();

    expect(onCard).toHaveBeenCalledOnce();
  });

  it("rejects invalid post links and promoted cards", () => {
    installTikTokCard({ href: "/@creator/live" });
    expect(shortVideoPageAdapter.extractCandidate(getMount())).toBeNull();

    installTikTokCard({ promoted: true });
    expect(shortVideoPageAdapter.extractCandidate(getMount())).toBeNull();
  });

  it("clears only its own processed marker", () => {
    installDouyinCard();
    const mount = getMount();

    shortVideoPageAdapter.markProcessed(mount);
    shortVideoPageAdapter.clearProcessed(mount);

    expect(mount.hasAttribute(SHORT_VIDEO_PROCESSED_ATTRIBUTE)).toBe(false);
  });
});
