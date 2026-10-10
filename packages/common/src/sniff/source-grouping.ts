import type { HLSMediaInfo } from "../types";

export interface GroupableSniffedSource {
  url: string;
  mediaInfo?: HLSMediaInfo;
  /** Optional isolation key, normally a browser tab ID. */
  sourceScope?: string;
}

function isMaster(source: GroupableSniffedSource): boolean {
  return source.mediaInfo?.playlistType === "master";
}

function masterContains(
  master: GroupableSniffedSource,
  source: GroupableSniffedSource,
): boolean {
  return (
    isMaster(master) &&
    sameScope(master, source) &&
    master.mediaInfo?.variants.some((variant) => variant.url === source.url) ===
      true
  );
}

function sameScope(
  first: GroupableSniffedSource,
  second: GroupableSniffedSource,
): boolean {
  return (
    first.sourceScope === undefined ||
    second.sourceScope === undefined ||
    first.sourceScope === second.sourceScope
  );
}

/**
 * Adds or updates one sniffed source while collapsing variants that are
 * explicitly referenced by a detected HLS master playlist. Sources from the
 * same page are never grouped solely by page URL.
 */
export function mergeSniffedSource<T extends GroupableSniffedSource>(
  current: T[],
  incoming: T,
): T[] {
  const withoutSameUrl = current.filter(
    (item) => item.url !== incoming.url || !sameScope(item, incoming),
  );

  if (
    !isMaster(incoming) &&
    withoutSameUrl.some((item) => masterContains(item, incoming))
  ) {
    return withoutSameUrl;
  }

  if (!isMaster(incoming)) {
    return [...withoutSameUrl, incoming];
  }

  const relatedUrls = new Set(
    incoming.mediaInfo?.variants.map((variant) => variant.url) ?? [],
  );
  return [
    ...withoutSameUrl.filter(
      (item) => !sameScope(item, incoming) || !relatedUrls.has(item.url),
    ),
    incoming,
  ];
}
