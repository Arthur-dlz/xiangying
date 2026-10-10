import {
  WEB_SHARE_PROTOCOLS,
  extractFirstHttpUrl,
  isFreshShareIntent,
  normalizeShareIntent,
  type ShareIntent,
} from "@mediago/common";

const STORAGE_KEY = "mediago.share-intents.v1";
const MAX_PENDING_INTENTS = 20;

interface StoredShareIntents {
  version: 1;
  intents: ShareIntent[];
}

interface LocationLike {
  hash: string;
  pathname: string;
  search: string;
}

interface HistoryLike {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

interface StorageLike {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

let startupShareError = false;

function readParams(location: LocationLike): URLSearchParams | null {
  const hash = location.hash;
  const queryIndex = hash.indexOf("?");
  const route = queryIndex >= 0 ? hash.slice(0, queryIndex) : hash;
  if (route === "#/share" || route === "#share") {
    return new URLSearchParams(
      queryIndex >= 0 ? hash.slice(queryIndex + 1) : "",
    );
  }
  if (location.pathname === "/share") {
    return new URLSearchParams(location.search);
  }
  return null;
}

function readStoredIntents(storage: StorageLike): ShareIntent[] {
  try {
    const stored = JSON.parse(
      storage.getItem(STORAGE_KEY) || "null",
    ) as StoredShareIntents | null;
    if (stored?.version !== 1 || !Array.isArray(stored.intents)) return [];
    return stored.intents.filter(isFreshShareIntent);
  } catch {
    return [];
  }
}

export function captureWebShareIntent(
  location: LocationLike = window.location,
  history: HistoryLike = window.history,
  storage: StorageLike = window.sessionStorage,
): boolean {
  const params = readParams(location);
  if (!params) return false;

  const intent = normalizeShareIntent(
    {
      source: params.has("title") || params.has("text") ? "pwa" : "web",
      url: params.get("url") || extractFirstHttpUrl(params.get("text")),
      name: params.get("name") || params.get("title"),
      type: params.get("type"),
    },
    { allowedProtocols: WEB_SHARE_PROTOCOLS },
  );

  try {
    if (intent) {
      const intents = [...readStoredIntents(storage), intent].slice(
        -MAX_PENDING_INTENTS,
      );
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: 1, intents } satisfies StoredShareIntents),
      );
    } else {
      startupShareError = true;
    }
  } catch {
    startupShareError = true;
  }

  history.replaceState(null, "", "/");
  return true;
}

export function drainPendingWebShareIntents(
  storage: StorageLike = window.sessionStorage,
): ShareIntent[] {
  const intents = readStoredIntents(storage);
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Storage may be disabled; the in-memory result is still consumable.
  }
  return intents;
}

export function consumeStartupShareError(): boolean {
  const value = startupShareError;
  startupShareError = false;
  return value;
}
