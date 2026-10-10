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
    local: "C:/isolated/downloads",
    theme: "system",
    language: "zh",
    webTheme: "system",
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
    setWebTheme: vi.fn((value: string) => {
      state.webTheme = value;
    }),
    writes: vi.fn(async (_values: Record<string, unknown>) => undefined),
    open: vi.fn(async (_path: string) => undefined),
    extensionDir: vi.fn(async () => "C:/isolated/resources/extension"),
    clearCache: vi.fn(async () => undefined),
    dialogOpen: vi.fn(async () => [
      JSON.stringify([{ url: "https://fixture.invalid" }]),
    ]),
    dialogSave: vi.fn(async (_options: unknown) => undefined),
    exportFavorites: vi.fn(async () => [{ url: "https://fixture.invalid" }]),
    importFavorites: vi.fn(async (_values: unknown[]) => undefined),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    t: (key: string) => key,
  };
});

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: mocks.t }),
}));
vi.mock("@/api/config", () => ({ setConfigValues: mocks.writes }));
vi.mock("@/api/favorite", () => ({
  exportFavorites: mocks.exportFavorites,
  importFavorites: mocks.importFavorites,
}));
vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({
    app: { getExtensionDir: mocks.extensionDir },
    browser: { clearCache: mocks.clearCache },
    contextMenu: { show: vi.fn() },
    dialog: { open: mocks.dialogOpen, save: mocks.dialogSave },
    shell: { open: mocks.open },
  }),
}));
vi.mock("@/hooks/use-config", () => ({
  useEnvPath: () => ({
    envPath: { configDir: "C:/isolated/config", binDir: "C:/isolated/bin" },
  }),
}));
vi.mock("@/store/app", () => ({ useAppStore: mocks.useAppStore }));
vi.mock("@/store/web-appearance", () => ({
  isAppTheme: (value: string) => ["system", "light", "dark"].includes(value),
  useWebAppearanceStore: (
    selector: (state: Record<string, unknown>) => unknown,
  ) => selector({ theme: mocks.state.webTheme, setTheme: mocks.setWebTheme }),
}));
vi.mock("@/store/session", () => ({
  useSessionStore: (selector: (value: Record<string, unknown>) => unknown) =>
    selector({
      updateAvailable: false,
      updateState: {
        status: "idle",
        currentVersion: "1.0.0",
        progress: 0,
        portable: false,
      },
    }),
}));
vi.mock("@/services/adapter-bootstrap", () => ({
  getAdapterCoreUrl: () => "",
}));
vi.mock("@/services/mcp-config", () => ({
  buildMCPAgentConfig: () => "",
  buildMCPEndpoint: () => "",
}));
vi.mock("@/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils")>()),
  get isWeb() {
    return false;
  },
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

const { SettingsFormProvider } = await import("./setting-fields");
const {
  BasicSettingsCard,
  BrowserExtensionCard,
  BrowserSettingsCard,
  MoreSettingsCard,
} = await import("./setting-sections");

let root: Root | undefined;
let container: HTMLDivElement;

async function render(card: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(SettingsFormProvider, null, card));
  });
}

async function clickButton(label: string) {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  expect(button, `button ${label} should exist`).toBeDefined();
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
}

async function settleWrites() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

