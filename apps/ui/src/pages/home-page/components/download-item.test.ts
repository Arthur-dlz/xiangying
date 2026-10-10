/** @vitest-environment happy-dom */

import { DownloadStatus, DownloadType } from "@mediago/common";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadTaskDetails } from "@/hooks/use-tasks";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  libraryImportFiles: vi.fn(),
  libraryList: vi.fn(),
  libraryPlay: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", resolvedLanguage: "en" },
  }),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, info: mocks.toastInfo },
}));

vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({
    shell: { open: mocks.open },
    library: {
      importFiles: mocks.libraryImportFiles,
      list: mocks.libraryList,
      play: mocks.libraryPlay,
    },
  }),
}));

vi.mock("@/hooks/use-config", () => ({
  useEnvPath: () => ({ envPath: { playerUrl: "http://127.0.0.1/player" } }),
}));

const { DownloadTaskItem } = await import("./download-item");
const { useAppStore } = await import("@/store/app");

function task(
  overrides: Partial<DownloadTaskDetails> = {},
): DownloadTaskDetails {
  return {
    id: 1,
    type: DownloadType.m3u8,
    name: "Live stream",
    url: "https://example.com/live.m3u8",
    status: DownloadStatus.Downloading,
    isLive: true,
    percent: "20",
    speed: "1 MB/s",
    origin: "local",
    ...overrides,
  };
}

