/** @vitest-environment happy-dom */

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { Conversion } from "@mediago/common";
import { ConversionTaskList } from "./conversion-task-list";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string) =>
      ({
        stopAllConversions: "Stop all",
        convertAll: "Convert all",
        clearCompletedConversions: "Clear completed",
      })[key] ?? key,
  }),
}));

vi.mock("lucide-react", () =>
  Object.fromEntries(
    ["CircleAlert", "FolderOpen", "Play", "RefreshCw", "Square", "Trash2"].map(
      (name) => [name, () => null],
    ),
  ),
);
vi.mock("@/components/app-empty-state", () => ({
  AppEmptyState: () => null,
}));
vi.mock("@/components/download-tag", () => ({
  DownloadTag: () => null,
}));
vi.mock("@/components/loading", () => ({ default: () => null }));
vi.mock("@/components/ui/pagination", () => ({
  PaginationControl: () => null,
}));
vi.mock("@/components/ui/progress", () => ({ Progress: () => null }));
vi.mock("@/components/ui/tooltip", () => {
  return {
    Tooltip: ({ children }: { children: ReactNode }) =>
      createElement("span", null, children),
    TooltipContent: ({ children }: { children: ReactNode }) =>
      createElement("span", null, children),
    TooltipProvider: ({ children }: { children: ReactNode }) =>
      createElement("span", null, children),
    TooltipTrigger: ({ children }: { children: ReactNode }) =>
      createElement("span", null, children),
  };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const currentPageDoneTasks: Conversion[] = Array.from(
  { length: 4 },
  (_, index) => ({
    id: index + 11,
    name: `page-two-done-${index + 1}`,
    path: `C:/media/page-two-${index + 1}.mp4`,
    status: "done",
    outputPath: `C:/media/page-two-${index + 1}-out.mp4`,
    outputFormat: "mp4",
    quality: "medium",
    progress: 100,
  }),
);

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

test("offers queue-wide actions when the current page has only completed work", () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  act(() => {
    root?.render(
      createElement(ConversionTaskList, {
        data: { total: 14, list: currentPageDoneTasks },
        error: undefined,
        isLoading: false,
        isBulkActionRunning: false,
        page: 2,
        pageSize: 10,
        onPageChange: vi.fn(),
        onPageSizeChange: vi.fn(),
        onRefresh: vi.fn(),
        onStart: vi.fn(),
        onStop: vi.fn(),
        onDelete: vi.fn(),
        onOpenFolder: vi.fn(),
        onConvertAll: vi.fn(),
        onStopAll: vi.fn(),
        onClearCompleted: vi.fn(),
      }),
    );
  });

  const labels = ["Convert all", "Stop all", "Clear completed"];
  const buttons = Array.from(container.querySelectorAll("button"));
  expect(
    labels.every((label) =>
      buttons.some((button) => button.textContent?.includes(label)),
    ),
  ).toBe(true);
});

test("disables all queue-wide actions while a bulk operation is running", () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  act(() => {
    root?.render(
      createElement(ConversionTaskList, {
        data: { total: 14, list: currentPageDoneTasks },
        error: undefined,
        isLoading: false,
        isBulkActionRunning: true,
        page: 2,
        pageSize: 10,
        onPageChange: vi.fn(),
        onPageSizeChange: vi.fn(),
        onRefresh: vi.fn(),
        onStart: vi.fn(),
        onStop: vi.fn(),
        onDelete: vi.fn(),
        onOpenFolder: vi.fn(),
        onConvertAll: vi.fn(),
        onStopAll: vi.fn(),
        onClearCompleted: vi.fn(),
      }),
    );
  });

  const buttons = Array.from(container.querySelectorAll("button")).filter(
    (button) =>
      ["Convert all", "Stop all", "Clear completed"].some((label) =>
        button.textContent?.includes(label),
      ),
  );
  expect(buttons).toHaveLength(3);
  expect(buttons.every((button) => button.disabled)).toBe(true);
});
