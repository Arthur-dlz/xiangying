/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it } from "vitest";
import { AppTheme } from "@mediago/common";
import {
  mergeWebAppearanceState,
  useWebAppearanceStore,
} from "./web-appearance";

describe("web appearance store", () => {
  beforeEach(() => {
    localStorage.clear();
    useWebAppearanceStore.setState({ theme: AppTheme.System });
  });

  it("persists a browser-local theme preference", () => {
    useWebAppearanceStore.getState().setTheme(AppTheme.Dark);

    expect(useWebAppearanceStore.getState().theme).toBe(AppTheme.Dark);
    expect(localStorage.getItem("web-appearance-storage")).toContain(
      `"theme":"${AppTheme.Dark}"`,
    );
  });

  it("falls back to the current theme for invalid persisted values", () => {
    const currentState = useWebAppearanceStore.getState();

    expect(
      mergeWebAppearanceState({ theme: "unsupported" }, currentState).theme,
    ).toBe(AppTheme.System);
    expect(
      mergeWebAppearanceState({ theme: AppTheme.Light }, currentState).theme,
    ).toBe(AppTheme.Light);
  });
});
