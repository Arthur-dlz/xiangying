import { describe, expect, it } from "vitest";
import {
  activeTabElementId,
  formatSourceBadge,
  getCloseFallbackId,
  getTabShortcut,
  getTabStripLayout,
  nextTabId,
  resolveTabLabel,
} from "./browser-tab-strip-logic";

describe("browser tab strip logic", () => {
  const ids = ["tab-a", "tab-b", "tab-c"];

  it("chooses the right close neighbor before the left", () => {
    expect(getCloseFallbackId(ids, "tab-b")).toBe("tab-c");
    expect(getCloseFallbackId(ids, "tab-c")).toBe("tab-b");
    expect(getCloseFallbackId(["tab-a"], "tab-a")).toBeUndefined();
  });

  it("cycles keyboard navigation in both directions", () => {
    expect(nextTabId(ids, "tab-c", 1)).toBe("tab-a");
    expect(nextTabId(ids, "tab-a", -1)).toBe("tab-c");
    expect(nextTabId(ids, "missing", 1)).toBe("tab-a");
  });

  it("builds concise labels from title, URL, or the translated fallback", () => {
    expect(
      resolveTabLabel({ title: "  Example title  ", url: "" }, "New tab"),
    ).toBe("Example title");
    expect(
      resolveTabLabel(
        { title: "", url: "https://media.example.com/watch/1" },
        "New tab",
      ),
    ).toBe("media.example.com");
    expect(resolveTabLabel({ title: "", url: "" }, "New tab")).toBe("New tab");
  });

  it("caps visual source badges while preserving the accessible count", () => {
    expect(formatSourceBadge(8)).toEqual({ text: "8", count: 8 });
    expect(formatSourceBadge(132)).toEqual({ text: "99+", count: 132 });
  });

  it("detects horizontal overflow and always reserves a pinned new-tab action", () => {
    expect(getTabStripLayout(2, 500)).toEqual({
      overflowing: false,
      newTabActionPinned: true,
    });
    expect(getTabStripLayout(25, 900)).toEqual({
      overflowing: true,
      newTabActionPinned: true,
    });
  });

  it("returns stable active scroll targets", () => {
    expect(activeTabElementId("tab-a/b c")).toBe("browser-tab-tab-a-2f-b-20-c");
  });

  it("maps documented cross-platform shortcuts", () => {
    expect(getTabShortcut({ key: "t", ctrlKey: true })).toBe("new");
    expect(getTabShortcut({ key: "w", metaKey: true })).toBe("close");
    expect(getTabShortcut({ key: "Tab", ctrlKey: true })).toBe("next");
    expect(getTabShortcut({ key: "Tab", ctrlKey: true, shiftKey: true })).toBe(
      "previous",
    );
    expect(getTabShortcut({ key: "Tab", metaKey: true })).toBeNull();
    expect(getTabShortcut({ key: "t" })).toBeNull();
  });
});
