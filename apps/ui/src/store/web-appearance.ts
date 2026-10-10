import { create } from "zustand";
import { persist } from "zustand/middleware";
import { AppTheme } from "@mediago/common";

const WEB_APPEARANCE_STORAGE_KEY = "web-appearance-storage";
const APP_THEMES = new Set<AppTheme>(Object.values(AppTheme));

type WebAppearanceState = {
  theme: AppTheme;
  setTheme: (theme: AppTheme) => void;
};

export function isAppTheme(value: unknown): value is AppTheme {
  return typeof value === "string" && APP_THEMES.has(value as AppTheme);
}

export function mergeWebAppearanceState(
  persistedState: unknown,
  currentState: WebAppearanceState,
): WebAppearanceState {
  if (
    persistedState === null ||
    typeof persistedState !== "object" ||
    Array.isArray(persistedState)
  ) {
    return currentState;
  }

  const theme = (persistedState as Partial<WebAppearanceState>).theme;
  return {
    ...currentState,
    theme: isAppTheme(theme) ? theme : currentState.theme,
  };
}

export const useWebAppearanceStore = create<WebAppearanceState>()(
  persist(
    (set) => ({
      theme: AppTheme.System,
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: WEB_APPEARANCE_STORAGE_KEY,
      version: 1,
      partialize: ({ theme }) => ({ theme }),
      merge: mergeWebAppearanceState,
    },
  ),
);
