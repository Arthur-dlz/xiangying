import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => {
  class FakeTaskEvents {
    readonly close = vi.fn();
    readonly listeners = new Map<string, Array<(payload: any) => void>>();

    on(eventName: string, listener: (payload: any) => void) {
      const listeners = this.listeners.get(eventName) ?? [];
      listeners.push(listener);
      this.listeners.set(eventName, listeners);
      return this;
    }

    emit(eventName: string, payload: any) {
      for (const listener of this.listeners.get(eventName) ?? []) {
        listener(payload);
      }
    }
  }

  return {
    bridgeClients: [] as Array<{ options: Record<string, unknown> }>,
    clients: [] as Array<{
      options: Record<string, unknown>;
      listTasks: ReturnType<typeof vi.fn>;
      streamEvents: ReturnType<typeof vi.fn>;
    }>,
    events: [] as FakeTaskEvents[],
    credentialServices: [] as Array<{
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    }>,
    discoveryExecutor: {
      start: vi.fn(),
      stop: vi.fn<() => Promise<void>>(),
    },
    FakeTaskEvents,
    runners: [] as Array<{
      getURL: ReturnType<typeof vi.fn>;
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    }>,
    runnerOptions: [] as Array<{
      extraArgs?: string[];
      extraEnv?: Record<string, string>;
      internal?: boolean;
    }>,
    runnerStart: vi.fn<() => Promise<void>>(),
    runnerStop: vi.fn<() => Promise<void>>(),
    listTasks: vi.fn(),
  };
});

vi.mock("@mediago/service-runner", () => ({
  ServiceRunner: class FakeServiceRunner {
    readonly getURL = vi.fn(() => "http://127.0.0.1:39719");
    readonly start = vi.fn(() => doubles.runnerStart());
    readonly stop = vi.fn(() => doubles.runnerStop());

    constructor(options: (typeof doubles.runnerOptions)[number]) {
      doubles.runners.push(this);
      doubles.runnerOptions.push(options);
    }
  },
}));

vi.mock("@mediago/core-sdk", () => ({
  MediaGoBridgeClient: class FakeMediaGoBridgeClient {
    constructor(readonly options: Record<string, unknown>) {
      doubles.bridgeClients.push(this);
    }
  },
  MediaGoClient: class FakeMediaGoClient {
    readonly listTasks = vi.fn(() => doubles.listTasks());
    readonly streamEvents = vi.fn(() => {
      const events = new doubles.FakeTaskEvents();
      doubles.events.push(events);
      return events;
    });

    constructor(options: Record<string, unknown>) {
      doubles.clients.push({
        options,
        listTasks: this.listTasks,
        streamEvents: this.streamEvents,
      });
    }
  },
  TaskStatus: {
    Downloading: "downloading",
  },
}));

vi.mock("../utils/binaryResolver", () => ({
  resolveCoreBinaries: () => ({
    coreBin: "/fake/core/mediago-core",
  }),
  resolveDepsBinaries: () => ({
    depsDir: "/fake/deps",
  }),
}));

vi.mock("../vendor/ElectronLogger", () => ({
  default: class FakeElectronLogger {},
}));

vi.mock("../core/core-credential.service", () => ({
  CoreCredentialService: class FakeCoreCredentialService {
    readonly start = vi.fn();
    readonly stop = vi.fn();

    constructor() {
      doubles.credentialServices.push(this);
    }
  },
}));

const { DownloaderServer } = await import("./downloader.server");

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createServer() {
  return new DownloaderServer(
    { info: vi.fn() } as never,
    doubles.discoveryExecutor as never,
  );
}

