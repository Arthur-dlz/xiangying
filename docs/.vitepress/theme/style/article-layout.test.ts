import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const globalStylesPath = fileURLToPath(
  new URL("./global.css", import.meta.url),
);
const footerPath = fileURLToPath(
  new URL("../components/Footer.vue", import.meta.url),
);

describe("article layout styles", () => {
  it("uses the sidebar surface behind the desktop brand area", () => {
    const styles = readFileSync(globalStylesPath, "utf8");

    expect(styles).toContain(
      "--mg-sidebar-rail-width: var(--vp-sidebar-width)",
    );
    expect(styles).toMatch(
      /\.VPNav \.VPNavBar\.has-sidebar\s*{[^}]*background:[^;]*var\(--vp-sidebar-bg-color\)/,
    );
  });

  it("keeps the navigation and sidebar surfaces borderless", () => {
    const styles = readFileSync(globalStylesPath, "utf8");

    expect(styles).toMatch(/\.VPNav \.VPNavBar\s*{[^}]*border-bottom: 0;/);
    expect(styles).toMatch(/\.VPSidebar\s*{[^}]*border-right: 0;/);
  });

  it("keeps sidebar links inside the sidebar grid", () => {
    const styles = readFileSync(globalStylesPath, "utf8");

    expect(styles).toMatch(
      /\.VPSidebarItem\.level-1 > \.item > \.link\s*{[^}]*margin: 1px 0;/,
    );
  });

  it("stops the table of contents at the article boundary", () => {
    const styles = readFileSync(globalStylesPath, "utf8");

    expect(styles).toMatch(
      /\.VPDoc \.aside-container\s*{[^}]*position: sticky;/,
    );
    expect(styles).toMatch(/\.VPDoc \.aside-curtain\s*{[^}]*display: none;/);
  });

  it("aligns the wide footer with the article container", () => {
    const footerSource = readFileSync(footerPath, "utf8");

    expect(footerSource).toContain(
      "padding-right: calc((100% - var(--vp-layout-max-width)) / 2)",
    );
  });
});
