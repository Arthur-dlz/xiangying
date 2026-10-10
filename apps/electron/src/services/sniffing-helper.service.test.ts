import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => {
  const listeners = new Map<string, (details: unknown) => void>();
  const sessions = new Map<
    string,
    {
      webRequest: {
        onHeadersReceived: ReturnType<typeof vi.fn>;
        onSendHeaders: ReturnType<typeof vi.fn>;
      };
    }
  >();
  const responseListeners = new Map<
    string,
    (details: unknown, callback: (response: object) => void) => void
  >();
  return {
    fromPartition: vi.fn((partition: string) => {
      let value = sessions.get(partition);
      if (!value) {
        value = {
          webRequest: {
            onHeadersReceived: vi.fn(
              (
                listener:
                  | ((
                      details: unknown,
                      callback: (response: object) => void,
                    ) => void)
                  | null,
              ) => {
                if (listener) responseListeners.set(partition, listener);
                else responseListeners.delete(partition);
              },
            ),
            onSendHeaders: vi.fn(
              (listener: ((details: unknown) => void) | null) => {
                if (listener) listeners.set(partition, listener);
                else listeners.delete(partition);
              },
            ),
          },
        };
        sessions.set(partition, value);
      }
      return value;
    }),
    listeners,
    responseListeners,
    sessions,
  };
});

vi.mock("electron", () => ({
  session: { fromPartition: electronMocks.fromPartition },
}));

