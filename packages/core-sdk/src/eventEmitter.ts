import {
  EventSource,
  ErrorEvent,
  type EventListenerOrEventListenerObject,
} from "eventsource";
import mitt, { type Emitter, type Handler as MittHandler } from "mitt";
import type {
  ConfigChangedPayload,
  TaskEventEmitter,
  TaskEventMap,
  TaskEventPayload,
  TaskFailedEventPayload,
} from "./types";

type TaskEventName = keyof TaskEventMap;
type InternalEventMap = TaskEventMap & {
  [key: string]: unknown;
  [key: number]: unknown;
  [key: symbol]: unknown;
};
type HandlerStore = Map<Function, Set<MittHandler<unknown>>>;

interface MessageEventLike {
  readonly data?: unknown;
  readonly type: string;
}

/**
 * Wraps an EventSource connection and re-emits typed task events.
 */
export class TaskStreamEventEmitter implements TaskEventEmitter {
  private readonly listeners: Array<{
    type: string;
    listener: EventListenerOrEventListenerObject;
  }> = [];
  private readonly emitter: Emitter<InternalEventMap>;
  private readonly handlerMap = new Map<TaskEventName, HandlerStore>();

  constructor(private readonly source: EventSource) {
    this.emitter = mitt<InternalEventMap>();
    this.attachSourceListeners();
  }

  on<TEventName extends TaskEventName>(
    eventName: TEventName,
    listener: (payload: TaskEventMap[TEventName]) => void,
  ): this {
    const handler: MittHandler<InternalEventMap[TEventName]> = (payload) =>
      listener(payload);
    this.trackHandler(eventName, listener, handler);
    this.emitter.on(eventName, handler);
    return this;
  }

  off<TEventName extends TaskEventName>(
    eventName: TEventName,
    listener: (payload: TaskEventMap[TEventName]) => void,
  ): this {
    const handlers = this.untrackHandler(eventName, listener) as Array<
      MittHandler<InternalEventMap[TEventName]>
    >;
    for (const handler of handlers) {
      this.emitter.off(eventName, handler);
    }
    return this;
  }

  once<TEventName extends TaskEventName>(
    eventName: TEventName,
    listener: (payload: TaskEventMap[TEventName]) => void,
  ): this {
    const wrapped: MittHandler<InternalEventMap[TEventName]> = (payload) => {
      // Detach only this wrapped handler, so a separate `on(eventName, listener)`
      // registration for the same listener is not removed by mistake.
      this.untrackHandlerInstance(eventName, listener, wrapped);
      this.emitter.off(eventName, wrapped);
      listener(payload);
    };
    this.trackHandler(eventName, listener, wrapped);
    this.emitter.on(eventName, wrapped);
    return this;
  }

  emit<TEventName extends TaskEventName>(
    eventName: TEventName,
    payload: TaskEventMap[TEventName],
  ): boolean {
    this.emitter.emit(eventName, payload as InternalEventMap[TEventName]);
    return true;
  }

  removeAllListeners<TEventName extends TaskEventName>(
    eventName?: TEventName,
  ): this {
    if (eventName) {
      const handlers = this.handlerMap.get(eventName);
      if (!handlers) {
        return this;
      }
      for (const registered of handlers.values()) {
        for (const handler of registered) {
          this.emitter.off(eventName, handler as MittHandler<any>);
        }
      }
      handlers.clear();
      this.handlerMap.delete(eventName);
      return this;
    }

    for (const [evtName, handlers] of this.handlerMap.entries()) {
      for (const registered of handlers.values()) {
        for (const handler of registered) {
          this.emitter.off(evtName, handler as MittHandler<any>);
        }
      }
      handlers.clear();
    }
    this.handlerMap.clear();
    return this;
  }

  close(): void {
    for (const { type, listener } of this.listeners) {
      this.source.removeEventListener(type, listener);
    }
    this.listeners.length = 0;
    this.source.close();
    this.removeAllListeners();
  }

