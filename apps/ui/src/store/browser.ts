import {
  type BrowserTabSnapshot,
  type BrowserTabSourceSnapshot,
  type BrowserTabsSnapshot,
  DownloadType,
  type HLSMediaInfo,
  mergeSniffedSource,
} from "@mediago/common";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { subscribeWithSelector } from "zustand/middleware";

export const PageMode = {
  Default: "home",
  Browser: "browser",
} as const;

export const BrowserStatus = {
  Default: "default",
  Loaded: "loaded",
  Loading: "loading",
  Failed: "failed",
} as const;

export interface SourceData extends BrowserTabSourceSnapshot {
  type: DownloadType;
  headers?: string;
  mediaInfo?: HLSMediaInfo;
}

export interface BrowserTabState extends Omit<
  BrowserTabSnapshot,
  "kind" | "sources"
> {
  kind: "user";
  sources: SourceData[];
}

export interface BrowserState {
  tabs: BrowserTabState[];
  activeTabId: string;
  sourcePanelCollapsed: boolean;
}

type TabUpdate = Partial<Omit<BrowserTabState, "id" | "kind" | "sources">>;

export interface BrowserActions {
  addTab: (tab?: BrowserTabSnapshot) => BrowserTabState;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  hydrateSnapshot: (snapshot: BrowserTabsSnapshot) => void;
  updateTab: (tabId: string, values: TabUpdate) => void;
  startNavigation: (tabId: string, url: string) => void;
  addSource: (tabId: string, source: SourceData) => void;
  deleteSource: (tabId: string, url: string) => void;
  setSources: (tabId: string, sources: SourceData[]) => void;
  clearSources: (tabId: string) => void;
  setSourcePanelCollapsed: (collapsed: boolean) => void;
  reset: () => void;
}

export type BrowserStore = BrowserState & BrowserActions;

let localTabSequence = 0;

function createHomeTab(id = nextLocalTabId()): BrowserTabState {
  return {
    id,
    kind: "user",
    mode: "home",
    status: "default",
    isMobile: false,
    url: "",
    title: "",
    sources: [],
  };
}

function createInitialState(): BrowserState {
  const tab = createHomeTab();
  return {
    tabs: [tab],
    activeTabId: tab.id,
    sourcePanelCollapsed: false,
  };
}

function nextLocalTabId(): string {
  localTabSequence += 1;
  return `local-tab-${localTabSequence}`;
}

function normalizeTab(
  tab: BrowserTabSnapshot,
  previous?: BrowserTabState,
): BrowserTabState {
  const previousSources = new Map(
    previous?.sources.map((source) => [source.url, source]),
  );
  return {
    id: tab.id,
    kind: "user",
    mode: tab.mode,
    status: tab.status,
    isMobile: tab.isMobile === true,
    url: tab.url,
    title: tab.title,
    favicon: tab.favicon,
    errorCode: tab.errorCode,
    errorMessage: tab.errorMessage,
    sources: tab.sources.map((source) => ({
      id: source.id,
      url: source.url,
      documentURL: source.documentURL,
      name: source.name,
      type: source.type,
      mediaInfo: source.mediaInfo,
      headers: previousSources.get(source.url)?.headers,
    })),
  };
}

const initialState = createInitialState();

