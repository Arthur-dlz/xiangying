import { app } from "electron";
import os from "node:os";
import path from "node:path";

const isWindows = os.platform() === "win32";
const ext = isWindows ? ".exe" : "";
const isDev = !app.isPackaged;

/**
 * Returns the monorepo root.
 * At runtime __dirname = apps/electron/build/, so 3 levels up = monorepo root.
 */
function getMonorepoRoot(): string {
  return path.resolve(__dirname, "..", "..", "..");
}

/**
 * Resolves the mediago-core binary path.
 *
 * Development: apps/core/bin/mediago-core (compiled by `pnpm core:build`)
 * Production: extraResources/bin/mediago-core (copied by electron-builder)
 *
 * Override with MEDIAGO_CORE_BIN env var.
 */
export function resolveCoreBinaries(): { coreBin: string } {
  if (process.env.MEDIAGO_CORE_BIN) {
    return { coreBin: process.env.MEDIAGO_CORE_BIN };
  }

  if (isDev) {
    const coreDir = path.join(getMonorepoRoot(), "apps", "core");
    return {
      coreBin: path.join(coreDir, "bin", `mediago-core${ext}`),
    };
  }

  // Production: extraResources
  return {
    coreBin: path.join(process.resourcesPath, "bin", `mediago-core${ext}`),
  };
}

/**
 * Resolves the bundled user-facing MediaGo CLI.
 *
 * Development: apps/core/bin/mediago
 * Production: extraResources/bin/mediago
 */
export function resolveCLIBinary(): string {
  if (process.env.MEDIAGO_CLI_BIN) {
    return process.env.MEDIAGO_CLI_BIN;
  }

  if (isDev) {
    return path.join(getMonorepoRoot(), "apps", "core", "bin", `mediago${ext}`);
  }

  return path.join(process.resourcesPath, "bin", `mediago${ext}`);
}

/**
 * Resolves the deps directory containing helper binaries (ffmpeg, N_m3u8DL-RE, BBDown, etc.).
 *
 * Development: .deps/{platform}/{arch}/ (downloaded by `pnpm deps:download`)
 * Production: extraResources/deps/
 *
 * Override with MEDIAGO_DEPS_DIR env var.
 */
export function resolveDepsBinaries(): { depsDir: string } {
  let depsDir: string;

  if (process.env.MEDIAGO_DEPS_DIR) {
    depsDir = process.env.MEDIAGO_DEPS_DIR;
  } else if (isDev) {
    const platformKey = `${os.platform()}-${os.arch()}`;
    depsDir = path.join(getMonorepoRoot(), ".deps", platformKey);
  } else {
    depsDir = path.join(process.resourcesPath, "deps");
  }

  return { depsDir };
}

/**
 * Resolves the bundled browser-extension directory.
 *
 * Development: packages/mediago-extension/dist (produced by
 *   `pnpm -F @mediago/extension build`)
 * Production: extraResources/extension (copied by electron-builder
 *   via the tooling Electron build module's `extraResources` declaration)
 *
 * Override with MEDIAGO_EXTENSION_DIR env var.
 *
 * Consumed by the `shell.openExtensionDir` IPC — the Settings page
 * exposes a "Browser extension directory" button so users can locate
 * the unpacked extension to load into Chrome / Edge.
 */
export function resolveExtensionDir(): { extensionDir: string } {
  if (process.env.MEDIAGO_EXTENSION_DIR) {
    return { extensionDir: process.env.MEDIAGO_EXTENSION_DIR };
  }

  if (isDev) {
    return {
      extensionDir: path.join(
        getMonorepoRoot(),
        "packages",
        "mediago-extension",
        "dist",
      ),
    };
  }

  return {
    extensionDir: path.join(process.resourcesPath, "extension"),
  };
}
