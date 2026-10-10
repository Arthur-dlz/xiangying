import { DownloadType } from "@mediago/common";
import type { PageAdapter, PageCandidate } from "../types";
import { matchesBilibiliPageLocation } from "./match";

export const BILIBILI_SELECTORS = {
  ad: ".bili-video-card__info--ad",
  card: ".bili-video-card__wrap",
  link: ".bili-video-card__image--link",
  observationTarget: ".bili-feed4-layout, .container",
  title: ".bili-video-card__info--tit",
} as const;

export const BILIBILI_PROCESSED_ATTRIBUTE = "data-mg-injected";

const SCALE_WRAPPER_CLASS = "__scale-wrap";

function markCard(card: HTMLElement, value: "ad" | "skip" | "true") {
  card.setAttribute(BILIBILI_PROCESSED_ATTRIBUTE, value);
}

function isExcludedCard(card: HTMLElement) {
  return (
    card.classList.contains(SCALE_WRAPPER_CLASS) ||
    card.querySelector(BILIBILI_SELECTORS.ad) !== null
  );
}

export const bilibiliPageAdapter: PageAdapter = {
  matches: matchesBilibiliPageLocation,

  observe(document, onCard) {
    const scan = () => {
      const selector = `${BILIBILI_SELECTORS.card}:not([${BILIBILI_PROCESSED_ATTRIBUTE}])`;
      const cards = document.querySelectorAll<HTMLElement>(selector);

      for (const card of cards) {
        if (card.classList.contains(SCALE_WRAPPER_CLASS)) {
          markCard(card, "skip");
          continue;
        }

        if (!card.querySelector(BILIBILI_SELECTORS.link)) continue;

        if (card.querySelector(BILIBILI_SELECTORS.ad)) {
          markCard(card, "ad");
          continue;
        }

        onCard(card);
      }
    };

    scan();

    const MutationObserverConstructor =
      document.defaultView?.MutationObserver ?? MutationObserver;
    const observer = new MutationObserverConstructor(scan);
    const target =
      document.querySelector(BILIBILI_SELECTORS.observationTarget) ??
      document.body ??
      document.documentElement;

    observer.observe(target, { childList: true, subtree: true });

    return () => observer.disconnect();
  },

  extractCandidate(card): PageCandidate | null {
    if (isExcludedCard(card)) return null;

    const link = card.querySelector<HTMLAnchorElement>(BILIBILI_SELECTORS.link);
    const href = link?.getAttribute("href")?.trim();
    if (!href) return null;

    let url: string;
    try {
      url = new URL(href, card.ownerDocument.baseURI).href;
    } catch {
      return null;
    }

    const name =
      card.querySelector(BILIBILI_SELECTORS.title)?.textContent?.trim() ?? "";

    return { name, url, type: DownloadType.bilibili };
  },

  markProcessed(card) {
    markCard(card, "true");
  },

  clearProcessed(card) {
    if (card.getAttribute(BILIBILI_PROCESSED_ATTRIBUTE) === "true") {
      card.removeAttribute(BILIBILI_PROCESSED_ATTRIBUTE);
    }
  },
};
