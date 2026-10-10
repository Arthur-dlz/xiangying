import { beforeEach, expect, test, vi } from "vitest";
import { AppLanguage } from "@mediago/common";

const languageMocks = vi.hoisted(() => ({
  syncAppLanguage: vi.fn(async () => undefined),
}));

vi.mock("../i18n/app-language", () => languageMocks);

const { useAppStore } = await import("./app");

beforeEach(() => {
  languageMocks.syncAppLanguage.mockClear();
});

test("re-resolves the system language when the stored value is unchanged", () => {
  expect(useAppStore.getState().language).toBe(AppLanguage.ZH);

  useAppStore.getState().setAppStore({ language: AppLanguage.System });

  useAppStore.getState().setAppStore({ language: AppLanguage.System });

  expect(languageMocks.syncAppLanguage).toHaveBeenCalledWith(
    AppLanguage.System,
  );
});
