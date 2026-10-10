/** @vitest-environment happy-dom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConversions: vi.fn(),
  startConversion: vi.fn(),
  stopConversion: vi.fn(),
  deleteConversion: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock("@/api/conversion", () => ({
  addConversion: vi.fn(),
  deleteConversion: mocks.deleteConversion,
  getConversions: mocks.getConversions,
  startConversion: mocks.startConversion,
  stopConversion: mocks.stopConversion,
}));

vi.mock("@/hooks/use-conversions", () => ({
  useConversions: () => ({
    data: {
      total: 2,
      list: [
        { id: 1, name: "first", path: "first.mp4", status: "pending" },
        { id: 2, name: "second", path: "second.mp4", status: "pending" },
      ],
    },
    error: undefined,
    isLoading: false,
    mutate: mocks.mutate,
    deleteConversion: mocks.deleteConversion,
    startConversion: mocks.startConversion,
    stopConversion: mocks.stopConversion,
  }),
}));

vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({
    app: { getPathForFile: vi.fn() },
    dialog: { open: vi.fn() },
    shell: { open: vi.fn() },
  }),
}));

vi.mock("@/utils", () => ({ tdApp: { onEvent: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        stopAllConversions: "Stop all",
        convertAll: "Convert all",
        clearCompletedConversions: "Clear completed",
      })[key] ?? key,
  }),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock("lucide-react", () =>
  Object.fromEntries(
    [
      "CircleAlert",
      "FolderOpen",
      "Play",
      "Plus",
      "RefreshCw",
      "Square",
      "Trash2",
    ].map((name) => [name, () => null]),
  ),
);
vi.mock("@/components/page-container", () => ({
  default: ({
    children,
    rightExtra,
  }: {
    children: React.ReactNode;
    rightExtra?: React.ReactNode;
  }) => createElement("main", null, rightExtra, children),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
  }) => createElement("button", props, children),
}));
vi.mock("./conversion-settings-dialog", () => ({
  ConversionSettingsDialog: () => null,
}));
vi.mock("@/components/app-empty-state", () => ({ AppEmptyState: () => null }));
vi.mock("@/components/download-tag", () => ({ DownloadTag: () => null }));
vi.mock("@/components/loading", () => ({ default: () => null }));
vi.mock("@/components/ui/pagination", () => ({
  PaginationControl: () => null,
}));
vi.mock("@/components/ui/progress", () => ({ Progress: () => null }));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    createElement("span", null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    createElement("span", null, children),
  TooltipProvider: ({ children }: { children: React.ReactNode }) =>
    createElement("span", null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    createElement("span", null, children),
}));

const { default: Converter } = await import("./index");

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.clearAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function bulkButtons() {
  return [...(container?.querySelectorAll("button") ?? [])].filter((button) =>
    ["Convert all", "Stop all", "Clear completed"].some((label) =>
      button.textContent?.includes(label),
    ),
  );
}

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 2_000, interval: 10 });
}

test("releases the bulk command gate before its read-only refresh settles", async () => {
  const startWrites = [deferred<void>(), deferred<void>()];
  const stopWrites = [deferred<void>(), deferred<void>()];
  const refreshes = [deferred<void>(), deferred<void>()];
  let refreshIndex = 0;
  mocks.getConversions
    .mockResolvedValueOnce({
      total: 2,
      list: [
        { id: 1, name: "first", path: "first.mp4", status: "pending" },
        { id: 2, name: "second", path: "second.mp4", status: "pending" },
      ],
    })
    .mockResolvedValueOnce({
      total: 2,
      list: [
        { id: 1, name: "first", path: "first.mp4", status: "converting" },
        { id: 2, name: "second", path: "second.mp4", status: "converting" },
      ],
    });
  mocks.startConversion.mockImplementation(
    (id: number) => startWrites[id - 1].promise,
  );
  mocks.stopConversion.mockImplementation(
    (id: number) => stopWrites[id - 1].promise,
  );
  mocks.mutate.mockImplementation(() => refreshes[refreshIndex++].promise);

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Converter));
  });

  const findButton = (label: string) =>
    bulkButtons().find((button) => button.textContent?.includes(label));
  await act(async () => findButton("Convert all")?.click());
  await waitFor(() => expect(mocks.startConversion).toHaveBeenCalledTimes(2));
  expect(bulkButtons().every((button) => button.disabled)).toBe(true);

  await act(async () => {
    startWrites.forEach(({ resolve }) => resolve());
  });
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
  expect(refreshIndex).toBe(1);
  expect(bulkButtons().every((button) => !button.disabled)).toBe(true);

  await act(async () => findButton("Stop all")?.click());
  await waitFor(() => expect(mocks.stopConversion).toHaveBeenCalledTimes(2));
  expect(bulkButtons().every((button) => button.disabled)).toBe(true);

  await act(async () => refreshes[0].resolve());
  expect(bulkButtons().every((button) => button.disabled)).toBe(true);

  await act(async () => {
    stopWrites.forEach(({ resolve }) => resolve());
  });
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(2));
  expect(refreshIndex).toBe(2);
  expect(bulkButtons().every((button) => !button.disabled)).toBe(true);

  await act(async () => refreshes[1].resolve());
});
