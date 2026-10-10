import { useCallback, useEffect, useRef, useState } from "react";

import type {
  DetectedSource,
  ExtensionMessage,
  ExtensionResponse,
  ExtensionSettings,
  LocalizedMessage,
  ServerStatus,
} from "@/shared/types";
import { storageKeyTab } from "@/shared/constants";

import {
  createPopupRequestGate,
  loadPopupData,
  normalizePopupLoadError,
  parsePopupSettingsResponse,
  parsePopupSourcesResponse,
  parsePopupStatusResponse,
  resolveClearSources,
  resolveSnapshotSources,
  type PopupLoadError,
} from "./popup-data-loader";

async function sendMessage<T extends ExtensionResponse>(
  msg: ExtensionMessage,
): Promise<T> {
  return (await chrome.runtime.sendMessage(msg)) as T;
}

interface PopupData {
  tab: chrome.tabs.Tab | null;
  sources: DetectedSource[];
  settings: ExtensionSettings | null;
  serverStatus: ServerStatus | null;
  loading: boolean;
  loadError: PopupLoadError | null;
  refresh: () => Promise<void>;
  clear: () => Promise<void>;
  importAll: () => Promise<void>;
  importOne: (source: DetectedSource) => Promise<void>;
  importing: boolean;
}

/**
 * Toast payload kind — the background may send either a ready-made
 * string (HTTP/network error from the server) or a translation
 * descriptor owned by the extension. The caller renders it.
 */
export type ToastValue =
  | string
  | LocalizedMessage
  | undefined
  | { key: "popup.imported"; values: { count: number } };

/**
 * Encapsulates every round-trip the popup makes to the background
 * worker. Also resolves the current mode → status probe policy:
 *
 * - `desktop-http` / `docker-http` — hit `/healthy` to flag green/red.
 * - `desktop-schema` — no silent probe possible (would cause an OS
 *   handoff every time the popup opens); we report a neutral "Schema"
 *   badge and let the user use the options page's Test button for
 *   the one-shot ping check.
 */
export function usePopupData(
  onToast: (kind: "success" | "error", value: ToastValue) => void,
): PopupData {
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [sources, setSources] = useState<DetectedSource[]>([]);
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<PopupLoadError | null>(null);
  const requestGateRef = useRef(createPopupRequestGate());
  const activeTabIdRef = useRef<number | null>(null);
  const sourceEventSequenceRef = useRef(0);
  const sourceEventsRef = useRef(
    new Map<string, { sequence: number; sources: DetectedSource[] }>(),
  );

  const refresh = useCallback(async () => {
    const request = requestGateRef.current.begin();
    const startSourceSequence = sourceEventSequenceRef.current;
    if (!requestGateRef.current.canCommit(request)) return;
    setLoading(true);
    setLoadError(null);
    try {
      const snapshot = await loadPopupData({
        getActiveTab: async () => {
          const [active] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          return active ?? null;
        },
        getSources: async (tabId) => {
          const response = await sendMessage<ExtensionResponse>({
            type: "GET_SOURCES",
            tabId,
          });
          return parsePopupSourcesResponse(response);
        },
        getSettings: async () => {
          const response = await sendMessage<ExtensionResponse>({
            type: "GET_SETTINGS",
          });
          return parsePopupSettingsResponse(response);
        },
        getServerStatus: async (currentSettings) => {
          const response = await sendMessage<ExtensionResponse>({
            type: "TEST_CONNECTION",
            mode: currentSettings.mode,
            serverUrl: currentSettings.serverUrl,
            apiKey: currentSettings.apiKey,
          });
          return parsePopupStatusResponse(response);
        },
      });
      if (!requestGateRef.current.canCommit(request)) return;
      activeTabIdRef.current = snapshot.tab?.id ?? null;
      setTab(snapshot.tab);
      const snapshotKey = snapshot.tab?.id
        ? storageKeyTab(snapshot.tab.id)
        : null;
      setSources(
        snapshotKey
          ? resolveSnapshotSources({
              snapshotSources: snapshot.sources,
              snapshotKey,
              startSequence: startSourceSequence,
              sourceEvents: sourceEventsRef.current,
            })
          : snapshot.sources,
      );
      setSettings(snapshot.settings);
      setServerStatus(snapshot.serverStatus);
    } catch (error) {
      if (requestGateRef.current.canCommit(request)) {
        setLoadError(normalizePopupLoadError(error));
      }
    } finally {
      if (requestGateRef.current.canCommit(request)) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== "session") return;
      for (const [key, change] of Object.entries(changes)) {
        if (!key.startsWith("mediago.tab.")) continue;
        const eventSources =
          (change.newValue as DetectedSource[] | undefined) ?? [];
        const sequence = sourceEventSequenceRef.current + 1;
        sourceEventSequenceRef.current = sequence;
        sourceEventsRef.current.set(key, { sequence, sources: eventSources });

        const activeTabId = activeTabIdRef.current;
        if (activeTabId !== null && key === storageKeyTab(activeTabId)) {
          setSources(eventSources);
        }
      }
    };

    chrome.storage.onChanged.addListener(onStorageChanged);
    void refresh();
    return () => {
      chrome.storage.onChanged.removeListener(onStorageChanged);
      requestGateRef.current.cancel();
    };
  }, [refresh]);

  const clear = useCallback(async () => {
    if (!tab?.id) return;
    const key = storageKeyTab(tab.id);
    const clearStartSequence = sourceEventSequenceRef.current;
    await sendMessage({ type: "CLEAR_SOURCES", tabId: tab.id });
    const resolution = resolveClearSources({
      key,
      clearStartSequence,
      sourceEvents: sourceEventsRef.current,
    });
    if (resolution.shouldSynthesizeEmptyEvent) {
      const sequence = sourceEventSequenceRef.current + 1;
      sourceEventSequenceRef.current = sequence;
      sourceEventsRef.current.set(key, { sequence, sources: [] });
    }
    setSources(resolution.sources);
  }, [tab?.id]);

  const runImport = useCallback(
    async (items: DetectedSource[]) => {
      if (items.length === 0) return;
      setImporting(true);
      try {
        const res = await sendMessage<ExtensionResponse>({
          type: "IMPORT_SOURCES",
          sources: items,
        });
        if (res.type === "IMPORT_RESULT") {
          if (res.ok) {
            onToast("success", {
              key: "popup.imported",
              values: { count: res.count },
            });
          } else {
            onToast("error", res.error);
          }
        }
      } finally {
        setImporting(false);
      }
    },
    [onToast],
  );

  const importAll = useCallback(() => runImport(sources), [runImport, sources]);
  const importOne = useCallback(
    (source: DetectedSource) => runImport([source]),
    [runImport],
  );

  return {
    tab,
    sources,
    settings,
    serverStatus,
    loading,
    loadError,
    refresh,
    clear,
    importAll,
    importOne,
    importing,
  };
}
