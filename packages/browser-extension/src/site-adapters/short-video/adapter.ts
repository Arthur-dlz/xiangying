import { DownloadType } from "@mediago/common";
import type { PageAdapter, PageCandidate } from "../types";
import { matchesShortVideoPageLocation } from "./match";

export const SHORT_VIDEO_SELECTORS = {
  card: [
    '[data-e2e="recommend-list-item-container"]',
    '[data-e2e="user-post-item"]',
    '[data-e2e="search-card-item"]',
    '[data-e2e="explore-item"]',
    '[data-e2e="feed-item"]',
    '[data-e2e="feed-active-video"]',
    '[data-e2e="aweme-item"]',
    "[data-aweme-id]",
    "article",
  ].join(", "),
  excluded: [
    "[data-ad]",
    '[data-e2e="ad-card"]',
    '[data-e2e="feed-ad"]',
    '[data-e2e="promoted-label"]',
  ].join(", "),
  mount: [
    '[data-e2e="video-player"]',
    '[data-e2e="browse-video"]',
    '[data-e2e="feed-video"]',
    '[data-e2e="video-card"]',
    "video",
    "picture",
    "img[alt]",
  ].join(", "),
  title: [
    '[data-e2e="video-desc"]',
    '[data-e2e="browse-video-desc"]',
    '[data-e2e="search-card-desc"]',
    '[data-e2e="explore-card-desc"]',
    '[data-e2e="feed-video-desc"]',
    "h1",
  ].join(", "),
} as const;

export const SHORT_VIDEO_PROCESSED_ATTRIBUTE = "data-mg-short-video-injected";

function canonicalShortVideoPostURL(
  value: string,
  baseURL: string,
): string | null {
  try {
    const url = new URL(value, baseURL);
    const hostname = url.hostname.toLowerCase();

    if (
      hostname === "tiktok.com" ||
      hostname === "www.tiktok.com" ||
      hostname === "m.tiktok.com" ||
      hostname === "tiktokv.com" ||
      hostname === "www.tiktokv.com"
    ) {
      const videoMatch = url.pathname.match(
        /^\/@([^/]+)\/video\/(\d+)(?:\/|$)/,
      );
      if (videoMatch) {
        return `https://www.tiktok.com/@${videoMatch[1]}/video/${videoMatch[2]}`;
      }

      const shareMatch = url.pathname.match(/^\/share\/video\/(\d+)(?:\/|$)/);
      if (shareMatch) {
        return `https://www.tiktok.com/share/video/${shareMatch[1]}`;
      }
      return null;
    }

    if (hostname === "douyin.com" || hostname === "www.douyin.com") {
      const match = url.pathname.match(/^\/video\/(\d+)(?:\/|$)/);
      if (match) {
        return `https://www.douyin.com/video/${match[1]}`;
      }

      const modalID = url.searchParams.get("modal_id");
      if (modalID && /^\d+$/.test(modalID)) {
        return `https://www.douyin.com/video/${modalID}`;
      }
      return null;
    }
  } catch {
    return null;
  }

  return null;
}

function getRenderer(card: HTMLElement): HTMLElement {
  const knownCard = card.closest<HTMLElement>(SHORT_VIDEO_SELECTORS.card);
  if (knownCard) return knownCard;

  const main = card.closest<HTMLElement>("main");
  return main ?? card.parentElement ?? card;
}

function isExcludedRenderer(renderer: HTMLElement): boolean {
  return (
    renderer.matches(SHORT_VIDEO_SELECTORS.excluded) ||
    renderer.closest(SHORT_VIDEO_SELECTORS.excluded) !== null ||
    renderer.querySelector(SHORT_VIDEO_SELECTORS.excluded) !== null
  );
}

