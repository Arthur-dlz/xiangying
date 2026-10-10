import { DownloadType } from "@mediago/common";
import { describe, expect, it, vi } from "vitest";

import type { DetectedSource } from "../shared/types";
import { enrichSourcesWithPageCookies } from "./page-cookies";

function source(overrides: Partial<DetectedSource> = {}): DetectedSource {
  return {
    id: "source-1",
    url: "https://www.xiaohongshu.com/explore/abc123?xsec_token=signed-token",
    documentURL: "https://www.xiaohongshu.com/explore",
    name: "小红书作品",
    type: DownloadType.xiaohongshu,
    detectedAt: 1,
    ...overrides,
  };
}

describe("Xiaohongshu browser credential handoff", () => {
  it("adds the current page cookies without losing replay headers", async () => {
    const readCookies = vi.fn(async () => [
      { name: "web_session", value: "session-value" },
      { name: "a1", value: "device-value" },
    ]);

    const [result] = await enrichSourcesWithPageCookies(
      [source({ headers: "Referer: https://www.xiaohongshu.com/" })],
      readCookies,
    );

    expect(readCookies).toHaveBeenCalledWith({
      url: "https://www.xiaohongshu.com/explore/abc123?xsec_token=signed-token",
    });
    expect(result.headers).toBe(
      "Referer: https://www.xiaohongshu.com/\nCookie: web_session=session-value; a1=device-value",
    );
  });

  it("replaces a stale Cookie header and leaves other source types untouched", async () => {
    const readCookies = vi.fn(async () => [
      { name: "web_session", value: "fresh" },
    ]);
    const youtube = source({
      id: "youtube",
      type: DownloadType.youtube,
      url: "https://www.youtube.com/watch?v=abc",
      headers: "Cookie: youtube-cookie",
    });

    const [xiaohongshu, untouched] = await enrichSourcesWithPageCookies(
      [source({ headers: "Cookie: stale\nUser-Agent: MediaGo" }), youtube],
      readCookies,
    );

    expect(xiaohongshu.headers).toBe(
      "User-Agent: MediaGo\nCookie: web_session=fresh",
    );
    expect(untouched).toBe(youtube);
    expect(readCookies).toHaveBeenCalledOnce();
  });

  it("keeps the source usable when cookie access fails", async () => {
    const original = source();
    await expect(
      enrichSourcesWithPageCookies([original], async () => {
        throw new Error("cookies unavailable");
      }),
    ).resolves.toEqual([original]);
  });
});
