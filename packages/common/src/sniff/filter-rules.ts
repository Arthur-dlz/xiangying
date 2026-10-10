import { DownloadType } from "../types";

const HLS_CONTENT_TYPES = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
]);

export function isHLSContentType(contentType: string): boolean {
  const [essence = ""] = contentType.split(";", 1);
  return HLS_CONTENT_TYPES.has(essence.trim().toLowerCase());
}

/**
 * A single sniff rule.
 *
 * `matches` is evaluated against a request URL's pathname (m3u8/.mp4-like
 * direct media streams). `hosts` is evaluated against a whole page URL
 * (site-specific extractors like bilibili/youtube that do not expose a
 * matchable media suffix).
 */
export interface SniffFilter {
  /** Patterns tested against a full page URL. */
  hosts?: RegExp[];
  /** Patterns tested against a request URL's pathname. */
  matches?: RegExp[];
  /** Which downloader to dispatch when the rule fires. */
  type: DownloadType;
  /** Optional hints for extracting display fields from the source context. */
  schema?: Record<string, string>;
}

/**
 * Canonical sniff rule list — shared by the Electron webview sniffing
 * helper and the browser extension's background worker so both surfaces
 * stay in lock-step.
 */
export const SNIFF_FILTERS: SniffFilter[] = [
  {
    matches: [/\.m3u8/],
    type: DownloadType.m3u8,
  },
  {
    // TODO: Collections, lists, favorites
    hosts: [/^https?:\/\/(www\.)?bilibili.com\/video/],
    type: DownloadType.bilibili,
    schema: {
      name: "title",
    },
  },
  {
    // X and legacy Twitter status pages are handled by the existing yt-dlp
    // execution channel. Timeline/search pages are intentionally excluded.
    hosts: [
      /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^/?#]+\/status\/\d+(?:[/?#]|$)/i,
    ],
    type: DownloadType.youtube,
    schema: {
      name: "title",
    },
  },
  {
    // TikTok and Douyin single-post and share URLs use the same yt-dlp
    // execution channel. Profiles, search pages, collections, and live
    // routes are intentionally excluded from page-level discovery.
    hosts: [
      /^https?:\/\/(?:(?:www|m)\.)?tiktokv?\.com\/(?:@[^/?#]+\/video\/\d+|share\/video\/\d+|t\/[A-Za-z0-9_-]+)(?:[/?#]|$)/i,
      /^https?:\/\/(?:vm|vt)\.tiktok\.com\/[A-Za-z0-9_-]+(?:[/?#]|$)/i,
      /^https?:\/\/(?:www\.)?douyin\.com\/video\/\d+(?:[/?#]|$)/i,
      /^https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+(?:[/?#]|$)/i,
    ],
    type: DownloadType.youtube,
    schema: {
      name: "title",
    },
  },
  {
    // Match actual video / short / live / embed URLs — not the homepage
    // or subscription feed, which would produce spurious "source found"
    // detections on every navigation.
    hosts: [
      /^https?:\/\/(www\.|m\.|music\.)?youtube\.com\/(watch\?|shorts\/|live\/|embed\/)/,
      /^https?:\/\/youtu\.be\/[^/?#]+/,
    ],
    type: DownloadType.youtube,
    schema: {
      name: "title",
    },
  },
  {
    // Xiaohongshu needs the stable note/share URL, including its xsec_token,
    // rather than one of the many short-lived image/video CDN renditions.
    hosts: [
      /^https?:\/\/(?:www\.)?xiaohongshu\.com\/(?:explore\/[^/?#]+|discovery\/item\/[^/?#]+|user\/profile\/[^/?#]+\/[^/?#]+)(?:[/?#]|$)/i,
      /^https?:\/\/(?:www\.)?xhslink\.com\/[^/?#]+(?:[/?#]|$)/i,
    ],
    type: DownloadType.xiaohongshu,
    schema: {
      name: "title",
    },
  },
  {
    matches: [
      /\.(mp4|flv|mov|avi|mkv|wmv|m4a|ogg|m4b|m4p|m4r|m4b|m4p|m4r)(?![a-zA-Z])/,
    ],
    type: DownloadType.direct,
  },
];

/**
 * Test a request URL (path-level) against every rule with a `matches`
 * entry. Returns the first matching rule, or undefined.
 */
export function matchRequestUrl(requestUrl: string): SniffFilter | undefined {
  let pathname: string;
  try {
    pathname = new URL(requestUrl).pathname;
  } catch {
    return undefined;
  }
  for (const filter of SNIFF_FILTERS) {
    if (!filter.matches) continue;
    for (const match of filter.matches) {
      if (match.test(pathname)) return filter;
    }
  }
  return undefined;
}

/**
 * Test a document/page URL against every rule with a `hosts` entry.
 * Returns the first matching rule, or undefined.
 */
export function matchPageUrl(pageUrl: string): SniffFilter | undefined {
  for (const filter of SNIFF_FILTERS) {
    if (!filter.hosts) continue;
    for (const host of filter.hosts) {
      if (host.test(pageUrl)) return filter;
    }
  }
  return undefined;
}

/**
 * Some supported sites expose many short-lived media renditions while their
 * page adapter can identify the stable, user-facing item instead. X/Twitter
 * timelines are the clearest example: every autoplayed tweet can request
 * several MP4 variants, but the adapter resolves each video to one canonical
 * status URL for yt-dlp.
 *
 * Suppress only generic request-level media sources here. Page-level sources
 * and per-card candidates keep flowing through the specialised extractor.
 */
export function shouldSuppressRequestSource(
  pageUrl: string,
  type: DownloadType,
): boolean {
  if (type !== DownloadType.direct && type !== DownloadType.m3u8) {
    return false;
  }

  try {
    const hostname = new URL(pageUrl).hostname.toLowerCase();
    const isX =
      hostname === "x.com" ||
      hostname.endsWith(".x.com") ||
      hostname === "twitter.com" ||
      hostname.endsWith(".twitter.com");
    const isShortVideo =
      hostname === "tiktok.com" ||
      hostname === "www.tiktok.com" ||
      hostname === "m.tiktok.com" ||
      hostname === "douyin.com" ||
      hostname === "www.douyin.com";
    const isXiaohongshu =
      hostname === "xiaohongshu.com" ||
      hostname.endsWith(".xiaohongshu.com") ||
      hostname === "xhslink.com" ||
      hostname.endsWith(".xhslink.com");
    return isX || isShortVideo || isXiaohongshu;
  } catch {
    return false;
  }
}
