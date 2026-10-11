import "@/styles/globals.css";

import React from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

import { Toaster } from "@/components/ui/sonner";
import { bootstrapExtensionI18n } from "@/i18n/bootstrap";
import { applySystemTheme } from "@/lib/theme";
import { App } from "./App";

applySystemTheme();

void (async () => {
  let i18n: Awaited<ReturnType<typeof bootstrapExtensionI18n>>;
  try {
    i18n = await bootstrapExtensionI18n();
  } catch (error) {
    // eslint-disable-next-line no-console -- Popup bootstrap failures need a diagnostic sink.
    console.error("Failed to bootstrap popup i18n", error);
    const rootElement = document.getElementById("root");
    if (rootElement) {
      rootElement.textContent = "Failed to load the popup. Please try again.";
    }
    return;
  }
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Popup root element not found");
  const root = createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <I18nextProvider i18n={i18n}>
        <App />
        <Toaster richColors position="top-center" duration={2400} />
      </I18nextProvider>
    </React.StrictMode>,
  );
})();
