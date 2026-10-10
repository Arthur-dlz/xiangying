import { DownloadFilter } from "@mediago/common";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

type State = {
  pages: Record<DownloadFilter, number>;
  pageSize: number;
};

type Actions = {
  setPage: (filter: DownloadFilter, page: number) => void;
  setPageSize: (size: number) => void;
};

export const useHomeStore = create<State & Actions>()(
  immer((set) => ({
    pages: {
      [DownloadFilter.list]: 1,
      [DownloadFilter.done]: 1,
    },
    pageSize: 20,
    setPage: (filter, page) => {
      set((state) => {
        state.pages[filter] = page;
      });
    },
    setPageSize: (pageSize) => {
      set((state) => {
        state.pageSize = pageSize;
        state.pages[DownloadFilter.list] = 1;
        state.pages[DownloadFilter.done] = 1;
      });
    },
  })),
);
