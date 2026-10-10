/** @vitest-environment happy-dom */

import { DownloadFilter, DownloadStatus, DownloadType } from "@mediago/common";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadTaskDetails } from "@/hooks/use-tasks";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  startDownload: vi.fn(),
  stopDownload: vi.fn(),
  deleteDownloadTask: vi.fn(),
  startDockerDownload: vi.fn(),
  stopDockerDownload: vi.fn(),
  deleteDockerDownloadTask: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (
      key: string,
      values?: { count?: number; success?: number; failed?: number },
    ) => {
      const translated =
        (
          {
            selectAll: "Select All",
            cancel: "Cancel",
            delete: "Delete",
            download: "Download",
            stopSelectedDownloads: "Stop selected",
            stoppingSelectedDownloads: "Stopping selected",
            stopSelectedLiveConfirmationTitle: "End live recording?",
            stopSelectedLiveConfirmationDescription:
              "End {{count}} live recording(s)?",
            stopSelectedLiveCancel: "Continue recording",
            stopSelectedLiveConfirm: "End and save",
            batchStopResult: "Stopped {{success}}; failed {{failed}}",
          } as Record<string, string>
        )[key] ?? key;
      return translated.replace(
        /\{\{(count|success|failed)\}\}/g,
        (_, name: string) =>
          String(values?.[name as "count" | "success" | "failed"] ?? 0),
      );
    },
  }),
  Trans: ({ values }: { values?: { count?: number } }) =>
    createElement("span", null, `${values?.count ?? 0} selected`),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
  },
}));

vi.mock("@/api/download-task", () => ({
  startDownload: mocks.startDownload,
  stopDownload: mocks.stopDownload,
  deleteDownloadTask: mocks.deleteDownloadTask,
}));

vi.mock("@/api/docker-download-task", () => ({
  startDockerDownload: mocks.startDockerDownload,
  stopDockerDownload: mocks.stopDockerDownload,
  deleteDockerDownloadTask: mocks.deleteDockerDownloadTask,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? createElement("div", { role: "dialog" }, children) : null,
  DialogContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DialogDescription: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DialogFooter: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DialogHeader: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DialogTitle: ({ children }: { children: ReactNode }) =>
    createElement("h2", null, children),
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    disabled,
    onCheckedChange,
    "aria-label": ariaLabel,
  }: {
    checked?: boolean | "indeterminate";
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    "aria-label"?: string;
  }) =>
    createElement("button", {
      type: "button",
      role: "checkbox",
      "aria-label": ariaLabel,
      "aria-checked": checked === "indeterminate" ? "mixed" : String(checked),
      disabled,
      onClick: () => onCheckedChange?.(checked !== true),
    }),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect?: () => void;
  }) => createElement("button", { onClick: onSelect }, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({
    contextMenu: { show: vi.fn() },
    dialog: { save: vi.fn() },
  }),
}));

vi.mock("@/store/download-dialog", () => ({
  useDownloadDialogStore: (
    selector: (state: Record<string, unknown>) => unknown,
  ) => selector({ openNew: vi.fn(), openEdit: vi.fn() }),
}));

vi.mock("./download-item", () => ({
  DownloadTaskItem: ({
    task,
    selected,
    onSelectChange,
  }: {
    task: DownloadTaskDetails;
    selected: boolean;
    onSelectChange: (task: DownloadTaskDetails) => void;
  }) =>
    createElement(
      "article",
      { role: "article", "aria-label": task.name },
      createElement("span", null, task.name),
      createElement("button", {
        type: "button",
        role: "checkbox",
        "aria-label": `Select ${task.name}`,
        "aria-checked": String(selected),
        disabled: task.remoteOffline,
        onClick: () => onSelectChange(task),
      }),
    ),
}));

const { DownloadTaskList } = await import("./download-list");

function makeTask(
  id: number,
  name: string,
  overrides: Partial<DownloadTaskDetails> = {},
): DownloadTaskDetails {
  return {
    id,
    type: DownloadType.direct,
    name,
    url: `https://example.test/${id}.mp4`,
    status: DownloadStatus.Ready,
    origin: "local",
    percent: "",
    speed: "",
    ...overrides,
  };
}

