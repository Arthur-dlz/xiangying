import { DownloadType, type DownloadTask } from "@mediago/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { http } from "@/utils";
import { postVideosToDocker } from "./use-docker-api";

const tasks: Omit<DownloadTask, "id">[] = [
  {
    type: DownloadType.bilibili,
    name: "example video",
    url: "https://www.bilibili.com/video/BV1example",
    folder: "videos",
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("postVideosToDocker", () => {
  it("submits the unchanged task form through the local Core proxy", async () => {
    const response = [{ id: 7 }];
    const post = vi.spyOn(http, "post").mockResolvedValue(response);

    await expect(
      postVideosToDocker({
        items: tasks,
        immediate: true,
      }),
    ).resolves.toBe(response);

    expect(post).toHaveBeenCalledWith("/api/docker/downloads", {
      tasks,
      startDownload: true,
    });
  });

  it("keeps add-to-list as the default Docker behavior", async () => {
    const post = vi.spyOn(http, "post").mockResolvedValue([]);

    await postVideosToDocker({
      items: tasks,
    });

    expect(post).toHaveBeenCalledWith("/api/docker/downloads", {
      tasks,
      startDownload: false,
    });
  });
});
