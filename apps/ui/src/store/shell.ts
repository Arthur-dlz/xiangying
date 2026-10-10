import { create } from "zustand";
import {
  SIDEBAR_DEFAULT_WIDTH,
  clampSidebarExpandedWidth,
} from "@/layout/sidebar-sizing";

const SIDEBAR_STORAGE_KEY = "mediago:shell:v1";
const SIDEBAR_WIDTH_STORAGE_KEY = "mediago:sidebar-width:v1";

function readSidebarCollapsed() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "collapsed";
  } catch {
    return false;
  }
}

function writeSidebarCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(
      SIDEBAR_STORAGE_KEY,
      collapsed ? "collapsed" : "expanded",
    );
  } catch {
    // Storage may be unavailable in private browsing; the UI still works.
  }
}

function readSidebarWidth() {
  if (typeof window === "undefined") return SIDEBAR_DEFAULT_WIDTH;
  try {
    const storedWidth = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (storedWidth === null) return SIDEBAR_DEFAULT_WIDTH;
    return clampSidebarExpandedWidth(Number(storedWidth));
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function writeSidebarWidth(width: number) {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Storage may be unavailable in private browsing; the UI still works.
  }
}

interface ShellState {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarExpandedWidth: (width: number) => void;
  toggleSidebar: () => void;
}

export const useShellStore = create<ShellState>((set) => ({
  sidebarCollapsed: readSidebarCollapsed(),
  sidebarWidth: readSidebarWidth(),
  setSidebarCollapsed: (sidebarCollapsed) => {
    writeSidebarCollapsed(sidebarCollapsed);
    set({ sidebarCollapsed });
  },
  setSidebarExpandedWidth: (width) => {
    const sidebarWidth = clampSidebarExpandedWidth(width);
    writeSidebarWidth(sidebarWidth);
    writeSidebarCollapsed(false);
    set({ sidebarCollapsed: false, sidebarWidth });
  },
  toggleSidebar: () =>
    set((state) => {
      const sidebarCollapsed = !state.sidebarCollapsed;
      writeSidebarCollapsed(sidebarCollapsed);
      return { sidebarCollapsed };
    }),
}));
