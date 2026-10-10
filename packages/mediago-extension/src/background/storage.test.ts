import { afterEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_SETTINGS, STORAGE_KEY_SETTINGS } from "../shared/constants";
import { loadSettings, saveSettings } from "./storage";

afterEach(() => {
  vi.unstubAllGlobals();
});

function installLocalStorage(stored?: unknown) {
  const get = vi.fn(async () =>
    stored === undefined ? {} : { [STORAGE_KEY_SETTINGS]: stored },
  );
  const set = vi.fn(async () => undefined);
  vi.stubGlobal("chrome", { storage: { local: { get, set } } });
  return { get, set };
}

describe("extension settings storage", () => {
  test("enables the page quick action for a new install", async () => {
    installLocalStorage();

    await expect(loadSettings()).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      pageQuickActionEnabled: true,
    });
  });

  test("migrates an older partial settings object to the enabled default", async () => {
    installLocalStorage({ language: "it", downloadNow: true });

    await expect(loadSettings()).resolves.toMatchObject({
      language: "it",
      downloadNow: true,
      pageQuickActionEnabled: true,
    });
  });

  test("preserves an explicitly disabled page quick action", async () => {
    installLocalStorage({ pageQuickActionEnabled: false });

    await expect(loadSettings()).resolves.toMatchObject({
      pageQuickActionEnabled: false,
    });
  });

  test("persists the page quick action preference with the complete settings", async () => {
    const { set } = installLocalStorage();
    const settings = { ...DEFAULT_SETTINGS, pageQuickActionEnabled: false };

    await saveSettings(settings);

    expect(set).toHaveBeenCalledWith({ [STORAGE_KEY_SETTINGS]: settings });
  });
});
