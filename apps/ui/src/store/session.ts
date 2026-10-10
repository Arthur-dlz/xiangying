import type { UpdateState } from "@mediago/common";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

const initialTheme =
  typeof document !== "undefined" &&
  document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";

const initialUpdateState: UpdateState = {
  status: "idle",
  currentVersion: "",
  progress: 0,
  autoDownload: true,
  portable: false,
};

type State = {
  updateState: UpdateState;
  updateAvailable: boolean;

  // theme
  theme: "light" | "dark";
};

type Actions = {
  setUpdateState: (updateState: UpdateState) => void;

  // theme
  setTheme: (theme: "light" | "dark") => void;
};

export const useSessionStore = create<State & Actions>()(
  immer((set) => ({
    updateState: initialUpdateState,
    updateAvailable: false,
    theme: initialTheme,
    setUpdateState: (updateState) => {
      set((state) => {
        state.updateState = updateState;
        state.updateAvailable = [
          "available",
          "downloading",
          "downloaded",
        ].includes(updateState.status);
      });
    },
    setTheme: (theme) => {
      set((state) => {
        state.theme = theme;
      });
    },
  })),
);

export const themeSelector = (s: State & Actions) => ({
  theme: s.theme,
  setTheme: s.setTheme,
});
