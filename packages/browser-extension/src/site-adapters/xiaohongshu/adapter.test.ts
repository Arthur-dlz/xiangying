// @vitest-environment happy-dom

import { DownloadType } from "@mediago/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startPageRuntime } from "../../runtime";
import { findPageAdapter } from "../registry";
import {
  XIAOHONGSHU_PROCESSED_ATTRIBUTE,
  xiaohongshuPageAdapter,
} from "./adapter";

const NOTE_ID = "66f00abc1234567890abcdef";
const NEXT_NOTE_ID = "77f00abc1234567890abcdef";
const cleanups: Array<() => void> = [];

function installListCard(options?: {
  noteId?: string;
  token?: string;
  title?: string;
  extraClass?: string;
  video?: boolean;
}) {
  const noteId = options?.noteId ?? NOTE_ID;
  const token = options?.token ?? "feed-token";
  document.head.innerHTML = '<base href="https://www.xiaohongshu.com/explore">';
  document.body.innerHTML = `
    <main class="feeds-container">
      <section class="note-item ${options?.extraClass ?? ""}">
        <a class="cover" href="/explore/${noteId}?xsec_token=${token}&xsec_source=pc_feed">
          <img alt="${options?.title ?? "小红书封面"}" />
          ${options?.video === false ? "" : '<span class="play-icon"></span>'}
        </a>
        <div class="footer">
          <a class="title">${options?.title ?? " 小红书列表作品 "}</a>
        </div>
      </section>
    </main>
  `;
}

function installDetailPage(options?: {
  href?: string;
  title?: string;
  image?: boolean;
}) {
  const href =
    options?.href ??
    `https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=detail-token&xsec_source=pc_feed`;
  document.head.innerHTML = `<base href="${href}">`;
  document.body.innerHTML = `
    <main>
      <div class="note-detail-mask">
        <div class="note-container">
          <div class="media-container">
            ${options?.image ? '<img src="cover.webp" alt="详情图片" />' : "<xg-player><video></video></xg-player>"}
          </div>
          <h1 id="detail-title">${options?.title ?? " 小红书详情作品 "}</h1>
        </div>
      </div>
    </main>
  `;
}

function getListMount(): HTMLElement {
  const mount = document.querySelector<HTMLElement>("a.cover");
  if (!mount) throw new Error("Expected a Xiaohongshu list mount");
  return mount;
}

function getDetailMount(): HTMLElement {
  const mount = document.querySelector<HTMLElement>(".media-container");
  if (!mount) throw new Error("Expected a Xiaohongshu detail mount");
  return mount;
}

function getButtonHost(mount: HTMLElement): HTMLElement {
  const host = mount.querySelector<HTMLElement>("mediago-download-button");
  if (!host) throw new Error("Expected an injected Xiaohongshu action");
  return host;
}

function getButton(mount: HTMLElement): HTMLButtonElement {
  const button =
    getButtonHost(mount).shadowRoot?.querySelector<HTMLButtonElement>(
      ".mg-button",
    );
  if (!button) throw new Error("Expected an injected download button");
  return button;
}

