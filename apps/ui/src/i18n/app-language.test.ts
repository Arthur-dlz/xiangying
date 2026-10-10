import { expect, test, vi } from "vitest";
import { createAppLanguageSynchronizer } from "./app-language";

test("resolves follow-system language from the platform preference", async () => {
  const changeLanguage = vi.fn(async () => undefined);
  const setDocumentLanguage = vi.fn();
  const syncLanguage = createAppLanguageSynchronizer({
    getPreferredSystemLanguage: vi.fn(async () => "zh-CN"),
    changeLanguage,
    setDocumentLanguage,
  });

  await syncLanguage("system");

  expect(setDocumentLanguage).toHaveBeenCalledWith("zh");
  expect(changeLanguage).toHaveBeenCalledWith("zh");
});

test("applies an explicit language without querying the system", async () => {
  const getPreferredSystemLanguage = vi.fn(async () => "zh-CN");
  const changeLanguage = vi.fn(async () => undefined);
  const syncLanguage = createAppLanguageSynchronizer({
    getPreferredSystemLanguage,
    changeLanguage,
    setDocumentLanguage: vi.fn(),
  });

  await syncLanguage("it");

  expect(getPreferredSystemLanguage).not.toHaveBeenCalled();
  expect(changeLanguage).toHaveBeenCalledWith("it");
});

test("does not let a delayed system lookup overwrite a newer selection", async () => {
  let resolveSystemLanguage!: (language: string) => void;
  const getPreferredSystemLanguage = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        resolveSystemLanguage = resolve;
      }),
  );
  const changeLanguage = vi.fn(async () => undefined);
  const syncLanguage = createAppLanguageSynchronizer({
    getPreferredSystemLanguage,
    changeLanguage,
    setDocumentLanguage: vi.fn(),
  });

  const pendingSystemSync = syncLanguage("system");
  await syncLanguage("en");
  resolveSystemLanguage("zh-CN");
  await pendingSystemSync;

  expect(changeLanguage).toHaveBeenCalledTimes(1);
  expect(changeLanguage).toHaveBeenCalledWith("en");
});
