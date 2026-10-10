import { EventEmitter } from "node:events";
import type { BridgeDiscoveryRequest, BridgeEventMap } from "@mediago/core-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiscoveryExecutorService } from "./discovery-executor.service";

class FakeBridgeStream extends EventEmitter {
  readonly close = vi.fn(() => this.removeAllListeners());

  override emit<TEventName extends keyof BridgeEventMap>(
    eventName: TEventName,
    payload: BridgeEventMap[TEventName],
  ): boolean {
    return super.emit(eventName, payload);
  }
}

function request(id: string): BridgeDiscoveryRequest {
  return {
    type: "discovery-requested",
    discoveryId: id,
    input: {
      url: `https://example.com/${id}`,
      mode: "browser",
      timeoutMs: 20_000,
      useSessionCookies: false,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createHarness() {
  const stream = new FakeBridgeStream();
  const client = {
    complete: vi.fn(async () => undefined),
    connect: vi.fn(() => stream),
    fail: vi.fn(async () => undefined),
    markStarted: vi.fn(async () => undefined),
  };
  const browser = {
    cancel: vi.fn(async () => undefined),
    discover: vi.fn(),
  };
  const executor = new DiscoveryExecutorService();
  executor.setBrowser(browser as never);
  executor.start(client as never);
  return { browser, client, executor, stream };
}

async function waitFor(assertion: () => void) {
  await vi.waitFor(assertion, { interval: 1, timeout: 1_000 });
}

describe("DiscoveryExecutorService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not register as an executor until a browser implementation exists", () => {
    const stream = new FakeBridgeStream();
    const client = { connect: vi.fn(() => stream) };
    const executor = new DiscoveryExecutorService();

    executor.start(client as never);
    expect(client.connect).not.toHaveBeenCalled();

    executor.setBrowser({ discover: vi.fn() } as never);
    expect(client.connect).toHaveBeenCalledOnce();
  });

  it("executes requests sequentially and acknowledges start and completion", async () => {
    const first = deferred<{ sources: []; partial: boolean }>();
    const second = deferred<{ sources: []; partial: boolean }>();
    const { browser, client, executor, stream } = createHarness();
    browser.discover
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    stream.emit("discovery-requested", request("job-1"));
    stream.emit("discovery-requested", request("job-2"));
    await waitFor(() => expect(browser.discover).toHaveBeenCalledTimes(1));
    expect(client.markStarted).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    first.resolve({ sources: [], partial: false });
    await waitFor(() => expect(client.complete).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(browser.discover).toHaveBeenCalledTimes(2));
    expect(client.markStarted).toHaveBeenLastCalledWith(
      "job-2",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    second.resolve({ sources: [], partial: false });
    await waitFor(() => expect(client.complete).toHaveBeenCalledTimes(2));
    await executor.stop();
  });

  it("reports a stable safe failure without forwarding browser error text", async () => {
    const { browser, client, executor, stream } = createHarness();
    browser.discover.mockRejectedValue(
      new Error("Cookie: sentinel-cookie https://private.example/path"),
    );

    stream.emit("discovery-requested", request("job-fail"));
    await waitFor(() => expect(client.fail).toHaveBeenCalledOnce());

    expect(client.fail).toHaveBeenCalledWith("job-fail", {
      errorCode: "discovery_executor_failed",
      error: "browser discovery failed",
      partial: false,
    });
    expect(JSON.stringify(client.fail.mock.calls)).not.toContain("sentinel");
    await executor.stop();
  });

  it("cancels active work and ignores a late completion", async () => {
    const pending = deferred<{ sources: []; partial: boolean }>();
    const { browser, client, executor, stream } = createHarness();
    browser.discover.mockReturnValue(pending.promise);

    stream.emit("discovery-requested", request("job-cancel"));
    await waitFor(() => expect(browser.discover).toHaveBeenCalledOnce());
    const signal = browser.discover.mock.calls[0][1] as AbortSignal;
    stream.emit("discovery-cancelled", { discoveryId: "job-cancel" });

    await waitFor(() =>
      expect(browser.cancel).toHaveBeenCalledWith("job-cancel"),
    );
    expect(signal.aborted).toBe(true);
    pending.resolve({ sources: [], partial: false });
    await Promise.resolve();
    expect(client.complete).not.toHaveBeenCalled();
    expect(client.fail).not.toHaveBeenCalled();
    await executor.stop();
  });

  it("invalidates disconnected work and accepts the Core redispatch", async () => {
    const stale = deferred<{ sources: []; partial: boolean }>();
    const { browser, client, executor, stream } = createHarness();
    browser.discover
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ sources: [], partial: false });

    stream.emit("discovery-requested", request("job-reconnect"));
    await waitFor(() => expect(browser.discover).toHaveBeenCalledOnce());
    stream.emit("error", new Event("error"));
    stream.emit("discovery-requested", request("job-reconnect"));

    await waitFor(() => expect(browser.discover).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(client.complete).toHaveBeenCalledOnce());
    expect(client.markStarted).toHaveBeenCalledTimes(2);
    stale.resolve({ sources: [], partial: false });
    await Promise.resolve();
    expect(client.complete).toHaveBeenCalledTimes(1);
    await executor.stop();
  });

  it("closes listeners and active browser work on shutdown", async () => {
    const pending = deferred<{ sources: []; partial: boolean }>();
    const { browser, client, executor, stream } = createHarness();
    browser.discover.mockReturnValue(pending.promise);
    stream.emit("discovery-requested", request("job-stop"));
    await waitFor(() => expect(browser.discover).toHaveBeenCalledOnce());

    await executor.stop();

    expect(stream.close).toHaveBeenCalledOnce();
    expect(browser.cancel).toHaveBeenCalledWith("job-stop");
    pending.resolve({ sources: [], partial: false });
    await Promise.resolve();
    expect(client.complete).not.toHaveBeenCalled();
  });
});
