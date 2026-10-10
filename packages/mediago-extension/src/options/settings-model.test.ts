import { describe, expect, test } from "vitest";

import type {
  ExtensionSettings,
  InvocationMode,
  LocalizedMessage,
} from "../shared/types";

import * as settingsModel from "./settings-model";

const { applySettingsPatch, isDownloadNowAvailable } = settingsModel;

const currentSettings: ExtensionSettings = {
  mode: "docker-http",
  serverUrl: "https://mediago.example.test",
  apiKey: "api-key",
  downloadNow: true,
  language: "zh",
  pageQuickActionEnabled: true,
};

type SaveResult = { ok: boolean; settings: ExtensionSettings };

interface SettingsSaveCoordinator {
  enqueue(patch: Partial<ExtensionSettings>): Promise<SaveResult>;
  getCurrent(): ExtensionSettings;
}

type CreateSettingsSaveCoordinator = (
  initial: ExtensionSettings,
  save: (settings: ExtensionSettings) => Promise<boolean>,
) => SettingsSaveCoordinator;

function coordinatorFactory(): CreateSettingsSaveCoordinator {
  const factory = (
    settingsModel as typeof settingsModel & {
      createSettingsSaveCoordinator?: CreateSettingsSaveCoordinator;
    }
  ).createSettingsSaveCoordinator;
  expect(factory).toBeTypeOf("function");
  if (!factory) throw new Error("Settings save coordinator is not available");
  return factory;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

interface ConnectionDraft {
  mode: InvocationMode;
  serverUrl: string;
  apiKey: string;
}

type ConnectionPatch = Pick<ExtensionSettings, "mode" | "serverUrl" | "apiKey">;

function connectionModel() {
  const model = settingsModel as typeof settingsModel & {
    normalizeConnectionDraft?: (draft: ConnectionDraft) => ConnectionPatch;
    validateConnectionDraft?: (
      draft: ConnectionDraft,
    ) => LocalizedMessage | null;
  };
  expect(model.normalizeConnectionDraft).toBeTypeOf("function");
  expect(model.validateConnectionDraft).toBeTypeOf("function");
  if (!model.normalizeConnectionDraft || !model.validateConnectionDraft) {
    throw new Error("Connection settings model is not available");
  }
  return model;
}

describe("applySettingsPatch", () => {
  test("preserves unpatched fields when changing mode", () => {
    expect(
      applySettingsPatch(currentSettings, { mode: "desktop-http" }),
    ).toEqual({
      ...currentSettings,
      mode: "desktop-http",
    });
  });

  test("preserves server and mode when changing language", () => {
    expect(applySettingsPatch(currentSettings, { language: "en" })).toEqual({
      ...currentSettings,
      language: "en",
    });
  });

  test("preserves other preferences when changing the page quick action", () => {
    expect(
      applySettingsPatch(currentSettings, { pageQuickActionEnabled: false }),
    ).toEqual({ ...currentSettings, pageQuickActionEnabled: false });
  });

  test("does not mutate either input", () => {
    const current = { ...currentSettings };
    const patch = { serverUrl: "https://next.example.test" };

    const result = applySettingsPatch(current, patch);

    expect(result).not.toBe(current);
    expect(result).not.toBe(patch);
    expect(current).toEqual(currentSettings);
    expect(patch).toEqual({ serverUrl: "https://next.example.test" });
  });
});

describe("isDownloadNowAvailable", () => {
  test.each([
    ["desktop HTTP", "desktop-http", true],
    ["Docker HTTP", "docker-http", true],
    ["desktop schema", "desktop-schema", false],
  ] as const)("is %s availability", (_label, mode, expected) => {
    expect(isDownloadNowAvailable(mode)).toBe(expected);
  });
});

describe("settings save coordination", () => {
  test("serializes rapid preference changes and merges each into the latest saved settings", async () => {
    const firstSave = deferred<boolean>();
    const writes: ExtensionSettings[] = [];
    const createCoordinator = coordinatorFactory();
    const coordinator = createCoordinator(currentSettings, async (settings) => {
      writes.push(settings);
      if (writes.length === 1) return firstSave.promise;
      return true;
    });

    const languageSave = coordinator.enqueue({ language: "en" });
    const downloadSave = coordinator.enqueue({ downloadNow: false });

    await Promise.resolve();
    expect(writes).toEqual([{ ...currentSettings, language: "en" }]);

    firstSave.resolve(true);
    await languageSave;
    await downloadSave;

    expect(writes).toEqual([
      { ...currentSettings, language: "en" },
      { ...currentSettings, language: "en", downloadNow: false },
    ]);
    expect(coordinator.getCurrent()).toEqual(writes[1]);
  });

  test("keeps preference saves when a queued connection draft is persisted", async () => {
    const createCoordinator = coordinatorFactory();
    const writes: ExtensionSettings[] = [];
    const coordinator = createCoordinator(currentSettings, async (settings) => {
      writes.push(settings);
      return true;
    });

    await Promise.all([
      coordinator.enqueue({ language: "it" }),
      coordinator.enqueue({
        mode: "desktop-http",
        serverUrl: "",
        apiKey: "",
      }),
    ]);

    expect(writes.at(-1)).toEqual({
      ...currentSettings,
      language: "it",
      mode: "desktop-http",
      serverUrl: "",
      apiKey: "",
    });
  });

  test("does not advance authoritative settings after a failed write", async () => {
    const createCoordinator = coordinatorFactory();
    let attempt = 0;
    const coordinator = createCoordinator(currentSettings, async () => {
      attempt += 1;
      return attempt > 1;
    });

    const failed = await coordinator.enqueue({ language: "it" });
    const recovered = await coordinator.enqueue({ downloadNow: false });

    expect(failed).toEqual({ ok: false, settings: currentSettings });
    expect(recovered).toEqual({
      ok: true,
      settings: { ...currentSettings, downloadNow: false },
    });
  });
});

describe("connection settings model", () => {
  test("normalizes Docker URL and credentials before persistence", () => {
    const model = connectionModel();

    expect(
      model.normalizeConnectionDraft({
        mode: "docker-http",
        serverUrl: "  https://mediago.example.test///  ",
        apiKey: "  secret  ",
      }),
    ).toEqual({
      mode: "docker-http",
      serverUrl: "https://mediago.example.test",
      apiKey: "secret",
    });
  });

  test("clears Docker-only fields for desktop modes", () => {
    const model = connectionModel();

    expect(
      model.normalizeConnectionDraft({
        mode: "desktop-schema",
        serverUrl: "https://stale.example.test",
        apiKey: "stale",
      }),
    ).toEqual({
      mode: "desktop-schema",
      serverUrl: "",
      apiKey: "",
    });
  });

  test("requires a non-empty server URL only for Docker mode", () => {
    const model = connectionModel();

    expect(
      model.validateConnectionDraft({
        mode: "docker-http",
        serverUrl: "   ",
        apiKey: "",
      }),
    ).toEqual({ key: "errors.dockerServerRequired" });
    expect(
      model.validateConnectionDraft({
        mode: "desktop-http",
        serverUrl: "",
        apiKey: "",
      }),
    ).toBeNull();
  });
});
