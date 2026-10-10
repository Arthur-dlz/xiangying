import { expect, test } from "vitest";
import type { HLSMediaInfo } from "../types";
import { mergeSniffedSource } from "./source-grouping";

interface TestSource {
  id: string;
  url: string;
  mediaInfo?: HLSMediaInfo;
}

const mediaInfo = (overrides: Partial<HLSMediaInfo>): HLSMediaInfo => ({
  status: "ready",
  playlistType: "media",
  variants: [],
  ...overrides,
});

test("replaces the pending copy of the same source", () => {
  const pending: TestSource = {
    id: "master",
    url: "https://media.example/master.m3u8",
    mediaInfo: mediaInfo({ status: "inspecting", playlistType: "unknown" }),
  };
  const ready: TestSource = {
    ...pending,
    mediaInfo: mediaInfo({ playlistType: "master", maxQuality: "1080p" }),
  };

  expect(mergeSniffedSource([pending], ready)).toStrictEqual([ready]);
});

test("collapses child playlists when their master arrives later", () => {
  const child: TestSource = {
    id: "child",
    url: "https://media.example/720.m3u8",
    mediaInfo: mediaInfo({}),
  };
  const master: TestSource = {
    id: "master",
    url: "https://media.example/master.m3u8",
    mediaInfo: mediaInfo({
      playlistType: "master",
      maxQuality: "1080p",
      variants: [
        { url: child.url, quality: "720p" },
        { url: "https://media.example/1080.m3u8", quality: "1080p" },
      ],
    }),
  };

  expect(mergeSniffedSource([child], master)).toStrictEqual([master]);
  expect(mergeSniffedSource([master], child)).toStrictEqual([master]);
});

test("keeps unrelated playlists separate", () => {
  const first: TestSource = {
    id: "first",
    url: "https://media.example/first.m3u8",
  };
  const second: TestSource = {
    id: "second",
    url: "https://media.example/second.m3u8",
  };

  expect(mergeSniffedSource([first], second)).toStrictEqual([first, second]);
});

test("never groups or replaces sources across explicit tab scopes", () => {
  const child: TestSource & { sourceScope: string } = {
    id: "child",
    sourceScope: "tab-b",
    url: "https://media.example/720.m3u8",
  };
  const master: TestSource & { sourceScope: string } = {
    id: "master",
    sourceScope: "tab-a",
    url: "https://media.example/master.m3u8",
    mediaInfo: mediaInfo({
      playlistType: "master",
      variants: [{ url: child.url, quality: "720p" }],
    }),
  };
  const sameURLInOtherTab: TestSource & { sourceScope: string } = {
    id: "other-master",
    sourceScope: "tab-b",
    url: master.url,
  };

  expect(mergeSniffedSource([child], master)).toStrictEqual([child, master]);
  expect(mergeSniffedSource([master], sameURLInOtherTab)).toStrictEqual([
    master,
    sameURLInOtherTab,
  ]);
});
