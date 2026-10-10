import { type BrowserTabSnapshot, DownloadType } from "@mediago/common";
import { beforeEach, describe, expect, it } from "vitest";
import {
  activeTabSelector,
  browserSnapshotSelector,
  browserSourcePanelSelector,
  type SourceData,
  useBrowserStore,
} from "./browser";

const source = (overrides: Partial<SourceData> = {}): SourceData => ({
  id: 0,
  url: "https://media.example/video.m3u8",
  documentURL: "https://example.com/watch/video",
  name: "Example video",
  type: DownloadType.m3u8,
  ...overrides,
});

const tab = (
  id: string,
  overrides: Partial<BrowserTabSnapshot> = {},
): BrowserTabSnapshot => ({
  id,
  kind: "user",
  mode: "home",
  status: "default",
  isMobile: false,
  url: "",
  title: "",
  sources: [],
  ...overrides,
});

beforeEach(() => {
  useBrowserStore.getState().reset();
});

describe("multi-tab browser store", () => {
  it("starts with one active home tab", () => {
    const state = useBrowserStore.getState();

    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(state.tabs[0].id);
    expect(activeTabSelector(state)).toMatchObject({
      mode: "home",
      status: "default",
      sources: [],
    });
  });

  it("adds, activates, closes, and selects the expected neighbor", () => {
    const store = useBrowserStore.getState();
    const first = store.activeTabId;
    store.addTab(tab("tab-b"));
    store.addTab(tab("tab-c"));
    store.activateTab("tab-b");

    store.closeTab("tab-b");
    expect(useBrowserStore.getState().activeTabId).toBe("tab-c");
    store.closeTab("tab-c");
    expect(useBrowserStore.getState().activeTabId).toBe(first);
    store.closeTab(first);

    const finalState = useBrowserStore.getState();
    expect(finalState.tabs).toHaveLength(1);
    expect(finalState.tabs[0]).toMatchObject({ mode: "home", url: "" });
    expect(finalState.tabs[0].id).not.toBe(first);
  });

  it("does not impose a business-rule tab limit", () => {
    const store = useBrowserStore.getState();
    for (let index = 0; index < 30; index += 1) {
      store.addTab(tab(`tab-${index}`));
    }

    expect(useBrowserStore.getState().tabs).toHaveLength(31);
    expect(useBrowserStore.getState().activeTabId).toBe("tab-29");
  });

  it("keeps navigation, errors, and sources isolated by tab", () => {
    const store = useBrowserStore.getState();
    const first = store.activeTabId;
    store.addTab(tab("tab-b"));
    store.startNavigation(first, "https://example.com/a");
    store.startNavigation("tab-b", "https://example.com/b");
    store.updateTab(first, {
      status: "failed",
      errorCode: -7,
      errorMessage: "failed a",
    });
    store.addSource("tab-b", source({ headers: "Cookie: private-b" }));

    const state = useBrowserStore.getState();
    expect(state.tabs.find((item) => item.id === first)).toMatchObject({
      url: "https://example.com/a",
      status: "failed",
      errorCode: -7,
      sources: [],
    });
    expect(state.tabs.find((item) => item.id === "tab-b")).toMatchObject({
      url: "https://example.com/b",
      status: "loading",
      sources: [expect.objectContaining({ headers: "Cookie: private-b" })],
    });
  });

  it("keeps device mode isolated and preserves it in snapshots", () => {
    const store = useBrowserStore.getState();
    const first = store.activeTabId;
    store.addTab(tab("tab-b", { isMobile: true }));
    store.updateTab(first, { isMobile: false });

    const state = useBrowserStore.getState();
    expect(state.tabs.find((item) => item.id === first)?.isMobile).toBe(false);
    expect(state.tabs.find((item) => item.id === "tab-b")?.isMobile).toBe(true);
    expect(
      browserSnapshotSelector(state).tabs.find((item) => item.id === "tab-b")
        ?.isMobile,
    ).toBe(true);
  });

  it("groups HLS variants only inside their owning tab", () => {
    const store = useBrowserStore.getState();
    const first = store.activeTabId;
    store.addTab(tab("tab-b"));
    const child = source({ url: "https://media.example/720.m3u8" });
    store.addSource(first, child);
    store.addSource("tab-b", child);
    store.addSource(
      first,
      source({
        url: "https://media.example/master.m3u8",
        mediaInfo: {
          status: "ready",
          playlistType: "master",
          maxQuality: "1080p",
          variants: [{ url: child.url, quality: "720p" }],
        },
      }),
    );

    const state = useBrowserStore.getState();
    expect(state.tabs.find((item) => item.id === first)?.sources).toHaveLength(
      1,
    );
    expect(
      state.tabs.find((item) => item.id === "tab-b")?.sources,
    ).toHaveLength(1);
    expect(state.tabs.find((item) => item.id === first)?.sources[0].url).toBe(
      "https://media.example/master.m3u8",
    );
    expect(state.tabs.find((item) => item.id === "tab-b")?.sources[0].url).toBe(
      child.url,
    );
  });

  it("keeps panel collapse global while active source counts change", () => {
    const store = useBrowserStore.getState();
    const first = store.activeTabId;
    store.addTab(tab("tab-b"));
    store.setSourcePanelCollapsed(true);
    store.addSource(first, source());

    expect(browserSourcePanelSelector(useBrowserStore.getState())).toEqual({
      hasSources: false,
      sourceCount: 0,
      sourcePanelCollapsed: true,
    });
    store.activateTab(first);
    expect(browserSourcePanelSelector(useBrowserStore.getState())).toEqual({
      hasSources: true,
      sourceCount: 1,
      sourcePanelCollapsed: true,
    });
  });

  it("hydrates safe snapshots, preserves matching local headers, and ignores stale events", () => {
    const store = useBrowserStore.getState();
    store.hydrateSnapshot({
      tabs: [
        tab("tab-a", {
          mode: "browser",
          status: "loaded",
          url: "https://example.com/a",
          sources: [source({ id: 1 })],
        }),
      ],
      activeTabId: "tab-a",
      sourcePanelCollapsed: false,
    });
    store.addSource(
      "tab-a",
      source({ id: 1, headers: "Authorization: private" }),
    );
    store.hydrateSnapshot({
      tabs: [
        tab("tab-a", {
          mode: "browser",
          status: "loaded",
          url: "https://example.com/a",
          sources: [source({ id: 1 })],
        }),
      ],
      activeTabId: "tab-a",
      sourcePanelCollapsed: true,
    });
    store.addSource("closed-tab", source({ url: "https://late.example" }));

    const state = useBrowserStore.getState();
    expect(activeTabSelector(state).sources[0].headers).toBe(
      "Authorization: private",
    );
    expect(state.tabs).toHaveLength(1);
    expect(state.sourcePanelCollapsed).toBe(true);
    expect(JSON.stringify(browserSnapshotSelector(state))).not.toContain(
      "Authorization",
    );
  });
});
