import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { enableMapSet } from "immer";
import {
  formatDownloadSpeed,
  normalizeDownloadPercent,
} from "./download-progress";

// Allow Immer to work with Map in state
enableMapSet();

interface DownloadEvent {
  percent: string;
  speed: string;
  id: number;
  isLive: boolean;
  startedAt?: string;
}

interface DownloadStore {
  count: number;
  events: DownloadEvent[];
  eventsMap: Map<string, DownloadEvent>;
}

const initialState: DownloadStore = {
  count: 0,
  events: [],
  eventsMap: new Map(),
};

type Actions = {
  clearCount: () => void;
  increase: () => void;
  setEvents: (events: DownloadEvent[]) => void;
};

export const useDownloadStore = create<DownloadStore & Actions>()(
  immer((set) => ({
    ...initialState,
    clearCount: () =>
      set((state) => {
        state.count = 0;
      }),
    increase: () =>
      set((state) => {
        state.count += 1;
      }),
    setEvents: (events: DownloadEvent[]) =>
      set((state) => {
        const normalized = events.map((item) => {
          const previous = state.eventsMap.get(String(item.id));
          const isLive = item.isLive || previous?.isLive === true;
          const prevPercent = normalizeDownloadPercent(previous?.percent);
          const currentPercent = normalizeDownloadPercent(item.percent);
          const percent = isLive
            ? 0
            : Math.min(100, Math.max(currentPercent ?? 0, prevPercent ?? 0, 0));

          return {
            ...item,
            isLive,
            percent: percent.toString(),
            speed: formatDownloadSpeed(item.speed),
            startedAt: item.startedAt ?? previous?.startedAt,
          };
        });

        state.events = normalized;
        state.eventsMap = new Map(
          normalized.map((item) => [String(item.id), item]),
        );
      }),
  })),
);

export const downloadStoreSelector = (state: DownloadStore & Actions) => {
  return {
    count: state.count,
    clearCount: state.clearCount,
    increase: state.increase,
    events: state.events,
    eventsMap: state.eventsMap,
    setEvents: state.setEvents,
  };
};
