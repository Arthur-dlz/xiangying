import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ExtensionLanguage,
  ExtensionMessage,
  ExtensionResponse,
  ExtensionSettings,
  InvocationMode,
  LocalizedMessage,
  ServerStatus,
} from "../shared/types";
import {
  createSettingsSaveCoordinator,
  normalizeConnectionDraft,
  validateConnectionDraft,
  type ConnectionDraft,
  type SettingsSaveCoordinator,
} from "./settings-model";

export type OptionsTransport = (
  message: ExtensionMessage,
) => Promise<ExtensionResponse>;

const runtimeTransport: OptionsTransport = async (message) =>
  (await chrome.runtime.sendMessage(message)) as ExtensionResponse;

export async function loadOptionsSettings(
  transport: OptionsTransport,
): Promise<ExtensionSettings> {
  const response = await transport({ type: "GET_SETTINGS" });
  if (response.type !== "SETTINGS") {
    throw new Error(`Unexpected GET_SETTINGS response: ${response.type}`);
  }
  return response.settings;
}

export interface RequestTicket {
  session: number;
  channel?: string;
  revision?: number;
}

export interface RequestSessionGate {
  beginSession(): void;
  capture(): RequestTicket;
  startLatest(channel: string): RequestTicket;
  invalidate(channel: string): void;
  canCommit(ticket: RequestTicket): boolean;
  cancel(): void;
}

export function createRequestSessionGate(): RequestSessionGate {
  let active = false;
  let session = 0;
  const revisions = new Map<string, number>();

  return {
    beginSession() {
      active = true;
      session += 1;
      revisions.clear();
    },
    capture() {
      return { session };
    },
    startLatest(channel) {
      const revision = (revisions.get(channel) ?? 0) + 1;
      revisions.set(channel, revision);
      return { session, channel, revision };
    },
    invalidate(channel) {
      revisions.set(channel, (revisions.get(channel) ?? 0) + 1);
    },
    canCommit(ticket) {
      if (!active || ticket.session !== session) return false;
      if (ticket.channel === undefined) return true;
      return revisions.get(ticket.channel) === ticket.revision;
    },
    cancel() {
      active = false;
      session += 1;
      revisions.clear();
    },
  };
}

const EMPTY_DRAFT: ConnectionDraft = {
  mode: "desktop-http",
  serverUrl: "",
  apiKey: "",
};

