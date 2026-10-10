import type {
  ExtensionSettings,
  InvocationMode,
  LocalizedMessage,
} from "../shared/types";

export interface ConnectionDraft {
  mode: InvocationMode;
  serverUrl: string;
  apiKey: string;
}

export function applySettingsPatch(
  current: ExtensionSettings,
  patch: Partial<ExtensionSettings>,
): ExtensionSettings {
  return { ...current, ...patch };
}

export function isDownloadNowAvailable(mode: InvocationMode): boolean {
  return mode !== "desktop-schema";
}

export function normalizeConnectionDraft(
  draft: ConnectionDraft,
): Pick<ExtensionSettings, "mode" | "serverUrl" | "apiKey"> {
  if (draft.mode !== "docker-http") {
    return { mode: draft.mode, serverUrl: "", apiKey: "" };
  }
  return {
    mode: draft.mode,
    serverUrl: draft.serverUrl.trim().replace(/\/+$/, ""),
    apiKey: draft.apiKey.trim(),
  };
}

export function validateConnectionDraft(
  draft: ConnectionDraft,
): LocalizedMessage | null {
  if (draft.mode === "docker-http" && !draft.serverUrl.trim()) {
    return { key: "errors.dockerServerRequired" };
  }
  return null;
}

export interface SettingsSaveResult {
  ok: boolean;
  settings: ExtensionSettings;
}

export interface SettingsSaveCoordinator {
  enqueue(patch: Partial<ExtensionSettings>): Promise<SettingsSaveResult>;
  getCurrent(): ExtensionSettings;
}

export function createSettingsSaveCoordinator(
  initial: ExtensionSettings,
  save: (settings: ExtensionSettings) => Promise<boolean>,
): SettingsSaveCoordinator {
  let current = initial;
  let queue = Promise.resolve();

  return {
    enqueue(patch) {
      const operation = queue.then(async () => {
        const next = applySettingsPatch(current, patch);
        let ok = false;
        try {
          ok = await save(next);
        } catch {
          ok = false;
        }
        if (ok) current = next;
        return { ok, settings: current };
      });
      queue = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    getCurrent() {
      return current;
    },
  };
}
