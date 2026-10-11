/** @vitest-environment happy-dom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DownloadType } from "@mediago/common";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  createDownloadTasks: vi.fn(),
  createDockerDownloadTasks: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock("@/api/download-task", () => ({
  createDownloadTasks: mocks.createDownloadTasks,
}));

vi.mock("@/api/docker-download-task", () => ({
  createDockerDownloadTasks: mocks.createDockerDownloadTasks,
}));

vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({ browser: { showDownloadDialog: vi.fn() } }),
}));

const { BrowserViewPanel } = await import("./browser-view-panel");
const { useBrowserStore } = await import("@/store/browser");
const { useAppStore } = await import("@/store/app");

describe("BrowserViewPanel direct download", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.createDownloadTasks.mockResolvedValue([{ id: 17 }]);
    mocks.createDockerDownloadTasks.mockResolvedValue([{ id: 18 }]);
    useBrowserStore.getState().reset();
    useBrowserStore.getState().hydrateSnapshot({
      tabs: [
        {
          id: "tab-1905",
          kind: "user",
          mode: "browser",
          status: "loaded",
          isMobile: false,
          url: "https://www.1905.com/vod/play/388459.shtml",
          title: "1905",
          sources: [
            {
              id: "resource-1",
              url: "https://cdn.example.test/video.mp4",
              documentURL: "https://www.1905.com/vod/play/388459.shtml",
              name: "1905 video",
              type: DownloadType.mp4,
            },
          ],
        },
      ],
      activeTabId: "tab-1905",
      sourcePanelCollapsed: false,
    });
    useAppStore.setState({ enableDocker: false });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(BrowserViewPanel));
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("gives visible confirmation after the source-card download request succeeds", async () => {
    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("downloadNow"),
    );

    await act(async () => {
      button?.click();
    });

    expect(mocks.createDownloadTasks).toHaveBeenCalledWith(
      [
        {
          url: "https://cdn.example.test/video.mp4",
          name: "1905 video",
          headers: undefined,
          type: DownloadType.mp4,
          folder: "",
        },
      ],
      true,
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已加入下载任务");
  });

  it("surfaces a rejected download request", async () => {
    mocks.createDownloadTasks.mockRejectedValueOnce(
      new Error("request failed"),
    );
    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("downloadNow"),
    );

    await act(async () => {
      button?.click();
    });

    expect(mocks.toastError).toHaveBeenCalledWith("request failed");
  });

  it("does not report success when the API returns no created tasks", async () => {
    mocks.createDownloadTasks.mockResolvedValueOnce([]);
    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("downloadNow"),
    );

    await act(async () => {
      button?.click();
    });

    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith("未能创建下载任务");
  });

  it("blocks duplicate clicks while task creation is pending", async () => {
    let resolve!: (value: unknown[]) => void;
    mocks.createDownloadTasks.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("downloadNow"),
    );

    await act(async () => {
      button?.click();
    });
    expect(button?.disabled).toBe(true);

    await act(async () => {
      button?.click();
    });
    expect(mocks.createDownloadTasks).toHaveBeenCalledTimes(1);

    await act(async () => resolve([{ id: 17 }]));
    expect(button?.disabled).toBe(false);
  });

  it("adds the selected source to Docker via the dedicated action and label", async () => {
    await act(async () => {
      useAppStore.setState({ enableDocker: true });
    });

    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.getAttribute("aria-label") === "addToDocker",
    );
    expect(button).toBeDefined();

    await act(async () => {
      button?.click();
    });

    expect(mocks.createDockerDownloadTasks).toHaveBeenCalledWith([
      {
        url: "https://cdn.example.test/video.mp4",
        name: "1905 video",
        headers: undefined,
        type: DownloadType.mp4,
        folder: "",
      },
    ]);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("addToDockerSuccess");
  });
});
