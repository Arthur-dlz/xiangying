import {
  ErrorEvent,
  EventSource,
  type EventListenerOrEventListenerObject,
  type FetchLike,
} from "eventsource";

import type {
  BridgeDiscoveryCancellation,
  BridgeDiscoveryCompleteParams,
  BridgeDiscoveryFailureParams,
  BridgeDiscoveryRequest,
  BridgeEventEmitter,
  BridgeEventMap,
  DiscoveryRequestOptions,
} from "./types";

export interface MediaGoBridgeClientOptions {
  baseURL?: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
}

type BridgeEventName = keyof BridgeEventMap;
type BridgeListener<TEventName extends BridgeEventName> = (
  payload: BridgeEventMap[TEventName],
) => void;

export class MediaGoBridgeClient {
  private readonly baseURL: string;
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: MediaGoBridgeClientOptions) {
    if (!options.token) {
      throw new Error("Electron bridge token is required");
    }
    this.baseURL = (options.baseURL ?? "http://localhost:8080").replace(
      /\/$/,
      "",
    );
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = clampTimeout(options.requestTimeoutMs ?? 10_000);
  }

  connect(): BridgeEventEmitter {
    const authorizedFetch: FetchLike = async (url, init) => {
      return this.fetchImpl(url, {
        ...init,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${this.token}`,
        },
      }) as ReturnType<FetchLike>;
    };
    const source = new EventSource(`${this.baseURL}/api/bridge/events`, {
      fetch: authorizedFetch,
      maxBufferSize: 1 << 20,
    });
    return new BridgeStreamEventEmitter(source);
  }

  async markStarted(
    discoveryId: string,
    options: DiscoveryRequestOptions = {},
  ): Promise<void> {
    await this.request(discoveryId, "start", undefined, options);
  }

  async complete(
    discoveryId: string,
    params: BridgeDiscoveryCompleteParams,
    options: DiscoveryRequestOptions = {},
  ): Promise<void> {
    await this.request(discoveryId, "complete", params, options);
  }

  async fail(
    discoveryId: string,
    params: BridgeDiscoveryFailureParams,
    options: DiscoveryRequestOptions = {},
  ): Promise<void> {
    await this.request(discoveryId, "fail", params, options);
  }

  private async request(
    discoveryId: string,
    action: "start" | "complete" | "fail",
    body:
      | BridgeDiscoveryCompleteParams
      | BridgeDiscoveryFailureParams
      | undefined,
    options: DiscoveryRequestOptions,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      clampTimeout(options.timeoutMs ?? this.requestTimeoutMs),
    );
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      controller.abort();
    }
    try {
      const response = await this.fetchImpl(
        `${this.baseURL}/api/bridge/discoveries/${encodeURIComponent(discoveryId)}/${action}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(
          `Electron bridge request failed with HTTP ${response.status}`,
        );
      }
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}

class BridgeStreamEventEmitter implements BridgeEventEmitter {
  private readonly handlers = new Map<BridgeEventName, Set<Function>>();
  private readonly sourceListeners: Array<{
    type: string;
    listener: EventListenerOrEventListenerObject;
  }> = [];

  constructor(private readonly source: EventSource) {
    this.attach();
  }

  on<TEventName extends BridgeEventName>(
    eventName: TEventName,
    listener: BridgeListener<TEventName>,
  ): this {
    const handlers = this.handlers.get(eventName) ?? new Set();
    handlers.add(listener);
    this.handlers.set(eventName, handlers);
    return this;
  }

  off<TEventName extends BridgeEventName>(
    eventName: TEventName,
    listener: BridgeListener<TEventName>,
  ): this {
    this.handlers.get(eventName)?.delete(listener);
    return this;
  }

  once<TEventName extends BridgeEventName>(
    eventName: TEventName,
    listener: BridgeListener<TEventName>,
  ): this {
    const wrapped = (payload: BridgeEventMap[TEventName]) => {
      this.off(eventName, wrapped);
      listener(payload);
    };
    return this.on(eventName, wrapped);
  }

  emit<TEventName extends BridgeEventName>(
    eventName: TEventName,
    payload: BridgeEventMap[TEventName],
  ): boolean {
    for (const handler of this.handlers.get(eventName) ?? []) {
      (handler as BridgeListener<TEventName>)(payload);
    }
    return true;
  }

  removeAllListeners<TEventName extends BridgeEventName>(
    eventName?: TEventName,
  ): this {
    if (eventName) {
      this.handlers.delete(eventName);
    } else {
      this.handlers.clear();
    }
    return this;
  }

  close(): void {
    for (const { type, listener } of this.sourceListeners) {
      this.source.removeEventListener(type, listener);
    }
    this.sourceListeners.length = 0;
    this.source.close();
    this.removeAllListeners();
  }

  private attach(): void {
    this.register("open", ((event: Event) => {
      this.emit("open", event);
    }) as EventListenerOrEventListenerObject);
    this.register("error", ((event: Event) => {
      this.emit("error", event);
    }) as EventListenerOrEventListenerObject);
    this.register("discovery-requested", ((event: MessageEvent) => {
      const parsed = this.parseRequested(event.data);
      if (parsed) {
        this.emit("discovery-requested", parsed);
      }
    }) as EventListenerOrEventListenerObject);
    this.register("discovery-cancelled", ((event: MessageEvent) => {
      const parsed = this.parseCancelled(event.data);
      if (parsed) {
        this.emit("discovery-cancelled", parsed);
      }
    }) as EventListenerOrEventListenerObject);
  }

  private register(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    this.source.addEventListener(type, listener);
    this.sourceListeners.push({ type, listener });
  }

  private parseRequested(data: unknown): BridgeDiscoveryRequest | null {
    const parsed = this.parseJSON(data);
    if (
      !parsed ||
      parsed.type !== "discovery-requested" ||
      typeof parsed.discoveryId !== "string" ||
      !parsed.input ||
      typeof parsed.input !== "object" ||
      typeof (parsed.input as Record<string, unknown>).url !== "string"
    ) {
      this.emitMalformed("discovery-requested");
      return null;
    }
    return parsed as unknown as BridgeDiscoveryRequest;
  }

  private parseCancelled(data: unknown): BridgeDiscoveryCancellation | null {
    const parsed = this.parseJSON(data);
    if (!parsed || typeof parsed.discoveryId !== "string") {
      this.emitMalformed("discovery-cancelled");
      return null;
    }
    return { discoveryId: parsed.discoveryId };
  }

  private parseJSON(data: unknown): Record<string, unknown> | null {
    if (typeof data !== "string" || data.length === 0) {
      return null;
    }
    try {
      const parsed = JSON.parse(data);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  private emitMalformed(type: string): void {
    this.emit(
      "error",
      new ErrorEvent("error", {
        message: `Failed to parse Electron bridge event "${type}"`,
      }),
    );
  }
}

function clampTimeout(timeoutMs: number): number {
  return Math.min(35_000, Math.max(1_000, timeoutMs));
}
