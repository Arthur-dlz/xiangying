/** @vitest-environment happy-dom */

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => {
  const listeners = new Set<
    (state: Record<string, unknown>, previous?: Record<string, unknown>) => void
  >();
  const state: Record<string, unknown> = {
    local: "",
    theme: "system",
    language: "zh",
    promptTone: true,
    showTerminal: false,
    autoUpgrade: false,
    allowBeta: false,
    closeMainWindow: false,
    enableMobilePlayer: false,
    audioMuted: true,
    openInNewWindow: false,
    proxy: "",
    useProxy: false,
    blockAds: true,
    isMobile: false,
    useExtension: false,
    privacy: false,
    downloadProxySwitch: false,
    deleteSegments: true,
    maxRunner: 2,
    apiKey: "",
    dockerUrl: "",
    enableDocker: false,
    enableMcp: false,
    mcpToken: "",
  };
  const setAppStore = vi.fn((values: Record<string, unknown>) => {
    const previous = { ...state };
    Object.assign(state, values);
    listeners.forEach((listener) => listener(state, previous));
  });
  state.setAppStore = setAppStore;
  const useAppStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    {
      getState: () => ({ ...state, setAppStore }),
      subscribe: (
        listener: (value: typeof state, previous?: typeof state) => void,
      ) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  );
  return {
    listeners,
    state,
    setAppStore,
    useAppStore,
    writes: vi.fn(async (_values: Record<string, unknown>) => undefined),
    t: (key: string) => key,
  };
});

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: mocks.t }),
}));
vi.mock("@/api/config", () => ({ setConfigValues: mocks.writes }));
vi.mock("@/store/app", () => ({ useAppStore: mocks.useAppStore }));

const { SettingsFormProvider, SettingNumberField, SettingSwitchField } =
  await import("./setting-fields");

let root: Root | undefined;
let container: HTMLDivElement;

async function renderField(field: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(SettingsFormProvider, null, field));
  });
}

async function settleWrites() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 35));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  Object.assign(mocks.state, {
    promptTone: true,
    proxy: "",
    useProxy: false,
    maxRunner: 2,
  });
  mocks.listeners.clear();
  mocks.writes.mockReset().mockResolvedValue(undefined);
  mocks.setAppStore.mockClear();
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  container?.remove();
});

test("persists a preference switch through the shared config writer", async () => {
  await renderField(
    createElement(SettingSwitchField, {
      name: "promptTone",
      label: "downloadPrompt",
    }),
  );

  const toggle = container.querySelector<HTMLButtonElement>(
    '[role="switch"][id="setting-promptTone"]',
  );
  expect(toggle).not.toBeNull();
  await act(async () => toggle?.click());
  await settleWrites();

  expect(mocks.writes).toHaveBeenCalledWith({ promptTone: false });
  expect(mocks.state.promptTone).toBe(false);
});

test("persists the remaining basic, player, browser, and download preference switches", async () => {
  for (const [name, label, initialValue] of [
    ["promptTone", "downloadPrompt", true],
    ["showTerminal", "showTerminal", false],
    ["enableMobilePlayer", "enableMobilePlayer", false],
    ["audioMuted", "audioMuted", true],
    ["openInNewWindow", "openInNewWindow", false],
    ["blockAds", "blockAds", true],
    ["isMobile", "defaultMobileMode", false],
    ["useExtension", "useImmersiveSniffing", false],
    ["privacy", "privacy", false],
    ["downloadProxySwitch", "downloadProxySwitch", false],
    ["deleteSegments", "deleteSegments", true],
  ] as const) {
    Object.assign(mocks.state, { [name]: initialValue });
    await renderField(createElement(SettingSwitchField, { name, label }));

    const toggle = container.querySelector<HTMLButtonElement>(
      `[role="switch"][id="setting-${name}"]`,
    );
    expect(toggle).not.toBeNull();
    await act(async () => toggle?.click());
    await settleWrites();

    expect(mocks.writes).toHaveBeenLastCalledWith({ [name]: !initialValue });
    expect(mocks.state[name]).toBe(!initialValue);
    await act(async () => root?.unmount());
    root = undefined;
    container.remove();
  }
});

test("rejects enabling the browser proxy while the proxy field is empty", async () => {
  await renderField(
    createElement(SettingSwitchField, {
      name: "useProxy",
      label: "proxySwitch",
      validate: (checked, getValues) =>
        checked && getValues("proxy") === ""
          ? "pleaseEnterProxyFirst"
          : undefined,
    }),
  );

  const toggle = container.querySelector<HTMLButtonElement>(
    '[role="switch"][id="setting-useProxy"]',
  );
  await act(async () => toggle?.click());
  await settleWrites();

  expect(container.textContent).toContain("pleaseEnterProxyFirst");
  expect(mocks.writes).not.toHaveBeenCalled();
  expect(mocks.state.useProxy).toBe(false);
});

