// @vitest-environment happy-dom

import { DownloadType } from "@mediago/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findPageAdapter } from "../registry";
import { YOUTUBE_PROCESSED_ATTRIBUTE, youtubePageAdapter } from "./adapter";

const cleanups: Array<() => void> = [];

function observe(onCard: (card: HTMLElement) => void) {
  const cleanup = youtubePageAdapter.observe(document, onCard);
  cleanups.push(cleanup);
}

function installCard(
  href = "/watch?v=video-id",
  title = "YouTube video title",
) {
  document.head.innerHTML = '<base href="https://www.youtube.com/">';
  document.body.innerHTML = `
    <ytd-app>
      <ytd-rich-item-renderer>
        <ytd-thumbnail>
          <a id="thumbnail" href="${href}" aria-label="Thumbnail title"></a>
        </ytd-thumbnail>
        <a id="video-title-link" href="${href}">
          <span id="video-title" title="${title}">${title}</span>
        </a>
      </ytd-rich-item-renderer>
    </ytd-app>
  `;
  const thumbnail = document.querySelector<HTMLElement>("ytd-thumbnail");
  if (!thumbnail) throw new Error("Expected a YouTube thumbnail");
  return thumbnail;
}

async function flushMutations() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("YouTube page adapter", () => {
  it("recognizes a homepage video card and mounts on its thumbnail", () => {
    const thumbnail = installCard();
    const onCard = vi.fn((card: HTMLElement) => {
      youtubePageAdapter.markProcessed(card);
    });

    observe(onCard);

    expect(onCard).toHaveBeenCalledOnce();
    expect(onCard).toHaveBeenCalledWith(thumbnail);
    expect(youtubePageAdapter.extractCandidate(thumbnail)).toEqual({
      name: "YouTube video title",
      url: "https://www.youtube.com/watch?v=video-id",
      type: DownloadType.youtube,
    });
    expect(thumbnail.getAttribute(YOUTUBE_PROCESSED_ATTRIBUTE)).toBe("true");
  });

  it.each([
    ["short", "/shorts/short-id"],
    ["live stream", "/live/live-id"],
  ])("recognizes a %s card URL", (_label, href) => {
    const thumbnail = installCard(href);

    expect(youtubePageAdapter.extractCandidate(thumbnail)?.url).toBe(
      `https://www.youtube.com${href}`,
    );
  });

  it("ignores ad renderers", () => {
    document.head.innerHTML = '<base href="https://www.youtube.com/">';
    document.body.innerHTML = `
      <ytd-app>
        <ytd-ad-slot-renderer>
          <ytd-video-renderer>
            <ytd-thumbnail><a id="thumbnail" href="/watch?v=ad"></a></ytd-thumbnail>
          </ytd-video-renderer>
        </ytd-ad-slot-renderer>
      </ytd-app>
    `;
    const onCard = vi.fn();

    observe(onCard);

    expect(onCard).not.toHaveBeenCalled();
  });

  it("waits for a dynamically inserted video card", async () => {
    document.head.innerHTML = '<base href="https://www.youtube.com/">';
    document.body.innerHTML = "<ytd-app></ytd-app>";
    const onCard = vi.fn((card: HTMLElement) => {
      youtubePageAdapter.markProcessed(card);
    });
    observe(onCard);

    document.querySelector("ytd-app")?.insertAdjacentHTML(
      "beforeend",
      `
        <ytd-video-renderer>
          <ytd-thumbnail><a id="thumbnail" href="/watch?v=late"></a></ytd-thumbnail>
          <h3><a href="/watch?v=late">Late video</a></h3>
        </ytd-video-renderer>
      `,
    );
    await flushMutations();

    expect(onCard).toHaveBeenCalledOnce();
    const card = onCard.mock.calls[0]?.[0];
    if (!card) throw new Error("Expected a dynamically observed card");
    expect(youtubePageAdapter.extractCandidate(card)).toMatchObject({
      name: "Late video",
      url: "https://www.youtube.com/watch?v=late",
    });
  });

  it("supports current and mobile YouTube hosts", () => {
    expect(findPageAdapter({ hostname: "www.youtube.com" })).toBe(
      youtubePageAdapter,
    );
    expect(findPageAdapter({ hostname: "m.youtube.com" })).toBe(
      youtubePageAdapter,
    );
    expect(findPageAdapter({ hostname: "music.youtube.com" })).toBe(
      youtubePageAdapter,
    );
  });
});
