import type { UpdateState } from "@mediago/common";
import { useEffect } from "react";
import { useBrowserStore } from "../store/browser";
import { useSessionStore } from "../store/session";
import { usePlatform } from "./use-platform";

export function useDesktopEvents() {
  const { browser, on, off, update } = usePlatform();
  const setUpdateState = useSessionStore((state) => state.setUpdateState);
  const hydrateSnapshot = useBrowserStore((state) => state.hydrateSnapshot);

  useEffect(() => {
    const onPrivacyChanged = () => {
      void browser
        .getTabs()
        .then(hydrateSnapshot)
        .catch(() => undefined);
    };
    const onUpdateStateChanged = (...args: unknown[]) => {
      const nextState = args[1] as UpdateState | undefined;
      if (nextState) setUpdateState(nextState);
    };

    on("browser:privacyChanged", onPrivacyChanged);
    on("update:stateChanged", onUpdateStateChanged);
    if (update?.getState) {
      void update
        .getState()
        .then(setUpdateState)
        .catch(() => undefined);
    }

    return () => {
      off("browser:privacyChanged", onPrivacyChanged);
      off("update:stateChanged", onUpdateStateChanged);
    };
  }, [browser, hydrateSnapshot, off, on, setUpdateState, update]);
}
