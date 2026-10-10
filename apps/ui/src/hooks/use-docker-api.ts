import type { DownloadTask } from "@mediago/common";
import { createDockerDownloadTasks } from "@/api/docker-download-task";

interface AddVideosToDockerOptions {
  items: Omit<DownloadTask, "id">[];
  immediate?: boolean;
}

export function postVideosToDocker({
  items,
  immediate = false,
}: AddVideosToDockerOptions) {
  return createDockerDownloadTasks(items, immediate);
}

export function useDockerApi() {
  const addVideosToDocker = ({
    items,
    immediate = false,
  }: {
    items: Omit<DownloadTask, "id">[];
    immediate?: boolean;
  }) => {
    return postVideosToDocker({
      items,
      immediate,
    });
  };

  return {
    addVideosToDocker,
  };
}
