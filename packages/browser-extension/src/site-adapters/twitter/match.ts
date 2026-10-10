import type { PageAdapterLocation } from "../types";

export function matchesTwitterPageLocation(
  location: PageAdapterLocation,
): boolean {
  const hostname = location.hostname.toLowerCase();
  return (
    hostname === "x.com" ||
    hostname.endsWith(".x.com") ||
    hostname === "twitter.com" ||
    hostname.endsWith(".twitter.com")
  );
}
