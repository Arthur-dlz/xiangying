/** @vitest-environment happy-dom */

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${String(values.count)}` : key,
  }),
}));
vi.mock("./converter-workbench", () => ({
  ConversionFilePicker: ({
    files,
    disabled,
    onRemove,
    onClear,
  }: {
    files: Array<{ path: string; name: string }>;
    disabled: boolean;
    onRemove: (path: string) => void;
    onClear: () => void;
  }) =>
    createElement(
      "div",
      { "data-testid": "fixture-picker" },
      ...files.map((file) =>
        createElement(
          "button",
          {
            key: file.path,
            type: "button",
            disabled,
            onClick: () => onRemove(file.path),
          },
          `remove:${file.name}`,
        ),
      ),
      createElement(
        "button",
        { type: "button", disabled, onClick: onClear },
        "clear:fixture",
      ),
    ),
}));

const { ConversionSettingsDialog } =
  await import("./conversion-settings-dialog");

let root: Root | undefined;
let container: HTMLDivElement;

async function render(
  props: Partial<ComponentProps<typeof ConversionSettingsDialog>> = {},
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const defaults: ComponentProps<typeof ConversionSettingsDialog> = {
    open: true,
    files: [],
    isDragging: false,
    outputType: "video",
    outputFormat: "mp4",
    quality: "medium",
    isSubmitting: false,
    onOpenChange: vi.fn(),
    onBrowse: vi.fn(),
    onDrop: vi.fn(),
    onDragOver: vi.fn(),
    onDragLeave: vi.fn(),
    onRemove: vi.fn(),
    onClear: vi.fn(),
    onOutputTypeChange: vi.fn(),
    onOutputFormatChange: vi.fn(),
    onQualityChange: vi.fn(),
    onSubmit: vi.fn(),
  };
  await act(async () => {
    root?.render(
      createElement(ConversionSettingsDialog, { ...defaults, ...props }),
    );
  });
  return defaults;
}

async function click(label: string) {
  const button = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.includes(label),
  );
  expect(button, `button ${label} should exist`).toBeDefined();
  await act(async () => button?.click());
}

async function openOptions(triggerId: string) {
  const trigger = document.getElementById(triggerId);
  expect(trigger, `select ${triggerId} should exist`).not.toBeNull();
  await act(async () => {
    trigger?.click();
    await Promise.resolve();
  });
  return [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
}

async function chooseOpenOption(optionLabel: string) {
  const option = [
    ...document.body.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((candidate) => candidate.textContent?.trim() === optionLabel);
  expect(option, `option ${optionLabel} should be available`).toBeDefined();
  await act(async () => option?.click());
}

async function rerender(
  defaults: ComponentProps<typeof ConversionSettingsDialog>,
  overrides: Partial<ComponentProps<typeof ConversionSettingsDialog>>,
) {
  await act(async () => {
    root?.render(
      createElement(ConversionSettingsDialog, { ...defaults, ...overrides }),
    );
  });
}

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  container?.remove();
  document
    .querySelectorAll("[data-radix-portal]")
    .forEach((portal) => portal.remove());
});

test("requires at least one staged file before either submit action", async () => {
  const handlers = await render();
  const buttons = [...document.body.querySelectorAll("button")];
  const queueButton = buttons.find((button) =>
    button.textContent?.includes("addSelectedToQueue"),
  );
  const startButton = buttons.find((button) =>
    button.textContent?.includes("startSelectedConversions"),
  );

  expect(queueButton?.disabled).toBe(true);
  expect(startButton?.disabled).toBe(true);
  await act(async () => {
    queueButton?.click();
    startButton?.click();
  });
  expect(handlers.onSubmit).not.toHaveBeenCalled();
});

test("offers the correct output types, formats, and quality choices", async () => {
  const handlers = await render({
    files: [
      {
        path: "C:/isolated/input/fixture.mp4",
        name: "fixture.mp4",
        extension: "mp4",
        kind: "video",
      },
    ],
  });

  const outputTypes = await openOptions("conversion-output-type");
  expect(outputTypes.map((option) => option.textContent?.trim())).toContain(
    "videoOutput",
  );
  expect(outputTypes.map((option) => option.textContent?.trim())).toContain(
    "audioOutput",
  );
  await chooseOpenOption("audioOutput");
  expect(handlers.onOutputTypeChange).toHaveBeenCalledWith("audio");

  await rerender(handlers, { outputType: "video", outputFormat: "mp4" });
  const videoFormats = (await openOptions("conversion-output-format")).map(
    (option) => option.textContent?.trim(),
  );
  expect(videoFormats).toEqual(expect.arrayContaining(["mp4", "mkv", "webm"]));
  await chooseOpenOption("mkv");
  expect(handlers.onOutputFormatChange).toHaveBeenCalledWith("mkv");

  await rerender(handlers, { outputType: "audio", outputFormat: "mp3" });
  const audioFormats = (await openOptions("conversion-output-format")).map(
    (option) => option.textContent?.trim(),
  );
  expect(audioFormats).toEqual(
    expect.arrayContaining(["mp3", "aac", "flac", "wav"]),
  );
  await chooseOpenOption("flac");
  expect(handlers.onOutputFormatChange).toHaveBeenCalledWith("flac");

  const qualities = (await openOptions("conversion-quality")).map((option) =>
    option.textContent?.trim(),
  );
  expect(qualities).toEqual(
    expect.arrayContaining([
      "conversionQualityHigh",
      "conversionQualityMedium",
      "conversionQualityLow",
    ]),
  );
  await chooseOpenOption("conversionQualityHigh");
  expect(handlers.onQualityChange).toHaveBeenCalledWith("high");
});

test("routes queue and immediate-start intents without starting conversion itself", async () => {
  const handlers = await render({
    files: [
      {
        path: "C:/isolated/input/fixture.mp4",
        name: "fixture.mp4",
        extension: "mp4",
        kind: "video",
      },
    ],
  });

  await click("addSelectedToQueue");
  await click("startSelectedConversions");

  expect(handlers.onSubmit).toHaveBeenNthCalledWith(1, false);
  expect(handlers.onSubmit).toHaveBeenNthCalledWith(2, true);
});

test("reports removal and clear actions for staged synthetic files", async () => {
  const onRemove = vi.fn();
  const onClear = vi.fn();
  await render({
    files: [
      {
        path: "C:/isolated/input/fixture.mp4",
        name: "fixture.mp4",
        extension: "mp4",
        kind: "video",
      },
      {
        path: "C:/isolated/input/fixture.wav",
        name: "fixture.wav",
        extension: "wav",
        kind: "audio",
      },
    ],
    onRemove,
    onClear,
  });

  await click("remove:fixture.mp4");
  await click("clear:fixture");

  expect(onRemove).toHaveBeenCalledWith("C:/isolated/input/fixture.mp4");
  expect(onClear).toHaveBeenCalledOnce();
});

test("locks controls while submitting and reports file-list actions", async () => {
  const onRemove = vi.fn();
  const onClear = vi.fn();
  const onOpenChange = vi.fn();
  const onSubmit = vi.fn();
  const onOutputTypeChange = vi.fn();
  const onOutputFormatChange = vi.fn();
  const onQualityChange = vi.fn();
  await render({
    files: [
      {
        path: "C:/isolated/input/fixture.wav",
        name: "fixture.wav",
        extension: "wav",
        kind: "audio",
      },
    ],
    isSubmitting: true,
    onRemove,
    onClear,
    onOpenChange,
    onSubmit,
    onOutputTypeChange,
    onOutputFormatChange,
    onQualityChange,
  });

  const remove = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent === "remove:fixture.wav",
  );
  const clear = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent === "clear:fixture",
  );
  expect(remove?.disabled).toBe(true);
  expect(clear?.disabled).toBe(true);
  const queue = [...document.body.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("addSelectedToQueue"),
  );
  const start = [...document.body.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("addingConversionTasks"),
  );
  expect(queue?.disabled).toBe(true);
  expect(start?.disabled).toBe(true);
  expect(
    document.getElementById("conversion-output-type")?.hasAttribute("disabled"),
  ).toBe(true);
  expect(
    [...document.body.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("addingConversionTasks"),
    ),
  ).toBe(true);
  await act(async () => {
    remove?.click();
    clear?.click();
    queue?.click();
    start?.click();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(onRemove).not.toHaveBeenCalled();
  expect(onClear).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
  expect(onOutputTypeChange).not.toHaveBeenCalled();
  expect(onOutputFormatChange).not.toHaveBeenCalled();
  expect(onQualityChange).not.toHaveBeenCalled();
  expect(onOpenChange).not.toHaveBeenCalled();
});
