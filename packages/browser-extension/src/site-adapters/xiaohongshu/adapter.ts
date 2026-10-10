import { DownloadType } from "@mediago/common";
import type { PageAdapter, PageCandidate } from "../types";
import { matchesXiaohongshuPageLocation } from "./match";

export const XIAOHONGSHU_SELECTORS = {
  card: [
    "section.note-item",
    ".feeds-container .note-item",
    ".note-detail-mask .note-container",
    ".note-container",
  ].join(", "),
  excluded: [
    "section.query-note-item",
    ".query-note-item",
    "[data-ad]",
    "[data-promoted]",
  ].join(", "),
  mount: [
    "a.cover[href]",
    ".media-container",
    ".video-player",
    "xg-player",
    "video",
    ".swiper-container",
    "picture",
    "img",
  ].join(", "),
  title: [
    "#detail-title",
    ".footer .title",
    ".note-item .title",
    ".title",
  ].join(", "),
} as const;

export const XIAOHONGSHU_PROCESSED_ATTRIBUTE = "data-mg-xiaohongshu-injected";

const MAX_SIGNED_NOTE_URLS = 500;
const signedNoteURLsByDocument = new WeakMap<Document, Map<string, string>>();

function canonicalXiaohongshuNoteURL(
  value: string,
  baseURL: string,
): string | null {
  try {
    const url = new URL(value, baseURL);
    const hostname = url.hostname.toLowerCase();
    const isXiaohongshu =
      hostname === "xiaohongshu.com" || hostname.endsWith(".xiaohongshu.com");
    const isShortLink =
      hostname === "xhslink.com" || hostname.endsWith(".xhslink.com");
    if (isShortLink) {
      if (url.pathname === "/") return null;
      url.hash = "";
      return url.toString();
    }
    if (!isXiaohongshu) return null;

    const isNotePath =
      /^\/(?:explore|discovery\/item)\/[^/]+(?:\/|$)/i.test(url.pathname) ||
      /^\/user\/profile\/[^/]+\/[^/]+(?:\/|$)/i.test(url.pathname);
    if (!isNotePath) return null;

    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function getRenderer(card: HTMLElement): HTMLElement {
  return (
    card.closest<HTMLElement>(XIAOHONGSHU_SELECTORS.card) ??
    card.closest<HTMLElement>("main") ??
    card.parentElement ??
    card
  );
}

function isExcludedRenderer(renderer: HTMLElement): boolean {
  return (
    renderer.matches(XIAOHONGSHU_SELECTORS.excluded) ||
    renderer.closest(XIAOHONGSHU_SELECTORS.excluded) !== null ||
    renderer.querySelector(XIAOHONGSHU_SELECTORS.excluded) !== null
  );
}

function getAnchorNoteURL(renderer: HTMLElement): string | null {
  const anchors = renderer.matches("a[href]")
    ? [renderer as HTMLAnchorElement]
    : Array.from(renderer.querySelectorAll<HTMLAnchorElement>("a[href]"));
  let fallback: string | null = null;
  for (const anchor of anchors) {
    const href = anchor.getAttribute("href")?.trim();
    if (!href) continue;
    const canonical = canonicalXiaohongshuNoteURL(
      href,
      renderer.ownerDocument.baseURI,
    );
    if (!canonical) continue;
    if (hasXsecToken(canonical)) return canonical;
    fallback ??= canonical;
  }
  return fallback;
}

function getNoteID(value: string, baseURL: string): string | null {
  const canonical = canonicalXiaohongshuNoteURL(value, baseURL);
  if (!canonical) return null;

  try {
    const parts = new URL(canonical).pathname.split("/").filter(Boolean);
    if (parts[0] === "explore") return parts[1] ?? null;
    if (parts[0] === "discovery" && parts[1] === "item") {
      return parts[2] ?? null;
    }
    if (parts[0] === "user" && parts[1] === "profile") {
      return parts[3] ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

function hasXsecToken(value: string): boolean {
  try {
    return Boolean(new URL(value).searchParams.get("xsec_token")?.trim());
  } catch {
    return false;
  }
}

function rememberSignedDocumentNoteURLs(document: Document): void {
  let signedURLs = signedNoteURLsByDocument.get(document);
  if (!signedURLs) {
    signedURLs = new Map();
    signedNoteURLsByDocument.set(document, signedURLs);
  }

  for (const anchor of document.querySelectorAll<HTMLAnchorElement>(
    'a[href*="/explore/"], a[href*="/discovery/item/"], a[href*="/user/profile/"]',
  )) {
    const href = anchor.getAttribute("href")?.trim();
    if (!href) continue;
    const canonical = canonicalXiaohongshuNoteURL(href, document.baseURI);
    if (!canonical || !hasXsecToken(canonical)) continue;
    const noteID = getNoteID(canonical, document.baseURI);
    if (!noteID) continue;

    signedURLs.delete(noteID);
    signedURLs.set(noteID, canonical);
    while (signedURLs.size > MAX_SIGNED_NOTE_URLS) {
      const oldest = signedURLs.keys().next().value;
      if (!oldest) break;
      signedURLs.delete(oldest);
    }
  }
}

function getSignedDocumentNoteURL(
  renderer: HTMLElement,
  targetURL: string,
): string | null {
  const document = renderer.ownerDocument;
  const targetID = getNoteID(targetURL, document.baseURI);
  if (!targetID) return null;

  rememberSignedDocumentNoteURLs(document);
  return signedNoteURLsByDocument.get(document)?.get(targetID) ?? null;
}

function isDetailRenderer(renderer: HTMLElement): boolean {
  return (
    renderer.matches(".note-container, .note-detail-mask, main") ||
    renderer.closest(".note-detail-mask") !== null ||
    renderer.querySelector("#detail-title") !== null
  );
}

function getNoteURL(renderer: HTMLElement): string | null {
  const anchorURL = getAnchorNoteURL(renderer);
  if (!isDetailRenderer(renderer)) return anchorURL;

  const pageURL = canonicalXiaohongshuNoteURL(
    renderer.ownerDocument.baseURI,
    renderer.ownerDocument.baseURI,
  );
  const targetURL = pageURL ?? anchorURL;
  if (!targetURL || hasXsecToken(targetURL)) return targetURL;

  // Xiaohongshu's detail overlay may replace the address bar with a bare
  // /explore/<id> route while retaining the original signed link on the
  // underlying feed card. Recover that exact note's xsec parameters so
  // yt-dlp receives the URL that the page itself successfully loaded.
  return getSignedDocumentNoteURL(renderer, targetURL) ?? targetURL;
}

function getMount(renderer: HTMLElement): HTMLElement | null {
  if (renderer.matches("a.cover[href], .media-container, .video-player")) {
    return renderer;
  }
  const media = renderer.querySelector<HTMLElement>(
    XIAOHONGSHU_SELECTORS.mount,
  );
  if (!media) return null;
  if (media.matches("video, picture, img, xg-player")) {
    return media.parentElement ?? renderer;
  }
  return media;
}

function hasVideoMedia(renderer: HTMLElement): boolean {
  return (
    renderer.matches('[data-note-type="video"], [data-type="video"]') ||
    renderer.querySelector(
      [
        "video",
        "xg-player",
        ".video-player",
        ".video-duration",
        ".play-icon",
        '[data-note-type="video"]',
        '[data-type="video"]',
      ].join(", "),
    ) !== null
  );
}

function getTitle(renderer: HTMLElement): string {
  const title = renderer.querySelector<HTMLElement>(
    XIAOHONGSHU_SELECTORS.title,
  );
  const visible =
    title?.getAttribute("title")?.trim() ||
    title?.getAttribute("aria-label")?.trim() ||
    title?.textContent?.trim();
  if (visible) return visible;

  const alt = renderer.querySelector<HTMLImageElement>("img[alt]")?.alt.trim();
  if (alt) return alt;
  return renderer.ownerDocument.title.trim() || "小红书作品";
}

export const xiaohongshuPageAdapter: PageAdapter = {
  matches: matchesXiaohongshuPageLocation,

  observe(document, onCard) {
    const emitRenderer = (renderer: HTMLElement) => {
      if (isExcludedRenderer(renderer)) return;
      if (!hasVideoMedia(renderer)) return;
      const url = getNoteURL(renderer);
      const mount = getMount(renderer);
      if (!url || !mount) return;
      if (mount.getAttribute(XIAOHONGSHU_PROCESSED_ATTRIBUTE) === url) return;
      onCard(mount);
    };

    const scan = () => {
      rememberSignedDocumentNoteURLs(document);
      for (const renderer of document.querySelectorAll<HTMLElement>(
        XIAOHONGSHU_SELECTORS.card,
      )) {
        emitRenderer(renderer);
      }

      if (
        !canonicalXiaohongshuNoteURL(document.baseURI, document.baseURI) ||
        document.querySelector(".note-detail-mask .note-container")
      ) {
        return;
      }
      const detailRoot =
        document.querySelector<HTMLElement>(".note-container") ??
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
      attributes: true,
      attributeFilter: ["href"],
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  },

  extractCandidate(card): PageCandidate | null {
    const renderer = getRenderer(card);
    if (isExcludedRenderer(renderer)) return null;
    if (!hasVideoMedia(renderer)) return null;
    const url = getNoteURL(renderer);
    if (!url || !getMount(renderer)) return null;
    return {
      name: getTitle(renderer),
      url,
      type: DownloadType.xiaohongshu,
    };
  },

  markProcessed(card) {
    const url = this.extractCandidate(card)?.url;
    if (url) card.setAttribute(XIAOHONGSHU_PROCESSED_ATTRIBUTE, url);
  },

  clearProcessed(card) {
    card.removeAttribute(XIAOHONGSHU_PROCESSED_ATTRIBUTE);
  },
};
