/** @vitest-environment happy-dom */

import { DownloadFilter, DownloadStatus, DownloadType } from "@mediago/common";
import { beforeEach, expect, test } from "vitest";
import {
  toDockerTaskSnapshot,
  useDockerDownloadStore,
} from "./docker-downloads";

beforeEach(() => {
  localStorage.clear();
  useDockerDownloadStore.setState({
    snapshots: {
      [DownloadFilter.list]: { list: [], total: 0 },
      [DownloadFilter.done]: { list: [], total: 0 },
    },
  });
});

test("persists only safe Docker task fields and strips URL credentials", () => {
  const snapshot = toDockerTaskSnapshot({
    id: 7,
    type: DownloadType.m3u8,
    name: "Remote",
    url: "https://media.example/live?token=secret#fragment",
    headers: "Cookie: session=secret",
    outputPath: "/private/output",
    folder: "private-folder",
    file: "/private/output/video.mp4",
    files: ["/private/output/video.mp4"],
    status: DownloadStatus.Ready,
  });

  expect(snapshot).toStrictEqual({
    id: 7,
    type: DownloadType.m3u8,
    name: "Remote",
    url: "https://media.example/live",
    status: DownloadStatus.Ready,
    isLive: undefined,
    createdDate: undefined,
    exists: undefined,
  });
  expect(JSON.stringify(snapshot)).not.toContain("secret");
  expect(JSON.stringify(snapshot)).not.toContain("/private/output");
  expect(JSON.stringify(snapshot)).not.toContain("private-folder");
});

test("stores independent snapshots for active and completed filters", () => {
  useDockerDownloadStore.getState().replaceSnapshot(
    DownloadFilter.list,
    [
      {
        id: 1,
        type: DownloadType.m3u8,
        name: "Active",
        url: "https://example.com/active.m3u8",
      },
    ],
    3,
    "2026-08-29T10:00:00.000Z",
  );

  expect(
    useDockerDownloadStore.getState().snapshots[DownloadFilter.list],
  ).toMatchObject({ total: 3, syncedAt: "2026-08-29T10:00:00.000Z" });
  expect(
    useDockerDownloadStore.getState().snapshots[DownloadFilter.done].list,
  ).toHaveLength(0);
});
