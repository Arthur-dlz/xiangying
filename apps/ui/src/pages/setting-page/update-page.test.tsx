/** @vitest-environment happy-dom */

import {
  act,
  createElement,
  Fragment,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const session = {
    updateAvailable: false,
    updateState: {
      status: "idle",
      currentVersion: "1.0.0",
      progress: 0,
      portable: false,
    },
  };
  const setUpdateState = vi.fn((updateState: Record<string, unknown>) => {
    session.updateState = updateState;
    listeners.forEach((listener) => listener());
  });
  Object.assign(session, { setUpdateState });
  return {
    listeners,
    session,
    update: {
      check: vi.fn(),
      startDownload: vi.fn(),
      install: vi.fn(),
      openLogDirectory: vi.fn(),
      getDiagnosticInfo: vi.fn(),
    },
    setUpdateState,
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));
vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({ update: mocks.update }),
}));
vi.mock("@/store/session", async () => {
  const react = await import("react");
  const useSessionStore = Object.assign(
    (selector: (state: typeof mocks.session) => unknown) =>
      react.useSyncExternalStore(
        (listener) => {
          mocks.listeners.add(listener);
          return () => mocks.listeners.delete(listener);
        },
        () => selector(mocks.session),
        () => selector(mocks.session),
      ),
    {
      getState: () => ({
        ...mocks.session,
        setUpdateState: mocks.setUpdateState,
      }),
    },
  );
  return {
    useSessionStore,
  };
});
vi.mock("@/utils", () => ({ isWeb: false, tdApp: { onEvent: vi.fn() } }));
vi.mock("@/const", () => ({ CHECK_UPDATE: "check-update" }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? createElement("div", { role: "dialog" }, children) : null,
  DialogContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DialogDescription: ({ children }: { children: ReactNode }) =>
    createElement("p", null, children),
  DialogFooter: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DialogHeader: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DialogTitle: ({ children }: { children: ReactNode }) =>
    createElement("h2", null, children),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) =>
    createElement("button", props, children),
}));
vi.mock("@/components/ui/progress", () => ({
  Progress: (props: HTMLAttributes<HTMLDivElement>) =>
    createElement("div", props),
}));
vi.mock("./setting-fields", () => ({
  SettingsFormProvider: ({ children }: { children: ReactNode }) =>
    createElement(Fragment, null, children),
}));
vi.mock("./settings-promo-card", () => ({ SettingsPromoCard: () => null }));
vi.mock("./setting-sections", () => ({
  BasicSettingsCard: () => null,
  BrowserExtensionCard: () => null,
  BrowserSettingsCard: () => null,
  CLISettingsCard: () => null,
  DockerSettingsCard: () => null,
  DownloadSettingsCard: () => null,
  MCPSettingsCard: () => null,
  MoreSettingsCard: ({ onCheckUpdate }: { onCheckUpdate: () => void }) =>
    createElement("button", { onClick: onCheckUpdate }, "check-update"),
  OpenSourceCard: () => null,
  SkillsSettingsCard: () => null,
}));

const { default: SettingPage } = await import("./index");

let root: Root | undefined;
let container: HTMLDivElement;

async function renderPage() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(SettingPage));
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

beforeEach(() => {
  mocks.listeners.clear();
  Object.assign(mocks.session, {
    updateAvailable: false,
    updateState: {
      status: "idle",
      currentVersion: "1.0.0",
      progress: 0,
      portable: false,
    },
  });
  mocks.setUpdateState.mockClear();
  mocks.update.check
    .mockReset()
    .mockRejectedValue(new Error("offline fixture"));
  mocks.update.startDownload.mockReset();
  mocks.update.install.mockReset();
  mocks.update.openLogDirectory
    .mockReset()
    .mockResolvedValue({ opened: false });
  mocks.update.getDiagnosticInfo
    .mockReset()
    .mockResolvedValue("fixture diagnostic");
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  container?.remove();
});

test("surfaces updater check errors and reports log/diagnostic action failures", async () => {
  await renderPage();

  expect(mocks.update.check).not.toHaveBeenCalled();
  await clickButton("check-update");

  expect(mocks.update.check).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("updateCheckFailed");
  expect(container.textContent).toContain("updateErrorDetailsHint");
  expect(container.textContent).toContain("UPDATE_IPC_FAILED");

  await clickButton("openUpdateLogs");
  expect(mocks.update.openLogDirectory).toHaveBeenCalledOnce();
  expect(mocks.toastError).toHaveBeenCalledWith("openUpdateLogsFailed");

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn().mockRejectedValue(new Error("clipboard denied")),
    },
  });
  await clickButton("copyUpdateDiagnostics");
  expect(mocks.update.getDiagnosticInfo).toHaveBeenCalledOnce();
  expect(mocks.toastError).toHaveBeenCalledWith("updateDiagnosticsCopyFailed");
  expect(mocks.update.startDownload).not.toHaveBeenCalled();
  expect(mocks.update.install).not.toHaveBeenCalled();
});
