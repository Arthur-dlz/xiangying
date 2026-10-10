import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const globalStylesPath = fileURLToPath(
  new URL("./global.css", import.meta.url),
);

describe("documentation table styles", () => {
  it("fills the article column without leaving an empty strip", () => {
    const styles = readFileSync(globalStylesPath, "utf8");

    expect(styles).toMatch(/\.vp-doc table\s*{[^}]*display: table;/);
    expect(styles).toMatch(/\.vp-doc table\s*{[^}]*width: 100%;/);
  });

  it("allows long cell content to wrap on narrow screens", () => {
    const styles = readFileSync(globalStylesPath, "utf8");

    expect(styles).toMatch(
      /\.vp-doc th,\s*\.vp-doc td\s*{[^}]*overflow-wrap: anywhere;/,
    );
    expect(styles).toMatch(/\.vp-doc th\s*{[^}]*white-space: nowrap;/);
  });
});
