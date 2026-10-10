import { DownloadType, matchPageUrl } from "@mediago/common";
import type { PageAdapter, PageCandidate } from "../types";
import { matchesYoutubePageLocation } from "./match";

export const YOUTUBE_SELECTORS = {
  card: [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-reel-item-renderer",
    "yt-lockup-view-model",
    "ytm-rich-item-renderer",
    "ytm-video-with-context-renderer",
    "ytm-compact-video-renderer",
    "ytm-reel-item-renderer",
    "ytmusic-responsive-list-item-renderer",
    "ytmusic-two-row-item-renderer",
  ].join(", "),
  excluded: [
    "[is-ad]",
    "ytd-ad-slot-renderer",
    "ytd-display-ad-renderer",
    "ytd-promoted-sparkles-web-renderer",
    "ytd-promoted-video-renderer",
  ].join(", "),
  mount: [
    "ytd-thumbnail",
    "yt-thumbnail-view-model",
    "ytm-thumbnail-cover",
    ".yt-lockup-view-model__content-image",
    "a#thumbnail",
  ].join(", "),
  observationTarget: "ytd-app, ytm-app, ytmusic-app",
  title: [
    "#video-title",
    "#video-title-link",
    ".yt-lockup-metadata-view-model__title",
    "yt-formatted-string.title",
    ".media-item-headline",
    "h3",
  ].join(", "),
} as const;

export const YOUTUBE_PROCESSED_ATTRIBUTE = "data-mg-youtube-injected";

function isYoutubeVideoUrl(url: string): boolean {
  return matchPageUrl(url)?.type === DownloadType.youtube;
}

function getRenderer(card: HTMLElement): HTMLElement | null {
  return card.closest<HTMLElement>(YOUTUBE_SELECTORS.card);
}

function isExcludedRenderer(renderer: HTMLElement): boolean {
  return (
    renderer.matches(YOUTUBE_SELECTORS.excluded) ||
    renderer.closest(YOUTUBE_SELECTORS.excluded) !== null ||
    renderer.querySelector(YOUTUBE_SELECTORS.excluded) !== null
  );
}

function getVideoLink(renderer: HTMLElement): HTMLAnchorElement | null {
  for (const link of renderer.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = link.getAttribute("href")?.trim();
    if (!href) continue;

    try {
      if (
        isYoutubeVideoUrl(new URL(href, renderer.ownerDocument.baseURI).href)
      ) {
        return link;
      }
    } catch {
      // Ignore malformed links and keep looking for the card's video URL.
    }
  }

  return null;
}

function getMount(renderer: HTMLElement, link: HTMLAnchorElement): HTMLElement {
  return (
    renderer.querySelector<HTMLElement>(YOUTUBE_SELECTORS.mount) ??
    link.parentElement ??
    renderer
  );
}

function getTitle(renderer: HTMLElement, link: HTMLAnchorElement): string {
  const title = renderer.querySelector<HTMLElement>(YOUTUBE_SELECTORS.title);
  return (
    title?.getAttribute("title")?.trim() ||
    title?.textContent?.trim() ||
    link.getAttribute("aria-label")?.trim() ||
    ""
  );
}

export const youtubePageAdapter: PageAdapter = {
  matches: matchesYoutubePageLocation,

  observe(document, onCard) {
    const scan = () => {
      const renderers = document.querySelectorAll<HTMLElement>(
        YOUTUBE_SELECTORS.card,
      );

      for (const renderer of renderers) {
        if (isExcludedRenderer(renderer)) continue;

        const link = getVideoLink(renderer);
        if (!link) continue;

        const mount = getMount(renderer, link);
        if (mount.hasAttribute(YOUTUBE_PROCESSED_ATTRIBUTE)) continue;
        onCard(mount);
      }
    };

    scan();

    const MutationObserverConstructor =
      document.defaultView?.MutationObserver ?? MutationObserver;
    const observer = new MutationObserverConstructor(scan);
    const target =
      document.querySelector(YOUTUBE_SELECTORS.observationTarget) ??
      document.body ??
      document.documentElement;

    observer.observe(target, { childList: true, subtree: true });

    return () => observer.disconnect();
  },

  extractCandidate(card): PageCandidate | null {
    const renderer = getRenderer(card);
    if (!renderer || isExcludedRenderer(renderer)) return null;

    const link = getVideoLink(renderer);
    const href = link?.getAttribute("href")?.trim();
    if (!link || !href) return null;

    let url: string;
    try {
      url = new URL(href, card.ownerDocument.baseURI).href;
    } catch {
      return null;
    }
    if (!isYoutubeVideoUrl(url)) return null;

    return {
      name: getTitle(renderer, link),
      url,
      type: DownloadType.youtube,
    };
  },

  markProcessed(card) {
    card.setAttribute(YOUTUBE_PROCESSED_ATTRIBUTE, "true");
  },

  clearProcessed(card) {
    if (card.getAttribute(YOUTUBE_PROCESSED_ATTRIBUTE) === "true") {
      card.removeAttribute(YOUTUBE_PROCESSED_ATTRIBUTE);
    }
  },
};
