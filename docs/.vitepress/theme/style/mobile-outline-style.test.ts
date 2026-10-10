import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const globalStylesPath = fileURLToPath(
  new URL("./global.css", import.meta.url),
);

describe("mobile outline dropdown styles", () => {
  it("uses a soft brand header instead of a dark gutter line", () => {
    const styles = readFileSync(globalStylesPath, "utf8");

    expect(styles).toMatch(
      /\.VPLocalNavOutlineDropdown \.items\s*{[^}]*gap: 0;/,
    );
    expect(styles).toMatch(
      /\.VPLocalNavOutlineDropdown \.header\s*{[^}]*border-bottom: 0;[^}]*background: var\(--vp-c-brand-soft\);/,
    );
    expect(styles).toMatch(
      /\.VPLocalNavOutlineDropdown \.outline\s*{[^}]*outline: none;/,
    );
  });
});
