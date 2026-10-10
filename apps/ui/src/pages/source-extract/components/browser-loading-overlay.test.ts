import { describe, expect, it } from "vitest";
import { browserLoadingHost } from "./browser-loading-overlay";

describe("browserLoadingHost", () => {
  it("shows the original destination host without a decorative www prefix", () => {
    expect(browserLoadingHost("https://www.youtube.com/watch?v=1")).toBe(
      "youtube.com",
    );
    expect(browserLoadingHost("https://x.com/home")).toBe("x.com");
  });

  it("keeps incomplete input readable while navigation starts", () => {
    expect(browserLoadingHost("  local address  ")).toBe("local address");
  });
});
