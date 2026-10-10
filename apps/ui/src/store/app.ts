import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist } from "zustand/middleware";
import { migrateAppStore } from "./app-store-migration";
import { AppLanguage, type AppStore, AppTheme } from "@mediago/common";
import { syncAppLanguage } from "../i18n/app-language";

const initialState: AppStore = {
  local: "",
  promptTone: true,
  proxy: "",
  useProxy: false,
  deleteSegments: true,
  openInNewWindow: false,
  theme: AppTheme.System,
  useExtension: false,
  isMobile: false,
  maxRunner: 2,
  language: AppLanguage.ZH,
  showTerminal: false,
  privacy: false,
  machineId: "",
  downloadProxySwitch: false,
  autoUpgrade: false,
  audioMuted: true,
  enableMobilePlayer: false,
  blockAds: true,
  allowBeta: false,
  enableDocker: false,
  dockerUrl: "",
  closeMainWindow: false,
  apiKey: "",
  enableMcp: false,
  mcpToken: "",
};

type Actions = {
  setAppStore: (values: Partial<AppStore>) => void;
};

export const useAppStore = create<AppStore & Actions>()(
  immer(
    persist(
      (set, get) => ({
        ...initialState,
        setAppStore: (values) => {
          // Initial config reconciliation intentionally sends the language even
          // when the persisted value is unchanged. "system" must be resolved
          // again because the OS language may have changed since last launch.
          if (values.language !== undefined) {
            void syncAppLanguage(values.language);
          }

          const current = get();
          const changedEntries = Object.entries(values).filter(
            ([key, value]) => !Object.is(current[key as keyof AppStore], value),
          );
          if (changedEntries.length === 0) return;

          set((state) => {
            changedEntries.forEach(([key, value]) => {
              (state as Record<string, unknown>)[key] = value;
            });
          });
        },
      }),
      {
        name: "appstore-storage",
        version: 1,
        migrate: migrateAppStore,
      },
    ),
  ),
);

export const appStoreSelector = (state: AppStore & Actions) => {
  const { setAppStore: _setAppStore, ...appStore } = state;
  return appStore;
};

export const setAppStoreSelector = (state: AppStore & Actions) => {
  return { setAppStore: state.setAppStore };
};
