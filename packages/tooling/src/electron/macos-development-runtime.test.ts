import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findMacOSAppBundle,
  prepareMacOSDevelopmentRuntime,
  type MacOSDevelopmentRuntimeDependencies,
} from "./macos-development-runtime.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("findMacOSAppBundle", () => {
  it("finds the containing app bundle from the Electron executable", () => {
    expect(
      findMacOSAppBundle(
        "/workspace/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
    ).toBe(path.resolve("/workspace/node_modules/electron/dist/Electron.app"));
  });

  it("rejects an executable outside an app bundle", () => {
    expect(() => findMacOSAppBundle("/usr/local/bin/electron")).toThrow(
      "Electron executable is not inside a macOS app bundle",
    );
  });
});

describe("prepareMacOSDevelopmentRuntime", () => {
  it("rebrands, signs, verifies, and then reuses a cached runtime", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "mediago-development-runtime-test-"),
    );
    temporaryDirectories.push(root);
    const sourceApp = path.join(root, "Electron.app");
    const sourceExecutable = path.join(
      sourceApp,
      "Contents",
      "MacOS",
      "Electron",
    );
    const helperInfo = path.join(
      sourceApp,
      "Contents",
      "Frameworks",
      "Electron Helper (Renderer).app",
      "Contents",
      "Info.plist",
    );
    await fs.mkdir(path.dirname(sourceExecutable), { recursive: true });
    await fs.mkdir(path.dirname(helperInfo), { recursive: true });
    await fs.writeFile(sourceExecutable, "electron");
    await fs.writeFile(path.join(sourceApp, "Contents", "Info.plist"), "root");
    await fs.writeFile(helperInfo, "helper");
    const iconPath = path.join(root, "icon.icns");
    await fs.writeFile(iconPath, "icon");

    const runTool = vi.fn((command: string, args: readonly string[]) => {
      if (command === "codesign" && args.includes("--display")) {
        return "Identifier=mediago.example.dev\nSignature=adhoc\nflags=0x2(adhoc)\n";
      }
      return "";
    });
    const signApp = vi.fn(async () => undefined);
    const copyApp = vi.fn(
      async (sourceBundle: string, destinationBundle: string) => {
        await fs.cp(sourceBundle, destinationBundle, { recursive: true });
      },
    );
    const dependencies: MacOSDevelopmentRuntimeDependencies = {
      copyApp,
      runTool,
      signApp,
    };
    const options = {
      appId: "mediago.example.dev",
      architecture: "arm64",
      cacheRoot: path.join(root, "cache"),
      electronExecutable: sourceExecutable,
      electronVersion: "43.2.0",
      iconPath,
      productName: "MediaGo Dev",
    } as const;

    const first = await prepareMacOSDevelopmentRuntime(options, dependencies);

    expect(first.appId).toBe("mediago.example.dev");
    expect(first.signingMode).toBe("ad-hoc");
    expect(first.executablePath).toBe(
      path.join(first.appPath, "Contents", "MacOS", "Electron"),
    );
    await expect(fs.stat(first.executablePath)).resolves.toBeDefined();
    expect(copyApp).toHaveBeenCalledOnce();
    expect(signApp).toHaveBeenCalledOnce();
    expect(signApp).toHaveBeenCalledWith(
      expect.objectContaining({
        app: expect.stringContaining("MediaGo Dev.app"),
        identity: "-",
        identityValidation: false,
        platform: "darwin",
        preAutoEntitlements: false,
        preEmbedProvisioningProfile: false,
        strictVerify: true,
      }),
    );
    expect(runTool).toHaveBeenCalledWith(
      "plutil",
      expect.arrayContaining([
        "CFBundleIdentifier",
        "mediago.example.dev.helper.Renderer",
      ]),
    );

    const second = await prepareMacOSDevelopmentRuntime(options, dependencies);

    expect(second).toStrictEqual(first);
    expect(signApp).toHaveBeenCalledOnce();
    expect(runTool).toHaveBeenCalledWith("codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      first.appPath,
    ]);
  });
});
