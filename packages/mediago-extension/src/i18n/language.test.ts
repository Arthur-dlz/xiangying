import { afterEach, describe, expect, test, vi } from "vitest";

import { resolveLanguage } from "./language";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveLanguage", () => {
  test.each([
    ["zh", "zh"],
    ["en", "en"],
    ["it", "it"],
  ] as const)("keeps the explicit %s language", (setting, expected) => {
    expect(resolveLanguage(setting)).toBe(expected);
  });

  test.each([
    ["zh-CN", "zh"],
    ["it-IT", "it"],
    ["fr-FR", "en"],
  ] as const)("maps browser UI language %s to %s", (uiLanguage, expected) => {
    vi.stubGlobal("chrome", {
      i18n: { getUILanguage: () => uiLanguage },
    });

    expect(resolveLanguage("system")).toBe(expected);
  });
});
