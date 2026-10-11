import type { PageAdapterLocation } from "../types";

export function matchesBilibiliPageLocation(
  location: PageAdapterLocation,
): boolean {
  const hostname = location.hostname.toLowerCase();
  return hostname === "bilibili.com" || hostname.endsWith(".bilibili.com");
}
