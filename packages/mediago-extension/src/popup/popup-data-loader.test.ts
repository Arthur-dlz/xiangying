import { describe, expect, test } from "vitest";

import type { ExtensionSettings, ServerStatus } from "@/shared/types";

import {
  createPopupRequestGate,
  loadPopupData,
  normalizePopupLoadError,
  parsePopupSettingsResponse,
  parsePopupSourcesResponse,
  parsePopupStatusResponse,
  resolveClearSources,
  resolveSnapshotSources,
  type PopupDataLoaderDependencies,
} from "./popup-data-loader";

const tab = {
  id: 12,
  title: "Example",
  url: "https://example.test",
} as chrome.tabs.Tab;
const settings: ExtensionSettings = {
  mode: "desktop-http",
  serverUrl: "",
  apiKey: "",
  downloadNow: false,
  language: "en",
  pageQuickActionEnabled: true,
};
const status: ServerStatus = { ok: true, message: "Connected" };

function createDependencies(
  overrides: Partial<PopupDataLoaderDependencies> = {},
): PopupDataLoaderDependencies {
  return {
    getActiveTab: async () => tab,
    getSources: async () => [],
    getSettings: async () => settings,
    getServerStatus: async () => status,
    ...overrides,
  };
}

describe("loadPopupData", () => {
  test("returns a complete snapshot after every load stage succeeds", async () => {
    const result = await loadPopupData(createDependencies());

    expect(result).toEqual({
      tab,
      sources: [],
      settings,
      serverStatus: status,
    });
  });

  test("reads sources after settings and the connection probe", async () => {
    const calls: string[] = [];

    await loadPopupData(
      createDependencies({
        getActiveTab: async () => {
          calls.push("active-tab");
          return tab;
        },
        getSettings: async () => {
          calls.push("settings");
          return settings;
        },
        getServerStatus: async () => {
          calls.push("status");
          return status;
        },
        getSources: async () => {
          calls.push("sources");
          return [];
        },
      }),
    );

    expect(calls).toEqual(["active-tab", "settings", "status", "sources"]);
  });

  test.each([
    [
      "active tab lookup",
      {
        getActiveTab: async () => {
          throw new Error("tab failed");
        },
      },
      "tab failed",
    ],
    [
      "source lookup",
      {
        getSources: async () => {
          throw new Error("sources failed");
        },
      },
      "sources failed",
    ],
    [
      "settings lookup",
      {
        getSettings: async () => {
          throw new Error("settings failed");
        },
      },
      "settings failed",
    ],
    [
      "connection probe",
      {
        getServerStatus: async () => {
          throw new Error("status failed");
        },
      },
      "status failed",
    ],
  ] as const)("propagates a rejected %s", async (_stage, override, message) => {
    await expect(loadPopupData(createDependencies(override))).rejects.toThrow(
      message,
    );
  });

  test("does not probe a schema-mode connection", async () => {
    let probeCalls = 0;

    const result = await loadPopupData(
      createDependencies({
        getSettings: async () => ({ ...settings, mode: "desktop-schema" }),
        getServerStatus: async () => {
          probeCalls += 1;
          return status;
        },
      }),
    );

    expect(probeCalls).toBe(0);
    expect(result.serverStatus).toEqual({
      ok: true,
      message: { key: "status.schemaMode" },
    });
  });
});

describe("createPopupRequestGate", () => {
  test("only permits the most recent request to commit", () => {
    const gate = createPopupRequestGate();
    const first = gate.begin();
    const second = gate.begin();

    expect(gate.canCommit(first)).toBe(false);
    expect(gate.canCommit(second)).toBe(true);
  });

  test("rejects commits after cancellation", () => {
    const gate = createPopupRequestGate();
    const request = gate.begin();

    gate.cancel();

    expect(gate.canCommit(request)).toBe(false);
  });

  test("permits only a new request after a cancelled lifecycle restarts", () => {
    const gate = createPopupRequestGate();
    const previousRequest = gate.begin();

    gate.cancel();
    const nextRequest = gate.begin();

    expect(gate.canCommit(previousRequest)).toBe(false);
    expect(gate.canCommit(nextRequest)).toBe(true);
  });
});

