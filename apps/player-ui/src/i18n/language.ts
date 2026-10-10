export type PlayerLanguage = "en" | "zh-CN" | "it";

export function resolvePlayerLanguage(
  languages: readonly string[] = navigator.languages,
): PlayerLanguage {
  for (const language of languages) {
    const normalizedLanguage = language.toLowerCase();

    if (normalizedLanguage.startsWith("zh")) {
      return "zh-CN";
    }

    if (normalizedLanguage.startsWith("it")) {
      return "it";
    }

    if (normalizedLanguage.startsWith("en")) {
      return "en";
    }
  }

  return "en";
}