export const useBrowserStore = create<BrowserStore>()(
  subscribeWithSelector(
    immer((set) => ({
      ...initialState,
      addTab: (tab) => {
        const normalized = tab ? normalizeTab(tab) : createHomeTab();
        set((state) => {
          const index = state.tabs.findIndex(
            (candidate) => candidate.id === normalized.id,
          );
          if (index >= 0) state.tabs[index] = normalized;
          else state.tabs.push(normalized);
          state.activeTabId = normalized.id;
        });
        return normalized;
      },
      activateTab: (tabId) =>
        set((state) => {
          if (state.tabs.some((tab) => tab.id === tabId)) {
            state.activeTabId = tabId;
          }
        }),
      closeTab: (tabId) =>
        set((state) => {
          const index = state.tabs.findIndex((tab) => tab.id === tabId);
          if (index < 0) return;
          const wasActive = state.activeTabId === tabId;
          state.tabs.splice(index, 1);
          if (state.tabs.length === 0) {
            const replacement = createHomeTab();
            state.tabs.push(replacement);
            state.activeTabId = replacement.id;
          } else if (wasActive) {
            state.activeTabId =
              state.tabs[Math.min(index, state.tabs.length - 1)].id;
          }
        }),
      hydrateSnapshot: (snapshot) =>
        set((state) => {
          if (!snapshot || !Array.isArray(snapshot.tabs)) return;
          const previousTabs = new Map(
            state.tabs.map((tab) => [tab.id, tab] as const),
          );
          const tabs = snapshot.tabs
            .filter((tab) => tab.kind === "user")
            .map((tab) => normalizeTab(tab, previousTabs.get(tab.id)));
          if (tabs.length === 0) return;
          state.tabs = tabs;
          state.activeTabId = tabs.some(
            (tab) => tab.id === snapshot.activeTabId,
          )
            ? snapshot.activeTabId
            : tabs[0].id;
          state.sourcePanelCollapsed = snapshot.sourcePanelCollapsed === true;
        }),
      updateTab: (tabId, values) =>
        set((state) => {
          const tab = state.tabs.find((candidate) => candidate.id === tabId);
          if (!tab) return;
          Object.assign(tab, values);
        }),
      startNavigation: (tabId, url) =>
        set((state) => {
          const tab = state.tabs.find((candidate) => candidate.id === tabId);
          if (!tab) return;
          Object.assign(tab, {
            url,
            mode: "browser" as const,
            status: "loading" as const,
            sources: [],
            errorMessage: undefined,
            errorCode: undefined,
          });
        }),
      addSource: (tabId, source) =>
        set((state) => {
          const tab = state.tabs.find((candidate) => candidate.id === tabId);
          if (!tab) return;
          const existing = tab.sources.find((item) => item.url === source.url);
          let nextId = 1;
          for (const item of tab.sources)
            nextId = Math.max(nextId, item.id + 1);
          tab.sources = mergeSniffedSource(tab.sources, {
            ...source,
            id: existing?.id ?? nextId,
          });
        }),
      deleteSource: (tabId, url) =>
        set((state) => {
          const tab = state.tabs.find((candidate) => candidate.id === tabId);
          if (!tab) return;
          tab.sources = tab.sources.filter((item) => item.url !== url);
        }),
      setSources: (tabId, sources) =>
        set((state) => {
          const tab = state.tabs.find((candidate) => candidate.id === tabId);
          if (tab) tab.sources = sources;
        }),
      clearSources: (tabId) =>
        set((state) => {
          const tab = state.tabs.find((candidate) => candidate.id === tabId);
          if (tab) tab.sources = [];
        }),
      setSourcePanelCollapsed: (collapsed) =>
        set((state) => {
          state.sourcePanelCollapsed = collapsed;
        }),
      reset: () =>
        set((state) => {
          const next = createInitialState();
          state.tabs = next.tabs;
          state.activeTabId = next.activeTabId;
          state.sourcePanelCollapsed = next.sourcePanelCollapsed;
        }),
    })),
  ),
);

const EMPTY_TAB = createHomeTab("missing-tab");

export const activeTabSelector = (state: BrowserStore): BrowserTabState =>
  state.tabs.find((tab) => tab.id === state.activeTabId) ??
  state.tabs[0] ??
  EMPTY_TAB;

export const browserTabsSelector = (state: BrowserStore) => ({
  tabs: state.tabs,
  activeTabId: state.activeTabId,
});

export const browserStoreSelector = (state: BrowserStore) => {
  const tab = activeTabSelector(state);
  return {
    tabId: tab.id,
    mode: tab.mode,
    url: tab.url,
    title: tab.title,
    status: tab.status,
    isMobile: tab.isMobile,
    errMsg: tab.errorMessage,
    errCode: tab.errorCode,
    sources: tab.sources,
  };
};

export const browserNavSelector = (state: BrowserStore) => {
  const tab = activeTabSelector(state);
  return {
    tabId: tab.id,
    mode: tab.mode,
    url: tab.url,
    title: tab.title,
    status: tab.status,
    isMobile: tab.isMobile,
  };
};

export const browserSourcesSelector = (state: BrowserStore) => {
  const tab = activeTabSelector(state);
  return { tabId: tab.id, sources: tab.sources };
};

export const browserSourcePanelSelector = (state: BrowserStore) => {
  const tab = activeTabSelector(state);
  return {
    hasSources: tab.sources.length > 0,
    sourceCount: tab.sources.length,
    sourcePanelCollapsed: state.sourcePanelCollapsed,
  };
};

export const browserErrorSelector = (state: BrowserStore) => {
  const tab = activeTabSelector(state);
  return {
    tabId: tab.id,
    status: tab.status,
    isMobile: tab.isMobile,
    errMsg: tab.errorMessage,
    errCode: tab.errorCode,
    url: tab.url,
  };
};

export const browserActionsSelector = (state: BrowserStore) => ({
  addTab: state.addTab,
  activateTab: state.activateTab,
  closeTab: state.closeTab,
  hydrateSnapshot: state.hydrateSnapshot,
  updateTab: state.updateTab,
  startNavigation: state.startNavigation,
  addSource: state.addSource,
  deleteSource: state.deleteSource,
  setSources: state.setSources,
  clearSources: state.clearSources,
  setSourcePanelCollapsed: state.setSourcePanelCollapsed,
  reset: state.reset,
});

export const setBrowserSelector = browserActionsSelector;

export const browserSnapshotSelector = (
  state: BrowserStore,
): BrowserTabsSnapshot => ({
  tabs: state.tabs.map((tab) => ({
    id: tab.id,
    kind: "user",
    mode: tab.mode,
    status: tab.status,
    isMobile: tab.isMobile,
    url: tab.url,
    title: tab.title,
    favicon: tab.favicon,
    errorCode: tab.errorCode,
    errorMessage: tab.errorMessage,
    sources: tab.sources.map((source) => ({
      id: source.id,
      url: source.url,
      documentURL: source.documentURL,
      name: source.name,
      type: source.type,
      mediaInfo: source.mediaInfo,
    })),
  })),
  activeTabId: state.activeTabId,
  sourcePanelCollapsed: state.sourcePanelCollapsed,
});
