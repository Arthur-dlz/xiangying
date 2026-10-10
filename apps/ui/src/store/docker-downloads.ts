import {
  DownloadFilter,
  type DownloadStatus,
  type DownloadTaskWithFile,
  type DownloadType,
} from "@mediago/common";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface DockerTaskSnapshot {
  createdDate?: string;
  exists?: boolean;
  id: number;
  isLive?: boolean;
  name: string;
  status?: DownloadStatus;
  type: DownloadType;
  url: string;
}

interface DockerDownloadSnapshot {
  list: DockerTaskSnapshot[];
  syncedAt?: string;
  total: number;
}

interface DockerDownloadState {
  snapshots: Record<DownloadFilter, DockerDownloadSnapshot>;
  replaceSnapshot: (
    filter: DownloadFilter,
    tasks: DownloadTaskWithFile[],
    total: number,
    syncedAt?: string,
  ) => void;
}

function sanitizeURL(rawURL: string): string {
  try {
    const url = new URL(rawURL);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return rawURL.split(/[?#]/, 1)[0] ?? "";
  }
}

export function toDockerTaskSnapshot(
  task: DownloadTaskWithFile,
): DockerTaskSnapshot {
  return {
    id: task.id,
    type: task.type,
    name: task.name,
    url: sanitizeURL(task.url),
    status: task.status,
    isLive: task.isLive,
    createdDate:
      task.createdDate instanceof Date
        ? task.createdDate.toISOString()
        : task.createdDate,
    exists: task.exists,
  };
}

const emptySnapshot = (): DockerDownloadSnapshot => ({ list: [], total: 0 });

export const useDockerDownloadStore = create<DockerDownloadState>()(
  persist(
    (set) => ({
      snapshots: {
        [DownloadFilter.list]: emptySnapshot(),
        [DownloadFilter.done]: emptySnapshot(),
      },
      replaceSnapshot: (
        filter,
        tasks,
        total,
        syncedAt = new Date().toISOString(),
      ) =>
        set((state) => ({
          snapshots: {
            ...state.snapshots,
            [filter]: {
              list: tasks.map(toDockerTaskSnapshot),
              syncedAt,
              total,
            },
          },
        })),
    }),
    {
      name: "docker-download-snapshot",
      partialize: (state) => ({ snapshots: state.snapshots }),
    },
  ),
);
