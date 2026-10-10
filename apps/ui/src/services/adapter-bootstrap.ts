import type { AppStore } from "@mediago/common";
import { getConfig } from "../api/config";
import { initGoEvents } from "../api/events";
import { useAppStore } from "../store/app";
import { isWeb } from "../utils";
import { setupHttp } from "../utils/http";
import { resolveWebCoreUrl } from "./web-core-url";

let adapterCoreUrl = "";
let adapterInitialization: Promise<AppStore | null> | null = null;

export function getAdapterCoreUrl() {
  return adapterCoreUrl;
}

export function canLoadProtectedConfig() {
  return !isWeb || useAppStore.getState().apiKey.length > 0;
}

export function initializeAdapter(): Promise<AppStore | null> {
  if (adapterInitialization) return adapterInitialization;

  const initialization = (async () => {
    try {
      let coreUrl = adapterCoreUrl;

      if (!coreUrl && isWeb) {
        coreUrl = resolveWebCoreUrl(
          window.location.origin,
          import.meta.env.DEV,
        );
      } else if (!coreUrl) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ipcResult: any = await window.electron?.app?.getEnvPath();
        const envPath =
          ipcResult && "code" in ipcResult && ipcResult.code === 0
            ? ipcResult.data
            : ipcResult;
        if (envPath && "coreUrl" in envPath && envPath.coreUrl) {
          coreUrl = envPath.coreUrl;
        }
      }

      if (!coreUrl) return null;

      if (!adapterCoreUrl) {
        adapterCoreUrl = coreUrl;
        setupHttp(coreUrl);
        initGoEvents(coreUrl);
      }

      // Sign-in still needs the Core URL, but web config is protected until
      // the API key has been stored.
      if (!canLoadProtectedConfig()) return null;

      try {
        return await getConfig({ timeoutMs: 5000 });
      } catch {
        // Go Core may not be fully ready yet.
        return null;
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("Go adapter init failed:", error);
      return null;
    }
  })();

  adapterInitialization = initialization;
  void initialization.finally(() => {
    if (adapterInitialization === initialization) {
      adapterInitialization = null;
    }
  });

  return initialization;
}
