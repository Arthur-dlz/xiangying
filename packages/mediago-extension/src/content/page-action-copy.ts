import { resolveLanguage, type SupportedLanguage } from "../i18n/language";
import type { ExtensionLanguage } from "../shared/types";

export interface PageActionCopy {
  idle: string;
  busy: string;
  failure: string;
  accessibleName: string;
}

export const PAGE_ACTION_COPY = {
  zh: {
    idle: "添加到 MediaGo",
    busy: "正在添加…",
    failure: "添加失败，重试",
    accessibleName: "添加当前页面到 MediaGo",
  },
  en: {
    idle: "Add to MediaGo",
    busy: "Adding…",
    failure: "Failed, try again",
    accessibleName: "Add current page to MediaGo",
  },
  it: {
    idle: "Aggiungi a MediaGo",
    busy: "Aggiunta…",
    failure: "Errore, riprova",
    accessibleName: "Aggiungi la pagina corrente a MediaGo",
  },
} satisfies Record<SupportedLanguage, PageActionCopy>;

export function getPageActionCopy(
  language: ExtensionLanguage | undefined,
): PageActionCopy {
  return PAGE_ACTION_COPY[resolveLanguage(language)];
}
