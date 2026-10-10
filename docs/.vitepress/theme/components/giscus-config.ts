export const GISCUS_CONFIG = {
  repo: "mediago-dev/mediago",
  repoId: "MDEwOlJlcG9zaXRvcnkzMzQ0ODUzOTI=",
  category: "General",
  categoryId: "DIC_kwDOE-_XkM4CVWnu",
  mapping: "pathname",
  strict: "1",
  reactionsEnabled: "1",
  emitMetadata: "0",
  inputPosition: "top",
} as const;

const GISCUS_LANGUAGES: Record<string, string> = {
  en: "en",
  it: "it",
  ja: "ja",
  jp: "ja",
  zh: "zh-CN",
  "zh-CN": "zh-CN",
};

export function getGiscusLanguage(language: string) {
  return GISCUS_LANGUAGES[language] ?? "zh-CN";
}

export function getGiscusTheme(isDark: boolean) {
  return isDark ? "transparent_dark" : "light";
}

export function getGiscusProps(language: string, isDark: boolean) {
  return {
    ...GISCUS_CONFIG,
    lang: getGiscusLanguage(language),
    theme: getGiscusTheme(isDark),
    loading: "lazy" as const,
  };
}
