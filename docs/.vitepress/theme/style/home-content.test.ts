import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const homePath = fileURLToPath(new URL("../../../index.md", import.meta.url));
const globalStylesPath = fileURLToPath(
  new URL("./global.css", import.meta.url),
);
const homeTopicsPath = fileURLToPath(
  new URL("../components/HomeTopics.vue", import.meta.url),
);

describe("documentation home content", () => {
  it("preserves the product positioning copy", () => {
    const home = readFileSync(homePath, "utf8");

    expect(home).toContain('name: "MediaGo"');
    expect(home).toContain('text: "跨平台视频下载器"');
    expect(home).toContain("内置嗅探，打开网页、选一下想要的资源、保存完事。");
  });

  it("links directly to the three blog topics", () => {
    const home = readFileSync(homePath, "utf8");
    const topics = readFileSync(homeTopicsPath, "utf8");

    expect(home).toContain(
      'import HomeTopics from "./.vitepress/theme/components/HomeTopics.vue"',
    );
    expect(home).toContain("<HomeTopics />");
    expect(topics).toContain(
      ":href=\"withBase('/blog/video-downloader-recommendation/')\"",
    );
    expect(topics).toContain(":href=\"withBase('/blog/video-download/')\"");
    expect(topics).toContain(":href=\"withBase('/blog/m3u8-hls-download/')\"");
  });

  it("uses an asymmetric desktop layout and a single mobile column", () => {
    const styles = readFileSync(globalStylesPath, "utf8");

    expect(styles).toMatch(
      /\.home-topics__grid\s*{[^}]*grid-template-columns: minmax\(0, 1\.15fr\) minmax\(280px, 0\.85fr\);/,
    );
    expect(styles).toMatch(
      /@media \(max-width: 767px\)\s*{[\s\S]*?\.home-topics__grid\s*{[^}]*grid-template-columns: minmax\(0, 1fr\);/,
    );
  });
});
