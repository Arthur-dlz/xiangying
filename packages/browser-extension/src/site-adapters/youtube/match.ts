import type { PageAdapterLocation } from "../types";

export function matchesYoutubePageLocation(
  location: PageAdapterLocation,
): boolean {
  const hostname = location.hostname.toLowerCase();
  return (
    hostname === "youtube.com" ||
    hostname.endsWith(".youtube.com") ||
    hostname === "youtu.be"
  );
}
