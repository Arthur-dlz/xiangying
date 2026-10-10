import { mergeSniffedSource } from "@mediago/common";

import type { DetectedSource } from "../shared/types";
import { clearTabSources, loadTabSources, saveTabSources } from "./storage";

export interface TabSourceServicePorts {
  load(tabId: number): Promise<DetectedSource[]>;
  save(tabId: number, sources: DetectedSource[]): Promise<void>;
  clear(tabId: number): Promise<void>;
  setBadgeCount(tabId: number, count: number): Promise<void>;
}

export interface EnsureResolvedSourceResult<T> {
  source: DetectedSource;
  meta: T;
  inserted: boolean;
  sources: DetectedSource[];
}

export interface TabSourceService {
  readonly pendingTabCount: number;
  addSource(tabId: number, source: DetectedSource): Promise<DetectedSource[]>;
  addSources(
    tabId: number,
    sources: DetectedSource[],
  ): Promise<DetectedSource[]>;
  clear(tabId: number): Promise<void>;
  remove(tabId: number): Promise<void>;
  ensureResolvedSource<T>(
    tabId: number,
    resolve: () => Promise<{ source: DetectedSource; meta: T }>,
  ): Promise<EnsureResolvedSourceResult<T>>;
}

export function createTabSourceService(
  ports: TabSourceServicePorts,
): TabSourceService {
  const queues = new Map<number, Promise<void>>();

  function enqueue<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(tabId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    queues.set(tabId, tail);

    return current.finally(() => {
      if (queues.get(tabId) === tail) queues.delete(tabId);
    });
  }

  async function addSourcesWithinQueue(
    tabId: number,
    sources: DetectedSource[],
  ): Promise<DetectedSource[]> {
    const existing = await ports.load(tabId);
    const next = sources.reduce(mergeSniffedSource, existing);
    await ports.save(tabId, next);
    await syncBadgeBestEffort(tabId, next.length);
    return next;
  }

  async function syncBadgeBestEffort(
    tabId: number,
    count: number,
  ): Promise<void> {
    try {
      await ports.setBadgeCount(tabId, count);
    } catch {
      // Storage is authoritative. A later operation for this tab retries
      // badge synchronization with its current source count.
    }
  }

  async function clearWithinQueue(tabId: number): Promise<void> {
    await ports.clear(tabId);
    await syncBadgeBestEffort(tabId, 0);
  }

  return {
    get pendingTabCount() {
      return queues.size;
    },
    addSource(tabId, source) {
      return enqueue(tabId, () => addSourcesWithinQueue(tabId, [source]));
    },
    addSources(tabId, sources) {
      return enqueue(tabId, () => addSourcesWithinQueue(tabId, sources));
    },
    clear(tabId) {
      return enqueue(tabId, () => clearWithinQueue(tabId));
    },
    remove(tabId) {
      return enqueue(tabId, async () => {
        await ports.clear(tabId);
        await syncBadgeBestEffort(tabId, 0);
      });
    },
    ensureResolvedSource(tabId, resolve) {
      return enqueue(tabId, async () => {
        const resolved = await resolve();
        const existing = await ports.load(tabId);
        const duplicate = existing.find(
          (item) => item.url === resolved.source.url,
        );

        if (duplicate) {
          await syncBadgeBestEffort(tabId, existing.length);
          return {
            source: duplicate,
            meta: resolved.meta,
            inserted: false,
            sources: existing,
          };
        }

        const next = mergeSniffedSource(existing, resolved.source);
        await ports.save(tabId, next);
        await syncBadgeBestEffort(tabId, next.length);
        return {
          source: resolved.source,
          meta: resolved.meta,
          inserted: next.includes(resolved.source),
          sources: next,
        };
      });
    },
  };
}

async function setBadgeCount(tabId: number, count: number): Promise<void> {
  if (count > 0) {
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: "#ef4444",
    });
    await chrome.action.setBadgeText({ tabId, text: String(count) });
    return;
  }

  await chrome.action.setBadgeText({ tabId, text: "" });
}

export const tabSourceService = createTabSourceService({
  load: loadTabSources,
  save: saveTabSources,
  clear: clearTabSources,
  setBadgeCount,
});