async function chooseSettingOption(id: string, label: string) {
  const trigger = document.getElementById(id);
  expect(trigger, `select ${id} should exist`).not.toBeNull();
  await act(async () => {
    trigger?.click();
    await Promise.resolve();
  });
  const option = [
    ...document.body.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((candidate) => candidate.textContent?.trim() === label);
  expect(option, `option ${label} should be available`).toBeDefined();
  await act(async () => option?.click());
}

beforeEach(() => {
  Object.assign(mocks.state, {
    local: "C:/isolated/downloads",
    proxy: "",
    useProxy: false,
  });
  mocks.listeners.clear();
  mocks.writes.mockReset().mockResolvedValue(undefined);
  mocks.open.mockReset().mockResolvedValue(undefined);
  mocks.extensionDir
    .mockReset()
    .mockResolvedValue("C:/isolated/resources/extension");
  mocks.clearCache.mockReset().mockResolvedValue(undefined);
  mocks.dialogOpen
    .mockReset()
    .mockResolvedValue([JSON.stringify([{ url: "https://fixture.invalid" }])]);
  mocks.dialogSave.mockReset().mockResolvedValue(undefined);
  mocks.exportFavorites
    .mockReset()
    .mockResolvedValue([{ url: "https://fixture.invalid" }]);
  mocks.importFavorites.mockReset().mockResolvedValue(undefined);
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  container?.remove();
});

test("browser card clears only its isolated browser cache and reports success", async () => {
  await render(createElement(BrowserSettingsCard));
  await clickButton("clearCache");

  expect(mocks.clearCache).toHaveBeenCalledOnce();
  expect(mocks.toastSuccess).toHaveBeenCalledWith("clearCacheSuccess");
  expect(mocks.toastError).not.toHaveBeenCalled();
});

test("browser cache failure reports an error without a success toast", async () => {
  mocks.clearCache.mockRejectedValueOnce(new Error("fixture cache failure"));
  await render(createElement(BrowserSettingsCard));
  await clickButton("clearCache");

  expect(mocks.clearCache).toHaveBeenCalledOnce();
  expect(mocks.toastError).toHaveBeenCalledWith("clearCacheFailed");
  expect(mocks.toastSuccess).not.toHaveBeenCalled();
});

test("theme and language selections persist allowed setting values", async () => {
  await render(createElement(BasicSettingsCard));
  await chooseSettingOption("setting-theme", "dark");
  await chooseSettingOption("setting-language", "english");
  await settleWrites();

  expect(mocks.writes).toHaveBeenNthCalledWith(1, { theme: "dark" });
  expect(mocks.writes).toHaveBeenNthCalledWith(2, { language: "en" });
  expect(mocks.state.theme).toBe("dark");
  expect(mocks.state.language).toBe("en");
});

test("directory picker cancel keeps the current isolated download directory", async () => {
  mocks.dialogOpen.mockResolvedValueOnce([]);
  await render(createElement(BasicSettingsCard));
  await clickButton("selectFolder");
  await settleWrites();

  expect(mocks.dialogOpen).toHaveBeenCalledWith({ type: "directory" });
  expect(mocks.state.local).toBe("C:/isolated/downloads");
  expect(mocks.writes).not.toHaveBeenCalled();
});

test("directory picker persists only a selected isolated download directory", async () => {
  mocks.dialogOpen.mockResolvedValueOnce(["C:/isolated/new-downloads"]);
  await render(createElement(BasicSettingsCard));
  await clickButton("selectFolder");
  await settleWrites();

  expect(mocks.dialogOpen).toHaveBeenCalledWith({ type: "directory" });
  expect(mocks.writes).toHaveBeenCalledWith({
    local: "C:/isolated/new-downloads",
  });
  expect(mocks.state.local).toBe("C:/isolated/new-downloads");
});

test("favorites actions import and export only synthetic fixture data", async () => {
  await render(createElement(BrowserSettingsCard));
  await clickButton("exportFavorite");
  await clickButton("importFavorite");

  expect(mocks.exportFavorites).toHaveBeenCalledOnce();
  expect(mocks.dialogSave).toHaveBeenCalledWith(
    expect.objectContaining({
      content: JSON.stringify([{ url: "https://fixture.invalid" }], null, 2),
      defaultPath: "favorites.json",
    }),
  );
  expect(mocks.dialogOpen).toHaveBeenCalledWith(
    expect.objectContaining({ type: "file", readContent: true }),
  );
  expect(mocks.importFavorites).toHaveBeenCalledWith([
    { url: "https://fixture.invalid" },
  ]);
});

test("extension card opens its packaged directory and fixed guide URL", async () => {
  await render(createElement(BrowserExtensionCard));
  await clickButton("extensionDir");
  await clickButton("extensionGuide");

  expect(mocks.extensionDir).toHaveBeenCalledOnce();
  expect(mocks.open).toHaveBeenNthCalledWith(
    1,
    "C:/isolated/resources/extension",
  );
  expect(mocks.open).toHaveBeenNthCalledWith(
    2,
    "https://downloader.caorushizi.cn/extension.html",
  );
});

test("more card opens only the supplied isolated directories", async () => {
  await render(createElement(MoreSettingsCard, { onCheckUpdate: vi.fn() }));
  await clickButton("configDir");
  await clickButton("binPath");
  await clickButton("localDir");

  expect(mocks.open.mock.calls).toStrictEqual([
    ["C:/isolated/config"],
    ["C:/isolated/bin"],
    ["C:/isolated/downloads"],
  ]);
});
