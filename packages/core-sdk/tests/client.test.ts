import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaGoClient } from "../src";
import * as EventSourceModule from "eventsource";

vi.mock("eventsource", () => {
  const instances: any[] = [];

  class BaseEvent {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  }

  class MockErrorEvent extends BaseEvent {
    code?: number;
    message?: string;
    constructor(type: string, init: { code?: number; message?: string } = {}) {
      super(type);
      this.code = init.code;
      this.message = init.message;
    }
  }

  class MockMessageEvent<T = unknown> extends BaseEvent {
    data: T | null;
    constructor(type: string, init: { data?: T | null } = {}) {
      super(type);
      this.data = init.data ?? null;
    }
  }

  type Listener = (event: any) => void;

  class MockEventSource {
    readonly url: string;
    readonly options: Record<string, unknown>;
    closed = false;
    private readonly listeners = new Map<string, Set<Listener>>();

    constructor(url: string, options: Record<string, unknown> = {}) {
      this.url = url;
      this.options = options;
      instances.push(this);
    }

    addEventListener(type: string, listener: Listener): void {
      if (!this.listeners.has(type)) {
        this.listeners.set(type, new Set());
      }
      this.listeners.get(type)!.add(listener);
    }

    removeEventListener(type: string, listener: Listener): void {
      this.listeners.get(type)?.delete(listener);
    }

    close(): void {
      this.closed = true;
      this.listeners.clear();
    }

    dispatch(
      type: string,
      init: { data?: unknown; code?: number; message?: string } = {},
    ): void {
      const listeners = this.listeners.get(type);
      if (!listeners || listeners.size === 0) {
        return;
      }

      const event =
        type === "error"
          ? new MockErrorEvent(type, { code: init.code, message: init.message })
          : new MockMessageEvent(type, { data: init.data });

      for (const listener of listeners) {
        listener(event);
      }
    }
  }

  return {
    default: MockEventSource,
    EventSource: MockEventSource,
    ErrorEvent: MockErrorEvent,
    __instances: instances,
  };
});

const getInstances = () =>
  (EventSourceModule as unknown as { __instances: any[] }).__instances ?? [];

describe("MediaGoClient.streamEvents", () => {
  beforeEach(() => {
    getInstances().length = 0;
  });

  it("connects to /api/events and re-emits task events", () => {
    const client = new MediaGoClient({ baseURL: "http://example.com" });
    const emitter = client.streamEvents();

    const instances = getInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0]?.url).toBe("http://example.com/api/events");

    const onStart = vi.fn();
    emitter.on("download-start", onStart);

    instances[0]?.dispatch("download-start", {
      data: JSON.stringify({ id: "task-1" }),
    });

    expect(onStart).toHaveBeenCalledWith({ id: "task-1" });
  });

  it("sends API keys as Bearer headers for SSE without putting them in the URL", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const client = new MediaGoClient({
      baseURL: "http://example.com",
      apiKey: "private-api-key",
    });
    client.streamEvents();

    const source = getInstances().at(-1);
    if (!source) throw new Error("EventSource was not constructed");
    expect(source.url).toBe("http://example.com/api/events");
    expect(source.url).not.toContain("private-api-key");
    const init = { headers: new Headers({ "X-Caller": "preserved" }) };
    // EventSource calls the override for each connection/reconnection.
    const options = source.options as { fetch?: typeof fetch };
    const fetchOverride = options.fetch;
    expect(fetchOverride).toBeTypeOf("function");
    if (!fetchOverride)
      throw new Error("EventSource fetch override is missing");
    await fetchOverride(source.url, init as never);
    const passedInit = fetcher.mock.calls[0]?.[1];
    expect(new Headers(passedInit?.headers).get("X-Caller")).toBe("preserved");
    expect(new Headers(passedInit?.headers).get("Authorization")).toBe(
      "Bearer private-api-key",
    );
    fetcher.mockRestore();
  });

  it("emits error events for invalid payloads and closes the source", () => {
    const client = new MediaGoClient();
    const emitter = client.streamEvents();
    const instances = getInstances();
    const source = instances.at(-1)!;

    const onError = vi.fn();
    emitter.on("error", onError);

    source.dispatch("download-start", { data: "not-json" });
    expect(onError).toHaveBeenCalledTimes(1);

    emitter.close();
    expect(source.closed).toBe(true);
  });
});

describe("MediaGoClient discovery methods", () => {
  it("uses the shared discovery routes with bounded timeouts and abort signals", async () => {
    const client = new MediaGoClient({ baseURL: "http://example.com" });
    const controller = new AbortController();
    const post = vi.spyOn(client.api, "post").mockResolvedValue({
      success: true,
      code: 202,
      message: "OK",
      data: { id: "job-1" },
    });
    const get = vi.spyOn(client.api, "get").mockResolvedValue({
      success: true,
      code: 200,
      message: "OK",
      data: { id: "job-1" },
    });

    await client.createDiscovery(
      {
        url: "https://example.com/watch",
        mode: "browser",
        timeoutMs: 30_000,
      },
      { signal: controller.signal },
    );
    expect(post).toHaveBeenCalledWith(
      "/api/discoveries",
      expect.objectContaining({ mode: "browser" }),
      expect.objectContaining({ signal: controller.signal, timeout: 35_000 }),
    );

    await client.getDiscovery("job/1", { signal: controller.signal });
    expect(get).toHaveBeenCalledWith(
      "/api/discoveries/job%2F1",
      expect.objectContaining({ signal: controller.signal }),
    );
    await client.cancelDiscovery("job/1");
    expect(post).toHaveBeenCalledWith(
      "/api/discoveries/job%2F1/cancel",
      undefined,
      expect.objectContaining({ timeout: 10_000 }),
    );
    await client.createDiscoveryDownloads("job/1", {
      sourceIds: ["source-1"],
      startDownload: true,
    });
    expect(post).toHaveBeenCalledWith(
      "/api/discoveries/job%2F1/downloads",
      expect.objectContaining({ sourceIds: ["source-1"] }),
      expect.objectContaining({ timeout: 10_000 }),
    );
    await client.getDiscoveryExecutorStatus();
    expect(get).toHaveBeenCalledWith(
      "/api/discovery-executor/status",
      expect.objectContaining({ timeout: 10_000 }),
    );
  });
});

describe("MediaGoClient favorite icon resolution", () => {
  it("resolves an icon by favorite ID without accepting a client icon URL", async () => {
    const client = new MediaGoClient({ baseURL: "http://example.com" });
    const post = vi.spyOn(client.api, "post").mockResolvedValue({
      success: true,
      code: 200,
      message: "OK",
      data: {
        id: 42,
        title: "Example",
        url: "https://example.com/original",
        icon: "https://example.com/favicon.ico",
        iconStatus: "ready",
        createdDate: "2026-08-27T00:00:00Z",
        updatedDate: "2026-08-27T00:00:00Z",
      },
    });

    await client.resolveFavoriteIcon(42);

    expect(post).toHaveBeenCalledWith("/api/favorites/42/icon/resolve");
  });
});
