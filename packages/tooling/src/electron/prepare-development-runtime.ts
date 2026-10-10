import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfileEnv } from "../env/index.js";
import { prepareMacOSDevelopmentRuntime } from "./macos-development-runtime.js";

const toolingDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(toolingDirectory, "../../../..");
const electronRoot = path.join(projectRoot, "apps", "electron");

loadProfileEnv(projectRoot);

if (process.platform !== "darwin") {
  process.stdout.write(
    `[electron-dev] signed development runtime is not required on ${process.platform}\n`,
  );
} else {
  const appId = process.env.APP_ID?.trim();
  if (!appId) {
    throw new Error("APP_ID is required to prepare the macOS development app");
  }
  const packageJson = JSON.parse(
    await fs.readFile(path.join(electronRoot, "package.json"), "utf8"),
  ) as { devDependencies?: { electron?: string } };
  const electronVersion = packageJson.devDependencies?.electron;
  if (!electronVersion) {
    throw new Error(
      "apps/electron/package.json does not declare an Electron version",
    );
  }

  const requireFromElectron = createRequire(
    path.join(electronRoot, "package.json"),
  );
  const electronExecutable = String(requireFromElectron("electron"));
  const runtime = await prepareMacOSDevelopmentRuntime({
    appId: `${appId}.dev`,
    architecture: os.arch(),
    cacheRoot: path.join(projectRoot, ".task", "electron-dev"),
    electronExecutable,
    electronVersion,
    iconPath: path.join(electronRoot, "assets", "icon.icns"),
    productName: "MediaGo Dev",
  });

  process.stdout.write(
    `[electron-dev] prepared ${runtime.appPath} (${runtime.signingMode})\n`,
  );
}
