/** @vitest-environment happy-dom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Favorite, FavoriteIconStatus } from "@mediago/common";
import { useFavoriteIconResolution } from "./use-favorite-icon-resolution";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function favorite(
  iconStatus: FavoriteIconStatus,
  icon: string | null = null,
): Favorite {
  return {
    id: 2,
    title: "YouTube",
    url: "https://youtube.com",
    icon,
    iconStatus,
    createdDate: new Date(0),
    updatedDate: new Date(0),
  };
}

function Harness({
  favorites,
  resolveFavoriteIcon,
}: {
  favorites: Favorite[];
  resolveFavoriteIcon: (id: number) => Promise<Favorite>;
}) {
  useFavoriteIconResolution(favorites, resolveFavoriteIcon, [2_000, 5_000]);
  return null;
}

describe("useFavoriteIconResolution", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("retries a transient result and stops after the icon resolves", async () => {
    const resolveFavoriteIcon = vi
      .fn<(id: number) => Promise<Favorite>>()
      .mockResolvedValueOnce(favorite("retryable"))
      .mockResolvedValueOnce(
        favorite(
          "ready",
          "https://www.youtube.com/s/desktop/app/img/favicon.ico",
        ),
      );

    await act(async () => {
      root.render(
        createElement(Harness, {
          favorites: [favorite("retryable")],
          resolveFavoriteIcon,
        }),
      );
    });
    expect(resolveFavoriteIcon).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(resolveFavoriteIcon).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(resolveFavoriteIcon).toHaveBeenCalledTimes(2);
  });

  it("does not request an icon again after a terminal missing result", async () => {
    const resolveFavoriteIcon = vi.fn<(id: number) => Promise<Favorite>>();

    await act(async () => {
      root.render(
        createElement(Harness, {
          favorites: [favorite("missing")],
          resolveFavoriteIcon,
        }),
      );
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(resolveFavoriteIcon).not.toHaveBeenCalled();
  });
});
