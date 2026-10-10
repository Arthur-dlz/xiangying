import { describe, expect, it } from "vitest";

import {
  DownloadType,
  IPC,
  type BrowserLoadURLPayload,
  type BrowserSourceDetectedPayload,
  type BrowserTabsSnapshot,
} from "../src";

describe("browser tab contracts", () => {
  it("represent an unbounded renderer-safe tab snapshot", () => {
    const snapshot = {
      tabs: Array.from({ length: 25 }, (_, index) => ({
        id: `tab-${index + 1}`,
        kind: "user",
        mode: "home",
        status: "default",
        url: "",
        title: "New tab",
        sources: [],
      })),
      activeTabId: "tab-25",
      sourcePanelCollapsed: false,
    } satisfies BrowserTabsSnapshot;

    expect(snapshot.tabs).toHaveLength(25);
    expect(IPC.browser.createTab).toBe("browser.createTab");
  });

  it("keeps tab identity on navigation and source events", () => {
    const navigation = {
      tabId: "tab-1",
      url: "https://example.com/watch",
    } satisfies BrowserLoadURLPayload;
    const detected = {
      tabId: "tab-1",
      source: {
        id: 1,
        url: "https://cdn.example.com/master.m3u8",
        documentURL: navigation.url,
        name: "Example",
        type: DownloadType.m3u8,
        headers: "Referer: https://example.com/watch",
      },
    } satisfies BrowserSourceDetectedPayload;

    expect(detected.tabId).toBe(navigation.tabId);
    expect(detected.source.headers).toContain("Referer");
  });
});
