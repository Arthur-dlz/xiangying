// @vitest-environment happy-dom

import { DownloadType } from "@mediago/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startPageRuntime } from "./runtime";
import { bilibiliPageAdapter } from "./site-adapters/bilibili/adapter";

const cleanups: Array<() => void> = [];

function start(transport = vi.fn()) {
  const cleanup = startPageRuntime({
    adapter: bilibiliPageAdapter,
    document,
    transport,
  });
  cleanups.push(cleanup);
  return { cleanup, transport };
}

function videoCard(href = "/video/BV1initial", title = "Initial title") {
  return `
    <article class="bili-video-card__wrap">
      <a class="bili-video-card__image--link" href="${href}"></a>
      <h3 class="bili-video-card__info--tit">${title}</h3>
    </article>
  `;
}

function getCard() {
  const card = document.querySelector<HTMLElement>(".bili-video-card__wrap");

  if (!card) throw new Error("Expected a Bilibili card");

  return card;
}

function getButtonHost(card = getCard()) {
  const host = card.querySelector<HTMLElement>("mediago-download-button");

  if (!host) throw new Error("Expected an injected button host");

  return host;
}

function getShadowButton(card = getCard()) {
  const button =
    getButtonHost(card).shadowRoot?.querySelector<HTMLButtonElement>(
      ".mg-button",
    );

  if (!button) throw new Error("Expected a Shadow DOM button");

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

describe("page runtime", () => {
  it("injects a native, named, focusable button", () => {
    document.body.innerHTML = videoCard();

    start();
    const button = getShadowButton();

    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");
    expect(button.textContent).toBe("下载");
    expect(button.tabIndex).toBe(0);
    button.focus();
    expect(getButtonHost().shadowRoot?.activeElement).toBe(button);
  });

  it("resets native button chrome and preserves a visible keyboard focus", () => {
    document.body.innerHTML = videoCard();

    start();
    const style = getButtonHost().shadowRoot?.querySelector("style");

    expect(style?.textContent).toMatch(/\.mg-button\s*\{[^}]*appearance:/s);
    expect(style?.textContent).toMatch(/\.mg-button\s*\{[^}]*border:/s);
    expect(style?.textContent).toMatch(/\.mg-button\s*\{[^}]*font:/s);
    expect(style?.textContent).toMatch(
      /\.mg-button:focus-visible\s*\{[^}]*outline:/s,
    );
  });

  it("injects exactly one Shadow DOM button across repeated mutations", async () => {
    document.body.innerHTML = videoCard();

    start();
    const card = getCard();
    card.appendChild(document.createElement("span"));
    document.body.appendChild(document.createElement("div"));
    await flushMutations();

    expect(card.querySelectorAll("mediago-download-button")).toHaveLength(1);
    expect(getShadowButton(card).textContent).toBe("下载");
  });

  it("prevents navigation and propagation when clicked", () => {
    document.body.innerHTML = videoCard();
    const propagated = vi.fn();
    getCard().addEventListener("click", propagated);
    start();
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
    });

    getShadowButton().dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(propagated).not.toHaveBeenCalled();
  });

  it("extracts the current absolute URL and title at click time", () => {
    document.head.innerHTML = '<base href="https://www.bilibili.com/">';
    document.body.innerHTML = videoCard();
    const { transport } = start();
    const card = getCard();
    const link = card.querySelector<HTMLAnchorElement>(
      ".bili-video-card__image--link",
    );
    const title = card.querySelector<HTMLElement>(
      ".bili-video-card__info--tit",
    );
    if (!link || !title) throw new Error("Expected card metadata");

    link.href = "/video/BV1current?from=feed";
    title.textContent = " Current title ";
    getShadowButton(card).click();

    expect(transport).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledWith({
      name: "Current title",
      url: "https://www.bilibili.com/video/BV1current?from=feed",
      type: DownloadType.bilibili,
    });
  });

  it("injects a button into a dynamically inserted card", async () => {
    start();

    document.body.insertAdjacentHTML("beforeend", videoCard());
    await flushMutations();

    expect(getCard().querySelectorAll("mediago-download-button")).toHaveLength(
      1,
    );
  });

  it("releases a removed card and reinjects it when it returns", async () => {
    document.body.innerHTML = videoCard();
    const { transport } = start();
    const card = getCard();
    const oldButton = getShadowButton(card);

    card.remove();
    await flushMutations();

    oldButton.click();
    expect(transport).not.toHaveBeenCalled();
    expect(card.hasAttribute("data-mg-injected")).toBe(false);
    expect(card.querySelector("mediago-download-button")).toBeNull();

    document.body.append(card);
    await flushMutations();

    expect(getShadowButton(card)).not.toBe(oldButton);
    getShadowButton(card).click();
    expect(transport).toHaveBeenCalledOnce();
  });

  it("disconnects observation during cleanup", async () => {
    const { cleanup } = start();

    cleanup();
    document.body.insertAdjacentHTML("beforeend", videoCard());
    await flushMutations();

    expect(getCard().querySelector("mediago-download-button")).toBeNull();
  });

  it("disables the old button and installs one usable button after restart", () => {
    document.body.innerHTML = videoCard();
    const first = start();
    const oldButton = getShadowButton();

    first.cleanup();
    oldButton.click();

    expect(first.transport).not.toHaveBeenCalled();
    expect(getCard().querySelector("mediago-download-button")).toBeNull();
    expect(getCard().hasAttribute("data-mg-injected")).toBe(false);

    const second = start();
    getShadowButton().click();

    expect(getCard().querySelectorAll("mediago-download-button")).toHaveLength(
      1,
    );
    expect(first.transport).not.toHaveBeenCalled();
    expect(second.transport).toHaveBeenCalledOnce();
  });

  it("cleans only normal processed markers owned by the runtime", () => {
    document.body.innerHTML = `
      ${videoCard()}
      <article class="bili-video-card__wrap advertisement">
        <a class="bili-video-card__image--link" href="/video/ad"></a>
        <span class="bili-video-card__info--ad">AD</span>
      </article>
      <article class="bili-video-card__wrap __scale-wrap">
        <a class="bili-video-card__image--link" href="/video/scaled"></a>
      </article>
    `;
    const cards = document.querySelectorAll<HTMLElement>(
      ".bili-video-card__wrap",
    );
    const normalCard = cards[0];
    const adCard = cards[1];
    const scaleCard = cards[2];
    if (!normalCard || !adCard || !scaleCard) {
      throw new Error("Expected normal, ad, and scale cards");
    }
    const { cleanup } = start();

    expect(normalCard.getAttribute("data-mg-injected")).toBe("true");
    expect(adCard.getAttribute("data-mg-injected")).toBe("ad");
    expect(scaleCard.getAttribute("data-mg-injected")).toBe("skip");

    cleanup();

    expect(normalCard.hasAttribute("data-mg-injected")).toBe(false);
    expect(normalCard.querySelector("mediago-download-button")).toBeNull();
    expect(adCard.getAttribute("data-mg-injected")).toBe("ad");
    expect(scaleCard.getAttribute("data-mg-injected")).toBe("skip");
  });
});
