import localforage from "localforage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { SMART_DOWNLOAD_TYPE, type DownloadFormType } from "./download-dialog";

type State = {
  // Last download type
  lastIsBatch: boolean;
  lastDownloadTypes: DownloadFormType;
};

type Actions = {
  setLastDownloadTypes: (type: DownloadFormType) => void;
  setLastIsBatch: (isBatch: boolean) => void;
};

export const useConfigStore = create<State & Actions>()(
  persist(
    immer((set) => ({
      lastIsBatch: false,
      lastDownloadTypes: SMART_DOWNLOAD_TYPE,
      setLastDownloadTypes: (type) => {
        set((state) => {
          state.lastDownloadTypes = type;
        });
      },
      setLastIsBatch: (isBatch) => {
        set((state) => {
          state.lastIsBatch = isBatch;
        });
      },
    })),
    {
      name: "config-storage",
      storage: createJSONStorage(() => localforage),
    },
  ),
);

export const downloadFormSelector = (s: State & Actions) => ({
  lastIsBatch: s.lastIsBatch,
  lastDownloadTypes: s.lastDownloadTypes,
  setLastDownloadTypes: s.setLastDownloadTypes,
  setLastIsBatch: s.setLastIsBatch,
});