function getTikTokFeedPostURL(renderer: HTMLElement): string | null {
  const player = Array.from(
    renderer.querySelectorAll<HTMLElement>('[id^="xgwrapper-"]'),
  ).find((element) => /-(\d{10,})$/.test(element.id));
  const postID = player?.id.match(/-(\d{10,})$/)?.[1];
  if (!postID) return null;

  const authorLinks = renderer.querySelectorAll<HTMLAnchorElement>(
    'a[data-e2e="video-author-avatar"][href], a[href^="/@"]',
  );
  for (const link of authorLinks) {
    try {
      const url = new URL(
        link.getAttribute("href") ?? "",
        renderer.ownerDocument.baseURI,
      );
      const hostname = url.hostname.toLowerCase();
      if (
        hostname !== "tiktok.com" &&
        hostname !== "www.tiktok.com" &&
        hostname !== "m.tiktok.com"
      ) {
        continue;
      }
      const author = url.pathname.match(/^\/@([^/]+)(?:\/|$)/)?.[1];
      if (author) {
        return `https://www.tiktok.com/@${author}/video/${postID}`;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function getStructuredPostURL(renderer: HTMLElement): string | null {
  const douyinCard = renderer.matches("[data-aweme-id]")
    ? renderer
    : renderer.closest<HTMLElement>("[data-aweme-id]");
  const awemeID = douyinCard?.getAttribute("data-aweme-id")?.trim();
  if (awemeID && /^\d+$/.test(awemeID)) {
    return `https://www.douyin.com/video/${awemeID}`;
  }

  return getTikTokFeedPostURL(renderer);
}

function isDetailRenderer(renderer: HTMLElement): boolean {
  return (
    renderer.matches(
      'main, body, html, [data-e2e="feed-active-video"], [data-e2e="modal-video-container"]',
    ) || renderer.closest('[data-e2e="modal-video-container"]') !== null
  );
}

function getPostURL(renderer: HTMLElement): string | null {
  const currentURL = canonicalShortVideoPostURL(
    renderer.ownerDocument.baseURI,
    renderer.ownerDocument.baseURI,
  );
  if (currentURL && isDetailRenderer(renderer)) return currentURL;

  for (const link of renderer.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = link.getAttribute("href")?.trim();
    if (!href) continue;
    const canonical = canonicalShortVideoPostURL(
      href,
      renderer.ownerDocument.baseURI,
    );
    if (canonical) return canonical;
  }

  return getStructuredPostURL(renderer) ?? currentURL;
}

function getMount(renderer: HTMLElement): HTMLElement | null {
  const media = renderer.querySelector<HTMLElement>(
    SHORT_VIDEO_SELECTORS.mount,
  );
  if (!media) return null;
  if (media.matches("video, picture, img")) {
    return media.parentElement ?? renderer;
  }
  return media;
}

function getTitle(renderer: HTMLElement): string {
  const title = renderer.querySelector<HTMLElement>(
    SHORT_VIDEO_SELECTORS.title,
  );
  const visibleTitle =
    title?.getAttribute("title")?.trim() ||
    title?.getAttribute("aria-label")?.trim() ||
    title?.textContent?.trim();
  if (visibleTitle) return visibleTitle;

  return (
    renderer.querySelector<HTMLImageElement>("img[alt]")?.alt.trim() ||
    renderer.ownerDocument.title.trim()
  );
}

export const shortVideoPageAdapter: PageAdapter = {
  matches: matchesShortVideoPageLocation,

  observe(document, onCard) {
    const emitRenderer = (renderer: HTMLElement) => {
      if (isExcludedRenderer(renderer) || !getPostURL(renderer)) return;
      const mount = getMount(renderer);
      if (!mount || mount.hasAttribute(SHORT_VIDEO_PROCESSED_ATTRIBUTE)) {
        return;
      }
      onCard(mount);
    };

    const scan = () => {
      for (const renderer of document.querySelectorAll<HTMLElement>(
        SHORT_VIDEO_SELECTORS.card,
      )) {
        emitRenderer(renderer);
      }

      if (!canonicalShortVideoPostURL(document.baseURI, document.baseURI)) {
        return;
      }
      const detailRoot =
        document.querySelector<HTMLElement>('[data-e2e="feed-active-video"]') ??
        document.querySelector<HTMLElement>("main") ??
        document.body ??
        document.documentElement;
      emitRenderer(detailRoot);
    };

    scan();

    const MutationObserverConstructor =
      document.defaultView?.MutationObserver ?? MutationObserver;
    const observer = new MutationObserverConstructor(scan);
    observer.observe(document.body ?? document.documentElement, {
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  },

  extractCandidate(card): PageCandidate | null {
    const renderer = getRenderer(card);
    if (isExcludedRenderer(renderer)) return null;

    const url = getPostURL(renderer);
    if (!url || !getMount(renderer)) return null;

    return {
      name: getTitle(renderer),
      url,
      type: DownloadType.youtube,
    };
  },

  markProcessed(card) {
    card.setAttribute(SHORT_VIDEO_PROCESSED_ATTRIBUTE, "true");
  },

  clearProcessed(card) {
    if (card.getAttribute(SHORT_VIDEO_PROCESSED_ATTRIBUTE) === "true") {
      card.removeAttribute(SHORT_VIDEO_PROCESSED_ATTRIBUTE);
    }
  },
};
