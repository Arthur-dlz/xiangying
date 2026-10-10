export interface PendingConfigValue<T> {
  pending: boolean;
  value?: T;
}

export interface RemoteConfigValue<T> {
  version: number;
  value?: T;
}

interface Deferred<T extends object> {
  key: keyof T;
  resolve: (value: T[keyof T]) => void;
  reject: (error: unknown) => void;
}

export interface ConfigWriteCoordinator<T extends object> {
  enqueue<K extends keyof T>(key: K, value: T[K]): Promise<T[K]>;
  flush(): Promise<void>;
  getPending<K extends keyof T>(key: K): PendingConfigValue<T[K]>;
  matchesPendingValue<K extends keyof T>(key: K, value: T[K]): boolean;
  acknowledgeInFlightValue<K extends keyof T>(key: K, value: T[K]): boolean;
  recordRemoteValue<K extends keyof T>(key: K, value: T[K]): void;
  getRemoteValue<K extends keyof T>(key: K): RemoteConfigValue<T[K]>;
}

export function shouldApplyPersistedValue<T>(
  versionAtWrite: number,
  latestRemote: RemoteConfigValue<T>,
  persistedValue: T,
): boolean {
  return (
    latestRemote.version === versionAtWrite ||
    Object.is(latestRemote.value, persistedValue)
  );
}

export function createConfigWriteCoordinator<T extends object>(
  write: (values: Partial<T>) => Promise<void>,
  flushDelayMs = 16,
): ConfigWriteCoordinator<T> {
  let queuedValues = new Map<keyof T, T[keyof T]>();
  let queuedWaiters: Deferred<T>[] = [];
  let inFlightValues: Map<keyof T, T[keyof T]> | null = null;
  let inFlightPromise: Promise<void> | null = null;
  let acknowledgedInFlight = new Set<keyof T>();
  const remoteValues = new Map<keyof T, RemoteConfigValue<T[keyof T]>>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const getPending = <K extends keyof T>(key: K): PendingConfigValue<T[K]> => {
    if (queuedValues.has(key)) {
      return { pending: true, value: queuedValues.get(key) as T[K] };
    }
    if (inFlightValues?.has(key)) {
      return { pending: true, value: inFlightValues.get(key) as T[K] };
    }
    return { pending: false };
  };

  const matchesPendingValue = <K extends keyof T>(key: K, value: T[K]) => {
    const matchesQueued =
      queuedValues.has(key) && Object.is(queuedValues.get(key), value);
    const matchesInFlight =
      Boolean(inFlightValues?.has(key)) &&
      Object.is(inFlightValues?.get(key), value);

    return matchesQueued || matchesInFlight;
  };

  const acknowledgeInFlightValue = <K extends keyof T>(key: K, value: T[K]) => {
    if (!inFlightValues?.has(key)) return false;
    if (!Object.is(inFlightValues.get(key), value)) return false;
    acknowledgedInFlight.add(key);
    return true;
  };

  const recordRemoteValue = <K extends keyof T>(key: K, value: T[K]) => {
    const previousVersion = remoteValues.get(key)?.version ?? 0;
    remoteValues.set(key, { version: previousVersion + 1, value });
    acknowledgeInFlightValue(key, value);
  };

  const getRemoteValue = <K extends keyof T>(
    key: K,
  ): RemoteConfigValue<T[K]> => {
    return (
      (remoteValues.get(key) as RemoteConfigValue<T[K]> | undefined) ?? {
        version: 0,
      }
    );
  };

  const drain = (): Promise<void> => {
    if (inFlightPromise) return inFlightPromise;
    if (queuedValues.size === 0) return Promise.resolve();

    const values = queuedValues;
    const waiters = queuedWaiters;
    queuedValues = new Map();
    queuedWaiters = [];
    inFlightValues = values;
    acknowledgedInFlight = new Set();

    const payload = Object.fromEntries(values) as Partial<T>;
    const finishBatch = () => {
      inFlightValues = null;
      inFlightPromise = null;
      acknowledgedInFlight = new Set();
      if (queuedValues.size > 0) scheduleFlush(0);
    };

    inFlightPromise = Promise.resolve()
      .then(() => write(payload))
      .then(() => {
        // Clear pending before resolving callers. Their continuations can
        // synchronously update Zustand, and subscribers must see this batch
        // as settled so remounted forms reconcile the confirmed value.
        finishBatch();
        waiters.forEach(({ key, resolve }) => {
          resolve(values.get(key) as T[keyof T]);
        });
      })
      .catch((error: unknown) => {
        const acknowledged = acknowledgedInFlight;
        finishBatch();

        let hasUnacknowledgedValue = false;
        waiters.forEach(({ key, resolve, reject }) => {
          if (acknowledged.has(key)) {
            resolve(values.get(key) as T[keyof T]);
          } else {
            hasUnacknowledgedValue = true;
            reject(error);
          }
        });

        if (hasUnacknowledgedValue) throw error;
      });

    return inFlightPromise;
  };

  const scheduleFlush = (delay = flushDelayMs) => {
    if (flushTimer || inFlightPromise) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void drain().catch(() => undefined);
    }, delay);
  };

  return {
    enqueue(key, value) {
      queuedValues.set(key, value);
      const promise = new Promise<T[typeof key]>((resolve, reject) => {
        queuedWaiters.push({
          key,
          resolve: resolve as (writtenValue: T[keyof T]) => void,
          reject,
        });
      });
      scheduleFlush();
      return promise;
    },

    async flush() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }

      let firstError: unknown;
      const drainRemaining = async (): Promise<void> => {
        const currentWrite =
          inFlightPromise ?? (queuedValues.size > 0 ? drain() : null);
        if (!currentWrite) return;

        try {
          await currentWrite;
        } catch (error: unknown) {
          firstError ??= error;
        }

        await drainRemaining();
      };

      await drainRemaining();
      if (firstError) throw firstError;
    },

    getPending,

    matchesPendingValue,

    acknowledgeInFlightValue,

    recordRemoteValue,

    getRemoteValue,
  };
}
