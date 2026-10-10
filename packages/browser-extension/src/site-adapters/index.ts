export {
  BILIBILI_PROCESSED_ATTRIBUTE,
  BILIBILI_SELECTORS,
  bilibiliPageAdapter,
} from "./bilibili/adapter";
export {
  matchesBilibiliPageLocation,
  matchesPageAdapterLocation,
  matchesShortVideoPageLocation,
  matchesTwitterPageLocation,
  matchesXiaohongshuPageLocation,
  matchesYoutubePageLocation,
} from "./adapter-matches";
export { findPageAdapter, PAGE_ADAPTERS } from "./registry";
export {
  SHORT_VIDEO_PROCESSED_ATTRIBUTE,
  SHORT_VIDEO_SELECTORS,
  shortVideoPageAdapter,
} from "./short-video/adapter";
export {
  TWITTER_PROCESSED_ATTRIBUTE,
  TWITTER_SELECTORS,
  twitterPageAdapter,
} from "./twitter/adapter";
export {
  YOUTUBE_PROCESSED_ATTRIBUTE,
  YOUTUBE_SELECTORS,
  youtubePageAdapter,
} from "./youtube/adapter";
export {
  XIAOHONGSHU_PROCESSED_ATTRIBUTE,
  XIAOHONGSHU_SELECTORS,
  xiaohongshuPageAdapter,
} from "./xiaohongshu/adapter";
export type {
  PageAdapter,
  PageAdapterLocation,
  PageCandidate,
  PageCard,
  PageCardHandler,
  PageTransport,
} from "./types";
export { startPageRuntime } from "../runtime";
export type { PageRuntimeOptions } from "../runtime";