describe("DownloadTaskList selection and batch stop", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startDownload.mockResolvedValue(undefined);
    mocks.stopDownload.mockResolvedValue(undefined);
    mocks.deleteDownloadTask.mockResolvedValue(undefined);
    mocks.startDockerDownload.mockResolvedValue(undefined);
    mocks.stopDockerDownload.mockResolvedValue(undefined);
    mocks.deleteDockerDownloadTask.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("selects the full eligible set when Select All follows a partial selection", async () => {
    const tasks = [
      makeTask(1, "first"),
      makeTask(2, "second"),
      makeTask(3, "offline", { origin: "docker", remoteOffline: true }),
    ];
    await act(async () => {
      root.render(
        createElement(DownloadTaskList, {
          filter: DownloadFilter.list,
          data: tasks,
          isLoading: false,
          mutate: vi.fn().mockResolvedValue(undefined),
        }),
      );
    });

    const first = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Select first"]',
    );
    const selectAll = [...container.querySelectorAll("span")].find(
      (element) => element.textContent === "Select All",
    );
    if (!first || !selectAll)
      throw new Error("selection controls not rendered");
    await act(async () => first.click());
    expect(container.textContent).toContain("1 selected");

    await act(async () => selectAll.click());

    expect(container.textContent).toContain("2 selected");
    expect(
      container
        .querySelector('button[aria-label="Select first"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      container
        .querySelector('button[aria-label="Select second"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      container
        .querySelector('button[aria-label="Select offline"]')
        ?.getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      container.querySelector('button[aria-label="Select offline"]')?.disabled,
    ).toBe(true);

    const checkboxes = container.querySelectorAll<HTMLButtonElement>(
      'button[role="checkbox"]',
    );
    await act(async () => checkboxes[0].click());
    expect(container.textContent).not.toContain("2 selected");
    expect(
      container
        .querySelector('button[aria-label="Select first"]')
        ?.getAttribute("aria-checked"),
    ).toBe("false");

    await act(async () => first.click());
    const cancel = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel",
    );
    if (!cancel) throw new Error("selection Cancel action was not rendered");
    await act(async () => cancel.click());
    expect(container.textContent).not.toContain("1 selected");
    expect(mocks.stopDownload).not.toHaveBeenCalled();
  });

  it("stops only selected tasks and reports partial failures", async () => {
    const tasks = [
      makeTask(11, "selected-active", { status: DownloadStatus.Downloading }),
      makeTask(12, "selected-pending", { status: DownloadStatus.Pending }),
      makeTask(13, "unselected"),
      makeTask(14, "offline", { origin: "docker", remoteOffline: true }),
      makeTask(15, "selected-remote-active", {
        origin: "docker",
        status: DownloadStatus.Downloading,
      }),
    ];
    mocks.stopDownload.mockImplementation(async (id: number) => {
      if (id === 12) throw new Error("controlled stop failure");
    });
    const mutate = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root.render(
        createElement(DownloadTaskList, {
          filter: DownloadFilter.list,
          data: tasks,
          isLoading: false,
          mutate,
        }),
      );
    });
    const selectedCheckboxes = [
      "selected-active",
      "selected-pending",
      "selected-remote-active",
    ].map((name) =>
      container.querySelector<HTMLButtonElement>(
        `button[aria-label="Select ${name}"]`,
      ),
    );
    if (selectedCheckboxes.some((checkbox) => !checkbox))
      throw new Error("selected task checkboxes were not rendered");
    await act(async () => {
      selectedCheckboxes.forEach((checkbox) => checkbox?.click());
    });

    const stopButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Stop selected",
    );
    if (!stopButton) throw new Error("Stop selected action was not rendered");
    await act(async () => stopButton.click());

    expect(mocks.stopDownload.mock.calls.map(([id]) => id)).toEqual([11, 12]);
    expect(mocks.stopDockerDownload).toHaveBeenCalledExactlyOnceWith(15);
    expect(mocks.stopDownload).not.toHaveBeenCalledWith(13);
    expect(mocks.stopDownload).not.toHaveBeenCalledWith(14);
    expect(mocks.toastWarning).toHaveBeenCalledWith("Stopped 2; failed 1");
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("requires explicit confirmation for selected live recordings and does not stop on cancel", async () => {
    const liveTask = makeTask(21, "live", {
      status: DownloadStatus.Downloading,
      isLive: true,
    });
    const mutate = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root.render(
        createElement(DownloadTaskList, {
          filter: DownloadFilter.list,
          data: [liveTask],
          isLoading: false,
          mutate,
        }),
      );
    });
    const checkbox = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Select live"]',
    );
    if (!checkbox) throw new Error("live task selection was not rendered");
    await act(async () => checkbox.click());
    const stopButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Stop selected",
    );
    if (!stopButton) throw new Error("Stop selected action was not rendered");

    await act(async () => stopButton.click());
    expect(mocks.stopDownload).not.toHaveBeenCalled();
    expect(container.textContent).toContain("End 1 live recording(s)?");

    const cancel = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Continue recording",
    );
    if (!cancel)
      throw new Error("live-stop confirmation cancel was not rendered");
    await act(async () => cancel.click());
    expect(mocks.stopDownload).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => stopButton.click());
    const confirm = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "End and save",
    );
    if (!confirm)
      throw new Error("live-stop confirmation action was not rendered");
    await act(async () => confirm.click());
    expect(mocks.stopDownload).toHaveBeenCalledExactlyOnceWith(21);
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("prevents duplicate stops while a selected batch is in flight", async () => {
    let resolveStop!: () => void;
    mocks.stopDownload.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveStop = resolve;
      }),
    );
    const mutate = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root.render(
        createElement(DownloadTaskList, {
          filter: DownloadFilter.list,
          data: [makeTask(31, "slow-stop")],
          isLoading: false,
          mutate,
        }),
      );
    });
    const checkbox = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Select slow-stop"]',
    );
    if (!checkbox) throw new Error("task selection was not rendered");
    await act(async () => checkbox.click());
    const stopButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Stop selected",
    );
    if (!stopButton) throw new Error("Stop selected action was not rendered");

    await act(async () => {
      stopButton.click();
      stopButton.click();
    });

    expect(mocks.stopDownload).toHaveBeenCalledExactlyOnceWith(31);
    const busyButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Stopping selected",
    );
    expect(busyButton?.disabled).toBe(true);
    await act(async () => resolveStop());
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("reports an all-failed selected stop batch as an error", async () => {
    mocks.stopDownload.mockRejectedValue(new Error("controlled failure"));
    const taskRecord = makeTask(41, "failed-stop");
    await act(async () => {
      root.render(
        createElement(DownloadTaskList, {
          filter: DownloadFilter.list,
          data: [taskRecord],
          isLoading: false,
          mutate: vi.fn().mockResolvedValue(undefined),
        }),
      );
    });
    const checkbox = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Select failed-stop"]',
    );
    if (!checkbox) throw new Error("task selection was not rendered");
    await act(async () => checkbox.click());
    const stopButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Stop selected",
    );
    if (!stopButton) throw new Error("Stop selected action was not rendered");

    await act(async () => stopButton.click());

    expect(mocks.toastError).toHaveBeenCalledWith("Stopped 0; failed 1");
  });
});
