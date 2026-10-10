import { type PlatformApi } from "@mediago/common";
import { isWeb } from "@/environment";
import { electronPlatformAdapter, electronIpcAdapter } from "./electron";
import { webPlatformStubs } from "./platform-stubs";
import type { IpcListener } from "./utils";

const hasElectronPreload =
  typeof window !== "undefined" && Boolean(window.electron);

// ============================================================
// Platform adapter (Electron IPC or web stubs)
// ============================================================

/**
 * Platform adapter: Electron-native operations in desktop mode,
 * no-op stubs in web/server mode.
 */
export const platformApi: PlatformApi =
  isWeb || !hasElectronPreload ? webPlatformStubs : electronPlatformAdapter;

/**
 * Electron IPC event listener (pure platform events only).
 * Go SSE events are handled separately by api/events.ts.
 */
export const platformEventListener: IpcListener =
  isWeb || !hasElectronPreload
    ? { on: () => {}, off: () => {} }
    : electronIpcAdapter;

export type { IpcListener } from "./utils";
