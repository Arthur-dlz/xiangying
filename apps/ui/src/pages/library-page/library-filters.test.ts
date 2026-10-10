import { expect, test } from "vitest";
import {
  DownloadStatus,
  DownloadType,
  type LibraryItem,
} from "@mediago/common";
import { completedLocalTaskPaths, filterLibraryItems } from "./library-filters";

const items = [
  {
    id: "1",
    title: "春日活动记录",
    category: "documentary",
    tags: ["校园", "春天"],
    screened: true,
  },
  {
    id: "2",
    title: "乡村电影夜",
    category: "movie",
    tags: ["家庭"],
    screened: false,
  },
].map((item) => item as LibraryItem);

test("searches title and tags while applying category and screened filters", () => {
  expect(
    filterLibraryItems(items, {
      query: "校园",
      category: "documentary",
      screened: "true",
    }).map((item) => item.id),
  ).toStrictEqual(["1"]);
  expect(
    filterLibraryItems(items, {
      query: "电影",
      category: "all",
      screened: "all",
    }).map((item) => item.id),
  ).toStrictEqual(["2"]);
  expect(
    filterLibraryItems(items, {
      query: "",
      category: "movie",
      screened: "true",
    }),
  ).toStrictEqual([]);
});

test("sync paths use only existing local successful task file paths", () => {
  expect(
    completedLocalTaskPaths([
      {
        id: 1,
        name: "done",
        type: DownloadType.direct,
        url: "",
        status: DownloadStatus.Success,
        file: "C:/media/movie.mp4",
        outputPath: "C:/stale.mp4",
      },
      {
        id: 2,
        name: "pending",
        type: DownloadType.direct,
        url: "",
        status: DownloadStatus.Downloading,
        file: "C:/media/partial.mp4",
      },
      {
        id: 3,
        name: "missing",
        type: DownloadType.direct,
        url: "",
        status: DownloadStatus.Success,
        file: "C:/media/gone.mp4",
        exists: false,
      },
      {
        id: 4,
        name: "same",
        type: DownloadType.direct,
        url: "",
        status: DownloadStatus.Success,
        file: "C:/media/movie.mp4",
      },
      {
        id: 5,
        name: "no-file",
        type: DownloadType.direct,
        url: "",
        status: DownloadStatus.Success,
      },
    ]),
  ).toStrictEqual(["C:/media/movie.mp4"]);
});
