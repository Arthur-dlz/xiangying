import { beforeEach, describe, expect, it, vi } from "vitest";
import * as EventSourceModule from "eventsource";

import { MediaGoBridgeClient } from "../src";

vi.mock("eventsource", () => {
  const instances: MockEventSource[] = [];

  class MockEventSource {
    readonly url: string;
    readonly options: Record<string, unknown>;
    closed = false;
    listeners = new Map<string, Set<(event: any) => void>>();

    constructor(url: string, options: Record<string, unknown> = {}) {
      this.url = url;
      this.options = options;
      instances.push(this);
    }

    addEventListener(type: string, listener: (event: any) => void): void {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: (event: any) => void): void {
      this.listeners.get(type)?.delete(listener);
    }

    close(): void {
      this.closed = true;
      this.listeners.clear();
    }

    dispatch(type: string, data?: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener({ type, data });
      }
    }
  }

  return {
    EventSource: MockEventSource,
    ErrorEvent: class MockErrorEvent extends Error {
      type: string;
      constructor(type: string, init: { message?: string } = {}) {
        super(init.message);
        this.type = type;
      }
    },
    instances,
  };
});

const instances = () =>
  (
    EventSourceModule as unknown as {
      instances: Array<{
        url: string;
        options: { fetch: Function };
        closed: boolean;
        listeners: Map<string, Set<(event: unknown) => void>>;
        dispatch(type: string, data?: unknown): void;
      }>;
    }
  ).instances;

describe("MediaGoBridgeClient", () => {
  beforeEach(() => {
    instances().length = 0;
  });

  it("sends the token only in Authorization headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });
    const client = new MediaGoBridgeClient({
      baseURL: "http://127.0.0.1:8080",
      token: "sentinel-token",
      fetch: fetchMock,
    });
    const stream = client.connect();
    const source = instances()[0];
    expect(source).toBeDefined();
    if (!source) throw new Error("missing EventSource instance");
    expect(source.url).toBe("http://127.0.0.1:8080/api/bridge/events");
    expect(source.url).not.toContain("sentinel-token");

    await source.options.fetch(source.url, {
      headers: { Accept: "text/event-stream" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      source.url,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer sentinel-token",
        }),
      }),
    );

    await client.markStarted("job/1");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://127.0.0.1:8080/api/bridge/discoveries/job%2F1/start",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sentinel-token",
        }),
      }),
    );
    stream.close();
  });

  it("parses requested/cancelled commands, reports malformed data, and cleans up", () => {
    const client = new MediaGoBridgeClient({
      token: "sentinel-token",
      fetch: vi.fn(),
    });
    const stream = client.connect();
    const source = instances()[0];
    expect(source).toBeDefined();
    if (!source) throw new Error("missing EventSource instance");
    const requested = vi.fn();
    const cancelled = vi.fn();
    const errors = vi.fn();
    stream.on("discovery-requested", requested);
    stream.on("discovery-cancelled", cancelled);
    stream.on("error", errors);

    source.dispatch(
      "discovery-requested",
      JSON.stringify({
        type: "discovery-requested",
        discoveryId: "job-1",
        input: {
          url: "https://example.com/watch",
          mode: "browser",
          timeoutMs: 20_000,
          useSessionCookies: false,
        },
      }),
    );
    source.dispatch(
      "discovery-cancelled",
      JSON.stringify({
        type: "discovery-cancelled",
        discoveryId: "job-1",
      }),
    );
    source.dispatch("discovery-requested", "not-json");

    expect(requested).toHaveBeenCalledWith(
      expect.objectContaining({ discoveryId: "job-1" }),
    );
    expect(cancelled).toHaveBeenCalledWith({ discoveryId: "job-1" });
    expect(errors).toHaveBeenCalledTimes(1);

    stream.close();
    expect(source.closed).toBe(true);
    expect(source.listeners.size).toBe(0);
  });
});
