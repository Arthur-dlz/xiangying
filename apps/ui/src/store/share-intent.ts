import { isFreshShareIntent, type ShareIntent } from "@mediago/common";
import { create } from "zustand";

const MAX_PENDING_INTENTS = 20;

interface ShareIntentQueueState {
  pending: ShareIntent[];
  enqueue: (intents: ShareIntent[]) => void;
  remove: (id: string) => void;
}

export const useShareIntentQueueStore = create<ShareIntentQueueState>(
  (set) => ({
    pending: [],
    enqueue: (intents) => {
      const fresh = intents.filter(isFreshShareIntent);
      if (fresh.length === 0) return;

      set((state) => {
        const knownIds = new Set(state.pending.map((intent) => intent.id));
        const additions = fresh.filter((intent) => !knownIds.has(intent.id));
        if (additions.length === 0) return state;
        return {
          pending: [...state.pending, ...additions].slice(-MAX_PENDING_INTENTS),
        };
      });
    },
    remove: (id) =>
      set((state) => ({
        pending: state.pending.filter((intent) => intent.id !== id),
      })),
  }),
);
