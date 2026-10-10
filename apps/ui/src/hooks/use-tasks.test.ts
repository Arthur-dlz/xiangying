import {
  DownloadStatus,
  DownloadType,
  type DownloadTaskResponse,
} from "@mediago/common";
import { expect, test } from "vitest";
import { mergeUnifiedTaskPage, taskRefKey } from "./use-tasks";

function response(
  tasks: Array<{ id: number; name: string; createdDate: string }>,
): DownloadTaskResponse {
  return {
    total: tasks.length,
    list: tasks.map((task) => ({
      ...task,
      createdDate: new Date(task.createdDate),
      type: DownloadType.m3u8,
      url: `https://example.com/${task.name}`,
      status: DownloadStatus.Ready,
    })),
  };
}

test("merges local and Docker tasks by date with composite identities", () => {
  const merged = mergeUnifiedTaskPage(
    response([
      { id: 1, name: "local-new", createdDate: "2026-08-29T10:00:00Z" },
      { id: 2, name: "local-old", createdDate: "2026-08-29T08:00:00Z" },
    ]),
    response([
      { id: 1, name: "docker-mid", createdDate: "2026-08-29T09:00:00Z" },
    ]),
    1,
    10,
    false,
  );

  expect(merged.list.map((task) => task.name)).toStrictEqual([
    "local-new",
    "docker-mid",
    "local-old",
  ]);
  expect(merged.list.map(taskRefKey)).toStrictEqual([
    "local:1",
    "docker:1",
    "local:2",
  ]);
  expect(merged.total).toBe(3);
});

test("marks retained Docker tasks offline and paginates after merging", () => {
  const merged = mergeUnifiedTaskPage(
    response([{ id: 2, name: "local", createdDate: "2026-08-29T10:00:00Z" }]),
    response([{ id: 3, name: "docker", createdDate: "2026-08-29T09:00:00Z" }]),
    2,
    1,
    true,
    "2026-08-29T09:30:00Z",
  );

  expect(merged.list).toMatchObject([
    {
      name: "docker",
      origin: "docker",
      remoteOffline: true,
      remoteLastSyncedAt: "2026-08-29T09:30:00Z",
    },
  ]);
});
