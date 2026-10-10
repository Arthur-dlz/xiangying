import { dirname, resolve } from "node:path";
import { app } from "electron";

export const appData = app.getPath("appData");
export const exePath = dirname(app.getPath("exe"));

export enum Platform {
  Windows = "win32",
  MacOS = "darwin",
  Linux = "linux",
}

export const isMac = process.platform === Platform.MacOS;
export const isWin = process.platform === Platform.Windows;
export const isLinux = process.platform === Platform.Linux;

if (!process.env.APP_NAME) {
  throw new Error("APP_NAME is not defined in environment variables");
}

export const appName = process.env.APP_NAME;
export const workspace = process.env.MEDIAGO_RUNTIME_ROOT
  ? resolve(process.env.MEDIAGO_RUNTIME_ROOT, "data")
  : process.env.PORTABLE_EXECUTABLE_DIR
    ? resolve(process.env.PORTABLE_EXECUTABLE_DIR, "xiangying-data")
    : resolve(appData, appName);
export const defaultScheme = appName;
export const PERSIST_MEDIAGO = "persist:mediago";
export const PERSIST_WEBVIEW = "persist:webview";
export const PRIVACY_WEBVIEW = "webview";
export const db = resolve(workspace, "app.db");
export const logDir = resolve(workspace, "logs");

// Keep the mobile override aligned with Electron's bundled Chromium instead of
// pinning an increasingly unsupported browser version. Desktop browsing also
// uses this Chromium version, with Electron's product token removed by the tab
// manager so sites identify it as a Chromium browser.
export const mobileUA = `Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Mobile Safari/537.36`;
