import type { PageAdapterLocation } from "../types";

export function matchesShortVideoPageLocation(
  location: PageAdapterLocation,
): boolean {
  const hostname = location.hostname.toLowerCase();
  return (
    hostname === "tiktok.com" ||
    hostname.endsWith(".tiktok.com") ||
    hostname === "tiktokv.com" ||
    hostname.endsWith(".tiktokv.com") ||
    hostname === "douyin.com" ||
    hostname.endsWith(".douyin.com")
  );
}
