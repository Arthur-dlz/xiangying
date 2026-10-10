import { describe, expect, it } from "vitest";
import { createCurrentPlatformBuildArgs } from "./build-args.ts";

describe("createCurrentPlatformBuildArgs", () => {
  it("enables development-only Go code for local development builds", () => {
    expect(
      createCurrentPlatformBuildArgs({
        commandPath: "./cmd/server",
        ldflags: "-s -w",
        mode: "development",
        output: "bin/mediago-core",
      }),
    ).toEqual([
      "build",
      "-tags",
      "dev",
      "-trimpath",
      "-ldflags",
      "-s -w",
      "-o",
      "bin/mediago-core",
      "./cmd/server",
    ]);
  });

  it("excludes development-only Go code from production builds", () => {
    const args = createCurrentPlatformBuildArgs({
      commandPath: "./cmd/server",
      ldflags: "-s -w",
      mode: "production",
      output: "bin/mediago-core",
    });

    expect(args).not.toContain("-tags");
    expect(args).not.toContain("dev");
  });
});
