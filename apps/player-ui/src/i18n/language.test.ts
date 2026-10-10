import { describe, expect, test } from "vitest";
import { resolvePlayerLanguage } from "./language";

describe("resolvePlayerLanguage", () => {
  test.each([
    [["zh-CN", "en-US"], "zh-CN"],
    [["zh-TW"], "zh-CN"],
    [["it-IT"], "it"],
    [["en-GB"], "en"],
    [["fr-FR"], "en"],
  ] as const)("resolves %j to %s", (languages, expected) => {
    expect(resolvePlayerLanguage(languages)).toBe(expected);
  });
});
