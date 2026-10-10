import { useCallback, useEffect, useRef } from "react";
import type { Favorite } from "@mediago/common";

const DEFAULT_RETRY_DELAYS_MS = [2_000, 5_000] as const;

type ResolveFavoriteIcon = (id: number) => Promise<Favorite>;

function isResolvable(favorite: Favorite | undefined): boolean {
  if (!favorite || favorite.icon?.trim()) return false;
  return favorite.iconStatus !== "missing";
}

/**
 * Resolves missing favorite icons and retries transient failures while the
 * favorites page remains open. Attempts reset on the next page entry, while a
 * server-side `missing` result remains terminal.
 */
export function useFavoriteIconResolution(
  favorites: readonly Favorite[],
  resolveFavoriteIcon: ResolveFavoriteIcon,
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
) {
  const latestFavorites = useRef(favorites);
  const attempts = useRef(new Map<number, number>());
  const inFlight = useRef(new Set<number>());
  const retryTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const isMounted = useRef(true);
  latestFavorites.current = favorites;

  const clearRetryTimer = useCallback((id: number) => {
    const timer = retryTimers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      retryTimers.current.delete(id);
    }
  }, []);

  const resolve = useCallback(
    (id: number) => {
      const favorite = latestFavorites.current.find((item) => item.id === id);
      if (!isMounted.current || !isResolvable(favorite)) {
        clearRetryTimer(id);
        return;
      }
      if (inFlight.current.has(id) || retryTimers.current.has(id)) return;

      const attempt = (attempts.current.get(id) ?? 0) + 1;
      attempts.current.set(id, attempt);
      inFlight.current.add(id);

      void resolveFavoriteIcon(id)
        .then((resolved) => {
          if (
            resolved.icon?.trim() ||
            resolved.iconStatus === "ready" ||
            resolved.iconStatus === "missing"
          ) {
            clearRetryTimer(id);
            return;
          }

          const retryDelay = retryDelaysMs[attempt - 1];
          if (retryDelay === undefined || !isMounted.current) return;
          const timer = setTimeout(() => {
            retryTimers.current.delete(id);
            resolve(id);
          }, retryDelay);
          retryTimers.current.set(id, timer);
        })
        .catch(() => {
          const retryDelay = retryDelaysMs[attempt - 1];
          if (retryDelay === undefined || !isMounted.current) return;
          const timer = setTimeout(() => {
            retryTimers.current.delete(id);
            resolve(id);
          }, retryDelay);
          retryTimers.current.set(id, timer);
        })
        .finally(() => {
          inFlight.current.delete(id);
        });
    },
    [clearRetryTimer, resolveFavoriteIcon, retryDelaysMs],
  );

  useEffect(() => {
    for (const favorite of favorites) {
      if (!isResolvable(favorite)) {
        clearRetryTimer(favorite.id);
        continue;
      }
      if (!attempts.current.has(favorite.id)) resolve(favorite.id);
    }
  }, [clearRetryTimer, favorites, resolve]);

  useEffect(() => {
    isMounted.current = true;
    const timers = retryTimers.current;
    return () => {
      isMounted.current = false;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);
}
