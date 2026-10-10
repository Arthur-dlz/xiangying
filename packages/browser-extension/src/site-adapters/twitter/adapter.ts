import { DownloadType } from "@mediago/common";
import type { PageAdapter, PageCandidate } from "../types";
import { matchesTwitterPageLocation } from "./match";

export const TWITTER_SELECTORS = {
  card: 'article[data-testid="tweet"]',
  promoted: '[data-testid="promotedIndicator"]',
  text: '[data-testid="tweetText"]',
  video: '[data-testid="videoPlayer"], [data-testid="videoComponent"], video',
} as const;

export const TWITTER_PROCESSED_ATTRIBUTE = "data-mg-twitter-injected";

function canonicalStatusURL(value: string, baseURL: string): string | null {
  try {
    const url = new URL(value, baseURL);
    if (!matchesTwitterPageLocation(url)) return null;
    const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)(?:\/|$)/);
    if (!match) return null;
    url.pathname = `/${match[1]}/status/${match[2]}`;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function getTweet(card: HTMLElement): HTMLElement | null {
  return card.closest<HTMLElement>(TWITTER_SELECTORS.card);
}

function getStatusURL(tweet: HTMLElement): string | null {
  const timestamp = tweet.querySelector("time");
  const timestampLink = timestamp?.closest<HTMLAnchorElement>("a[href]");
  const timestampURL = timestampLink?.getAttribute("href");
  if (timestampURL) {
    const canonical = canonicalStatusURL(
      timestampURL,
      tweet.ownerDocument.baseURI,
    );
    if (canonical) return canonical;
  }

  for (const link of tweet.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = link.getAttribute("href")?.trim();
    if (!href) continue;
    const canonical = canonicalStatusURL(href, tweet.ownerDocument.baseURI);
    if (canonical) return canonical;
  }

  return null;
}

function getVideoMount(tweet: HTMLElement): HTMLElement | null {
  const video = tweet.querySelector<HTMLElement>(TWITTER_SELECTORS.video);
  if (!video) return null;
  return (
    video.closest<HTMLElement>('[data-testid="videoPlayer"]') ??
    video.closest<HTMLElement>('[data-testid="videoComponent"]') ??
    video.parentElement ??
    video
  );
}

export const twitterPageAdapter: PageAdapter = {
  matches: matchesTwitterPageLocation,

  observe(document, onCard) {
    const scan = () => {
      const tweets = document.querySelectorAll<HTMLElement>(
        TWITTER_SELECTORS.card,
      );
      for (const tweet of tweets) {
        if (tweet.querySelector(TWITTER_SELECTORS.promoted)) continue;
        if (!getStatusURL(tweet)) continue;
        const mount = getVideoMount(tweet);
        if (!mount || mount.hasAttribute(TWITTER_PROCESSED_ATTRIBUTE)) continue;
        onCard(mount);
      }
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
    const tweet = getTweet(card);
    if (!tweet || tweet.querySelector(TWITTER_SELECTORS.promoted)) return null;
    const url = getStatusURL(tweet);
    if (!url || !getVideoMount(tweet)) return null;
    const name =
      tweet.querySelector(TWITTER_SELECTORS.text)?.textContent?.trim() ?? "";
    return { name, url, type: DownloadType.youtube };
  },

  markProcessed(card) {
    card.setAttribute(TWITTER_PROCESSED_ATTRIBUTE, "true");
  },

  clearProcessed(card) {
    if (card.getAttribute(TWITTER_PROCESSED_ATTRIBUTE) === "true") {
      card.removeAttribute(TWITTER_PROCESSED_ATTRIBUTE);
    }
  },
};
