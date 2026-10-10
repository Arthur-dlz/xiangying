import type { AppStore } from "@mediago/common";
import { useMemoizedFn } from "ahooks";
import { useEffect, useRef } from "react";
import { getConfig } from "../api/config";
import { onConfigChanged } from "../api/events";
import { canLoadProtectedConfig } from "../services/adapter-bootstrap";
import {
  type ConfigChange,
  mergeDeferredConfigChanges,
} from "../services/config-change-order";
import { settingConfigWriter } from "../services/setting-config-writer";
import { useAppStore } from "../store/app";

function isAppStoreKey(key: string): key is keyof AppStore {
  return key !== "setAppStore" && key in useAppStore.getState();
}

export function useConfigReconciliation() {
  const setAppStore = useAppStore((state) => state.setAppStore);
  const initialConfigReady = useRef(false);
  const bufferedConfigChanges = useRef<ConfigChange[]>([]);
  const configChangesToReconcile = useRef<ConfigChange[]>([]);
  const configReconcileNeeded = useRef(false);
  const configReconcilePromise = useRef<Promise<void> | null>(null);
  const configReconcileRetry = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const applyConfigChange = useMemoizedFn((data: ConfigChange) => {
    if (!isAppStoreKey(data.key)) return true;
    const key = data.key;
    const value = data.value as AppStore[typeof key];
    const pending = settingConfigWriter.getPending(key);
    if (pending.pending) {
      settingConfigWriter.acknowledgeInFlightValue(key, value);
      if (settingConfigWriter.matchesPendingValue(key, value)) return true;
      configReconcileNeeded.current = true;
      return false;
    }

    setAppStore({ [key]: value } as Partial<AppStore>);
    return true;
  });

  const scheduleConfigReconcile = useMemoizedFn(() => {
    if (!canLoadProtectedConfig()) return;
    if (configReconcilePromise.current) return;
    if (configReconcileRetry.current) {
      clearTimeout(configReconcileRetry.current);
      configReconcileRetry.current = null;
    }

    const applyReconcileChanges = (changes: ConfigChange[]) => {
      const deferred: ConfigChange[] = [];
      changes.forEach((change) => {
        if (!applyConfigChange(change)) deferred.push(change);
      });
      return deferred;
    };

    const reconcile = async () => {
      if (
        !configReconcileNeeded.current &&
        configChangesToReconcile.current.length === 0
      ) {
        return;
      }

      configReconcileNeeded.current = false;
      await settingConfigWriter.flush();
      if (!canLoadProtectedConfig()) {
        configReconcileNeeded.current = true;
        return;
      }

      const changesBeforeGet = configChangesToReconcile.current.splice(0);
      configChangesToReconcile.current.push(
        ...applyReconcileChanges(changesBeforeGet),
      );
      if (configChangesToReconcile.current.length > 0) {
        await reconcile();
        return;
      }

      const config = await getConfig({
        suppressAuthRedirect: true,
        timeoutMs: 5000,
      });
      // Events received while GET was in flight happened after its snapshot.
      const eventsAfterSnapshot = configChangesToReconcile.current.splice(0);
      const deferredSnapshot: ConfigChange[] = [];
      Object.entries(config).forEach(([key, value]) => {
        const change = { key, value };
        if (!applyConfigChange(change)) deferredSnapshot.push(change);
      });

      configChangesToReconcile.current.push(
        ...mergeDeferredConfigChanges(
          deferredSnapshot,
          eventsAfterSnapshot,
          applyConfigChange,
        ),
      );
      await reconcile();
    };

    configReconcilePromise.current = reconcile()
      .catch((error: unknown) => {
        configReconcileNeeded.current = true;
        // eslint-disable-next-line no-console
        console.warn("Config reconciliation failed:", error);
      })
      .finally(() => {
        configReconcilePromise.current = null;
        if (
          !configReconcileNeeded.current ||
          configReconcileRetry.current ||
          !canLoadProtectedConfig()
        ) {
          return;
        }
        configReconcileRetry.current = setTimeout(() => {
          configReconcileRetry.current = null;
          scheduleConfigReconcile();
        }, 1000);
      });
  });

  const handleConfigChanged = useMemoizedFn((data: ConfigChange) => {
    if (!data) return;
    if (isAppStoreKey(data.key)) {
      settingConfigWriter.recordRemoteValue(
        data.key,
        data.value as AppStore[typeof data.key],
      );
    }
    if (!initialConfigReady.current) {
      // An apiKey event proves the server committed the key, so use it for the
      // next authenticated retry even if the HTTP response was lost.
      if (data.key === "apiKey" && typeof data.value === "string") {
        setAppStore({ apiKey: data.value });
      } else {
        applyConfigChange(data);
      }
      bufferedConfigChanges.current.push(data);
      return;
    }
    if (configReconcilePromise.current) {
      configChangesToReconcile.current.push(data);
      configReconcileNeeded.current = true;
      return;
    }
    if (!applyConfigChange(data)) {
      configChangesToReconcile.current.push(data);
      scheduleConfigReconcile();
    }
  });

  const beginInitialConfigLoad = useMemoizedFn(() => {
    initialConfigReady.current = false;
  });

  const applyInitialConfig = useMemoizedFn((config: AppStore) => {
    const bufferedChanges = bufferedConfigChanges.current.splice(0);
    const deferredSnapshot: ConfigChange[] = [];
    const initialValues: Partial<AppStore> = {};

    Object.entries(config).forEach(([key, value]) => {
      if (!isAppStoreKey(key)) return;
      const typedValue = value as AppStore[typeof key];
      const pending = settingConfigWriter.getPending(key);
      if (pending.pending) {
        settingConfigWriter.acknowledgeInFlightValue(key, typedValue);
        if (!settingConfigWriter.matchesPendingValue(key, typedValue)) {
          configReconcileNeeded.current = true;
          deferredSnapshot.push({ key, value });
        }
        return;
      }
      Object.assign(initialValues, { [key]: typedValue });
    });

    setAppStore(initialValues);
    configChangesToReconcile.current.push(
      ...mergeDeferredConfigChanges(
        deferredSnapshot,
        bufferedChanges,
        applyConfigChange,
      ),
    );
    initialConfigReady.current = true;
    if (configReconcileNeeded.current) scheduleConfigReconcile();
  });

  useEffect(() => {
    const unsubscribe = onConfigChanged((...args: unknown[]) => {
      handleConfigChanged(args[1] as ConfigChange);
    });
    return unsubscribe;
  }, []);

  useEffect(
    () => () => {
      if (configReconcileRetry.current) {
        clearTimeout(configReconcileRetry.current);
      }
    },
    [],
  );

  return { applyInitialConfig, beginInitialConfigLoad };
}
