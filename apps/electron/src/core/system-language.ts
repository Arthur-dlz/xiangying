import { app } from "electron";

/**
 * Return the OS language Electron recommends for application UI.
 *
 * `app.getLocale()` describes Chromium's current application locale, which can
 * stay on the language used when the process started. The preferred-language
 * list reflects the operating-system language order and is the appropriate
 * source for MediaGo's "follow system" setting.
 */
export function getPreferredSystemLanguage(): string {
  return app.getPreferredSystemLanguages()[0] ?? app.getLocale();
}
