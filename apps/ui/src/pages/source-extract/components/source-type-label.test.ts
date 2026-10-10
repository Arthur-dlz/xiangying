import { describe, expect, it } from "vitest";
import { DownloadType } from "@mediago/common";
import { sourceTypeLabel } from "./source-type-label";

describe("sourceTypeLabel", () => {
  it("labels X/Twitter yt-dlp sources as X", () => {
    expect(
      sourceTypeLabel({
        type: DownloadType.youtube,
        url: "https://x.com/openai/status/123",
      }),
    ).toBe("X");
    expect(
      sourceTypeLabel({
        type: DownloadType.youtube,
        url: "https://twitter.com/openai/status/123",
      }),
    ).toBe("X");
  });

  it("labels TikTok and Douyin yt-dlp sources by platform", () => {
    expect(
      sourceTypeLabel({
        type: DownloadType.youtube,
        url: "https://www.tiktok.com/@creator/video/7480123456789012345",
      }),
    ).toBe("TikTok");
    expect(
      sourceTypeLabel({
        type: DownloadType.youtube,
        url: "https://vm.tiktok.com/ZTR45GpSF/",
      }),
    ).toBe("TikTok");
    expect(
      sourceTypeLabel({
        type: DownloadType.youtube,
        url: "https://www.douyin.com/video/7480123456789012345",
      }),
    ).toBe("抖音");
    expect(
      sourceTypeLabel({
        type: DownloadType.youtube,
        url: "https://v.douyin.com/iF123AbC/",
      }),
    ).toBe("抖音");
  });

  it("keeps platform and protocol labels readable", () => {
    expect(
      sourceTypeLabel({
        type: DownloadType.xiaohongshu,
        url: "https://www.xiaohongshu.com/explore/abc123?xsec_token=token",
      }),
    ).toBe("小红书");
    expect(
      sourceTypeLabel({
        type: DownloadType.youtube,
        url: "https://www.youtube.com/watch?v=video",
      }),
    ).toBe("YouTube");
    expect(
      sourceTypeLabel({
        type: DownloadType.m3u8,
        url: "https://example.com/live.m3u8",
      }),
    ).toBe("HLS");
    expect(
      sourceTypeLabel({
        type: DownloadType.youtube,
        url: "https://example.com/video",
      }),
    ).toBe("yt-dlp");
  });
});