test("commits valid concurrency bounds and rejects out-of-range values", async () => {
  await renderField(
    createElement(SettingNumberField, {
      name: "maxRunner",
      label: "maxRunner",
      min: 1,
      max: 50,
    }),
  );

  const input = container.querySelector<HTMLInputElement>("#setting-maxRunner");
  expect(input).not.toBeNull();
  await act(async () => {
    input!.focus();
    setInputValue(input!, "50");
    input!.blur();
  });
  await settleWrites();

  expect(mocks.writes).toHaveBeenCalledWith({ maxRunner: 50 });
  expect(mocks.state.maxRunner).toBe(50);

  mocks.writes.mockClear();
  await act(async () => {
    input!.focus();
    setInputValue(input!, "51");
    input!.blur();
  });
  await settleWrites();

  expect(mocks.writes).not.toHaveBeenCalled();
  expect(mocks.state.maxRunner).toBe(50);
  expect(container.textContent).toContain("1–50");

  mocks.writes.mockClear();
  await act(async () => {
    input!.focus();
    setInputValue(input!, "1");
    input!.blur();
  });
  await settleWrites();
  expect(mocks.writes).toHaveBeenCalledWith({ maxRunner: 1 });
  expect(mocks.state.maxRunner).toBe(1);

  for (const invalidValue of ["0", "1.5", ""]) {
    mocks.writes.mockClear();
    await act(async () => {
      input!.focus();
      setInputValue(input!, invalidValue);
      input!.blur();
    });
    await settleWrites();
    expect(
      mocks.writes,
      `invalid value ${JSON.stringify(invalidValue)}`,
    ).not.toHaveBeenCalled();
    expect(mocks.state.maxRunner).toBe(1);
    expect(input!.value).toBe("1");
  }
});

test("persists a valid concurrency edit only once across Enter and a repeated blur", async () => {
  Object.assign(mocks.state, { maxRunner: 1 });
  await renderField(
    createElement(SettingNumberField, {
      name: "maxRunner",
      label: "maxRunner",
      min: 1,
      max: 50,
    }),
  );

  const input = container.querySelector<HTMLInputElement>("#setting-maxRunner");
  if (!input) throw new Error("maxRunner input was not rendered");

  await act(async () => {
    input.focus();
    setInputValue(input, "2");
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  await settleWrites();

  expect(input.value).toBe("2");
  expect(mocks.state.maxRunner).toBe(2);
  expect(mocks.writes).toHaveBeenCalledTimes(1);

  await act(async () => {
    input.focus();
    input.blur();
  });
  await settleWrites();

  expect(input.value).toBe("2");
  expect(mocks.state.maxRunner).toBe(2);
  expect(mocks.writes).toHaveBeenCalledTimes(1);
});

test("does not persist a valid concurrency value when it has not changed", async () => {
  Object.assign(mocks.state, { maxRunner: 2 });
  await renderField(
    createElement(SettingNumberField, {
      name: "maxRunner",
      label: "maxRunner",
      min: 1,
      max: 50,
    }),
  );

  const input = container.querySelector<HTMLInputElement>("#setting-maxRunner");
  if (!input) throw new Error("maxRunner input was not rendered");

  await act(async () => {
    input.focus();
    setInputValue(input, "2");
    input.blur();
    input.focus();
    input.blur();
  });
  await settleWrites();

  expect(input.value).toBe("2");
  expect(mocks.state.maxRunner).toBe(2);
  expect(mocks.writes).not.toHaveBeenCalled();
});

test("allows retrying a concurrency value after a failed write rolls back", async () => {
  Object.assign(mocks.state, { maxRunner: 1 });
  mocks.writes.mockRejectedValueOnce(new Error("fixture write failure"));
  await renderField(
    createElement(SettingNumberField, {
      name: "maxRunner",
      label: "maxRunner",
      min: 1,
      max: 50,
    }),
  );

  const input = container.querySelector<HTMLInputElement>("#setting-maxRunner");
  if (!input) throw new Error("maxRunner input was not rendered");

  await act(async () => {
    input.focus();
    setInputValue(input, "2");
    input.blur();
  });
  await settleWrites();

  expect(input.value).toBe("1");
  expect(mocks.state.maxRunner).toBe(1);
  expect(mocks.writes).toHaveBeenCalledTimes(1);

  await act(async () => {
    input.focus();
    setInputValue(input, "2");
    input.blur();
  });
  await settleWrites();

  expect(input.value).toBe("2");
  expect(mocks.state.maxRunner).toBe(2);
  expect(mocks.writes).toHaveBeenCalledTimes(2);
  expect(mocks.writes).toHaveBeenLastCalledWith({ maxRunner: 2 });
});

test("keeps the concurrency validation error through consecutive invalid blurs", async () => {
  Object.assign(mocks.state, { maxRunner: 1 });
  await renderField(
    createElement(SettingNumberField, {
      name: "maxRunner",
      label: "maxRunner",
      min: 1,
      max: 50,
    }),
  );

  const input = container.querySelector<HTMLInputElement>("#setting-maxRunner");
  if (!input) throw new Error("maxRunner input was not rendered");

  const commitInvalid = async (invalidValue: string) => {
    await act(async () => {
      input.focus();
      setInputValue(input, invalidValue);
      input.blur();
    });
    await settleWrites();

    expect(input.value, `after ${invalidValue}`).toBe("1");
    expect(input.getAttribute("aria-invalid"), `after ${invalidValue}`).toBe(
      "true",
    );
    expect(container.textContent, `after ${invalidValue}`).toContain("1–50");
    expect(mocks.state.maxRunner).toBe(1);
    expect(mocks.writes).not.toHaveBeenCalled();
  };

  await commitInvalid("0");
  await commitInvalid("51");

  await act(async () => {
    input.focus();
    setInputValue(input, "");
    input.blur();
  });
  await settleWrites();
  expect(input.value).toBe("1");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(container.textContent).toContain("1–50");
  expect(mocks.state.maxRunner).toBe(1);
  expect(mocks.writes).not.toHaveBeenCalled();

  await act(async () => {
    input.focus();
    setInputValue(input, "10");
    input.blur();
  });
  await settleWrites();
  expect(input.value).toBe("10");
  expect(input.getAttribute("aria-invalid")).toBe("false");
  expect(container.textContent).not.toContain("1–50");
  expect(mocks.writes).toHaveBeenCalledWith({ maxRunner: 10 });
  expect(mocks.state.maxRunner).toBe(10);
});
