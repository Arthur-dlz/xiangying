import { matchesBilibiliPageLocation } from "./bilibili/match";
import { matchesShortVideoPageLocation } from "./short-video/match";
import type { PageAdapterLocation } from "./types";
import { matchesTwitterPageLocation } from "./twitter/match";
import { matchesXiaohongshuPageLocation } from "./xiaohongshu/match";
import { matchesYoutubePageLocation } from "./youtube/match";

export { matchesBilibiliPageLocation } from "./bilibili/match";
export { matchesShortVideoPageLocation } from "./short-video/match";
export { matchesTwitterPageLocation } from "./twitter/match";
export { matchesXiaohongshuPageLocation } from "./xiaohongshu/match";
export { matchesYoutubePageLocation } from "./youtube/match";

export function matchesPageAdapterLocation(
  location: PageAdapterLocation,
): boolean {
  return (
    matchesBilibiliPageLocation(location) ||
    matchesYoutubePageLocation(location) ||
    matchesTwitterPageLocation(location) ||
    matchesShortVideoPageLocation(location) ||
    matchesXiaohongshuPageLocation(location)
  );
}
