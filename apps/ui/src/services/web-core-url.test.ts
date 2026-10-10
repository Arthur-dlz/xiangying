import { describe, expect, it } from "vitest";
import { resolveWebCoreUrl } from "./web-core-url";

describe("resolveWebCoreUrl", () => {
  it.each([
    ["http://192.168.1.20:8501", "http://192.168.1.20:9900"],
    ["http://mediago.local:8501", "http://mediago.local:9900"],
    ["http://[fd00::20]:8501", "http://[fd00::20]:9900"],
  ])("uses the page host for development Web access", (origin, expected) => {
    expect(resolveWebCoreUrl(origin, true)).toBe(expected);
  });

  it("keeps the production Web origin", () => {
    expect(resolveWebCoreUrl("https://media.example:8443", false)).toBe(
      "https://media.example:8443",
    );
  });
});
