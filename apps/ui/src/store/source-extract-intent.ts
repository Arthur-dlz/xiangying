import { create } from "zustand";

interface SourceExtractIntentState {
  pendingURL?: string;
  clear: () => void;
  consume: () => string | undefined;
  openURL: (url: string) => void;
}

export const useSourceExtractIntentStore = create<SourceExtractIntentState>(
  (set, get) => ({
    clear: () => set({ pendingURL: undefined }),
    consume: () => {
      const pendingURL = get().pendingURL;
      set({ pendingURL: undefined });
      return pendingURL;
    },
    openURL: (url) => set({ pendingURL: url.trim() || undefined }),
  }),
);
