import { expect, test } from "vitest";
import {
  defaultSelectedSourceIds,
  defaultSelectedVariantUrls,
} from "./discovered-source-picker";

test("preselects every available source and leaves duplicates disabled", () => {
  expect(
    defaultSelectedSourceIds([
      { id: "one", url: "https://example.com/1", name: "One", available: true },
      {
        id: "duplicate",
        url: "https://example.com/2",
        name: "Two",
        available: false,
        unavailableReason: "duplicate",
      },
    ]),
  ).toEqual(["one"]);
});

test("defaults master playlists to automatic quality selection", () => {
  expect(
    defaultSelectedVariantUrls([
      {
        id: "master",
        url: "https://example.com/master",
        name: "Master",
        available: true,
        playlistType: "master",
        variants: [{ url: "https://example.com/1080", quality: "1080p" }],
      },
      {
        id: "direct",
        url: "https://example.com/video.mp4",
        name: "Direct",
        available: true,
      },
    ]),
  ).toStrictEqual({ master: "https://example.com/master" });
});
