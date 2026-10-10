import { DownloadType } from "@mediago/common";
import type { PageCandidate } from "@mediago/browser-extension/site-adapters";
import {
  matchesBilibiliPageLocation,
  matchesShortVideoPageLocation,
  matchesTwitterPageLocation,
  matchesYoutubePageLocation,
  matchesXiaohongshuPageLocation,
} from "@mediago/browser-extension/site-adapter-matches";

export const candidate: PageCandidate = {
  name: "Example",
  url: "https://www.bilibili.com/video/BV1example",
  type: DownloadType.bilibili,
};

export const matchesHomepage = matchesBilibiliPageLocation({
  hostname: "www.bilibili.com",
});

export const matchesYoutube = matchesYoutubePageLocation({
  hostname: "www.youtube.com",
});

export const matchesTwitter = matchesTwitterPageLocation({ hostname: "x.com" });

export const matchesShortVideo = matchesShortVideoPageLocation({
  hostname: "www.tiktok.com",
});

export const matchesXiaohongshu = matchesXiaohongshuPageLocation({
  hostname: "www.xiaohongshu.com",
});
