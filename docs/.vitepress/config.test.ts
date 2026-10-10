import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const configPath = fileURLToPath(new URL("./config.ts", import.meta.url));

describe("VitePress configuration", () => {
  it("uses native-loader-compatible extensions for local imports", () => {
    const configSource = readFileSync(configPath, "utf8");

    expect(configSource).toContain('from "./plugins.ts"');
    expect(configSource).not.toContain('from "./plugins"');
  });

  it("keeps documentation search local and excludes internal plans", () => {
    const configSource = readFileSync(configPath, "utf8");

    expect(configSource).toContain(
      'srcExclude: ["superpowers/**", "plans/**"]',
    );
    expect(configSource).toContain('search: { provider: "local" }');
  });
});
