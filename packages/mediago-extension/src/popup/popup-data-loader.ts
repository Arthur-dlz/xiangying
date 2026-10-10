import type {
  DetectedSource,
  ExtensionResponse,
  ExtensionSettings,
  LocalizedMessage,
  ServerStatus,
} from "@/shared/types";

export type PopupLoadError = string | LocalizedMessage;

export interface PopupDataSnapshot {
  tab: chrome.tabs.Tab | null;
  sources: DetectedSource[];
  settings: ExtensionSettings | null;
  serverStatus: ServerStatus | null;
}

export interface PopupDataLoaderDependencies {
  getActiveTab: () => Promise<chrome.tabs.Tab | null>;
  getSources: (tabId: number) => Promise<DetectedSource[]>;
  getSettings: () => Promise<ExtensionSettings | null>;
  getServerStatus: (
    settings: ExtensionSettings,
  ) => Promise<ServerStatus | null>;
}

export interface PopupSourceEvent {
  sequence: number;
  sources: DetectedSource[];
}

export interface ResolveSnapshotSourcesInput {
  snapshotSources: DetectedSource[];
  snapshotKey: string;
  startSequence: number;
  sourceEvents: ReadonlyMap<string, PopupSourceEvent>;
}

export interface ResolveClearSourcesInput {
  key: string;
  clearStartSequence: number;
  sourceEvents: ReadonlyMap<string, PopupSourceEvent>;
}

export interface ClearSourcesResolution {
  sources: DetectedSource[];
  shouldSynthesizeEmptyEvent: boolean;
}

export async function loadPopupData({
  getActiveTab,
  getSources,
  getSettings,
  getServerStatus,
}: PopupDataLoaderDependencies): Promise<PopupDataSnapshot> {
  const tab = await getActiveTab();
  if (!tab?.id) {
    return {
      tab: null,
      sources: [],
      settings: null,
      serverStatus: null,
    };
  }

  const settings = await getSettings();
  const serverStatus =
    settings?.mode === "desktop-schema"
      ? { ok: true, message: { key: "status.schemaMode" } }
      : settings
        ? await getServerStatus(settings)
        : null;
  const sources = await getSources(tab.id);

  return { tab, sources, settings, serverStatus };
}

function throwUnexpectedPopupResponse(response: ExtensionResponse): never {
  if (response.type === "IMPORT_RESULT" && response.error) {
    throw response.error;
  }
  throw {
    key: "errors.unknown",
    values: { detail: response.type },
  } satisfies LocalizedMessage;
}

export function parsePopupSourcesResponse(
  response: ExtensionResponse,
): DetectedSource[] {
  if (response.type === "SOURCES") return response.sources;
  return throwUnexpectedPopupResponse(response);
}

export function parsePopupSettingsResponse(
  response: ExtensionResponse,
): ExtensionSettings {
  if (response.type === "SETTINGS") return response.settings;
  return throwUnexpectedPopupResponse(response);
}

export function parsePopupStatusResponse(
  response: ExtensionResponse,
): ServerStatus {
  if (response.type === "STATUS") return response.status;
  return throwUnexpectedPopupResponse(response);
}

export function resolveSnapshotSources({
  snapshotSources,
  snapshotKey,
  startSequence,
  sourceEvents,
}: ResolveSnapshotSourcesInput): DetectedSource[] {
  const cachedEvent = sourceEvents.get(snapshotKey);
  if (cachedEvent && cachedEvent.sequence > startSequence) {
    return cachedEvent.sources;
  }
  return snapshotSources;
}

export function resolveClearSources({
  key,
  clearStartSequence,
  sourceEvents,
}: ResolveClearSourcesInput): ClearSourcesResolution {
  const cachedEvent = sourceEvents.get(key);
  if (cachedEvent && cachedEvent.sequence > clearStartSequence) {
    return {
      sources: cachedEvent.sources,
      shouldSynthesizeEmptyEvent: false,
    };
  }
  return { sources: [], shouldSynthesizeEmptyEvent: true };
}

export interface PopupRequestGate {
  begin: () => number;
  canCommit: (request: number) => boolean;
  cancel: () => void;
}

export function createPopupRequestGate(): PopupRequestGate {
  let latestRequest = 0;
  let cancelled = false;

  return {
    begin: () => {
      cancelled = false;
      latestRequest += 1;
      return latestRequest;
    },
    canCommit: (request) => !cancelled && request === latestRequest,
    cancel: () => {
      cancelled = true;
    },
  };
}

export function normalizePopupLoadError(error: unknown): PopupLoadError {
  if (typeof error === "string") return error;
  if (error instanceof Error && error.message) return error.message;
  if (isLocalizedMessage(error)) return error;
  return {
    key: "errors.unknown",
    values: { detail: describeUnknownError(error) },
  };
}

function isLocalizedMessage(error: unknown): error is LocalizedMessage {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { key?: unknown; values?: unknown };
  return (
    typeof candidate.key === "string" &&
    (candidate.values === undefined ||
      (candidate.values !== null && typeof candidate.values === "object"))
  );
}

function describeUnknownError(error: unknown): string {
  if (error && typeof error === "object") {
    try {
      const serialized = JSON.stringify(error);
      if (serialized) return serialized;
    } catch {
      // Fall through to the generic string conversion below.
    }
  }
  return String(error);
}
