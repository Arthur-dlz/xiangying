import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  new URL("./globals.css", import.meta.url),
  "utf8",
);
const desktopStylesheet = readFileSync(
  new URL("../../../../apps/ui/src/globals.css", import.meta.url),
  "utf8",
);

function rule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = stylesheet.match(
    new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\n\\}`),
  );
  if (!match?.[1]) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1];
}

function cssVariable(cssRule: string, name: string): string {
  const value = cssRule.match(
    new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"),
  )?.[1];
  if (!value) throw new Error(`Missing hexadecimal --${name}`);
  return value;
}

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);
  if (!channels) throw new Error(`Invalid color ${hex}`);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("extension design tokens", () => {
  it("keeps core brand and surface tokens synchronized with desktop", () => {
    const extensionModes = [rule(":root"), rule(".dark")];
    const desktopModes = [
      ruleFrom(desktopStylesheet, ":root"),
      ruleFrom(desktopStylesheet, ".dark"),
    ];
    const sharedTokens = [
      "brand",
      "canvas",
      "surface",
      "surface-raised",
      "surface-subtle",
      "surface-hover",
      "surface-selected",
    ];

    for (const [index, extensionMode] of extensionModes.entries()) {
      for (const token of sharedTokens) {
        expect(cssVariable(extensionMode, token)).toBe(
          cssVariable(desktopModes[index], token),
        );
      }
    }
  });

  it("uses the desktop light semantic palette", () => {
    const light = rule(":root");

    expect(light).toContain("--brand: #0f766e");
    expect(light).toContain("--canvas: #ffffff");
    expect(light).toContain("--surface: #f5f8fc");
    expect(light).toContain("--surface-raised: #ffffff");
    expect(light).toContain("--surface-subtle: #edf2f7");
    expect(light).toContain("--surface-hover: #e8eff7");
    expect(light).toContain("--surface-selected: #e2eeff");
  });

  it("uses the desktop dark semantic palette", () => {
    const dark = rule(".dark");

    expect(dark).toContain("--brand: #2dd4bf");
    expect(dark).toContain("--canvas: #1f1f1f");
    expect(dark).toContain("--surface: #252a31");
    expect(dark).toContain("--surface-raised: #2b313a");
    expect(dark).toContain("--surface-subtle: #20252b");
    expect(dark).toContain("--surface-hover: #303844");
    expect(dark).toContain("--surface-selected: #183b63");
  });

  it("keeps extension aliases but removes the multicolor timeline palette", () => {
    expect(stylesheet).toContain("--surface-100: var(--surface-raised)");
    expect(stylesheet).toContain("--timeline-thinking: var(--brand)");
    expect(stylesheet).toContain("--timeline-grep: var(--brand)");
    expect(stylesheet).not.toMatch(/#dfa88f|#9fc9a2|#c0a8dd|#f54e00/i);
    expect(stylesheet).not.toContain("source-serif-4");
  });

  it("keeps a compact text-hero compatibility utility", () => {
    const hero = rule(".text-hero");

    expect(hero).toContain("font-size: clamp(");
    expect(hero).toContain("2rem");
    expect(hero).not.toMatch(/40px|52px|60px/);
  });

  it("keeps solid action text at WCAG AA contrast in every mode and state", () => {
    for (const mode of [rule(":root"), rule(".dark")]) {
      for (const token of ["action", "action-hover", "action-active"]) {
        expect(
          contrastRatio(cssVariable(mode, token), "#ffffff"),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps branded small text readable across every core surface", () => {
    const coreSurfaces = [
      "canvas",
      "surface",
      "surface-raised",
      "surface-subtle",
      "surface-hover",
      "surface-selected",
    ];

    for (const mode of [rule(":root"), rule(".dark")]) {
      const foreground = cssVariable(mode, "brand-foreground");

      for (const surface of coreSurfaces) {
        expect(
          contrastRatio(foreground, cssVariable(mode, surface)),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps form control boundaries distinguishable from adjacent surfaces", () => {
    const adjacentSurfaces = [
      "canvas",
      "surface",
      "surface-raised",
      "surface-subtle",
      "surface-hover",
      "surface-selected",
    ];

    for (const mode of [rule(":root"), rule(".dark")]) {
      for (const surface of adjacentSurfaces) {
        const surfaceColor = cssVariable(mode, surface);
        expect(
          contrastRatio(cssVariable(mode, "control-border"), surfaceColor),
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrastRatio(cssVariable(mode, "control-track"), surfaceColor),
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("keeps focus rings and scrollbars distinguishable from adjacent surfaces", () => {
    for (const mode of [rule(":root"), rule(".dark")]) {
      const adjacentSurfaces = ["canvas", "surface", "surface-raised"];

      for (const surface of adjacentSurfaces) {
        const surfaceColor = cssVariable(mode, surface);
        expect(
          contrastRatio(cssVariable(mode, "focus-ring"), surfaceColor),
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrastRatio(cssVariable(mode, "scrollbar-thumb"), surfaceColor),
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("keeps opaque semantic badge text at WCAG AA contrast in every mode", () => {
    const semanticBadges = ["success", "destructive", "warning"];

    for (const mode of [rule(":root"), rule(".dark")]) {
      for (const semantic of semanticBadges) {
        const background = cssVariable(mode, `${semantic}-badge-background`);
        const foreground = cssVariable(mode, `${semantic}-badge-foreground`);

        expect(contrastRatio(background, foreground)).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });
});

describe("extension shell behavior", () => {
  it("keeps popup and options viewports stable", () => {
    expect(rule("body.popup")).toMatch(/width:\s*380px/);
    expect(rule("body.popup")).toMatch(/max-height:\s*560px/);
    expect(rule("body.options")).toMatch(/min-height:\s*100dvh/);
  });

  it("defines accessible cursor semantics and reduced motion", () => {
    expect(stylesheet).toContain("cursor: pointer");
    expect(stylesheet).toContain("cursor: not-allowed");
    expect(stylesheet).toContain("cursor: grab");
    expect(stylesheet).toContain("cursor: grabbing");
    expect(stylesheet).toContain("cursor: progress");
    expect(stylesheet).toContain("cursor: wait");
    expect(stylesheet).toContain("prefers-reduced-motion: reduce");
    expect(stylesheet).toContain("scrollbar-color:");
    expect(stylesheet).not.toContain("label[for],");
  });
});

function ruleFrom(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(
    new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\n\\}`),
  );
  if (!match?.[1]) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1];
}