async function flushMutations() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("Xiaohongshu page adapter", () => {
  it.each([
    "xiaohongshu.com",
    "www.xiaohongshu.com",
    "xhslink.com",
    "www.xhslink.com",
  ])("is selected for %s", (hostname) => {
    expect(findPageAdapter({ hostname })).toBe(xiaohongshuPageAdapter);
  });

  it("extracts a list candidate without discarding xsec parameters", () => {
    installListCard();
    const onCard = vi.fn((card: HTMLElement) => {
      xiaohongshuPageAdapter.markProcessed(card);
    });
    cleanups.push(xiaohongshuPageAdapter.observe(document, onCard));

    const mount = getListMount();
    expect(onCard).toHaveBeenCalledOnce();
    expect(xiaohongshuPageAdapter.extractCandidate(mount)).toEqual({
      name: "小红书列表作品",
      url: `https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=feed-token&xsec_source=pc_feed`,
      type: DownloadType.xiaohongshu,
    });
    expect(mount.getAttribute(XIAOHONGSHU_PROCESSED_ATTRIBUTE)).toContain(
      NOTE_ID,
    );
  });

  it("prefers the signed list URL when a bare navigation link appears first", () => {
    installListCard();
    const renderer = document.querySelector("section.note-item");
    if (!renderer) throw new Error("Expected a Xiaohongshu list renderer");
    renderer.insertAdjacentHTML(
      "afterbegin",
      `<a href="/explore/${NOTE_ID}"></a>`,
    );

    expect(xiaohongshuPageAdapter.extractCandidate(getListMount())).toEqual({
      name: "小红书列表作品",
      url: `https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=feed-token&xsec_source=pc_feed`,
      type: DownloadType.xiaohongshu,
    });
  });

  it.each([
    `https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=detail-token&xsec_source=pc_feed`,
    `https://www.xiaohongshu.com/discovery/item/${NOTE_ID}?xsec_token=detail-token`,
    `https://www.xiaohongshu.com/user/profile/5abc1234567890abcdef1234/${NOTE_ID}?xsec_token=detail-token`,
  ])("extracts the current detail URL and title: %s", (href) => {
    installDetailPage({ href });
    const onCard = vi.fn((card: HTMLElement) => {
      xiaohongshuPageAdapter.markProcessed(card);
    });
    cleanups.push(xiaohongshuPageAdapter.observe(document, onCard));

    expect(onCard).toHaveBeenCalledOnce();
    expect(xiaohongshuPageAdapter.extractCandidate(getDetailMount())).toEqual({
      name: "小红书详情作品",
      url: href,
      type: DownloadType.xiaohongshu,
    });
  });

  it("recovers the signed feed URL for a bare detail route", () => {
    installDetailPage({
      href: `https://www.xiaohongshu.com/explore/${NOTE_ID}`,
    });
    document.body.insertAdjacentHTML(
      "beforeend",
      `
        <section class="note-item">
          <a class="cover" href="/explore/${NEXT_NOTE_ID}?xsec_token=unrelated-token"></a>
          <a class="cover" href="/explore/${NOTE_ID}?xsec_token=recovered-token&xsec_source=pc_feed"></a>
        </section>
      `,
    );

    const detailMount = getDetailMount();
    cleanups.push(xiaohongshuPageAdapter.observe(document, vi.fn()));
    document.querySelector("section.note-item")?.remove();

    expect(xiaohongshuPageAdapter.extractCandidate(detailMount)).toEqual({
      name: "小红书详情作品",
      url: `https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=recovered-token&xsec_source=pc_feed`,
      type: DownloadType.xiaohongshu,
    });
  });

  it("does not offer yt-dlp for image-only detail notes", () => {
    installDetailPage({ image: true });
    document
      .querySelector(".note-container")
      ?.insertAdjacentHTML(
        "beforeend",
        '<span class="duration">发布于 2 小时前</span>',
      );
    const onCard = vi.fn((card: HTMLElement) => {
      xiaohongshuPageAdapter.markProcessed(card);
    });
    cleanups.push(xiaohongshuPageAdapter.observe(document, onCard));

    expect(onCard).not.toHaveBeenCalled();
    expect(
      xiaohongshuPageAdapter.extractCandidate(getDetailMount()),
    ).toBeNull();
  });

  it("ignores image-only list cards", () => {
    installListCard({ video: false });
    expect(xiaohongshuPageAdapter.extractCandidate(getListMount())).toBeNull();
  });

  it("observes dynamically inserted note cards once", async () => {
    document.head.innerHTML =
      '<base href="https://www.xiaohongshu.com/search_result?keyword=video">';
    document.body.innerHTML = '<main class="feeds-container"></main>';
    const onCard = vi.fn((card: HTMLElement) => {
      xiaohongshuPageAdapter.markProcessed(card);
    });
    cleanups.push(xiaohongshuPageAdapter.observe(document, onCard));

    document.querySelector("main")?.insertAdjacentHTML(
      "beforeend",
      `
        <section class="note-item">
          <a class="cover" href="/explore/${NOTE_ID}?xsec_token=search-token&xsec_source=pc_search">
            <img alt="搜索结果" />
            <span class="play-icon"></span>
          </a>
          <div class="title">搜索作品</div>
        </section>
      `,
    );
    await flushMutations();
    await flushMutations();

    expect(onCard).toHaveBeenCalledOnce();
  });

  it("ignores related-search and promoted cards", () => {
    installListCard({ extraClass: "query-note-item" });
    expect(xiaohongshuPageAdapter.extractCandidate(getListMount())).toBeNull();

    installListCard();
    document.querySelector("section")?.setAttribute("data-ad", "true");
    expect(xiaohongshuPageAdapter.extractCandidate(getListMount())).toBeNull();
  });

  it("refreshes a virtualized card when its note URL changes", async () => {
    installListCard();
    const transport = vi.fn();
    cleanups.push(
      startPageRuntime({
        adapter: xiaohongshuPageAdapter,
        document,
        transport,
      }),
    );
    const mount = getListMount();
    const firstHost = getButtonHost(mount);

    mount.setAttribute(
      "href",
      `/explore/${NEXT_NOTE_ID}?xsec_token=next-token&xsec_source=pc_feed`,
    );
    const title = document.querySelector(".title");
    if (!title) throw new Error("Expected a virtualized card title");
    title.textContent = "下一条作品";
    await flushMutations();
    await flushMutations();

    expect(getButtonHost(mount)).not.toBe(firstHost);
    getButton(mount).click();
    expect(transport).toHaveBeenCalledWith({
      name: "下一条作品",
      url: `https://www.xiaohongshu.com/explore/${NEXT_NOTE_ID}?xsec_token=next-token&xsec_source=pc_feed`,
      type: DownloadType.xiaohongshu,
    });
  });

  it("clears only its own processed marker", () => {
    installListCard();
    const mount = getListMount();
    mount.setAttribute("data-other", "keep");

    xiaohongshuPageAdapter.markProcessed(mount);
    xiaohongshuPageAdapter.clearProcessed(mount);

    expect(mount.hasAttribute(XIAOHONGSHU_PROCESSED_ATTRIBUTE)).toBe(false);
    expect(mount.getAttribute("data-other")).toBe("keep");
  });
});
