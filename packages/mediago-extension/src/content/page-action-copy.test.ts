import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { resources } from "../i18n/resources";
import type { SupportedLanguage } from "../i18n/language";
import type { ExtensionLanguage } from "../shared/types";
import * as pageActionCopy from "./page-action-copy";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("page action copy", () => {
  test("uses the canonical concrete language set for resources and button copy", () => {
    expectTypeOf<SupportedLanguage>().toEqualTypeOf<
      Exclude<ExtensionLanguage, "system">
    >();
    expect(Object.keys(pageActionCopy.PAGE_ACTION_COPY).toSorted()).toEqual(
      Object.keys(resources).toSorted(),
    );
  });

  test.each([
    ["zh", "添加到 MediaGo", "正在添加…", "添加失败，重试"],
    ["en", "Add to MediaGo", "Adding…", "Failed, try again"],
    ["it", "Aggiungi a MediaGo", "Aggiunta…", "Errore, riprova"],
  ] as const)(
    "returns compact %s labels for idle, busy, and retry states",
    (language, idle, busy, failure) => {
      const getCopy = (
        pageActionCopy as typeof pageActionCopy & {
          getPageActionCopy?: (language: "zh" | "en" | "it") => {
            idle: string;
            busy: string;
            failure: string;
            accessibleName: string;
          };
        }
      ).getPageActionCopy;
      expect(getCopy).toBeTypeOf("function");
      if (!getCopy) throw new Error("Page action copy resolver is unavailable");

      const copy = getCopy(language);

      expect(copy).toMatchObject({ idle, busy, failure });
      expect(copy.accessibleName).toContain("MediaGo");
    },
  );

  test("follows the Chrome UI language for the system preference", () => {
    vi.stubGlobal("chrome", {
      i18n: { getUILanguage: () => "it-IT" },
    });

    expect(pageActionCopy.getPageActionCopy("system").idle).toBe(
      "Aggiungi a MediaGo",
    );
  });

  test("falls back to English for an unknown browser UI language", () => {
    vi.stubGlobal("chrome", {
      i18n: { getUILanguage: () => "de-DE" },
    });

    expect(pageActionCopy.getPageActionCopy("system").idle).toBe(
      "Add to MediaGo",
    );
  });
});
