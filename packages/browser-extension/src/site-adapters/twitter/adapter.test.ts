// @vitest-environment happy-dom

import { DownloadType } from "@mediago/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findPageAdapter } from "../registry";
import { TWITTER_PROCESSED_ATTRIBUTE, twitterPageAdapter } from "./adapter";

const cleanups: Array<() => void> = [];

function tweet(options?: {
  href?: string;
  text?: string;
  withVideo?: boolean;
}) {
  const href = options?.href ?? "/openai/status/1234567890/analytics";
  const text = options?.text ?? " Example X video ";
  const video =
    options?.withVideo === false
      ? ""
      : '<div data-testid="videoPlayer"><video></video></div>';
  return `
    <article data-testid="tweet">
      <div data-testid="tweetText">${text}</div>
      <a href="${href}">status</a>
      ${video}
    </article>
  `;
}

function getTweet() {
  const element = document.querySelector<HTMLElement>(
    'article[data-testid="tweet"]',
  );
  if (!element) throw new Error("Expected an X tweet fixture");
  return element;
}

function getVideoMount() {
  const element = document.querySelector<HTMLElement>(
    '[data-testid="videoPlayer"]',
  );
  if (!element) throw new Error("Expected an X video mount");
  return element;
}

async function flushMutations() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("X/Twitter page adapter", () => {
  it.each(["x.com", "www.x.com", "twitter.com", "mobile.twitter.com"])(
    "is selected for %s",
    (hostname) => {
      expect(findPageAdapter({ hostname })).toBe(twitterPageAdapter);
    },
  );

  it("extracts one canonical status candidate from a video tweet", () => {
    document.head.innerHTML = '<base href="https://x.com/">';
    document.body.innerHTML = tweet();
    const onCard = vi.fn((card: HTMLElement) => {
      twitterPageAdapter.markProcessed(card);
    });
    const cleanup = twitterPageAdapter.observe(document, onCard);
    cleanups.push(cleanup);

    const mount = getVideoMount();
    expect(onCard).toHaveBeenCalledOnce();
    expect(onCard).toHaveBeenCalledWith(mount);
    expect(twitterPageAdapter.extractCandidate(mount)).toEqual({
      name: "Example X video",
      url: "https://x.com/openai/status/1234567890",
      type: DownloadType.youtube,
    });
    expect(mount.getAttribute(TWITTER_PROCESSED_ATTRIBUTE)).toBe("true");
  });

  it("ignores image-only tweets until a video appears", async () => {
    document.head.innerHTML = '<base href="https://x.com/">';
    document.body.innerHTML = tweet({ withVideo: false });
    const onCard = vi.fn((card: HTMLElement) => {
      twitterPageAdapter.markProcessed(card);
    });
    const cleanup = twitterPageAdapter.observe(document, onCard);
    cleanups.push(cleanup);

    expect(onCard).not.toHaveBeenCalled();
    expect(getTweet().hasAttribute(TWITTER_PROCESSED_ATTRIBUTE)).toBe(false);

    getTweet().insertAdjacentHTML(
      "beforeend",
      '<div data-testid="videoPlayer"><video></video></div>',
    );
    await flushMutations();

    expect(onCard).toHaveBeenCalledOnce();
    expect(onCard).toHaveBeenCalledWith(getVideoMount());
  });

  it("rejects links that only contain status-like text outside the path", () => {
    document.head.innerHTML = '<base href="https://x.com/">';
    document.body.innerHTML = tweet({
      href: "/openai/media?next=/openai/status/1234567890",
    });

    expect(twitterPageAdapter.extractCandidate(getVideoMount())).toBeNull();
  });

  it("clears only its own processed marker", () => {
    document.head.innerHTML = '<base href="https://x.com/">';
    document.body.innerHTML = tweet();
    const mount = getVideoMount();

    twitterPageAdapter.markProcessed(mount);
    twitterPageAdapter.clearProcessed(mount);

    expect(mount.hasAttribute(TWITTER_PROCESSED_ATTRIBUTE)).toBe(false);
  });
});
