import { getConfig } from "@/api/config";
import PageContainer from "@/components/page-container";
import { useBrowserActions } from "@/hooks/use-browser-actions";
import { usePlatform } from "@/hooks/use-platform";
import { setAppStoreSelector, useAppStore } from "@/store/app";
import {
  activeTabSelector,
  browserActionsSelector,
  type SourceData,
  useBrowserStore,
} from "@/store/browser";
import { cn } from "@/utils";
import { useSourceExtractIntentStore } from "@/store/source-extract-intent";
import { useAsyncEffect, useMemoizedFn } from "ahooks";
import {
  type BrowserNavigationFailurePayload,
  type BrowserNavigationPayload,
  type BrowserSourceDetectedPayload,
  type BrowserTabsSnapshot,
  IpcEvent,
} from "@mediago/common";
import { type FC, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { BrowserTabStrip } from "./components/browser-tab-strip";
import {
  activeTabElementId,
  getTabShortcut,
  nextTabId,
} from "./components/browser-tab-strip-logic";
import { BrowserView } from "./components/browser-view";
import { FavoriteList } from "./components/favorite-list";
import { ToolBar } from "./components/tool-bar";

interface SourceExtractProps {
  page?: boolean;
}

const SourceExtract: FC<SourceExtractProps> = ({ page = false }) => {
  const { app, on, off } = usePlatform();
  const { activateTab, closeTab, createTab } = useBrowserActions();
  const { setAppStore } = useAppStore(useShallow(setAppStoreSelector));
  const mode = useBrowserStore((state) => activeTabSelector(state).mode);
  const activeTabId = useBrowserStore((state) => state.activeTabId);
  const { addSource, hydrateSnapshot, updateTab } = useBrowserStore(
    useShallow(browserActionsSelector),
  );
  useAsyncEffect(async () => {
    const [configResult, snapshotResult] = await Promise.allSettled([
      getConfig(),
      app.getSharedState(),
    ]);
    if (configResult.status === "fulfilled") setAppStore(configResult.value);
    if (snapshotResult.status === "fulfilled") {
      hydrateSnapshot(snapshotResult.value);
    }
    const pendingURL = useSourceExtractIntentStore.getState().consume();
    if (pendingURL) await createTab(pendingURL);
  }, []);

  const onTabsChanged = useMemoizedFn((...args: unknown[]) => {
    const snapshot = args[1] as BrowserTabsSnapshot | undefined;
    if (snapshot) hydrateSnapshot(snapshot);
  });

  const onPageInfo = useMemoizedFn((...args: unknown[]) => {
    const payload = args[1] as BrowserNavigationPayload | undefined;
    if (!payload) return;
    updateTab(payload.tabId, {
      url: payload.url,
      title: payload.title ?? "",
    });
  });

  const onDidNavigate = useMemoizedFn((...args: unknown[]) => {
    const payload = args[1] as BrowserNavigationPayload | undefined;
    if (!payload) return;
    updateTab(payload.tabId, {
      url: payload.url,
      title: payload.title ?? "",
      errorCode: undefined,
      errorMessage: undefined,
    });
  });

  const onFailLoad = useMemoizedFn((...args: unknown[]) => {
    const payload = args[1] as BrowserNavigationFailurePayload | undefined;
    if (!payload) return;
    updateTab(payload.tabId, {
      url: payload.url,
      title: payload.title ?? "",
      status: "failed",
      errorCode: payload.errorCode,
      errorMessage: payload.errorMessage,
    });
  });

  const onSourceDetected = useMemoizedFn((...args: unknown[]) => {
    const payload = args[1] as BrowserSourceDetectedPayload | undefined;
    if (!payload) return;
    addSource(payload.tabId, payload.source as SourceData);
  });

  useEffect(() => {
    on(IpcEvent.browser.tabsChanged, onTabsChanged);
    on(IpcEvent.browser.domReady, onPageInfo);
    on(IpcEvent.browser.didFailLoad, onFailLoad);
    on(IpcEvent.browser.didNavigate, onDidNavigate);
    on(IpcEvent.browser.didNavigateInPage, onPageInfo);
    on(IpcEvent.browser.sourceDetected, onSourceDetected);

    return () => {
      off(IpcEvent.browser.tabsChanged, onTabsChanged);
      off(IpcEvent.browser.domReady, onPageInfo);
      off(IpcEvent.browser.didFailLoad, onFailLoad);
      off(IpcEvent.browser.didNavigate, onDidNavigate);
      off(IpcEvent.browser.didNavigateInPage, onPageInfo);
      off(IpcEvent.browser.sourceDetected, onSourceDetected);
    };
  }, [
    off,
    on,
    onDidNavigate,
    onFailLoad,
    onPageInfo,
    onSourceDetected,
    onTabsChanged,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const shortcut = getTabShortcut(event);
      if (!shortcut) return;
      event.preventDefault();
      const state = useBrowserStore.getState();
      if (shortcut === "new") {
        void createTab();
        return;
      }
      if (shortcut === "close") {
        void closeTab(state.activeTabId);
        return;
      }
      const targetId = nextTabId(
        state.tabs.map((tab) => tab.id),
        state.activeTabId,
        shortcut === "next" ? 1 : -1,
      );
      if (targetId) void activateTab(targetId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activateTab, closeTab, createTab]);

  return (
    <PageContainer
      className={cn(
        "flex min-h-0 flex-col overflow-hidden p-0",
        page && "rounded-none border-0",
      )}
      wrapperClassName={cn(page && "p-0")}
    >
      <BrowserTabStrip />
      <ToolBar page={page} />
      <div
        id={`browser-panel-${activeTabId}`}
        role="tabpanel"
        aria-labelledby={activeTabElementId(activeTabId)}
        className="flex min-h-0 flex-1 overflow-hidden"
      >
        {mode === "browser" ? <BrowserView /> : <FavoriteList />}
      </div>
    </PageContainer>
  );
};

export default SourceExtract;
