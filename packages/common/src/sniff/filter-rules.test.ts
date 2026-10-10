import { describe, expect, it } from "vitest";
import { DownloadType } from "../types";
import {
  isHLSContentType,
  matchPageUrl,
  shouldSuppressRequestSource,
} from "./filter-rules";

describe("isHLSContentType", () => {
  it.each([
    "application/vnd.apple.mpegurl",
    "application/x-mpegURL",
    "audio/mpegurl",
    "audio/x-mpegurl; charset=utf-8",
  ])("recognizes HLS response MIME type: %s", (contentType) => {
    expect(isHLSContentType(contentType)).toBe(true);
  });

  it.each(["text/html", "application/json", "video/mp4", ""])(
    "rejects unrelated response MIME type: %s",
    (contentType) => {
      expect(isHLSContentType(contentType)).toBe(false);
    },
  );
});

describe("matchPageUrl", () => {
  it.each([
    "https://x.com/openai/status/1234567890",
    "https://www.x.com/openai/status/1234567890?ref_src=twsrc",
    "https://twitter.com/openai/status/1234567890",
    "https://mobile.twitter.com/openai/status/1234567890/video/1",
  ])("routes X/Twitter status URLs through yt-dlp: %s", (url) => {
    expect(matchPageUrl(url)?.type).toBe(DownloadType.youtube);
  });

  it.each([
    "https://x.com/",
    "https://x.com/explore",
    "https://twitter.com/search?q=video",
  ])("does not treat a non-status X page as a download: %s", (url) => {
    expect(matchPageUrl(url)).toBeUndefined();
  });

  it.each([
    "https://www.tiktok.com/@creator/video/7480123456789012345",
    "https://m.tiktok.com/@creator/video/7480123456789012345",
    "https://www.tiktok.com/share/video/7480123456789012345/",
    "https://www.tiktok.com/t/ZTRC5xgJp",
    "https://vm.tiktok.com/ZTR45GpSF/",
    "https://vt.tiktok.com/ZSe4FqkKd",
    "https://www.douyin.com/video/7480123456789012345",
    "https://v.douyin.com/iF123AbC/",
  ])("routes TikTok/Douyin post URLs through yt-dlp: %s", (url) => {
    expect(matchPageUrl(url)?.type).toBe(DownloadType.youtube);
  });

  it.each([
    "https://www.tiktok.com/",
    "https://www.tiktok.com/@creator",
    "https://www.tiktok.com/@creator/live",
    "https://www.douyin.com/",
    "https://www.douyin.com/user/example",
    "https://www.douyin.com/search/video",
  ])("does not treat a short-video browsing page as a download: %s", (url) => {
    expect(matchPageUrl(url)).toBeUndefined();
  });

  it.each([
    "https://www.xiaohongshu.com/explore/66f00abc1234567890abcdef?xsec_token=token&xsec_source=pc_feed",
    "https://www.xiaohongshu.com/discovery/item/66f00abc1234567890abcdef?xsec_token=token",
    "https://www.xiaohongshu.com/user/profile/5abc1234567890abcdef1234/66f00abc1234567890abcdef?xsec_token=token",
    "https://xhslink.com/a1B2c3D4",
  ])("routes Xiaohongshu notes through its dedicated downloader: %s", (url) => {
    expect(matchPageUrl(url)?.type).toBe(DownloadType.xiaohongshu);
  });

  it.each([
    "https://www.xiaohongshu.com/",
    "https://www.xiaohongshu.com/explore",
    "https://www.xiaohongshu.com/search_result?keyword=video",
    "https://www.xiaohongshu.com/user/profile/5abc1234567890abcdef1234",
  ])("does not treat Xiaohongshu browsing pages as notes: %s", (url) => {
    expect(matchPageUrl(url)).toBeUndefined();
  });
});

describe("shouldSuppressRequestSource", () => {
  it.each([
    "https://x.com/home",
    "https://www.x.com/openai/status/123",
    "https://twitter.com/search?q=video",
    "https://mobile.twitter.com/home",
  ])("prefers the X/Twitter page extractor for generic media on %s", (url) => {
    expect(shouldSuppressRequestSource(url, DownloadType.direct)).toBe(true);
    expect(shouldSuppressRequestSource(url, DownloadType.m3u8)).toBe(true);
  });

  it("keeps specialised page sources and unrelated sites", () => {
    expect(
      shouldSuppressRequestSource(
        "https://x.com/openai/status/123",
        DownloadType.youtube,
      ),
    ).toBe(false);
    expect(
      shouldSuppressRequestSource(
        "https://example.com/video",
        DownloadType.direct,
      ),
    ).toBe(false);
    expect(
      shouldSuppressRequestSource(
        "https://x.com.example/video",
        DownloadType.direct,
      ),
    ).toBe(false);
  });

  it.each([
    "https://www.tiktok.com/foryou",
    "https://m.tiktok.com/@creator/video/7480123456789012345",
    "https://www.douyin.com/recommend",
    "https://www.douyin.com/video/7480123456789012345",
  ])("suppresses raw media renditions on short-video pages: %s", (url) => {
    expect(shouldSuppressRequestSource(url, DownloadType.direct)).toBe(true);
    expect(shouldSuppressRequestSource(url, DownloadType.m3u8)).toBe(true);
  });

  it.each([
    "https://www.xiaohongshu.com/explore",
    "https://www.xiaohongshu.com/explore/66f00abc1234567890abcdef?xsec_token=token",
  ])("suppresses raw media renditions on Xiaohongshu pages: %s", (url) => {
    expect(shouldSuppressRequestSource(url, DownloadType.direct)).toBe(true);
    expect(shouldSuppressRequestSource(url, DownloadType.m3u8)).toBe(true);
    expect(shouldSuppressRequestSource(url, DownloadType.xiaohongshu)).toBe(
      false,
    );
  });
});
