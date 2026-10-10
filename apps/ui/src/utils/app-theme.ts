import { AppTheme } from "@mediago/common";

export function resolveAppTheme(appTheme: AppTheme, systemDark: boolean) {
  if (appTheme === AppTheme.System) return systemDark ? "dark" : "light";
  return appTheme === AppTheme.Dark ? "dark" : "light";
}
