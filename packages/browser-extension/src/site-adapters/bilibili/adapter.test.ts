// @vitest-environment happy-dom

import { DownloadType } from "@mediago/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findPageAdapter } from "../registry";
import { bilibiliPageAdapter } from "./adapter";

const cleanups: Array<() => void> = [];

function observe(onCard: (card: HTMLElement) => void) {
  const cleanup = bilibiliPageAdapter.observe(document, onCard);
  cleanups.push(cleanup);
}

function getCard() {
  const card = document.querySelector<HTMLElement>(".bili-video-card__wrap");

  if (!card) throw new Error("Expected a Bilibili card");

  return card;
}

async function flushMutations() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("Bilibili page adapter", () => {
  it("recognizes an ordinary existing video card", () => {
    document.head.innerHTML = '<base href="https://www.bilibili.com/">';
    document.body.innerHTML = `
      <article class="bili-video-card__wrap">
        <a class="bili-video-card__image--link" href="/video/BV1example"></a>
        <h3 class="bili-video-card__info--tit"> Example title </h3>
      </article>
    `;
    const onCard = vi.fn((card: HTMLElement) => {
      bilibiliPageAdapter.markProcessed(card);
    });

    observe(onCard);

    const card = getCard();
    expect(onCard).toHaveBeenCalledOnce();
    expect(onCard).toHaveBeenCalledWith(card);
    expect(bilibiliPageAdapter.extractCandidate(card)).toEqual({
      name: "Example title",
      url: "https://www.bilibili.com/video/BV1example",
      type: DownloadType.bilibili,
    });
    expect(card.getAttribute("data-mg-injected")).toBe("true");
  });

  it("marks advertisements without reporting them", () => {
    document.body.innerHTML = `
      <article class="bili-video-card__wrap">
        <a class="bili-video-card__image--link" href="/video/ad"></a>
        <span class="bili-video-card__info--ad">AD</span>
      </article>
    `;
    const onCard = vi.fn();

    observe(onCard);

    expect(onCard).not.toHaveBeenCalled();
    expect(getCard().getAttribute("data-mg-injected")).toBe("ad");
  });

  it("leaves a card without a link eligible for later recognition", async () => {
    document.body.innerHTML = `
      <article class="bili-video-card__wrap">
        <h3 class="bili-video-card__info--tit">Late link</h3>
      </article>
    `;
    const onCard = vi.fn((card: HTMLElement) => {
      bilibiliPageAdapter.markProcessed(card);
    });

    observe(onCard);

    const card = getCard();
    expect(onCard).not.toHaveBeenCalled();
    expect(card.hasAttribute("data-mg-injected")).toBe(false);

    const link = document.createElement("a");
    link.className = "bili-video-card__image--link";
    link.href = "/video/BV1late";
    card.appendChild(link);
    await flushMutations();

    expect(onCard).toHaveBeenCalledOnce();
    expect(onCard).toHaveBeenCalledWith(card);
    expect(card.getAttribute("data-mg-injected")).toBe("true");
  });

  it("marks scale-wrapper cards as skipped", () => {
    document.body.innerHTML = `
      <article class="bili-video-card__wrap __scale-wrap">
        <a class="bili-video-card__image--link" href="/video/scaled"></a>
      </article>
    `;
    const onCard = vi.fn();

    observe(onCard);

    expect(onCard).not.toHaveBeenCalled();
    expect(getCard().getAttribute("data-mg-injected")).toBe("skip");
  });

  it("is selected only for the Bilibili homepage host", () => {
    expect(findPageAdapter({ hostname: "www.bilibili.com" })).toBe(
      bilibiliPageAdapter,
    );
    expect(findPageAdapter({ hostname: "example.com" })).toBeNull();
  });
});
