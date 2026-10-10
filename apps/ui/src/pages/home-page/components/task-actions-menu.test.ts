/** @vitest-environment happy-dom */

import { DownloadStatus, DownloadType } from "@mediago/common";
import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) =>
    createElement(Fragment, null, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onSelect?: () => void;
  }) => createElement("button", { disabled, onClick: onSelect }, children),
  DropdownMenuSeparator: () => createElement("hr"),
}));

const { TaskActionsMenu } = await import("./task-actions-menu");

describe("TaskActionsMenu live recording labels", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function renderMenu(
    status: DownloadStatus,
    isStoppingRecording = false,
  ) {
    await act(async () => {
      root.render(
        createElement(TaskActionsMenu, {
          task: {
            id: 1,
            type: DownloadType.m3u8,
            name: "Live stream",
            url: "https://example.com/live.m3u8",
            status,
            isLive: true,
          },
          isStoppingRecording,
          onDelete: vi.fn(),
          onEdit: vi.fn(),
          onPlay: vi.fn(),
          onRefresh: vi.fn(),
          onSelect: vi.fn(),
          onStart: vi.fn(),
          onStop: vi.fn(),
        }),
      );
    });
  }

  it("uses end-recording semantics while a live task is active", async () => {
    await renderMenu(DownloadStatus.Downloading);
    expect(container.textContent).toContain("endRecording");
    expect(container.textContent).not.toContain("pause");

    await renderMenu(DownloadStatus.Downloading, true);
    const ending = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("endingRecording"),
    );
    expect(ending?.disabled).toBe(true);
  });

  it("labels a stopped live task as a new recording", async () => {
    await renderMenu(DownloadStatus.Stopped);
    expect(container.textContent).toContain("recordAgain");
    expect(container.textContent).not.toContain("continueDownload");
  });
});