describe("DownloaderServer.stop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    doubles.bridgeClients.length = 0;
    doubles.clients.length = 0;
    doubles.events.length = 0;
    doubles.credentialServices.length = 0;
    doubles.runners.length = 0;
    doubles.runnerOptions.length = 0;
    doubles.discoveryExecutor.start.mockReset();
    doubles.discoveryExecutor.stop.mockReset().mockResolvedValue(undefined);
    doubles.runnerStart.mockReset().mockResolvedValue(undefined);
    doubles.runnerStop.mockReset().mockResolvedValue(undefined);
    doubles.listTasks.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses an explicitly isolated Core port without attaching to the default instance", async () => {
    vi.stubEnv("MEDIAGO_CORE_PORT", "39729");
    const server = createServer();
    await server.start({ dbPath: "/fake/data/media.db", logDir: "/fake/logs" });
    expect(doubles.runnerOptions[0]).toMatchObject({
      preferredPort: 39729,
      internal: true,
    });
    await server.stop();
  });

  it.each(["0", "80", "65536", "39729x", "1.5"])(
    "rejects invalid isolated Core port %s before spawning",
    async (port) => {
      vi.stubEnv("MEDIAGO_CORE_PORT", port);
      const server = createServer();
      await expect(
        server.start({ dbPath: "/fake/data/media.db", logDir: "/fake/logs" }),
      ).rejects.toThrow(/MEDIAGO_CORE_PORT/);
      expect(doubles.runners).toHaveLength(0);
    },
  );
  it("stops polling, events, and the runner exactly once across repeated calls", async () => {
    const runnerStop = deferred();
    doubles.runnerStop.mockReturnValue(runnerStop.promise);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const server = createServer();

    await server.start({ dbPath: "/fake/data/media.db", logDir: "/fake/logs" });
    doubles.events[0].emit("download-start", { id: "42" });

    const firstStop = server.stop();
    const concurrentStop = server.stop();

    expect(concurrentStop).toBe(firstStop);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(doubles.events[0].close).toHaveBeenCalledTimes(1);
    expect(doubles.discoveryExecutor.stop).toHaveBeenCalledTimes(1);
    expect(doubles.credentialServices[0]?.stop).toHaveBeenCalledTimes(1);
    expect(doubles.runners[0].stop).toHaveBeenCalledTimes(1);
    expect(() => server.getClient()).toThrowError(
      "DownloaderServer not started",
    );
    await expect(server.getURL()).resolves.toBe("");

    runnerStop.resolve();
    await Promise.all([firstStop, concurrentStop]);
    await server.stop();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(doubles.events[0].close).toHaveBeenCalledTimes(1);
    expect(doubles.discoveryExecutor.stop).toHaveBeenCalledTimes(1);
    expect(doubles.runners[0].stop).toHaveBeenCalledTimes(1);
  });

  it("forwards polled YouTube percent and speed to the renderer", async () => {
    doubles.listTasks.mockResolvedValue({
      data: {
        tasks: [
          {
            id: "30",
            type: "youtube",
            percent: 15.1,
            speed: "2.26MiB/s",
            isLive: false,
            status: "downloading",
          },
        ],
      },
    });
    const server = createServer();
    const onProgress = vi.fn();
    server.on("download-progress", onProgress);

    await server.start({ dbPath: "/fake/data/media.db", logDir: "/fake/logs" });
    doubles.events[0].emit("download-start", { id: "30" });
    await vi.advanceTimersByTimeAsync(1000);

    expect(onProgress).toHaveBeenCalledExactlyOnceWith([
      {
        id: 30,
        type: "youtube",
        percent: "15.1",
        speed: "2.26MiB/s",
        isLive: false,
        status: "downloading",
      },
    ]);
    await server.stop();
  });

  it("waits for a pending start before stopping without publishing stale state", async () => {
    const runnerStart = deferred();
    doubles.runnerStart.mockReturnValue(runnerStart.promise);
    const server = createServer();

    const start = server.start({
      dbPath: "/fake/data/media.db",
      logDir: "/fake/logs",
    });
    const stop = server.stop();

    expect(doubles.runners[0].stop).not.toHaveBeenCalled();
    expect(doubles.clients).toHaveLength(0);
    expect(doubles.events).toHaveLength(0);
    expect(() => server.getClient()).toThrowError(
      "DownloaderServer not started",
    );
    await expect(server.getURL()).resolves.toBe("");

    runnerStart.resolve();
    await Promise.all([start, stop]);

    expect(doubles.runners[0].stop).toHaveBeenCalledTimes(1);
    expect(doubles.clients).toHaveLength(0);
    expect(doubles.events).toHaveLength(0);
    await expect(server.getURL()).resolves.toBe("");
  });

  it("coalesces concurrent starts around one runner", async () => {
    const runnerStart = deferred();
    doubles.runnerStart.mockReturnValue(runnerStart.promise);
    const server = createServer();

    const firstStart = server.start({
      dbPath: "/fake/data/media.db",
      logDir: "/fake/logs",
    });
    const concurrentStart = server.start({
      dbPath: "/fake/other.db",
      logDir: "/fake/other-logs",
    });

    expect(concurrentStart).toBe(firstStart);
    expect(doubles.runners).toHaveLength(1);

    runnerStart.resolve();
    await Promise.all([firstStart, concurrentStart]);

    expect(doubles.clients).toHaveLength(1);
    expect(doubles.events).toHaveLength(1);
    await server.stop();
  });

  it("rejects a start while runner shutdown is pending", async () => {
    const runnerStop = deferred();
    doubles.runnerStop.mockReturnValue(runnerStop.promise);
    const server = createServer();

    await server.start({ dbPath: "/fake/data/media.db", logDir: "/fake/logs" });
    const stop = server.stop();

    await expect(
      server.start({ dbPath: "/fake/new.db", logDir: "/fake/new-logs" }),
    ).rejects.toThrowError("DownloaderServer is stopping");
    expect(doubles.runners).toHaveLength(1);

    runnerStop.resolve();
    await stop;
  });

  it("can start again after a successful stop", async () => {
    const server = createServer();

    await server.start({ dbPath: "/fake/data/media.db", logDir: "/fake/logs" });
    await server.stop();
    await server.start({ dbPath: "/fake/new.db", logDir: "/fake/new-logs" });

    expect(doubles.runners).toHaveLength(2);
    expect(doubles.clients).toHaveLength(2);
    expect(doubles.events).toHaveLength(2);
    expect(server.getClient()).toBeDefined();
    await expect(server.getURL()).resolves.toBe("http://127.0.0.1:39719");

    await server.stop();
    expect(doubles.runnerStop).toHaveBeenCalledTimes(2);
  });

  it("creates unique Core credentials per start and keeps them out of arguments", async () => {
    const server = createServer();

    await server.start({ dbPath: "/fake/data/media.db", logDir: "/fake/logs" });
    await server.stop();
    await server.start({ dbPath: "/fake/data/media.db", logDir: "/fake/logs" });

    expect(doubles.runnerOptions).toHaveLength(2);
    const tokens = doubles.runnerOptions.map(
      (options) => options.extraEnv?.MEDIAGO_ELECTRON_BRIDGE_TOKEN,
    );
    const apiTokens = doubles.runnerOptions.map(
      (options) => options.extraEnv?.MEDIAGO_ELECTRON_API_TOKEN,
    );
    expect(tokens[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(tokens[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(apiTokens[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(apiTokens[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(apiTokens[0]).not.toBe(apiTokens[1]);
    for (const [index, options] of doubles.runnerOptions.entries()) {
      expect(options.internal).toBe(true);
      expect(options.extraArgs?.join(" ")).not.toContain(tokens[index]);
      expect(options.extraArgs?.join(" ")).not.toContain(apiTokens[index]);
    }
    expect(doubles.bridgeClients[0]?.options).toEqual({
      baseURL: "http://127.0.0.1:39719",
      token: tokens[0],
    });
    expect(doubles.discoveryExecutor.start).toHaveBeenCalledTimes(2);
    expect(doubles.credentialServices[0]?.start).toHaveBeenCalledWith(
      "http://127.0.0.1:39719",
      apiTokens[0],
    );
    expect(doubles.clients[0]?.options).toEqual({
      baseURL: "http://127.0.0.1:39719",
      apiKey: apiTokens[0],
    });

    await server.stop();
  });

  it("closes the discovery bridge before stopping the Core runner", async () => {
    const server = createServer();
    await server.start({ dbPath: "/fake/data/media.db", logDir: "/fake/logs" });

    await server.stop();

    expect(doubles.discoveryExecutor.stop).toHaveBeenCalledOnce();
    expect(
      doubles.discoveryExecutor.stop.mock.invocationCallOrder[0],
    ).toBeLessThan(doubles.runners[0].stop.mock.invocationCallOrder[0]);
  });

  it("shares a runner stop rejection and remains stopped afterward", async () => {
    const runnerStop = deferred();
    const stopError = new Error("runner shutdown failed");
    doubles.runnerStop.mockReturnValue(runnerStop.promise);
    const server = createServer();

    await server.start({ dbPath: "/fake/data/media.db", logDir: "/fake/logs" });

    const firstStop = server.stop();
    const concurrentStop = server.stop();
    runnerStop.reject(stopError);
    const results = await Promise.allSettled([firstStop, concurrentStop]);

    expect(results).toEqual([
      { reason: stopError, status: "rejected" },
      { reason: stopError, status: "rejected" },
    ]);
    expect(doubles.events[0].close).toHaveBeenCalledTimes(1);
    expect(doubles.runners[0].stop).toHaveBeenCalledTimes(1);
    expect(() => server.getClient()).toThrowError(
      "DownloaderServer not started",
    );
    await expect(server.getURL()).resolves.toBe("");

    await expect(
      server.start({ dbPath: "/fake/new.db", logDir: "/fake/new-logs" }),
    ).rejects.toThrowError(
      "DownloaderServer cannot restart after shutdown failure",
    );
    expect(doubles.runners).toHaveLength(1);

    await server.stop();

    expect(doubles.events[0].close).toHaveBeenCalledTimes(1);
    expect(doubles.runners[0].stop).toHaveBeenCalledTimes(1);
  });

  it("clears state and stops the runner when closing events throws", async () => {
    const closeError = new Error("event close failed");
    const server = createServer();

    await server.start({ dbPath: "/fake/data/media.db", logDir: "/fake/logs" });
    doubles.events[0].close.mockImplementation(() => {
      throw closeError;
    });

    const stop = server.stop();

    expect(() => server.getClient()).toThrowError(
      "DownloaderServer not started",
    );
    await expect(server.getURL()).resolves.toBe("");
    expect(doubles.runners[0].stop).toHaveBeenCalledTimes(1);
    await expect(stop).rejects.toBe(closeError);
    expect(doubles.events[0].close).toHaveBeenCalledTimes(1);
    expect(doubles.runners[0].stop).toHaveBeenCalledTimes(1);
  });

  it("does not stop a runner again after start rejects", async () => {
    const startError = new Error("runner start failed");
    doubles.runnerStart.mockRejectedValue(startError);
    const server = createServer();

    await expect(
      server.start({ dbPath: "/fake/data/media.db", logDir: "/fake/logs" }),
    ).rejects.toBe(startError);
    await server.stop();

    expect(doubles.runners[0].stop).not.toHaveBeenCalled();
    expect(() => server.getClient()).toThrowError(
      "DownloaderServer not started",
    );
    await expect(server.getURL()).resolves.toBe("");
  });
});