  private attachSourceListeners(): void {
    this.registerListener("open", ((event: Event) => {
      this.emit("open", event);
    }) as EventListenerOrEventListenerObject);

    this.registerListener("error", ((event: ErrorEvent) => {
      this.emit("error", event);
    }) as EventListenerOrEventListenerObject);

    const taskEvents: Array<
      Extract<
        TaskEventName,
        "download-start" | "download-success" | "download-stop"
      >
    > = ["download-start", "download-success", "download-stop"];

    for (const eventName of taskEvents) {
      this.registerListener(eventName, ((event: MessageEventLike) => {
        const payload = this.safeParse<TaskEventPayload>(event);
        if (payload) {
          this.emit(eventName, payload);
        }
      }) as EventListenerOrEventListenerObject);
    }

    this.registerListener("download-failed", ((event: MessageEventLike) => {
      const payload = this.safeParse<TaskFailedEventPayload>(event);
      if (payload) {
        this.emit("download-failed", payload);
      }
    }) as EventListenerOrEventListenerObject);

    this.registerListener("config-changed", ((event: MessageEventLike) => {
      const payload = this.safeParse<ConfigChangedPayload>(event);
      if (payload) {
        this.emit("config-changed", payload);
      }
    }) as EventListenerOrEventListenerObject);
  }

  private registerListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    this.source.addEventListener(type, listener);
    this.listeners.push({ type, listener });
  }

  private safeParse<T>(event: MessageEventLike): T | null {
    if (typeof event.data !== "string" || event.data.length === 0) {
      return null;
    }

    try {
      return JSON.parse(event.data) as T;
    } catch {
      const errorEvent = new ErrorEvent("error", {
        message: `Failed to parse SSE payload for "${event.type}"`,
      });
      this.emit("error", errorEvent);
      return null;
    }
  }

  private trackHandler<TEventName extends TaskEventName>(
    eventName: TEventName,
    listener: (payload: TaskEventMap[TEventName]) => void,
    handler: MittHandler<InternalEventMap[TEventName]>,
  ): void {
    let store = this.handlerMap.get(eventName);
    if (!store) {
      store = new Map();
      this.handlerMap.set(eventName, store);
    }
    const key = listener as unknown as Function;
    let registered = store.get(key);
    if (!registered) {
      registered = new Set();
      store.set(key, registered);
    }
    registered.add(handler as MittHandler<unknown>);
  }

  /**
   * Detach every handler registered for `listener` (a listener may be
   * registered more than once via `on`/`once`) and return them so the caller
   * can unsubscribe each one from the underlying emitter.
   */
  private untrackHandler<TEventName extends TaskEventName>(
    eventName: TEventName,
    listener: (payload: TaskEventMap[TEventName]) => void,
  ): MittHandler<unknown>[] {
    const store = this.handlerMap.get(eventName);
    if (!store) {
      return [];
    }
    const key = listener as unknown as Function;
    const registered = store.get(key);
    if (!registered) {
      return [];
    }
    store.delete(key);
    if (store.size === 0) {
      this.handlerMap.delete(eventName);
    }
    return [...registered];
  }

  /**
   * Detach a single handler (used by `once` so it removes only its own wrapper
   * without touching other registrations for the same listener).
   */
  private untrackHandlerInstance<TEventName extends TaskEventName>(
    eventName: TEventName,
    listener: (payload: TaskEventMap[TEventName]) => void,
    handler: MittHandler<InternalEventMap[TEventName]>,
  ): void {
    const store = this.handlerMap.get(eventName);
    if (!store) {
      return;
    }
    const key = listener as unknown as Function;
    const registered = store.get(key);
    if (!registered) {
      return;
    }
    registered.delete(handler as MittHandler<unknown>);
    if (registered.size === 0) {
      store.delete(key);
      if (store.size === 0) {
        this.handlerMap.delete(eventName);
      }
    }
  }
}
