import { describe, expect, it } from "vitest";
import { DownloadType } from "@mediago/common";
import { generateUrl, urlDownloadType } from "./index";

describe("generateUrl", () => {
  it("uses HTTPS for schemeless domains", () => {
    expect(generateUrl("x.com/user/status/123")).toBe(
      "https://x.com/user/status/123",
    );
  });

  it("preserves explicit HTTP URLs for local development", () => {
    expect(generateUrl("http://localhost:4173")).toBe("http://localhost:4173");
  });

  it("keeps search fallback behavior", () => {
    expect(generateUrl("download this video")).toBe(
      "https://www.baidu.com/s?word=download this video",
    );
  });
});

describe("urlDownloadType", () => {
  it.each([
    "https://x.com/openai/status/1234567890",
    "https://twitter.com/openai/status/1234567890",
  ])("routes X/Twitter status URLs through yt-dlp: %s", (url) => {
    expect(urlDownloadType(url)).toBe(DownloadType.youtube);
  });

  it("does not classify the X homepage as a downloadable status", () => {
    expect(urlDownloadType("https://x.com/home")).toBe(DownloadType.direct);
  });

  it.each([
    "https://www.tiktok.com/@creator/video/7480123456789012345",
    "https://vm.tiktok.com/ZTR45GpSF/",
    "https://www.douyin.com/video/7480123456789012345",
    "https://v.douyin.com/iF123AbC/",
  ])("routes TikTok/Douyin post URLs through yt-dlp: %s", (url) => {
    expect(urlDownloadType(url)).toBe(DownloadType.youtube);
  });

  it.each([
    "https://www.tiktok.com/@creator/live",
    "https://www.douyin.com/user/example",
  ])("does not classify unsupported short-video routes: %s", (url) => {
    expect(urlDownloadType(url)).toBe(DownloadType.direct);
  });

  it.each([
    "https://www.xiaohongshu.com/explore/66f00abc1234567890abcdef?xsec_token=token",
    "https://www.xiaohongshu.com/discovery/item/66f00abc1234567890abcdef?xsec_token=token",
    "https://xhslink.com/a1B2c3D4",
  ])("routes Xiaohongshu note URLs through yt-dlp: %s", (url) => {
    expect(urlDownloadType(url)).toBe(DownloadType.xiaohongshu);
  });
});