describe("popup response parsing", () => {
  const importError = { key: "errors.serverNotConfigured" };

  test.each([
    [
      "sources",
      () =>
        parsePopupSourcesResponse({
          type: "IMPORT_RESULT",
          ok: false,
          count: 0,
          error: importError,
        }),
    ],
    [
      "settings",
      () =>
        parsePopupSettingsResponse({
          type: "IMPORT_RESULT",
          ok: false,
          count: 0,
          error: importError,
        }),
    ],
    [
      "status",
      () =>
        parsePopupStatusResponse({
          type: "IMPORT_RESULT",
          ok: false,
          count: 0,
          error: importError,
        }),
    ],
  ])("preserves an error in an unexpected %s response", (_kind, parse) => {
    let caught: unknown;
    try {
      parse();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(importError);
  });

  test.each([
    ["sources", () => parsePopupSourcesResponse({ type: "OK" })],
    ["settings", () => parsePopupSettingsResponse({ type: "OK" })],
    ["status", () => parsePopupStatusResponse({ type: "OK" })],
  ])(
    "throws for an unexpected %s response without an error",
    (_kind, parse) => {
      expect(parse).toThrow();
    },
  );
});

describe("resolveSnapshotSources", () => {
  const snapshotSources = [];
  const eventSources = ["event"] as unknown as typeof snapshotSources;
  const otherTabSources = ["other-tab"] as unknown as typeof snapshotSources;

  test("uses a same-tab storage event that arrived after refresh began", () => {
    const sourceEvents = new Map([
      ["mediago.tab.12", { sequence: 5, sources: eventSources }],
    ]);

    expect(
      resolveSnapshotSources({
        snapshotSources,
        snapshotKey: "mediago.tab.12",
        startSequence: 4,
        sourceEvents,
      }),
    ).toBe(eventSources);
  });

  test("does not let another tab's storage event replace the snapshot", () => {
    const sourceEvents = new Map([
      ["mediago.tab.99", { sequence: 5, sources: otherTabSources }],
    ]);

    expect(
      resolveSnapshotSources({
        snapshotSources,
        snapshotKey: "mediago.tab.12",
        startSequence: 4,
        sourceEvents,
      }),
    ).toBe(snapshotSources);
  });

  test("keeps the final snapshot when the cached event predates refresh", () => {
    const sourceEvents = new Map([
      ["mediago.tab.12", { sequence: 4, sources: eventSources }],
    ]);

    expect(
      resolveSnapshotSources({
        snapshotSources,
        snapshotKey: "mediago.tab.12",
        startSequence: 4,
        sourceEvents,
      }),
    ).toBe(snapshotSources);
  });

  test("keeps a post-refresh clear instead of writing back old sources", () => {
    const sourceEvents = new Map([
      ["mediago.tab.12", { sequence: 5, sources: [] }],
    ]);

    expect(
      resolveSnapshotSources({
        snapshotSources: eventSources,
        snapshotKey: "mediago.tab.12",
        startSequence: 4,
        sourceEvents,
      }),
    ).toEqual([]);
  });
});

describe("resolveClearSources", () => {
  const key = "mediago.tab.12";
  const newSources = ["new"] as unknown as never[];

  test("synthesizes an empty event when no same-tab event arrived", () => {
    expect(
      resolveClearSources({
        key,
        clearStartSequence: 4,
        sourceEvents: new Map(),
      }),
    ).toEqual({ sources: [], shouldSynthesizeEmptyEvent: true });
  });

  test("respects a same-tab empty event that arrived during clear", () => {
    expect(
      resolveClearSources({
        key,
        clearStartSequence: 4,
        sourceEvents: new Map([[key, { sequence: 5, sources: [] }]]),
      }),
    ).toEqual({ sources: [], shouldSynthesizeEmptyEvent: false });
  });

  test("keeps new same-tab sources that arrived during clear", () => {
    expect(
      resolveClearSources({
        key,
        clearStartSequence: 4,
        sourceEvents: new Map([[key, { sequence: 5, sources: newSources }]]),
      }),
    ).toEqual({
      sources: newSources,
      shouldSynthesizeEmptyEvent: false,
    });
  });

  test("ignores another tab's event when clearing the active tab", () => {
    expect(
      resolveClearSources({
        key,
        clearStartSequence: 4,
        sourceEvents: new Map([
          ["mediago.tab.99", { sequence: 5, sources: newSources }],
        ]),
      }),
    ).toEqual({ sources: [], shouldSynthesizeEmptyEvent: true });
  });
});

describe("popup load errors", () => {
  test("preserves string rejections", () => {
    expect(normalizePopupLoadError("Network unavailable")).toBe(
      "Network unavailable",
    );
  });

  test("turns unknown rejections into a localizable error", () => {
    expect(normalizePopupLoadError({ reason: "offline" })).toEqual({
      key: "errors.unknown",
      values: { detail: '{"reason":"offline"}' },
    });
  });

  test("preserves a LocalizedMessage thrown by a response parser", () => {
    const error = { key: "errors.serverNotConfigured" };
    let caught: unknown;

    try {
      parsePopupSettingsResponse({
        type: "IMPORT_RESULT",
        ok: false,
        count: 0,
        error,
      });
    } catch (responseError) {
      caught = responseError;
    }

    expect(normalizePopupLoadError(caught)).toBe(error);
  });
});
