import { describe, expect, test } from "vitest";

import type {
  ExtensionMessage,
  ExtensionResponse,
  ExtensionSettings,
} from "../shared/types";
import * as optionsController from "./use-options";

type OptionsTransport = (
  message: ExtensionMessage,
) => Promise<ExtensionResponse>;

type LoadOptionsSettings = (
  transport: OptionsTransport,
) => Promise<ExtensionSettings>;

interface RequestTicket {
  session: number;
  channel?: string;
  revision?: number;
}

interface RequestSessionGate {
  beginSession(): void;
  capture(): RequestTicket;
  startLatest(channel: string): RequestTicket;
  invalidate(channel: string): void;
  canCommit(ticket: RequestTicket): boolean;
  cancel(): void;
}

type CreateRequestSessionGate = () => RequestSessionGate;

function settingsLoader(): LoadOptionsSettings {
  const load = (
    optionsController as typeof optionsController & {
      loadOptionsSettings?: LoadOptionsSettings;
    }
  ).loadOptionsSettings;
  expect(load).toBeTypeOf("function");
  if (!load) throw new Error("Options settings loader is not available");
  return load;
}

function requestGateFactory(): CreateRequestSessionGate {
  const create = (
    optionsController as typeof optionsController & {
      createRequestSessionGate?: CreateRequestSessionGate;
    }
  ).createRequestSessionGate;
  expect(create).toBeTypeOf("function");
  if (!create) throw new Error("Options request session gate is unavailable");
  return create;
}

const settings: ExtensionSettings = {
  mode: "desktop-http",
  serverUrl: "",
  apiKey: "",
  downloadNow: false,
  language: "system",
  pageQuickActionEnabled: true,
};

describe("loadOptionsSettings", () => {
  test("returns settings from the expected background response", async () => {
    const load = settingsLoader();

    await expect(
      load(async () => ({ type: "SETTINGS", settings })),
    ).resolves.toEqual(settings);
  });

  test("rejects an unexpected response instead of treating the page as loaded", async () => {
    const load = settingsLoader();

    await expect(load(async () => ({ type: "OK" }))).rejects.toThrow(
      "Unexpected GET_SETTINGS response",
    );
  });
});

describe("options request session gate", () => {
  test("refresh supersedes an older save session", () => {
    const gate = requestGateFactory()();
    gate.beginSession();
    const save = gate.capture();

    gate.beginSession();

    expect(gate.canCommit(save)).toBe(false);
    expect(gate.canCommit(gate.capture())).toBe(true);
  });

  test("a draft change supersedes an in-flight connection test", () => {
    const gate = requestGateFactory()();
    gate.beginSession();
    const testRequest = gate.startLatest("test");

    gate.invalidate("test");

    expect(gate.canCommit(testRequest)).toBe(false);
  });

  test("cancel prevents commits after lifecycle teardown", () => {
    const gate = requestGateFactory()();
    gate.beginSession();
    const request = gate.capture();

    gate.cancel();

    expect(gate.canCommit(request)).toBe(false);
  });

  test("only the latest request in a channel can commit", () => {
    const gate = requestGateFactory()();
    gate.beginSession();
    const first = gate.startLatest("test");
    const second = gate.startLatest("test");

    expect(gate.canCommit(first)).toBe(false);
    expect(gate.canCommit(second)).toBe(true);
  });
});
