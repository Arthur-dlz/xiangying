import { DownloadType } from "@mediago/common";

import type { DetectedSource } from "../shared/types";

export type PageCookieReader = (details: {
  url: string;
}) => Promise<Pick<chrome.cookies.Cookie, "name" | "value">[]>;

function withCookieHeader(headers: string | undefined, cookie: string): string {
  const retained = (headers ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((header) => !/^\s*cookie\s*:/i.test(header));
  retained.push(`Cookie: ${cookie}`);
  return retained.filter(Boolean).join("\n");
}

/** Attach the browser's Xiaohongshu session only for direct HTTP handoff. */
export async function enrichSourcesWithPageCookies(
  sources: DetectedSource[],
  readCookies: PageCookieReader = (details) => chrome.cookies.getAll(details),
): Promise<DetectedSource[]> {
  return Promise.all(
    sources.map(async (source) => {
      if (source.type !== DownloadType.xiaohongshu) return source;
      try {
        const cookies = await readCookies({ url: source.url });
        const cookie = cookies
          .filter(({ name }) => name.trim() !== "")
          .map(({ name, value }) => `${name}=${value}`)
          .join("; ");
        if (!cookie) return source;
        return {
          ...source,
          headers: withCookieHeader(source.headers, cookie),
        };
      } catch {
        return source;
      }
    }),
  );
}
