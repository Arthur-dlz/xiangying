import type { SourceInspection } from "@mediago/core-sdk";
import type { HLSMediaInfo } from "@mediago/common";

export function formattedHeadersToArray(headers?: string): string[] {
  if (!headers) return [];
  return headers
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((header) => header.trim())
    .filter(Boolean);
}

export function inspectionToMediaInfo(
  inspection?: SourceInspection,
): HLSMediaInfo {
  if (!inspection || inspection.error) {
    return {
      status: "failed",
      playlistType: "unknown",
      variants: [],
    };
  }
  return {
    status: "ready",
    playlistType: inspection.playlistType,
    maxQuality: inspection.maxQuality,
    variants: inspection.variants,
  };
}

const SENSITIVE_DISCOVERY_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

export interface DiscoveryHeaderSplit {
  publicHeaders: string[];
  privateHeaders: string[];
}

export function splitDiscoveryHeaders(
  headers: string[],
  includeSensitive: boolean,
): DiscoveryHeaderSplit {
  const publicHeaders: string[] = [];
  const privateHeaders: string[] = [];
  for (const rawHeader of headers.slice(0, 100)) {
    if (rawHeader.length > 16 * 1024 || /[\r\n]/.test(rawHeader)) continue;
    const separator = rawHeader.indexOf(":");
    if (separator <= 0) continue;
    const name = rawHeader.slice(0, separator).trim();
    const value = rawHeader.slice(separator + 1).trim();
    if (!name || !value) continue;
    const normalized = `${name}: ${value}`;
    if (SENSITIVE_DISCOVERY_HEADERS.has(name.toLowerCase())) {
      if (includeSensitive) privateHeaders.push(normalized);
    } else {
      publicHeaders.push(normalized);
    }
  }
  return { privateHeaders, publicHeaders };
}
