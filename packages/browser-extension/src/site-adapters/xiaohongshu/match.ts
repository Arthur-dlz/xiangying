import type { PageAdapterLocation } from "../types";

export function matchesXiaohongshuPageLocation(
  location: PageAdapterLocation,
): boolean {
  const hostname = location.hostname.toLowerCase();
  return (
    hostname === "xiaohongshu.com" ||
    hostname.endsWith(".xiaohongshu.com") ||
    hostname === "xhslink.com" ||
    hostname.endsWith(".xhslink.com")
  );
}
