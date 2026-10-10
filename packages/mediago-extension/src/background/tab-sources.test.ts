import { DownloadType } from "@mediago/common";
import { describe, expect, test, vi } from "vitest";

import type { DetectedSource } from "../shared/types";
import {
  createTabSourceService,
  type TabSourceServicePorts,
} from "./tab-sources";

function source(
  id: string,
  url = `https://media.example/${id}.mp4`,
): DetectedSource {
  return {
    id,
    url,
    documentURL: "https://page.example/video",
    name: id,
    type: DownloadType.direct,
    detectedAt: Number(id.replace(/\D/g, "")) || 1,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function memoryPorts(initial: Record<number, DetectedSource[]> = {}) {
  const stored = new Map(
    Object.entries(initial).map(([tabId, sources]) => [Number(tabId), sources]),
  );
  const badges = new Map<number, number>();
  const ports: TabSourceServicePorts = {
    load: vi.fn(async (tabId) => stored.get(tabId) ?? []),
    save: vi.fn(async (tabId, sources) => {
      stored.set(tabId, sources);
    }),
    clear: vi.fn(async (tabId) => {
      stored.delete(tabId);
    }),
    setBadgeCount: vi.fn(async (tabId, count) => {
      badges.set(tabId, count);
    }),
  };
  return { stored, badges, ports };
}

describe("TabSourceService", () => {
  test("ordinary adds preserve mergeSniffedSource replacement order", async () => {
    const replaced = source("old", "https://media.example/shared.mp4");
    const unrelated = source("other");
    const incoming = {
      ...source("new", replaced.url),
      name: "latest metadata",
    };
    const memory = memoryPorts({ 1: [replaced, unrelated] });
    const service = createTabSourceService(memory.ports);

    const result = await service.addSource(1, incoming);

    expect(result).toEqual([unrelated, incoming]);
    expect(memory.stored.get(1)).toEqual([unrelated, incoming]);
    expect(memory.badges.get(1)).toBe(2);
  });

  test("ensure preserves the complete existing item and its index for a duplicate URL", async () => {
    const before = source("before");
    const existing = source("existing", "https://page.example/video/1");
    const after = source("after");
    const incoming = {
      ...source("replacement", existing.url),
      name: "must not replace existing metadata",
    };
    const memory = memoryPorts({ 2: [before, existing, after] });
    const service = createTabSourceService(memory.ports);

    const result = await service.ensureResolvedSource(2, async () => ({
      source: incoming,
      meta: { windowId: 7 },
    }));

    expect(result).toEqual({
      source: existing,
      meta: { windowId: 7 },
      inserted: false,
      sources: [before, existing, after],
    });
    expect(result.source).toBe(existing);
    expect(memory.ports.save).not.toHaveBeenCalled();
    expect(memory.stored.get(2)).toEqual([before, existing, after]);
    expect(memory.badges.get(2)).toBe(3);
  });

  test("ensure inserts a new URL using normal merge semantics", async () => {
    const existing = source("existing");
    const incoming = source("incoming");
    const memory = memoryPorts({ 3: [existing] });
    const service = createTabSourceService(memory.ports);

    const result = await service.ensureResolvedSource(3, async () => ({
      source: incoming,
      meta: "resolved-live-tab",
    }));

    expect(result).toEqual({
      source: incoming,
      meta: "resolved-live-tab",
      inserted: true,
      sources: [existing, incoming],
    });
    expect(memory.stored.get(3)).toEqual([existing, incoming]);
    expect(memory.badges.get(3)).toBe(2);
  });

  test("serializes concurrent adds to the same tab without losing a source", async () => {
    const memory = memoryPorts();
    const firstLoad = deferred<DetectedSource[]>();
    vi.mocked(memory.ports.load)
      .mockImplementationOnce(() => firstLoad.promise)
      .mockImplementation(async (tabId) => memory.stored.get(tabId) ?? []);
    const service = createTabSourceService(memory.ports);
    const first = service.addSource(4, source("first"));
    const second = service.addSource(4, source("second"));

    await vi.waitFor(() => expect(memory.ports.load).toHaveBeenCalledTimes(1));
    firstLoad.resolve([]);
    await Promise.all([first, second]);

    expect(memory.stored.get(4)?.map((item) => item.id)).toEqual([
      "first",
      "second",
    ]);
    expect(memory.ports.load).toHaveBeenCalledTimes(2);
    expect(memory.badges.get(4)).toBe(2);
  });

  test("honors clear-before-add ordering", async () => {
    const existing = source("existing");
    const incoming = source("incoming");
    const memory = memoryPorts({ 5: [existing] });
    const clearGate = deferred();
    vi.mocked(memory.ports.clear).mockImplementationOnce(async (tabId) => {
      await clearGate.promise;
      memory.stored.delete(tabId);
    });
    const service = createTabSourceService(memory.ports);

    const clearing = service.clear(5);
    const adding = service.addSource(5, incoming);
    await vi.waitFor(() => expect(memory.ports.clear).toHaveBeenCalledOnce());
    expect(memory.ports.load).not.toHaveBeenCalled();

    clearGate.resolve();
    await Promise.all([clearing, adding]);

    expect(memory.stored.get(5)).toEqual([incoming]);
    expect(memory.badges.get(5)).toBe(1);
  });

  test("runs an ensure resolver inside the queue so a later navigation clear wins", async () => {
    const incoming = source("resolved-page");
    const memory = memoryPorts();
    const resolverStarted = deferred();
    const resolverGate = deferred<{
      source: DetectedSource;
      meta: { url: string };
    }>();
    const service = createTabSourceService(memory.ports);

    const ensuring = service.ensureResolvedSource(6, async () => {
      resolverStarted.resolve();
      return resolverGate.promise;
    });
    await resolverStarted.promise;
    const clearing = service.clear(6);

    expect(memory.ports.clear).not.toHaveBeenCalled();
    resolverGate.resolve({ source: incoming, meta: { url: incoming.url } });
    await Promise.all([ensuring, clearing]);

    expect(memory.stored.has(6)).toBe(false);
    expect(memory.badges.get(6)).toBe(0);
    expect(vi.mocked(memory.ports.setBadgeCount).mock.calls).toEqual([
      [6, 1],
      [6, 0],
    ]);
  });

  test("a failed operation does not poison later work for the tab", async () => {
    const memory = memoryPorts();
    vi.mocked(memory.ports.save).mockRejectedValueOnce(new Error("disk full"));
    const service = createTabSourceService(memory.ports);

    await expect(service.addSource(7, source("failed"))).rejects.toThrow(
      "disk full",
    );
    await expect(service.addSource(7, source("recovered"))).resolves.toEqual([
      source("recovered"),
    ]);

    expect(memory.stored.get(7)).toEqual([source("recovered")]);
    expect(service.pendingTabCount).toBe(0);
  });

  test("blocked work for one tab does not block another tab", async () => {
    const memory = memoryPorts();
    const tabEightGate = deferred<DetectedSource[]>();
    vi.mocked(memory.ports.load).mockImplementation(async (tabId) => {
      if (tabId === 8) return tabEightGate.promise;
      return memory.stored.get(tabId) ?? [];
    });
    const service = createTabSourceService(memory.ports);

    const blocked = service.addSource(8, source("blocked"));
    await expect(service.addSource(9, source("independent"))).resolves.toEqual([
      source("independent"),
    ]);
    expect(service.pendingTabCount).toBe(1);

    tabEightGate.resolve([]);
    await blocked;
    expect(service.pendingTabCount).toBe(0);
  });

  test("remove is serialized after pending mutations and clears tab state", async () => {
    const memory = memoryPorts();
    const saveGate = deferred();
    vi.mocked(memory.ports.save).mockImplementationOnce(
      async (tabId, items) => {
        await saveGate.promise;
        memory.stored.set(tabId, items);
      },
    );
    const service = createTabSourceService(memory.ports);

    const adding = service.addSource(10, source("late"));
    const removing = service.remove(10);
    await vi.waitFor(() => expect(memory.ports.save).toHaveBeenCalledOnce());
    expect(memory.ports.clear).not.toHaveBeenCalled();

    saveGate.resolve();
    await Promise.all([adding, removing]);

    expect(memory.stored.has(10)).toBe(false);
    expect(memory.badges.get(10)).toBe(0);
    expect(service.pendingTabCount).toBe(0);
  });

  test("remove still completes when Chrome has already discarded the tab badge", async () => {
    const existing = source("closing");
    const memory = memoryPorts({ 11: [existing] });
    vi.mocked(memory.ports.setBadgeCount).mockRejectedValueOnce(
      new Error("No tab with id: 11"),
    );
    const service = createTabSourceService(memory.ports);

    await expect(service.remove(11)).resolves.toBeUndefined();

    expect(memory.stored.has(11)).toBe(false);
    expect(memory.ports.setBadgeCount).toHaveBeenCalledWith(11, 0);
    expect(service.pendingTabCount).toBe(0);
  });

  test("add resolves from authoritative storage when badge sync fails and retries later", async () => {
    const first = source("first-badge");
    const second = source("second-badge");
    const memory = memoryPorts();
    vi.mocked(memory.ports.setBadgeCount).mockRejectedValueOnce(
      new Error("action API unavailable"),
    );
    const service = createTabSourceService(memory.ports);

    await expect(service.addSource(12, first)).resolves.toEqual([first]);
    expect(memory.stored.get(12)).toEqual([first]);

    await expect(service.addSource(12, second)).resolves.toEqual([
      first,
      second,
    ]);
    expect(memory.badges.get(12)).toBe(2);
    expect(vi.mocked(memory.ports.setBadgeCount).mock.calls).toEqual([
      [12, 1],
      [12, 2],
    ]);
  });

  test("batch add resolves with saved state when badge sync fails", async () => {
    const batch = [source("batch-one"), source("batch-two")];
    const memory = memoryPorts();
    vi.mocked(memory.ports.setBadgeCount).mockRejectedValueOnce(
      new Error("action API unavailable"),
    );
    const service = createTabSourceService(memory.ports);

    await expect(service.addSources(17, batch)).resolves.toEqual(batch);

    expect(memory.stored.get(17)).toEqual(batch);
    expect(memory.ports.setBadgeCount).toHaveBeenCalledWith(17, 2);
  });

  test("clear resolves from authoritative storage when badge sync fails", async () => {
    const memory = memoryPorts({ 13: [source("clear-badge")] });
    vi.mocked(memory.ports.setBadgeCount).mockRejectedValueOnce(
      new Error("action API unavailable"),
    );
    const service = createTabSourceService(memory.ports);

    await expect(service.clear(13)).resolves.toBeUndefined();

    expect(memory.stored.has(13)).toBe(false);
    expect(memory.ports.setBadgeCount).toHaveBeenCalledWith(13, 0);
  });

  test("duplicate ensure resolves with the retained item when badge sync fails", async () => {
    const existing = source("duplicate-badge");
    const memory = memoryPorts({ 14: [existing] });
    vi.mocked(memory.ports.setBadgeCount).mockRejectedValueOnce(
      new Error("action API unavailable"),
    );
    const service = createTabSourceService(memory.ports);

    await expect(
      service.ensureResolvedSource(14, async () => ({
        source: { ...existing, id: "must-not-replace" },
        meta: "duplicate",
      })),
    ).resolves.toEqual({
      source: existing,
      meta: "duplicate",
      inserted: false,
      sources: [existing],
    });

    expect(memory.ports.save).not.toHaveBeenCalled();
    expect(memory.stored.get(14)).toEqual([existing]);
  });

  test("inserted ensure resolves with saved state when badge sync fails", async () => {
    const incoming = source("inserted-badge");
    const memory = memoryPorts();
    vi.mocked(memory.ports.setBadgeCount).mockRejectedValueOnce(
      new Error("action API unavailable"),
    );
    const service = createTabSourceService(memory.ports);

    await expect(
      service.ensureResolvedSource(15, async () => ({
        source: incoming,
        meta: "inserted",
      })),
    ).resolves.toEqual({
      source: incoming,
      meta: "inserted",
      inserted: true,
      sources: [incoming],
    });

    expect(memory.stored.get(15)).toEqual([incoming]);
  });

  test("storage load and clear failures remain authoritative errors", async () => {
    const memory = memoryPorts({ 16: [source("existing")] });
    const service = createTabSourceService(memory.ports);
    vi.mocked(memory.ports.load).mockRejectedValueOnce(
      new Error("load failed"),
    );

    await expect(service.addSource(16, source("incoming"))).rejects.toThrow(
      "load failed",
    );

    vi.mocked(memory.ports.clear).mockRejectedValueOnce(
      new Error("clear failed"),
    );
    await expect(service.clear(16)).rejects.toThrow("clear failed");
    expect(memory.stored.get(16)).toEqual([source("existing")]);
  });
});
