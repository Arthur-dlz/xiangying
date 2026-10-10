import { describe, expect, test, vi } from "vitest";

import { installPageActionContentScript } from "./lifecycle";

function createWindowTarget() {
  let unload: (() => void) | undefined;
  const target = {
    addEventListener: vi.fn((_type: "unload", listener: () => void) => {
      unload = listener;
    }),
    removeEventListener: vi.fn((_type: "unload", listener: () => void) => {
      if (unload === listener) unload = undefined;
    }),
  };
  return { target, unload: () => unload?.() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("page action content lifecycle", () => {
  test("guards against duplicate initialization and cleans up on unload", async () => {
    const browserWindow = createWindowTarget();
    const destroy = vi.fn();
    const start = vi.fn(async () => ({ destroy }));

    const firstCleanup = installPageActionContentScript(
      browserWindow.target,
      start,
    );
    const duplicateCleanup = installPageActionContentScript(
      browserWindow.target,
      start,
    );
    await Promise.resolve();

    expect(start).toHaveBeenCalledTimes(1);
    expect(duplicateCleanup).toBe(firstCleanup);

    browserWindow.unload();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(browserWindow.target.removeEventListener).toHaveBeenCalledTimes(1);
  });

  test("destroys a controller that resolves after cleanup", async () => {
    const browserWindow = createWindowTarget();
    const pending = deferred<{ destroy(): void }>();
    const destroy = vi.fn();

    const cleanup = installPageActionContentScript(
      browserWindow.target,
      () => pending.promise,
    );
    cleanup();
    pending.resolve({ destroy });
    await pending.promise;
    await Promise.resolve();

    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
