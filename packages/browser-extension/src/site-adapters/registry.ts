import { bilibiliPageAdapter } from "./bilibili/adapter";
import type { PageAdapter, PageAdapterLocation } from "./types";
import { shortVideoPageAdapter } from "./short-video/adapter";
import { twitterPageAdapter } from "./twitter/adapter";
import { xiaohongshuPageAdapter } from "./xiaohongshu/adapter";
import { youtubePageAdapter } from "./youtube/adapter";

export const PAGE_ADAPTERS: readonly PageAdapter[] = [
  bilibiliPageAdapter,
  youtubePageAdapter,
  twitterPageAdapter,
  shortVideoPageAdapter,
  xiaohongshuPageAdapter,
];

export function findPageAdapter(
  location: PageAdapterLocation,
): PageAdapter | null {
  return PAGE_ADAPTERS.find((adapter) => adapter.matches(location)) ?? null;
}
