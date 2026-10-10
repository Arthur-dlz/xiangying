import { describe, expect, test } from "vitest";

import {
  derivePopupViewState,
  isPopupImportDisabled,
} from "./popup-view-state";

describe("derivePopupViewState", () => {
  test.each([
    ["loading", { loading: true }, "loading"],
    ["load error", { loadError: true }, "load-error"],
    ["missing Docker setup", { needsSetup: true }, "needs-setup"],
    ["connection error", { connectionError: true }, "connection-error"],
    ["no detected sources", { sourceCount: 0 }, "empty"],
    ["detected sources", { sourceCount: 1 }, "ready"],
  ] as const)("returns %s", (_label, partialInput, expected) => {
    expect(
      derivePopupViewState({
        loading: false,
        loadError: false,
        needsSetup: false,
        connectionError: false,
        sourceCount: 1,
        ...partialInput,
      }),
    ).toBe(expected);
  });

  test("applies the documented state priority", () => {
    expect(
      derivePopupViewState({
        loading: true,
        loadError: true,
        needsSetup: true,
        connectionError: true,
        sourceCount: 0,
      }),
    ).toBe("load-error");

    expect(
      derivePopupViewState({
        loading: true,
        loadError: false,
        needsSetup: true,
        connectionError: true,
        sourceCount: 0,
      }),
    ).toBe("loading");

    expect(
      derivePopupViewState({
        loading: false,
        loadError: false,
        needsSetup: true,
        connectionError: true,
        sourceCount: 0,
      }),
    ).toBe("needs-setup");

    expect(
      derivePopupViewState({
        loading: false,
        loadError: false,
        needsSetup: false,
        connectionError: true,
        sourceCount: 0,
      }),
    ).toBe("connection-error");
  });
});

describe("isPopupImportDisabled", () => {
  const readyInput = {
    importing: false,
    inspecting: false,
    viewState: "ready" as const,
    sourceCount: 1,
  };

  test.each([
    ["an import is already running", { importing: true }],
    ["a source is being inspected", { inspecting: true }],
    ["the popup is loading", { viewState: "loading" as const }],
    ["there are no sources", { sourceCount: 0 }],
  ])("disables imports when %s", (_reason, input) => {
    expect(isPopupImportDisabled({ ...readyInput, ...input })).toBe(true);
  });

  test("enables imports for ready sources", () => {
    expect(isPopupImportDisabled(readyInput)).toBe(false);
  });
});
