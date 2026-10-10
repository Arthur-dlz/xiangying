import { afterEach, describe, expect, it, vi } from "vitest";

const electronProbe = vi.hoisted(() => ({
  onHeadersReceived: vi.fn(),
  onSendHeaders: vi.fn(),
}));

vi.mock("electron", () => ({
  session: {
    fromPartition: vi.fn(() => ({
      webRequest: {
        onHeadersReceived: electronProbe.onHeadersReceived,
        onSendHeaders: electronProbe.onSendHeaders,
      },
    })),
  },
}));

vi.mock("@mediago/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mediago/common")>();
  return {
    ...actual,
    matchPageUrl: vi.fn(() => undefined),
    matchRequestUrl: vi.fn((url: string) =>
      url.endsWith(".m3u8") ? { type: actual.DownloadType.m3u8 } : undefined,
    ),
    shouldSuppressRequestSource: vi.fn(() => false),
  };
});

vi.mock("../utils", () => ({
  formatHeaders: (headers: Record<string, string>) =>
    Object.entries(headers)
      .map(([name, value]) => `${name}:${value}`)
      .join("\n"),
}));
vi.mock("../vendor/ElectronLogger", () => ({
  default: class ElectronLogger {},
}));
vi.mock("./downloader.server", () => ({
  DownloaderServer: class DownloaderServer {},
}));

const { SniffingHelper } = await import("./sniffing-helper.service");

afterEach(() => vi.useRealTimers());

describe("default HLS inspection private-header probe", () => {
  it("removes private request headers from the real user and agent-default contexts", async () => {
    vi.useFakeTimers();
    const inspectSources = vi.fn(async ({ sources }) => ({
      data: {
        sources: sources.map((source: { id: string; url: string }) => ({
          ...source,
          playlistType: "media" as const,
          variants: [],
        })),
      },
    }));
    const helper = new SniffingHelper(
      { info: vi.fn(), warn: vi.fn() } as never,
      { getClient: () => ({ inspectSources }) } as never,
    );
    helper.register({
      initialPageInfo: {
        title: "Owned user probe",
        url: "http://127.0.0.1/watch",
      },
      kind: "user",
      partition: "persist:owned-inspection-user-probe",
      tabId: "owned-default-user",
      useSessionCookies: true,
      webContentsId: 44017,
    });
    helper.register({
      initialPageInfo: {
        title: "Owned agent probe",
        url: "http://127.0.0.1/watch",
      },
      kind: "agent",
      partition: "owned-inspection-agent-probe",
      tabId: "owned-default-agent",
      useSessionCookies: false,
      webContentsId: 44018,
    });

    const listeners = electronProbe.onSendHeaders.mock.calls.map(
      ([listener]) => listener as (details: unknown) => void,
    );
    expect(listeners).toHaveLength(2);
    for (const [index, listener] of listeners.entries()) {
      listener({
        id: 17 + index,
        requestHeaders: {
          Cookie: "closure_dummy_cookie_marker",
          Authorization: "Bearer closure_dummy_auth_marker",
          Referer: "http://127.0.0.1/watch",
        },
        url: `http://127.0.0.1/private/master-${index}.m3u8`,
        webContentsId: 44017 + index,
      });
    }
    await vi.advanceTimersByTimeAsync(150);

    expect(inspectSources).toHaveBeenCalledTimes(2);
    const observations = inspectSources.mock.calls.map(([payload]) => {
      const sources = (payload as { sources: Array<{ headers: string[] }> })
        .sources;
      const headers = sources[0]?.headers ?? [];
      return {
        hasDummyCookie: headers.some(
          (header) =>
            header.toLowerCase().startsWith("cookie:") &&
            header.includes("closure_dummy_cookie_marker"),
        ),
        hasDummyAuthorization: headers.some(
          (header) =>
            header.toLowerCase().startsWith("authorization:") &&
            header.includes("closure_dummy_auth_marker"),
        ),
        hasSafeReferer: headers.some((header) =>
          header.toLowerCase().startsWith("referer:"),
        ),
      };
    });
    expect(observations).toEqual([
      {
        hasDummyCookie: false,
        hasDummyAuthorization: false,
        hasSafeReferer: true,
      },
      {
        hasDummyCookie: false,
        hasDummyAuthorization: false,
        hasSafeReferer: true,
      },
    ]);
    helper.close();
  });
});
