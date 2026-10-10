import { describe, expect, it } from "vitest";
import {
  assertMacOSSigningEnvironment,
  hasHardenedRuntimeFlag,
  MACOS_SIGNING_ENVIRONMENT_VARIABLES,
  resolveMacOSSigningSettings,
} from "./macos-signing.ts";

const completeEnvironment = Object.fromEntries(
  MACOS_SIGNING_ENVIRONMENT_VARIABLES.map((name) => [name, `${name}-value`]),
);

describe("resolveMacOSSigningSettings", () => {
  it("requires signing and notarization for macOS distribution artifacts", () => {
    expect(
      resolveMacOSSigningSettings({
        platform: "darwin",
        isDir: false,
        environment: completeEnvironment,
      }),
    ).toStrictEqual({
      enabled: true,
      forceCodeSigning: true,
      hardenedRuntime: true,
      notarize: true,
      signDmg: true,
    });
  });

  it.each([
    ["darwin", true],
    ["linux", false],
    ["win32", false],
  ] as const)(
    "does not require Apple credentials for %s dir=%s",
    (platform, isDir) => {
      expect(
        resolveMacOSSigningSettings({ platform, isDir, environment: {} }),
      ).toStrictEqual({
        enabled: false,
        forceCodeSigning: false,
        hardenedRuntime: false,
        notarize: false,
        signDmg: false,
      });
    },
  );
});

describe("assertMacOSSigningEnvironment", () => {
  it("accepts the five standard electron-builder variables", () => {
    expect(() =>
      assertMacOSSigningEnvironment(completeEnvironment),
    ).not.toThrow();
  });

  it("reports every missing variable without exposing values", () => {
    expect(() =>
      assertMacOSSigningEnvironment({
        CSC_LINK: "certificate",
        CSC_KEY_PASSWORD: " ",
      }),
    ).toThrow(
      "macOS distribution requires: CSC_KEY_PASSWORD, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID",
    );
  });
});

describe("hasHardenedRuntimeFlag", () => {
  it("recognizes the runtime flag inside a CodeDirectory line", () => {
    expect(
      hasHardenedRuntimeFlag(
        "CodeDirectory v=20500 size=769 flags=0x10000(runtime) hashes=13+7 location=embedded",
      ),
    ).toBe(true);
  });

  it("rejects a signature without the runtime flag", () => {
    expect(
      hasHardenedRuntimeFlag(
        "CodeDirectory v=20500 size=769 flags=0x0(none) hashes=13+7 location=embedded",
      ),
    ).toBe(false);
  });
});
