import { afterEach, describe, expect, it } from "vitest";
import {
  registerTrustedAppContents,
  shouldInjectCoreCredential,
  unregisterTrustedAppContents,
} from "./trust-policy";

describe("shouldInjectCoreCredential", () => {
  afterEach(() => unregisterTrustedAppContents(123));

  const details = (overrides: Record<string, unknown> = {}) => {
    const mainFrame = { url: "http://localhost:8500/" };
    return {
      url: "http://127.0.0.1:39719/api/config",
      webContentsId: 123,
      frame: mainFrame,
      webContents: { id: 123, mainFrame },
      ...overrides,
    } as never;
  };

  it("requires a registered trusted top-level app frame and exact loopback Core origin", () => {
    registerTrustedAppContents(123);
    expect(
      shouldInjectCoreCredential(details(), "http://127.0.0.1:39719", true),
    ).toBe(true);
    expect(
      shouldInjectCoreCredential(details(), "http://127.0.0.1:39720", true),
    ).toBe(false);
    expect(
      shouldInjectCoreCredential(
        details({ webContentsId: 124 }),
        "http://127.0.0.1:39719",
        true,
      ),
    ).toBe(false);
    expect(
      shouldInjectCoreCredential(
        details({ frame: { url: "https://remote.example" } }),
        "http://127.0.0.1:39719",
        true,
      ),
    ).toBe(false);
    const remoteTopFrame = { url: "https://remote.example/" };
    expect(
      shouldInjectCoreCredential(
        details({
          frame: remoteTopFrame,
          webContents: { id: 123, mainFrame: remoteTopFrame },
        }),
        "http://127.0.0.1:39719",
        true,
      ),
    ).toBe(false);
    expect(
      shouldInjectCoreCredential(
        details({ frame: null }),
        "http://127.0.0.1:39719",
        true,
      ),
    ).toBe(false);
  });

  it("does not authorize a non-loopback Core origin", () => {
    registerTrustedAppContents(123);
    expect(
      shouldInjectCoreCredential(
        details({ url: "https://api.example/api/config" }),
        "https://api.example",
        true,
      ),
    ).toBe(false);
  });
});
