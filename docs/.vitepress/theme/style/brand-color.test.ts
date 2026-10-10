import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const variableStylesPath = fileURLToPath(new URL("./var.css", import.meta.url));

describe("brand button colors", () => {
  it("uses the MediaGo blue palette in light mode", () => {
    const styles = readFileSync(variableStylesPath, "utf8");
    const lightVariables = styles.match(/:root\s*{([\s\S]*?)}\s*\.dark/)?.[1];

    expect(lightVariables).toContain("--vp-button-brand-bg: #0969da");
    expect(lightVariables).toContain("--vp-button-brand-hover-bg: #0550ae");
    expect(lightVariables).toContain("--vp-button-brand-active-bg: #033d8b");
  });

  it("uses an accessible blue fill in dark mode", () => {
    const styles = readFileSync(variableStylesPath, "utf8");
    const darkVariables = styles.match(/\.dark\s*{([\s\S]*?)}\s*$/)?.[1];

    expect(darkVariables).toContain("--vp-button-brand-bg: #1f6feb");
    expect(darkVariables).toContain("--vp-button-brand-hover-bg: #388bfd");
    expect(darkVariables).toContain("--vp-button-brand-active-bg: #1158c7");
  });
});
