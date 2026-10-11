import { useEffect, useState } from "react";
import { PAGE_LOAD } from "../const";
import {
  canLoadProtectedConfig,
  initializeAdapter,
} from "../services/adapter-bootstrap";
import { useAppStore } from "../store/app";
import { tdApp } from "../utils";
import { useConfigReconciliation } from "./use-config-reconciliation";

export function useAdapterBootstrap() {
  const apiKey = useAppStore((state) => state.apiKey);
  const [adapterReady, setAdapterReady] = useState(false);
  const { applyInitialConfig, beginInitialConfigLoad } =
    useConfigReconciliation();

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let active = true;
    beginInitialConfigLoad();

    const initialize = () => {
      void initializeAdapter().then((config) => {
        if (!active) return;

        if (!config) {
          // No config loaded yet. Only unblock the app when no protected
          // config is expected (e.g. web before sign-in); otherwise keep
          // retrying so protected routes and PAGE_LOAD stay gated until
          // configuration is actually applied.
          if (!canLoadProtectedConfig()) {
            setAdapterReady(true);
          } else {
            retryTimer = setTimeout(initialize, 1000);
          }
          return;
        }

        applyInitialConfig(config);
        setAdapterReady(true);
      });
    };

    initialize();

    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [apiKey]);

  useEffect(() => {
    if (!adapterReady) return;
    tdApp.onEvent(PAGE_LOAD, {
      deviceId: useAppStore.getState().machineId || "",
    });
  }, [adapterReady]);

  return adapterReady;
}
