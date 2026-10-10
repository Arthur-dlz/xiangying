import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import "./index.css";
import App from "./App.tsx";
import { playerI18n, playerI18nReady, playerLanguage } from "./i18n";

async function startApplication() {
  await playerI18nReady;

  document.documentElement.lang = playerLanguage;
  document.title = playerI18n.t("pageTitle");
  const rootElement = document.getElementById("root");
  if (!rootElement) return;

  createRoot(rootElement).render(
    <StrictMode>
      <I18nextProvider i18n={playerI18n}>
        <App />
      </I18nextProvider>
    </StrictMode>,
  );
}

void startApplication();
