import { describe, expect, it } from "vitest";
import {
  GISCUS_CONFIG,
  getGiscusProps,
  getGiscusLanguage,
  getGiscusTheme,
} from "./giscus-config";

describe("Giscus comments configuration", () => {
  it("targets the MediaGo General discussion category by pathname", () => {
    expect(GISCUS_CONFIG).toEqual({
      repo: "mediago-dev/mediago",
      repoId: "MDEwOlJlcG9zaXRvcnkzMzQ0ODUzOTI=",
      category: "General",
      categoryId: "DIC_kwDOE-_XkM4CVWnu",
      mapping: "pathname",
      strict: "1",
      reactionsEnabled: "1",
      emitMetadata: "0",
      inputPosition: "top",
    });
  });

  it.each([
    ["zh", "zh-CN"],
    ["zh-CN", "zh-CN"],
    ["en", "en"],
    ["jp", "ja"],
    ["ja", "ja"],
    ["it", "it"],
  ])("maps the VitePress language %s to %s", (language, expected) => {
    expect(getGiscusLanguage(language)).toBe(expected);
  });

  it("falls back to Chinese for an unknown site language", () => {
    expect(getGiscusLanguage("unknown")).toBe("zh-CN");
  });

  it("follows the VitePress color mode", () => {
    expect(getGiscusTheme(false)).toBe("light");
    expect(getGiscusTheme(true)).toBe("transparent_dark");
  });

  it("builds reactive Giscus component props", () => {
    expect(getGiscusProps("jp", true)).toEqual({
      ...GISCUS_CONFIG,
      lang: "ja",
      theme: "transparent_dark",
      loading: "lazy",
    });
  });
});
