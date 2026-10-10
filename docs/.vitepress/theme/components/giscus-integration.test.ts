import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const commentsPath = fileURLToPath(new URL("./Comments.vue", import.meta.url));
const packagePath = fileURLToPath(
  new URL("../../../package.json", import.meta.url),
);
const palettePath = fileURLToPath(new URL("../style/var.css", import.meta.url));

describe("Giscus comments integration", () => {
  it("uses Giscus instead of the retired Waline client", () => {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    const commentsSource = readFileSync(commentsPath, "utf8");

    expect(packageJson.dependencies["@giscus/vue"]).toBeDefined();
    expect(packageJson.dependencies["@waline/client"]).toBeUndefined();
    expect(commentsSource).toContain('from "@giscus/vue"');
    expect(commentsSource).not.toContain("Waline");
    expect(commentsSource).not.toContain("comments.ziying.site");
  });

  it("recreates the thread on route changes and reacts to site appearance", () => {
    const commentsSource = readFileSync(commentsPath, "utf8");

    expect(commentsSource).toContain(':key="route.path"');
    expect(commentsSource).toContain('v-bind="giscusProps"');
    expect(commentsSource).toContain(
      "getGiscusProps(lang.value, isDark.value)",
    );
    expect(commentsSource).not.toContain("getGiscusKey");
  });

  it("aligns the site palette with the GitHub light and dark canvases", () => {
    const paletteSource = readFileSync(palettePath, "utf8");

    expect(paletteSource).toContain("--vp-c-bg: #ffffff");
    expect(paletteSource).toContain("--vp-c-bg-alt: #f6f8fa");
    expect(paletteSource).toContain("--vp-c-text-1: #1f2328");
    expect(paletteSource).toContain("--vp-c-border: #d0d7de");
    expect(paletteSource).toContain("--vp-c-brand-1: #0969da");
    expect(paletteSource).toContain("--vp-c-bg: #0d1117");
    expect(paletteSource).toContain("--vp-c-bg-alt: #010409");
    expect(paletteSource).toContain("--vp-c-text-1: #e6edf3");
    expect(paletteSource).toContain("--vp-c-border: #30363d");
    expect(paletteSource).toContain("--vp-c-brand-1: #58a6ff");
  });
});
