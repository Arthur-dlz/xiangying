import { provide } from "@inversifyjs/binding-decorators";
import {
  type BridgeDiscoveryCompleteParams,
  type BridgeDiscoveryRequest,
  type BridgeEventEmitter,
  MediaGoBridgeClient,
} from "@mediago/core-sdk";
import { injectable } from "inversify";

export interface DiscoveryBrowserExecutor {
  discover(
    request: BridgeDiscoveryRequest,
    signal: AbortSignal,
  ): Promise<BridgeDiscoveryCompleteParams>;
  cancel?(discoveryId: string): Promise<void> | void;
}

interface ActiveExecution {
  controller: AbortController;
  discoveryId: string;
  generation: number;
}

@injectable()
@provide()
export class DiscoveryExecutorService {
  private client: MediaGoBridgeClient | null = null;
  private stream: BridgeEventEmitter | null = null;
  private browser: DiscoveryBrowserExecutor | null = null;
  private active: ActiveExecution | null = null;
  private cancelled = new Set<string>();
  private queue = Promise.resolve();
  private generation = 0;

  start(client: MediaGoBridgeClient): void {
    this.disconnectStream();
    void this.abortActive();
    this.client = client;
    this.generation += 1;
    this.connectIfReady();
  }

  setBrowser(browser: DiscoveryBrowserExecutor | null): void {
    if (this.browser === browser) return;
    this.disconnectStream();
    void this.abortActive();
    this.browser = browser;
    this.generation += 1;
    this.connectIfReady();
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.disconnectStream();
    const activeCleanup = this.abortActive();
    this.client = null;
    this.cancelled.clear();
    this.queue = Promise.resolve();
    await activeCleanup;
  }

  private connectIfReady(): void {
    if (!this.client || !this.browser || this.stream) return;
    const stream = this.client.connect();
    this.stream = stream;
    stream.on("discovery-requested", this.onDiscoveryRequested);
    stream.on("discovery-cancelled", this.onDiscoveryCancelled);
    stream.on("error", this.onStreamError);
  }

  private disconnectStream(): void {
    const stream = this.stream;
    this.stream = null;
    if (!stream) return;
    stream.off("discovery-requested", this.onDiscoveryRequested);
    stream.off("discovery-cancelled", this.onDiscoveryCancelled);
    stream.off("error", this.onStreamError);
    stream.close();
  }

  private readonly onDiscoveryRequested = (request: BridgeDiscoveryRequest) => {
    const generation = this.generation;
    this.queue = this.queue
      .catch(() => undefined)
      .then(() => this.execute(request, generation));
  };

  private readonly onDiscoveryCancelled = (payload: {
    discoveryId: string;
  }) => {
    this.cancelled.add(payload.discoveryId);
    if (this.active?.discoveryId !== payload.discoveryId) return;
    void this.abortActive();
  };

  private readonly onStreamError = () => {
    // EventSource reconnects automatically. Invalidating the active execution
    // prevents a late result from being submitted after Core has observed the
    // bridge disconnect and transitioned the authoritative job state.
    this.generation += 1;
    void this.abortActive();
  };

  private async execute(
    request: BridgeDiscoveryRequest,
    generation: number,
  ): Promise<void> {
    if (
      generation !== this.generation ||
      this.cancelled.delete(request.discoveryId)
    ) {
      return;
    }
    const client = this.client;
    const browser = this.browser;
    if (!client || !browser) return;

    const execution: ActiveExecution = {
      controller: new AbortController(),
      discoveryId: request.discoveryId,
      generation,
    };
    this.active = execution;
    try {
      await client.markStarted(request.discoveryId, {
        signal: execution.controller.signal,
      });
      if (!this.isCurrent(execution)) return;
      const result = await abortable(
        browser.discover(request, execution.controller.signal),
        execution.controller.signal,
      );
      if (!this.isCurrent(execution)) return;
      await client.complete(request.discoveryId, result, {
        signal: execution.controller.signal,
      });
    } catch (error) {
      if (execution.controller.signal.aborted || !this.isCurrent(execution)) {
        return;
      }
      const failure = safeExecutionFailure(error);
      await client
        .fail(request.discoveryId, {
          errorCode: failure.errorCode,
          error: failure.error,
          partial: false,
        })
        .catch(() => undefined);
    } finally {
      if (this.active === execution) this.active = null;
      this.cancelled.delete(request.discoveryId);
    }
  }

  private isCurrent(execution: ActiveExecution): boolean {
    return (
      this.active === execution &&
      execution.generation === this.generation &&
      !execution.controller.signal.aborted
    );
  }

  private abortActive(): Promise<void> {
    const active = this.active;
    this.active = null;
    active?.controller.abort();
    if (!active || !this.browser?.cancel) return Promise.resolve();
    return Promise.resolve(this.browser.cancel(active.discoveryId)).catch(
      () => undefined,
    );
  }
}

function safeExecutionFailure(error: unknown): {
  error: string;
  errorCode: string;
} {
  const code =
    error && typeof error === "object" && "errorCode" in error
      ? String(error.errorCode)
      : "";
  switch (code) {
    case "discovery_timeout":
      return {
        error: "browser discovery timed out",
        errorCode: code,
      };
    case "discovery_cancelled":
      return {
        error: "browser discovery cancelled",
        errorCode: code,
      };
    case "discovery_navigation_failed":
      return {
        error: "browser navigation failed",
        errorCode: code,
      };
    default:
      return {
        error: "browser discovery failed",
        errorCode: "discovery_executor_failed",
      };
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}
