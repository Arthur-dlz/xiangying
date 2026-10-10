import { useLayoutEffect } from "react";
import { useAppStore } from "../store/app";
import { useSessionStore } from "../store/session";
import { useWebAppearanceStore } from "../store/web-appearance";
import { isWeb } from "../environment";
import { resolveAppTheme } from "../utils/app-theme";

export function useAppTheme() {
  const appTheme = useAppStore((state) => state.theme);
  const webTheme = useWebAppearanceStore((state) => state.theme);
  const theme = useSessionStore((state) => state.theme);
  const setTheme = useSessionStore((state) => state.setTheme);
  const preferredTheme = isWeb ? webTheme : appTheme;

  useLayoutEffect(() => {
    const systemTheme = matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolvedTheme = resolveAppTheme(
        preferredTheme,
        systemTheme.matches,
      );
      document.documentElement.classList.toggle(
        "dark",
        resolvedTheme === "dark",
      );
      setTheme(resolvedTheme);
    };
    applyTheme();
    systemTheme.addEventListener("change", applyTheme);
    return () => systemTheme.removeEventListener("change", applyTheme);
  }, [preferredTheme, setTheme]);

  return theme;
}
