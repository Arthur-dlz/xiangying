export const SIDEBAR_COLLAPSED_WIDTH = 64;
export const SIDEBAR_DEFAULT_WIDTH = 204;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 360;
export const SIDEBAR_SNAP_THRESHOLD = Math.round(
  (SIDEBAR_COLLAPSED_WIDTH + SIDEBAR_MIN_WIDTH) / 2,
);

export interface SidebarResizeResult {
  collapsed: boolean;
  width: number;
}

export function clampSidebarExpandedWidth(width: number) {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(
    SIDEBAR_MAX_WIDTH,
    Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)),
  );
}

export function resolveSidebarResize(width: number): SidebarResizeResult {
  if (width < SIDEBAR_SNAP_THRESHOLD) {
    return { collapsed: true, width: SIDEBAR_COLLAPSED_WIDTH };
  }

  return {
    collapsed: false,
    width: clampSidebarExpandedWidth(width),
  };
}