vi.mock("@mediago/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mediago/common")>();
  return {
    ...actual,
    matchPageUrl: vi.fn(() => undefined),
    matchRequestUrl: vi.fn((url: string) => {
      if (url.endsWith(".m3u8")) return { type: actual.DownloadType.m3u8 };
      if (url.endsWith(".mp4")) return { type: actual.DownloadType.direct };
      return undefined;
    }),
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

const { DownloadType } = await import("@mediago/common");
const { AgentCollectionError, getCookieBackedType, SniffingHelper } =
  await import("./sniffing-helper.service");

afterEach(() => {
  vi.useRealTimers();
});

function createHelper() {
  const inspectSources = vi.fn(async ({ sources }) => ({
    data: {
      sources: sources.map((source: { id: string; url: string }) => ({
        ...source,
        playlistType: "media" as const,
        variants: [],
      })),
    },
  }));
  const logger = { info: vi.fn(), warn: vi.fn() };
  const helper = new SniffingHelper(
    logger as never,
    { getClient: () => ({ inspectSources }) } as never,
  );
  return { helper, inspectSources, logger };
}

function register(
  helper: InstanceType<typeof SniffingHelper>,
  tabId: string,
  webContentsId: number,
  kind: "user" | "agent" = "user",
  useSessionCookies = false,
) {
  helper.register({
    initialPageInfo: {
      title: `Title ${tabId}`,
      url: `https://example.com/${tabId}`,
    },
    kind,
    partition: "persist:webview",
    tabId,
    useSessionCookies,
    webContentsId,
  });
}

describe("SniffingHelper tab isolation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    electronMocks.listeners.clear();
    electronMocks.responseListeners.clear();
    electronMocks.sessions.clear();
    electronMocks.fromPartition.mockClear();
  });

  it.each([
    {
      name: "ordinary user tab even though its persistent partition is enabled",
      kind: "user" as const,
      useSessionCookies: true,
      expected: {
        cookie: false,
        authorization: false,
        proxyAuthorization: false,
        apiKey: false,
        referer: true,
        accept: true,
        acceptEncoding: false,
      },
    },
    {
      name: "agent discovery without session-cookie opt-in",
      kind: "agent" as const,
      useSessionCookies: false,
      expected: {
        cookie: false,
        authorization: false,
        proxyAuthorization: false,
        apiKey: false,
        referer: true,
        accept: true,
        acceptEncoding: false,
      },
    },
    {
      name: "explicit agent session-cookie opt-in for the original source",
      kind: "agent" as const,
      useSessionCookies: true,
      expected: {
        cookie: true,
        authorization: true,
        proxyAuthorization: true,
        apiKey: false,
        referer: true,
        accept: true,
        acceptEncoding: false,
      },
    },
  ])(
    "filters HLS inspection RPC headers for $name",
    async ({ kind, useSessionCookies, expected }) => {
      const { helper, inspectSources } = createHelper();
      register(
        helper,
        `tab-${kind}-${String(useSessionCookies)}`,
        44017,
        kind,
        useSessionCookies,
      );
      helper.send(`tab-${kind}-${String(useSessionCookies)}`, {
        documentURL: "https://example.com/watch",
        headers: [
          "Cookie: closure_dummy_cookie_marker",
          "Authorization: Bearer closure_dummy_auth_marker",
          "Proxy-Authorization: Basic closure_dummy_proxy_marker",
          "X-Api-Key: closure_dummy_api_key_marker",
          "Referer: https://example.com/watch",
          "Accept: application/vnd.apple.mpegurl",
          "Accept-Encoding: gzip, br",
        ].join("\n"),
        name: "Owned HLS probe",
        type: DownloadType.m3u8,
        url: "https://cdn.example.com/master.m3u8",
      });
      await vi.advanceTimersByTimeAsync(150);

      const payload = inspectSources.mock.calls[0]?.[0] as {
        sources: Array<{ headers: string[] }>;
      };
      const headers = payload.sources[0]?.headers ?? [];
      const observed = {
        cookie: headers.some((header) =>
          header.toLowerCase().startsWith("cookie:"),
        ),
        authorization: headers.some((header) =>
          header.toLowerCase().startsWith("authorization:"),
        ),
        proxyAuthorization: headers.some((header) =>
          header.toLowerCase().startsWith("proxy-authorization:"),
        ),
        apiKey: headers.some((header) =>
          header.toLowerCase().startsWith("x-api-key:"),
        ),
        referer: headers.some((header) =>
          header.toLowerCase().startsWith("referer:"),
        ),
        accept: headers.some((header) =>
          header.toLowerCase().startsWith("accept:"),
        ),
        acceptEncoding: headers.some((header) =>
          header.toLowerCase().startsWith("accept-encoding:"),
        ),
      };
      expect(observed).toEqual(expected);
      helper.close();
    },
  );

  it("uses one session listener and routes metadata, dedup, and HLS results by webContentsId", async () => {
    const { helper, inspectSources } = createHelper();
    const events: Array<{
      tabId: string;
      source: {
        url: string;
        documentURL: string;
        name: string;
        mediaInfo?: { status: string };
      };
    }> = [];
    helper.on("source", (event) => events.push(event));
    register(helper, "tab-a", 101);
    register(helper, "tab-b", 202);

    expect(electronMocks.fromPartition).toHaveBeenCalledOnce();
    expect(
      electronMocks.sessions.get("persist:webview")?.webRequest.onSendHeaders,
    ).toHaveBeenCalledOnce();
    const listener = electronMocks.listeners.get("persist:webview");
    expect(listener).toBeTypeOf("function");
    listener?.({
      requestHeaders: { Referer: "https://example.com/tab-a" },
      url: "https://cdn.example.com/a.m3u8",
      webContentsId: 101,
    });
    listener?.({
      requestHeaders: { Referer: "https://example.com/tab-b" },
      url: "https://cdn.example.com/b.m3u8",
      webContentsId: 202,
    });
    listener?.({
      requestHeaders: { Referer: "https://example.com/tab-a" },
      url: "https://cdn.example.com/a.m3u8",
      webContentsId: 101,
    });

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.tabId)).toEqual(["tab-a", "tab-b"]);
    expect(events[0].source).toMatchObject({
      documentURL: "https://example.com/tab-a",
      name: "Title tab-a",
      url: "https://cdn.example.com/a.m3u8",
    });

    await vi.advanceTimersByTimeAsync(150);
    expect(inspectSources).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(4);
    expect(
      events
        .slice(2)
        .map((event) => event.tabId)
        .sort(),
    ).toEqual(["tab-a", "tab-b"]);
    expect(
      events.every((event) =>
        event.source.url.includes(
          event.tabId === "tab-a" ? "a.m3u8" : "b.m3u8",
        ),
      ),
    ).toBe(true);
  });

  it.each([
    "application/vnd.apple.mpegurl",
    "application/x-mpegURL",
    "audio/mpegurl",
  ])(
    "inspects a suffixless HLS response identified by %s",
    async (contentType) => {
      const { helper, inspectSources } = createHelper();
      const events: Array<{ source: { type: DownloadType; url: string } }> = [];
      helper.on("source", (event) => events.push(event));
      register(helper, "tab-hls", 808);

      electronMocks.listeners.get("persist:webview")?.({
        id: 44,
        requestHeaders: { Referer: "https://example.com/tab-hls" },
        url: "https://cdn.example.com/signed/play?id=1",
        webContentsId: 808,
      });
      const callback = vi.fn();
      electronMocks.responseListeners.get("persist:webview")?.(
        {
          id: 44,
          responseHeaders: { "Content-Type": [contentType] },
          url: "https://cdn.example.com/signed/play?id=1",
          webContentsId: 808,
        },
        callback,
      );

      expect(callback).toHaveBeenCalledWith({});
      expect(events).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(150);
      expect(events[0]?.source).toMatchObject({
        type: DownloadType.m3u8,
        url: "https://cdn.example.com/signed/play?id=1",
      });
      expect(inspectSources).toHaveBeenCalledWith({
        sources: [
          expect.objectContaining({
            url: "https://cdn.example.com/signed/play?id=1",
          }),
        ],
      });
    },
  );

  it("rejects late HLS inspection results after navigation", async () => {
    let resolveInspection!: (value: unknown) => void;
    const inspection = new Promise((resolve) => {
      resolveInspection = resolve;
    });
    const { helper, inspectSources } = createHelper();
    inspectSources.mockReturnValue(inspection);
    const events: unknown[] = [];
    helper.on("source", (event) => events.push(event));
    register(helper, "tab-a", 101);

    helper.send("tab-a", {
      documentURL: "https://example.com/tab-a",
      name: "Old page",
      type: DownloadType.m3u8,
      url: "https://cdn.example.com/old.m3u8",
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(events).toHaveLength(1);
    helper.update("tab-a", {
      title: "New page",
      url: "https://example.com/new",
    });
    resolveInspection({
      data: {
        sources: [
          {
            id: "hls-101-1",
            playlistType: "media",
            url: "https://cdn.example.com/old.m3u8",
            variants: [],
          },
        ],
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toHaveLength(1);
  });

  it("ignores generic media requests on X pages in favor of tweet candidates", async () => {
    const { helper, inspectSources } = createHelper();
    const events: unknown[] = [];
    helper.on("source", (event) => events.push(event));
    register(helper, "tab-x", 303);
    helper.update("tab-x", { title: "Home / X", url: "https://x.com/home" });

    const listener = electronMocks.listeners.get("persist:webview");
    listener?.({
      requestHeaders: { Referer: "https://x.com/home" },
      url: "https://video.twimg.com/ext_tw_video/example/video.mp4",
      webContentsId: 303,
    });
    listener?.({
      requestHeaders: { Referer: "https://x.com/home" },
      url: "https://video.twimg.com/amplify_video/example/playlist.m3u8",
      webContentsId: 303,
    });

    await vi.advanceTimersByTimeAsync(150);

    expect(events).toHaveLength(0);
    expect(inspectSources).not.toHaveBeenCalled();
  });

  it.each([
    "https://www.tiktok.com/foryou",
    "https://www.douyin.com/recommend",
  ])(
    "ignores raw media requests on supported short-video pages: %s",
    async (url) => {
      const { helper, inspectSources } = createHelper();
      const events: unknown[] = [];
      helper.on("source", (event) => events.push(event));
      register(helper, "tab-short-video", 404);
      helper.update("tab-short-video", { title: "Short video", url });

      const listener = electronMocks.listeners.get("persist:webview");
      listener?.({
        requestHeaders: { Referer: url },
        url: "https://media.example.com/video.mp4",
        webContentsId: 404,
      });
      listener?.({
        requestHeaders: { Referer: url },
        url: "https://media.example.com/master.m3u8",
        webContentsId: 404,
      });

      await vi.advanceTimersByTimeAsync(150);

      expect(events).toHaveLength(0);
      expect(inspectSources).not.toHaveBeenCalled();
    },
  );
});

describe("cookie-backed page types", () => {
  it.each([
    ["https://www.bilibili.com/video/BV1", DownloadType.bilibili],
    ["https://www.youtube.com/watch?v=video", DownloadType.youtube],
    ["https://x.com/openai/status/123", DownloadType.youtube],
    ["https://twitter.com/openai/status/123", DownloadType.youtube],
    [
      "https://www.tiktok.com/@creator/video/7480123456789012345",
      DownloadType.youtube,
    ],
    ["https://www.douyin.com/video/7480123456789012345", DownloadType.youtube],
    [
      "https://www.xiaohongshu.com/explore/66f00abc1234567890abcdef?xsec_token=token",
      DownloadType.xiaohongshu,
    ],
  ])("maps %s to %s", (url, type) => {
    expect(getCookieBackedType(url)).toBe(type);
  });

  it("does not classify an unrelated site", () => {
    expect(getCookieBackedType("https://example.com/video")).toBeUndefined();
  });
});

describe("SniffingHelper Agent collection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    electronMocks.listeners.clear();
    electronMocks.responseListeners.clear();
    electronMocks.sessions.clear();
  });

  it("waits for DOM ready and network quiet, then returns redacted headers", async () => {
    const { helper } = createHelper();
    register(helper, "agent-job", 303, "agent", false);
    const result = helper.collectAgent("agent-job", { timeoutMs: 20_000 });
    helper.send("agent-job", {
      documentURL: "https://example.com/watch",
      headers:
        "Referer:https://example.com/watch\nCookie:sentinel-cookie\nAuthorization:Bearer sentinel-auth",
      name: "Agent page",
      type: DownloadType.direct,
      url: "https://cdn.example.com/video.mp4",
    });

    await vi.advanceTimersByTimeAsync(5_000);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    helper.markDomReady("agent-job");
    await vi.advanceTimersByTimeAsync(1_499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const completed = await result;
    expect(completed.partial).toBe(false);
    expect(completed.sources).toHaveLength(1);
    expect(completed.sources[0].headers).toEqual([
      "Referer: https://example.com/watch",
    ]);
    expect(JSON.stringify(completed)).not.toContain("sentinel");
  });

  it("includes sensitive headers only after explicit session opt-in", async () => {
    const { helper } = createHelper();
    register(helper, "agent-private", 404, "agent", true);
    const result = helper.collectAgent("agent-private", { timeoutMs: 20_000 });
    helper.send("agent-private", {
      documentURL: "https://example.com/watch",
      headers: "Cookie:session=value\nProxy-Authorization:Basic private",
      name: "Private page",
      type: DownloadType.direct,
      url: "https://cdn.example.com/private.mp4",
    });
    helper.markDomReady("agent-private");
    await vi.advanceTimersByTimeAsync(1_500);

    expect((await result).sources[0].headers).toEqual([
      "Cookie: session=value",
      "Proxy-Authorization: Basic private",
    ]);
  });

  it("resets network quiet after each new source", async () => {
    const { helper } = createHelper();
    register(helper, "agent-quiet", 505, "agent");
    const result = helper.collectAgent("agent-quiet", { timeoutMs: 20_000 });
    helper.markDomReady("agent-quiet");
    await vi.advanceTimersByTimeAsync(1_000);
    helper.send("agent-quiet", {
      documentURL: "https://example.com/agent-quiet",
      name: "Quiet",
      type: DownloadType.direct,
      url: "https://cdn.example.com/video.mp4",
    });
    await vi.advanceTimersByTimeAsync(1_499);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ partial: false });
  });

  it("enforces hard timeout and cancellation", async () => {
    const { helper } = createHelper();
    register(helper, "agent-timeout", 606, "agent");
    const timedOut = helper.collectAgent("agent-timeout", { timeoutMs: 3_000 });
    const timeoutAssertion = expect(timedOut).rejects.toMatchObject({
      errorCode: "discovery_timeout",
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await timeoutAssertion;

    helper.unregister("agent-timeout");
    register(helper, "agent-cancel", 707, "agent");
    const controller = new AbortController();
    const cancelled = helper.collectAgent("agent-cancel", {
      signal: controller.signal,
      timeoutMs: 20_000,
    });
    const cancelAssertion =
      expect(cancelled).rejects.toBeInstanceOf(AgentCollectionError);
    controller.abort();
    await cancelAssertion;
  });

  it("returns collected sources as partial when the hard timeout expires", async () => {
    const { helper } = createHelper();
    register(helper, "agent-partial", 909, "agent");
    const result = helper.collectAgent("agent-partial", { timeoutMs: 3_000 });
    helper.send("agent-partial", {
      documentURL: "https://example.com/watch",
      name: "Partial result",
      type: DownloadType.direct,
      url: "https://cdn.example.com/video.mp4",
    });

    await vi.advanceTimersByTimeAsync(3_000);

    await expect(result).resolves.toMatchObject({
      partial: true,
      sources: [
        expect.objectContaining({
          url: "https://cdn.example.com/video.mp4",
        }),
      ],
    });
  });

  it("removes session listeners when the helper closes", () => {
    const { helper } = createHelper();
    register(helper, "tab-close", 818);
    const webRequest =
      electronMocks.sessions.get("persist:webview")?.webRequest;

    helper.close();

    expect(webRequest?.onSendHeaders).toHaveBeenLastCalledWith(null);
    expect(webRequest?.onHeadersReceived).toHaveBeenLastCalledWith(null);
    expect(electronMocks.listeners.has("persist:webview")).toBe(false);
    expect(electronMocks.responseListeners.has("persist:webview")).toBe(false);
  });

  it("drops a MIME-only HLS candidate when Core says the content is not HLS", async () => {
    const { helper, inspectSources } = createHelper();
    inspectSources.mockResolvedValue({
      data: {
        sources: [
          {
            error: "response is not an M3U8 playlist",
            errorCode: "not_hls",
            id: "hls-1001-1",
            playlistType: "unknown",
            url: "https://cdn.example.com/play",
            variants: [],
          },
        ],
      },
    });
    register(helper, "agent-mime-conflict", 1001, "agent");
    const result = helper.collectAgent("agent-mime-conflict", {
      timeoutMs: 20_000,
    });
    electronMocks.listeners.get("persist:webview")?.({
      id: 55,
      requestHeaders: {},
      url: "https://cdn.example.com/play",
      webContentsId: 1001,
    });
    electronMocks.responseListeners.get("persist:webview")?.(
      {
        id: 55,
        responseHeaders: {
          "content-type": ["application/vnd.apple.mpegurl"],
        },
        url: "https://cdn.example.com/play",
        webContentsId: 1001,
      },
      vi.fn(),
    );
    helper.markDomReady("agent-mime-conflict");

    await vi.advanceTimersByTimeAsync(150 + 1_500);

    await expect(result).resolves.toEqual({ partial: false, sources: [] });
  });

  it("drops an HLS-looking URL in Agent mode when its content is not HLS", async () => {
    const { helper, inspectSources } = createHelper();
    inspectSources.mockResolvedValue({
      data: {
        sources: [
          {
            error: "response is not an M3U8 playlist",
            errorCode: "not_hls",
            id: "hls-1101-1",
            playlistType: "unknown",
            url: "https://cdn.example.com/fake.m3u8",
            variants: [],
          },
        ],
      },
    });
    register(helper, "agent-url-conflict", 1101, "agent");
    const result = helper.collectAgent("agent-url-conflict", {
      timeoutMs: 20_000,
    });
    helper.send("agent-url-conflict", {
      documentURL: "https://example.com/watch",
      name: "Fake playlist",
      type: DownloadType.m3u8,
      url: "https://cdn.example.com/fake.m3u8",
    });
    helper.markDomReady("agent-url-conflict");

    await vi.advanceTimersByTimeAsync(150 + 1_500);

    await expect(result).resolves.toEqual({ partial: false, sources: [] });
  });
});