describe("DownloadTaskItem live recording actions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.libraryImportFiles.mockResolvedValue({
      added: 1,
      skipped: 0,
      rejected: [],
      items: [],
    });
    mocks.libraryList.mockResolvedValue({ items: [], totalBytes: 0 });
    mocks.libraryPlay.mockResolvedValue(undefined);
    useAppStore.setState({ showTerminal: false });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  async function renderItem(
    value: DownloadTaskDetails,
    onStopDownload = vi
      .fn<(task: DownloadTaskDetails) => Promise<void>>()
      .mockResolvedValue(undefined),
  ) {
    await act(async () => {
      root.render(
        createElement(DownloadTaskItem, {
          task: value,
          selected: false,
          onSelect: vi.fn(),
          onSelectChange: vi.fn(),
          onStartDownload: vi.fn(),
          onStopDownload,
          onContextMenu: vi.fn(),
          onDelete: vi.fn(),
          onRefresh: vi.fn(),
        }),
      );
    });
    return onStopDownload;
  }

  it("confirms a live stop and exposes a finalizing state", async () => {
    let resolve!: () => void;
    const onStopDownload = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    await renderItem(task(), onStopDownload);

    const stopButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="endRecording"]',
    );
    await act(async () => stopButton?.click());
    expect(onStopDownload).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("endLiveRecordingDescription");

    const confirm = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "endAndSaveRecording",
    );
    await act(async () => confirm?.click());

    expect(onStopDownload).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 1, origin: "local" }),
    );
    const endingButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="endingRecording"]',
    );
    expect(endingButton?.disabled).toBe(true);
    expect(container.textContent).toContain("endingRecording");

    await act(async () => resolve());
  });

  it("continues recording when the confirmation is cancelled", async () => {
    const onStopDownload = await renderItem(task());
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="endRecording"]')
        ?.click();
    });
    const cancel = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "continueRecording",
    );
    await act(async () => cancel?.click());

    expect(onStopDownload).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(
      "endLiveRecordingDescription",
    );
  });

  it("keeps the existing immediate pause behavior for non-live downloads", async () => {
    const onStopDownload = await renderItem(task({ isLive: false }));
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="pause"]')
        ?.click();
    });

    expect(onStopDownload).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 1, origin: "local" }),
    );
    expect(document.body.textContent).not.toContain(
      "endLiveRecordingDescription",
    );
  });

  it("shows a standardized live status without a percentage progress bar", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T07:32:34.000Z"));
    await renderItem(
      task({
        percent: "92",
        speed: "1.55MBps",
        recordingStartedAt: "2026-08-27T07:20:00.000Z",
      }),
    );

    expect(container.querySelector('[data-slot="progress"]')).toBeNull();
    expect(container.textContent).toContain("recording");
    expect(
      [...container.querySelectorAll("span")].filter(
        (element) => element.textContent === "recording",
      ),
    ).toHaveLength(1);
    expect(container.textContent).toContain("recordedDuration");
    expect(container.textContent).toContain("00:12:34");
    expect(container.textContent).toContain("recordingStartedAt");
    expect(container.textContent).toContain("1.55 MB/s");
    expect(container.textContent).not.toContain("92%");
  });

  it("keeps percentage progress for regular downloads", async () => {
    await renderItem(task({ isLive: false, percent: "42", speed: "2.5MiB/s" }));

    expect(container.querySelector('[data-slot="progress"]')).not.toBeNull();
    expect(container.textContent).toContain("42%");
  });

  it("keeps an offline Docker task visible while disabling its actions", async () => {
    await renderItem(
      task({
        origin: "docker",
        remoteOffline: true,
        remoteLastSyncedAt: "2026-08-29T10:00:00.000Z",
        status: DownloadStatus.Ready,
        isLive: false,
      }),
    );

    expect(container.textContent).toContain("dockerOffline");
    expect(
      container.querySelector<HTMLInputElement>('button[role="checkbox"]')
        ?.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="edit"]')
        ?.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="download"]',
      )?.disabled,
    ).toBe(true);
  });

  it("imports a completed local file then plays its matching library item", async () => {
    const filePath = "C:\\Videos\\Campus Film.mp4";
    mocks.libraryList.mockResolvedValue({
      items: [{ id: "library-1", path: "c:/videos/CAMPUS FILM.MP4" }],
      totalBytes: 100,
    });
    await renderItem(
      task({
        id: 41,
        name: "Campus Film",
        status: DownloadStatus.Success,
        isLive: false,
        origin: "local",
        exists: true,
        file: filePath,
      }),
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="playVideo"]')
        ?.click();
    });

    expect(mocks.libraryImportFiles).toHaveBeenCalledExactlyOnceWith(
      [filePath],
      "download",
    );
    expect(mocks.libraryList).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.libraryPlay).toHaveBeenCalledExactlyOnceWith("library-1");
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("prevents duplicate library playback while importing a file", async () => {
    const filePath = "C:\\Videos\\Campus Film.mp4";
    let finishImport!: (result: {
      added: number;
      skipped: number;
      rejected: never[];
      items: never[];
    }) => void;
    mocks.libraryImportFiles.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishImport = resolve;
        }),
    );
    mocks.libraryList.mockResolvedValue({
      items: [{ id: "library-1", path: filePath }],
      totalBytes: 100,
    });
    await renderItem(
      task({
        status: DownloadStatus.Success,
        isLive: false,
        origin: "local",
        exists: true,
        file: filePath,
      }),
    );
    const playButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="playVideo"]',
    );

    await act(async () => {
      playButton?.click();
      playButton?.click();
    });

    expect(mocks.libraryImportFiles).toHaveBeenCalledTimes(1);
    expect(playButton?.disabled).toBe(true);
    await act(async () => {
      finishImport({ added: 1, skipped: 0, rejected: [], items: [] });
    });
    expect(mocks.libraryPlay).toHaveBeenCalledExactlyOnceWith("library-1");
  });

  it("shows the file importer rejection and does not play it", async () => {
    const filePath = "C:\\Videos\\bad.mp4";
    mocks.libraryImportFiles.mockResolvedValue({
      added: 0,
      skipped: 0,
      rejected: [{ path: filePath, reason: "文件格式不受支持" }],
      items: [],
    });
    await renderItem(
      task({
        status: DownloadStatus.Success,
        isLive: false,
        origin: "local",
        exists: true,
        file: filePath,
      }),
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="playVideo"]')
        ?.click();
    });

    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      "文件格式不受支持",
    );
    expect(mocks.libraryPlay).not.toHaveBeenCalled();
  });

  it("does not open a Core player URL for a Docker task", async () => {
    await renderItem(
      task({
        status: DownloadStatus.Success,
        isLive: false,
        origin: "docker",
        exists: true,
        file: "/remote/videos/movie.mp4",
      }),
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="playVideo"]')
        ?.click();
    });

    expect(mocks.toastInfo).toHaveBeenCalledExactlyOnceWith(
      "仅本地已完成且文件存在的视频可加入片库播放。",
    );
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.libraryImportFiles).not.toHaveBeenCalled();
  });

  it("requires a local completed file before attempting library playback", async () => {
    await renderItem(
      task({
        status: DownloadStatus.Success,
        isLive: false,
        origin: "local",
        exists: false,
        file: undefined,
      }),
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="playVideo"]')
        ?.click();
    });

    expect(mocks.toastInfo).toHaveBeenCalledExactlyOnceWith(
      "仅本地已完成且文件存在的视频可加入片库播放。",
    );
    expect(mocks.libraryImportFiles).not.toHaveBeenCalled();
    expect(mocks.libraryPlay).not.toHaveBeenCalled();
  });
});
