// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { PageActionCopy } from "./page-action-copy";
import * as pageActionButton from "./page-action-button";

const englishCopy: PageActionCopy = {
  idle: "Add to MediaGo",
  busy: "Adding…",
  failure: "Failed, try again",
  accessibleName: "Add current page to MediaGo",
};

function buttonFactory() {
  const create = (
    pageActionButton as typeof pageActionButton & {
      createPageActionButton?: typeof pageActionButton.createPageActionButton;
    }
  ).createPageActionButton;
  expect(create).toBeTypeOf("function");
  if (!create) throw new Error("Page action button factory is unavailable");
  return create;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("page action button", () => {
  test("mounts an isolated, fixed top-right MediaGo button", () => {
    document.head.innerHTML = `
      <style>
        button { color: hotpink !important; }
        [data-mediago-page-action] {
          all: unset !important;
          display: none !important;
          position: static !important;
          top: auto !important;
          right: auto !important;
          z-index: -1 !important;
        }
      </style>
    `;

    const action = buttonFactory()({
      document,
      iconUrl: "chrome-extension://id/public/icons/mediago-16.png",
      copy: englishCopy,
      onActivate: async () => undefined,
    });

    expect(action.host.parentElement).toBe(document.documentElement);
    expect(action.host.style.all).toBe("initial");
    expect(action.host.style.getPropertyPriority("all")).toBe("important");
    expect(action.host.style.display).toBe("block");
    expect(action.host.style.getPropertyPriority("display")).toBe("important");
    expect(action.host.style.position).toBe("fixed");
    expect(action.host.style.getPropertyPriority("position")).toBe("important");
    expect(action.host.style.top).toBe("16px");
    expect(action.host.style.getPropertyPriority("top")).toBe("important");
    expect(action.host.style.right).toBe("16px");
    expect(action.host.style.getPropertyPriority("right")).toBe("important");
    expect(action.host.style.zIndex).toBe("2147483647");
    expect(action.host.style.getPropertyPriority("z-index")).toBe("important");
    expect(getComputedStyle(action.host).display).toBe("block");
    expect(getComputedStyle(action.host).position).toBe("fixed");
    expect(action.host.shadowRoot?.mode).toBe("open");
    expect(document.querySelectorAll("button")).toHaveLength(0);

    const button = action.button;
    expect(button.type).toBe("button");
    expect(button.tabIndex).toBe(0);
    expect(button.getAttribute("aria-label")).toBe(englishCopy.accessibleName);
    expect(button.textContent).toContain(englishCopy.idle);
    const icon = action.host.shadowRoot?.querySelector("img");
    expect(icon?.getAttribute("src")).toBe(
      "chrome-extension://id/public/icons/mediago-16.png",
    );
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    const css = action.host.shadowRoot?.querySelector("style")?.textContent;
    expect(css).toContain("cursor: pointer");
    expect(css).toContain("cursor: progress");
  });

  test("uses a disabled progress state and ignores repeated activation", async () => {
    const pending = deferred<void>();
    const onActivate = vi.fn(() => pending.promise);
    const action = buttonFactory()({
      document,
      iconUrl: "icon.png",
      copy: englishCopy,
      onActivate,
    });

    action.button.dispatchEvent(new MouseEvent("click"));
    action.button.dispatchEvent(new MouseEvent("click"));

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(action.button.disabled).toBe(true);
    expect(action.button.getAttribute("aria-busy")).toBe("true");
    expect(action.button.textContent).toContain(englishCopy.busy);

    pending.resolve();
    await pending.promise;
    await Promise.resolve();

    expect(action.button.disabled).toBe(false);
    expect(action.button.hasAttribute("aria-busy")).toBe(false);
    expect(action.button.textContent).toContain(englishCopy.idle);
  });

  test("shows a retryable failure and resets it after a delay", async () => {
    vi.useFakeTimers();
    const onActivate = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("popup failed"))
      .mockResolvedValueOnce(undefined);
    const action = buttonFactory()({
      document,
      iconUrl: "icon.png",
      copy: englishCopy,
      onActivate,
      failureResetMs: 2_000,
    });

    action.button.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(action.button.disabled).toBe(false);
    expect(action.button.textContent).toContain(englishCopy.failure);

    action.button.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(onActivate).toHaveBeenCalledTimes(2);
    expect(action.button.textContent).toContain(englishCopy.idle);

    onActivate.mockRejectedValueOnce(new Error("again"));
    action.button.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(action.button.textContent).toContain(englishCopy.failure);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(action.button.textContent).toContain(englishCopy.idle);
  });

  test("updates localized copy without recreating the host", () => {
    const action = buttonFactory()({
      document,
      iconUrl: "icon.png",
      copy: englishCopy,
      onActivate: async () => undefined,
    });

    action.setCopy({
      idle: "添加到 MediaGo",
      busy: "正在添加…",
      failure: "添加失败，重试",
      accessibleName: "添加当前页面到 MediaGo",
    });

    expect(action.button.textContent).toContain("添加到 MediaGo");
    expect(action.button.getAttribute("aria-label")).toBe(
      "添加当前页面到 MediaGo",
    );
  });

  test("destroy removes the host, listener, and pending reset timer idempotently", async () => {
    vi.useFakeTimers();
    const onActivate = vi.fn(async () => {
      throw new Error("failed");
    });
    const action = buttonFactory()({
      document,
      iconUrl: "icon.png",
      copy: englishCopy,
      onActivate,
      failureResetMs: 2_000,
    });
    const button = action.button;
    button.click();
    await Promise.resolve();
    await Promise.resolve();

    action.destroy();
    action.destroy();
    button.dispatchEvent(new MouseEvent("click"));
    await vi.runAllTimersAsync();

    expect(action.host.isConnected).toBe(false);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});
