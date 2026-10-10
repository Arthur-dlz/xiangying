import type { PageAdapterLocation } from "../types";

export function matchesBilibiliPageLocation(
  location: PageAdapterLocation,
): boolean {
  return location.hostname === "www.bilibili.com";
}