type SaveOutcome =
  | { ok: true }
  | { ok: false; error: LocalizedMessage | string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useOptions(transport: OptionsTransport = runtimeTransport) {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [draft, setDraft] = useState<ConnectionDraft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [savingConnection, setSavingConnection] = useState(false);
  const [preferenceSaves, setPreferenceSaves] = useState(0);
  const [lastStatus, setLastStatus] = useState<ServerStatus | null>(null);
  const coordinatorRef = useRef<SettingsSaveCoordinator | null>(null);
  const gateRef = useRef<RequestSessionGate | null>(null);
  if (gateRef.current === null) {
    gateRef.current = createRequestSessionGate();
  }
  const gate = gateRef.current;

  const createCoordinator = useCallback(
    (initial: ExtensionSettings) => {
      const sessionTicket = gate.capture();
      return createSettingsSaveCoordinator(initial, async (next) => {
        if (!gate.canCommit(sessionTicket)) return false;
        const response = await transport({
          type: "SAVE_SETTINGS",
          settings: next,
        });
        return gate.canCommit(sessionTicket) && response.type === "OK";
      });
    },
    [gate, transport],
  );

  const refresh = useCallback(async () => {
    gate.beginSession();
    const ticket = gate.capture();
    coordinatorRef.current = null;
    setLoading(true);
    setLoadError(null);
    setTesting(false);
    setSavingConnection(false);
    setPreferenceSaves(0);
    setLastStatus(null);
    try {
      const next = await loadOptionsSettings(transport);
      if (!gate.canCommit(ticket)) return;
      setSettings(next);
      setDraft({
        mode: next.mode,
        serverUrl: next.serverUrl,
        apiKey: next.apiKey,
      });
      coordinatorRef.current = createCoordinator(next);
    } catch (error) {
      if (!gate.canCommit(ticket)) return;
      setSettings(null);
      coordinatorRef.current = null;
      setLoadError(errorMessage(error));
    } finally {
      if (gate.canCommit(ticket)) setLoading(false);
    }
  }, [createCoordinator, gate, transport]);

  useEffect(() => {
    void refresh();
    return () => {
      gate.cancel();
    };
  }, [gate, refresh]);

  const updateDraft = useCallback(
    (patch: Partial<ConnectionDraft>) => {
      gate.invalidate("test");
      setDraft((current) => ({ ...current, ...patch }));
      setTesting(false);
      setLastStatus(null);
    },
    [gate],
  );

  const persistPreference = useCallback(
    async (
      patch: Pick<
        Partial<ExtensionSettings>,
        "downloadNow" | "language" | "pageQuickActionEnabled"
      >,
    ): Promise<boolean> => {
      const coordinator = coordinatorRef.current;
      if (!coordinator) return false;
      const ticket = gate.capture();
      if (!gate.canCommit(ticket)) return false;
      setPreferenceSaves((count) => count + 1);
      try {
        const result = await coordinator.enqueue(patch);
        if (!gate.canCommit(ticket)) return false;
        if (result.ok) setSettings(result.settings);
        return result.ok;
      } finally {
        if (gate.canCommit(ticket)) {
          setPreferenceSaves((count) => Math.max(0, count - 1));
        }
      }
    },
    [gate],
  );

  const changeDownloadNow = useCallback(
    (downloadNow: boolean) => persistPreference({ downloadNow }),
    [persistPreference],
  );

  const changeLanguage = useCallback(
    (language: ExtensionLanguage) => persistPreference({ language }),
    [persistPreference],
  );

  const changePageQuickActionEnabled = useCallback(
    (pageQuickActionEnabled: boolean) =>
      persistPreference({ pageQuickActionEnabled }),
    [persistPreference],
  );

  const test = useCallback(async () => {
    const validation = validateConnectionDraft(draft);
    if (validation) {
      setLastStatus({
        ok: false,
        message: { key: "errors.serverUrlRequired" },
      });
      return;
    }
    const normalized = normalizeConnectionDraft(draft);
    const ticket = gate.startLatest("test");
    setTesting(true);
    try {
      const response = await transport({
        type: "TEST_CONNECTION",
        ...normalized,
      });
      if (!gate.canCommit(ticket)) return;
      setLastStatus(
        response.type === "STATUS"
          ? response.status
          : {
              ok: false,
              message: `Unexpected TEST_CONNECTION response: ${response.type}`,
            },
      );
    } catch (error) {
      if (gate.canCommit(ticket)) {
        setLastStatus({ ok: false, message: errorMessage(error) });
      }
    } finally {
      if (gate.canCommit(ticket)) setTesting(false);
    }
  }, [draft, gate, transport]);

  const saveConnection = useCallback(async (): Promise<SaveOutcome> => {
    const validation = validateConnectionDraft(draft);
    if (validation) return { ok: false, error: validation };
    const coordinator = coordinatorRef.current;
    if (!coordinator) {
      return { ok: false, error: { key: "common.saveFailed" } };
    }
    const ticket = gate.capture();
    if (!gate.canCommit(ticket)) {
      return { ok: false, error: { key: "common.saveFailed" } };
    }
    const normalized = normalizeConnectionDraft(draft);
    setSavingConnection(true);
    try {
      const result = await coordinator.enqueue(normalized);
      if (!gate.canCommit(ticket)) {
        return { ok: false, error: { key: "common.saveFailed" } };
      }
      if (!result.ok) {
        return { ok: false, error: { key: "common.saveFailed" } };
      }
      setSettings(result.settings);
      setDraft(normalized);
      return { ok: true };
    } finally {
      if (gate.canCommit(ticket)) setSavingConnection(false);
    }
  }, [draft, gate]);

  return {
    settings,
    draft,
    loading,
    loadError,
    testing,
    savingConnection,
    savingPreference: preferenceSaves > 0,
    lastStatus,
    refresh,
    setMode: (mode: InvocationMode) => updateDraft({ mode }),
    setServerUrl: (serverUrl: string) => updateDraft({ serverUrl }),
    setApiKey: (apiKey: string) => updateDraft({ apiKey }),
    test,
    saveConnection,
    changeDownloadNow,
    changePageQuickActionEnabled,
    changeLanguage,
  };
}
