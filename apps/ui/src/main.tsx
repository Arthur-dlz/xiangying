import "./bootstrap-share-intent";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { registerPwaServiceWorker } from "./services/pwa";
import { isWeb, tdApp } from "./utils";
import "./i18n";
import "./globals.css";
import { BrowserRouter } from "react-router-dom";
import { syncAppLanguage } from "./i18n/app-language";
import { useAppStore } from "./store/app";
tdApp.init();
if (isWeb) registerPwaServiceWorker();

const application = (
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
const shouldUseStrictMode = isWeb || import.meta.env.PROD;
const LANGUAGE_SYNC_TIMEOUT_MS = 3_000;

// Resolve the persisted language preference before React renders, but never let
// a hung IPC call (Electron OS-language lookup) or a missing i18n "initialized"
// event block first paint indefinitely.
function syncLanguageWithTimeout(language: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => resolve(undefined),
      LANGUAGE_SYNC_TIMEOUT_MS,
    );
    syncAppLanguage(language).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function startApplication() {
  // Resolve the persisted preference once before React renders. In Electron,
  // this asks the main process for the OS language, so stale browser language
  // detector caches cannot decide the visible interface language.
  try {
    await syncLanguageWithTimeout(useAppStore.getState().language);
  } catch {
    // Keep the language selected during i18n initialization rather than
    // blocking the entire UI if the startup synchronization ever fails.
  }

  createRoot(document.getElementById("root") as HTMLElement).render(
    shouldUseStrictMode ? <StrictMode>{application}</StrictMode> : application,
  );
}

void startApplication();
