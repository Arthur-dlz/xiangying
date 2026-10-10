import {
  findPageAdapter,
  startPageRuntime,
  type PageAdapter,
  type PageCandidate,
} from "@mediago/browser-extension/site-adapters";
import { matchPageUrl } from "@mediago/common";

import { getPageActionCopy } from "./page-action-copy";
import {
  createPageActionButton,
  type PageActionButton,
} from "./page-action-button";
import { DEFAULT_SETTINGS, STORAGE_KEY_SETTINGS } from "../shared/constants";
import type {
  ExtensionMessage,
  ExtensionResponse,
  ExtensionSettings,
} from "../shared/types";

export type StorageChangeListener = (
  changes: Record<string, { newValue?: unknown }>,
  areaName: string,
) => void;

export type RuntimeMessageListener = (message: unknown) => void;

export interface PageActionControllerPorts {
  document: Document;
  currentUrl(): string;
  loadStoredSettings(): Promise<Partial<ExtensionSettings>>;
  iconUrl: string;
  sendMessage(message: ExtensionMessage): Promise<ExtensionResponse>;
  addStorageChangeListener(listener: StorageChangeListener): () => void;
  addRuntimeMessageListener(listener: RuntimeMessageListener): () => void;
}

export interface PageActionController {
  destroy(): void;
}

function asSettings(value: unknown): Partial<ExtensionSettings> {
  return value && typeof value === "object"
    ? (value as Partial<ExtensionSettings>)
    : {};
}

function findAdapter(url: string): PageAdapter | null {
  try {
    return findPageAdapter(new URL(url));
  } catch {
    return null;
  }
}

function defaultPorts(): PageActionControllerPorts {
  return {
    document,
    currentUrl: () => window.location.href,
    async loadStoredSettings() {
      const raw = await chrome.storage.local.get(STORAGE_KEY_SETTINGS);
      return asSettings(raw[STORAGE_KEY_SETTINGS]);
    },
    iconUrl: chrome.runtime.getURL("public/icons/mediago-16.png"),
    sendMessage: (message) => chrome.runtime.sendMessage(message),
    addStorageChangeListener(listener) {
      chrome.storage.onChanged.addListener(listener);
      return () => chrome.storage.onChanged.removeListener(listener);
    },
    addRuntimeMessageListener(listener) {
      chrome.runtime.onMessage.addListener(listener);
      return () => chrome.runtime.onMessage.removeListener(listener);
    },
  };
}

/** Keep content-script path gating in lock-step with the shared sniff rules. */
export function isSupportedPageUrl(url: string): boolean {
  return matchPageUrl(url) !== undefined;
}

export async function createPageActionController(
  ports: PageActionControllerPorts = defaultPorts(),
): Promise<PageActionController> {
  let settings: ExtensionSettings | null = null;
  let latestChangedSettings: ExtensionSettings | null = null;
  let settingsRevision = 0;
  let actionButton: PageActionButton | null = null;
  let cardAdapter: PageAdapter | null = null;
  let stopCardRuntime: (() => void) | null = null;
  let activation: Promise<void> | null = null;
  let destroyed = false;

  const activate = (): Promise<void> => {
    if (activation) return activation;
    activation = ports
      .sendMessage({ type: "ADD_CURRENT_PAGE_TO_POPUP" })
      .then((response) => {
        if (response.type !== "PAGE_ACTION_RESULT" || !response.ok) {
          throw new Error("MediaGo page action failed");
        }
      })
      .finally(() => {
        activation = null;
      });
    return activation;
  };

  const addPageCandidate = (candidate: PageCandidate): void => {
    void ports
      .sendMessage({ type: "ADD_PAGE_CANDIDATE_TO_POPUP", candidate })
      .then((response) => {
        if (response.type !== "PAGE_ACTION_RESULT" || !response.ok) {
          throw new Error("MediaGo page candidate action failed");
        }
      })
      .catch(() => undefined);
  };

  const updateVisibility = () => {
    if (destroyed || !settings) return;
    const currentUrl = ports.currentUrl();
    const enabled = settings.pageQuickActionEnabled;
    const visible = enabled && isSupportedPageUrl(currentUrl);
    if (!visible) {
      actionButton?.destroy();
      actionButton = null;
    } else {
      const copy = getPageActionCopy(settings.language);
      if (actionButton) {
        actionButton.setCopy(copy);
      } else {
        actionButton = createPageActionButton({
          document: ports.document,
          iconUrl: ports.iconUrl,
          copy,
          onActivate: activate,
        });
      }
    }

    const adapter = enabled ? findAdapter(currentUrl) : null;
    if (adapter === cardAdapter) return;

    stopCardRuntime?.();
    stopCardRuntime = null;
    cardAdapter = adapter;
    if (adapter) {
      stopCardRuntime = startPageRuntime({
        adapter,
        document: ports.document,
        transport: addPageCandidate,
      });
    }
  };

  const handleStorageChange: StorageChangeListener = (changes, areaName) => {
    if (destroyed || areaName !== "local") return;
    const change = changes[STORAGE_KEY_SETTINGS];
    if (!change) return;
    settingsRevision += 1;
    latestChangedSettings = {
      ...DEFAULT_SETTINGS,
      ...asSettings(change.newValue),
    };
    if (!settings) return;
    settings = latestChangedSettings;
    updateVisibility();
  };

  const handleRuntimeMessage: RuntimeMessageListener = (message) => {
    if (
      !destroyed &&
      message !== null &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "PAGE_CONTEXT_CHANGED"
    ) {
      updateVisibility();
    }
  };

  const removeStorageListener =
    ports.addStorageChangeListener(handleStorageChange);
  const removeRuntimeListener =
    ports.addRuntimeMessageListener(handleRuntimeMessage);
  const revisionBeforeLoad = settingsRevision;
  try {
    const storedSettings = await ports.loadStoredSettings();
    settings =
      settingsRevision === revisionBeforeLoad || !latestChangedSettings
        ? { ...DEFAULT_SETTINGS, ...storedSettings }
        : latestChangedSettings;
  } catch (error) {
    destroyed = true;
    removeStorageListener();
    removeRuntimeListener();
    throw error;
  }
  updateVisibility();

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      removeStorageListener();
      removeRuntimeListener();
      actionButton?.destroy();
      actionButton = null;
      stopCardRuntime?.();
      stopCardRuntime = null;
      cardAdapter = null;
    },
  };
}
