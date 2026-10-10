import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrubElectronEnvironment } from "./electron-network.ts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const SETTINGS_EVIDENCE_ROOT = path.join(
  REPOSITORY_ROOT,
  ".task/regression-20261006/settings",
);

export interface RegressionSettingsRuntime {
  runtimeRoot: string;
  downloadsDirectory: string;
  environment: Record<string, string>;
  cleanup(): Promise<void>;
}

export async function createRegressionSettingsRuntime(): Promise<RegressionSettingsRuntime> {
  const runtimeRoot = await mkdtemp(
    path.join(SETTINGS_EVIDENCE_ROOT, "profile-"),
  );
  const downloadsDirectory = path.join(runtimeRoot, "downloads");
  const appData = path.join(runtimeRoot, "appdata");
  const localAppData = path.join(runtimeRoot, "localappdata");
  await Promise.all([
    mkdir(downloadsDirectory, { recursive: true }),
    mkdir(appData, { recursive: true }),
    mkdir(localAppData, { recursive: true }),
  ]);

  return {
    runtimeRoot,
    downloadsDirectory,
    environment: {
      ...scrubElectronEnvironment(process.env),
      APP_NAME: "xiangying",
      APP_TARGET: "electron",
      NODE_ENV: "production",
      ELECTRON_IS_DEV: "0",
      MEDIAGO_RUNTIME_ROOT: runtimeRoot,
      MEDIAGO_CORE_PORT: "39749",
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
    },
    async cleanup() {
      await rm(runtimeRoot, {
        recursive: true,
        force: true,
        maxRetries: 4,
        retryDelay: 250,
      });
    },
  };
}
