/** @vitest-environment happy-dom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AppTheme } from "@mediago/common";
import { useAppStore } from "../store/app";
import { useSessionStore } from "../store/session";
import { useWebAppearanceStore } from "../store/web-appearance";

vi.mock("../environment", () => ({ isWeb: true }));

const { useAppTheme } = await import("./use-app-theme");

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function ThemeProbe() {
  const theme = useAppTheme();
  return createElement("span", { "data-theme": theme });
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  document.documentElement.classList.remove("dark");
  useAppStore.setState({ theme: AppTheme.Light });
  useWebAppearanceStore.setState({ theme: AppTheme.Dark });
  useSessionStore.setState({ theme: "light" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

test("uses the browser-local theme instead of the server theme on Web", () => {
  act(() => root.render(createElement(ThemeProbe)));

  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(container.querySelector("span")?.dataset.theme).toBe("dark");

  act(() => useWebAppearanceStore.getState().setTheme(AppTheme.Light));

  expect(document.documentElement.classList.contains("dark")).toBe(false);
  expect(container.querySelector("span")?.dataset.theme).toBe("light");
});
