import i18next, { type i18n } from "i18next";
import { initReactI18next } from "react-i18next";

import { type SupportedLanguage } from "./language";
import { resources } from "./resources";

/**
 * Build a fresh i18next instance wired to React. Each extension page
 * (popup, options) owns its own instance — they live in separate
 * JS realms anyway, so there's nothing to share.
 */
export function createExtensionI18n(initialLng: SupportedLanguage): i18n {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng: initialLng,
    fallbackLng: "en",
    resources,
    interpolation: { escapeValue: false },
    // React already escapes; keep newlines as-is for our multi-line copy.
    returnNull: false,
  });
  return instance;
}

export { resources } from "./resources";
export { resolveLanguage } from "./language";
export type { ExtensionLanguage } from "../shared/types";
export type { SupportedLanguage } from "./language";
