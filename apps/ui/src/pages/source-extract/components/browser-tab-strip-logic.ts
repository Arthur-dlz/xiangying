export type TabShortcut = "new" | "close" | "next" | "previous";

interface ShortcutEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export function getCloseFallbackId(
  tabIds: readonly string[],
  closingTabId: string,
): string | undefined {
  const index = tabIds.indexOf(closingTabId);
  if (index < 0 || tabIds.length <= 1) return undefined;
  return tabIds[index + 1] ?? tabIds[index - 1];
}

export function nextTabId(
  tabIds: readonly string[],
  currentTabId: string,
  direction: 1 | -1,
): string | undefined {
  if (tabIds.length === 0) return undefined;
  const currentIndex = tabIds.indexOf(currentTabId);
  if (currentIndex < 0) return tabIds[0];
  return tabIds[(currentIndex + direction + tabIds.length) % tabIds.length];
}

export function resolveTabLabel(
  tab: { title: string; url: string },
  fallback: string,
): string {
  const title = tab.title.trim();
  if (title) return title;
  if (tab.url) {
    try {
      return new URL(tab.url).hostname || fallback;
    } catch {
      return tab.url;
    }
  }
  return fallback;
}

export function formatSourceBadge(count: number): {
  count: number;
  text: string;
} {
  const normalized = Math.max(0, Math.floor(count));
  return { count: normalized, text: normalized > 99 ? "99+" : `${normalized}` };
}

export function getTabStripLayout(
  tabCount: number,
  viewportWidth: number,
): { newTabActionPinned: true; overflowing: boolean } {
  const minimumTabWidth = 96;
  const pinnedActionWidth = 36;
  return {
    overflowing:
      Math.max(0, tabCount) * minimumTabWidth >
      Math.max(0, viewportWidth - pinnedActionWidth),
    newTabActionPinned: true,
  };
}

export function activeTabElementId(tabId: string): string {
  const safeId = tabId.replace(
    /[^a-zA-Z0-9_-]/g,
    (character) => `-${character.codePointAt(0)?.toString(16) ?? "x"}-`,
  );
  return `browser-tab-${safeId}`;
}

export function getTabShortcut(event: ShortcutEvent): TabShortcut | null {
  const key = event.key.toLowerCase();
  if (key === "tab" && event.ctrlKey) {
    return event.shiftKey ? "previous" : "next";
  }
  const command = event.ctrlKey || event.metaKey;
  if (!command) return null;
  if (key === "t" && !event.shiftKey) return "new";
  if (key === "w" && !event.shiftKey) return "close";
  return null;
}
