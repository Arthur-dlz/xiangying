import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const globalStylesPath = fileURLToPath(
  new URL("./global.css", import.meta.url),
);

describe("local search styles", () => {
  it("uses the search bar as the single visible focus boundary", () => {
    const styles = readFileSync(globalStylesPath, "utf8");

    expect(styles).toMatch(
      /\.VPLocalSearchBox \.search-input:focus-visible\s*{[^}]*outline: none;/,
    );
  });

  it("uses a compact borderless search icon on mobile", () => {
    const styles = readFileSync(globalStylesPath, "utf8");

    expect(styles).toMatch(
      /@media \(max-width: 767px\)\s*{[\s\S]*?\.VPNavBarSearch button\s*{[^}]*width: 44px;[^}]*height: 44px !important;[^}]*border: 0 !important;/,
    );
  });

  it("keeps the desktop search shell height stable while results load", () => {
    const styles = readFileSync(globalStylesPath, "utf8");

    expect(styles).toMatch(
      /@media \(min-width: 768px\)\s*{[\s\S]*?\.VPLocalSearchBox \.shell\s*{[^}]*height: min\(70dvh, 40rem\);/,
    );
    expect(styles).toMatch(
      /\.VPLocalSearchBox \.results\s*{[^}]*flex: 1 1 auto;[^}]*min-height: 0;/,
    );
  });

  it("uses one-pixel borders throughout the search surface", () => {
    const styles = readFileSync(globalStylesPath, "utf8");

    expect(styles).toMatch(
      /\.VPLocalSearchBox \.search-bar,\s*\.VPLocalSearchBox \.result\s*{[^}]*border: 1px solid var\(--vp-c-divider\) !important;/,
    );
  });

  it("animates the search surface without ignoring reduced motion", () => {
    const styles = readFileSync(globalStylesPath, "utf8");

    expect(styles).toContain("@keyframes mg-search-shell-in");
    expect(styles).toMatch(
      /\.VPLocalSearchBox \.shell\s*{[^}]*animation: mg-search-shell-in/,
    );
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*{[\s\S]*?\.VPLocalSearchBox \.backdrop,[\s\S]*?\.VPLocalSearchBox \.shell\s*{[^}]*animation: none;/,
    );
  });
});
