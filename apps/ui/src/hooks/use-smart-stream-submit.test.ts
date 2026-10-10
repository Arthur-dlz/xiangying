import type { DiscoveryJob, SourceInspection } from "@mediago/core-sdk";
import { describe, expect, it, vi } from "vitest";
import { runSmartStreamDiscovery } from "./use-smart-stream-submit";

const inspection = (
  overrides: Partial<SourceInspection> = {},
): SourceInspection => ({
  id: "homepage-source",
  url: "https://media.example/play",
  playlistType: "media",
  variants: [],
  ...overrides,
});

const job = (overrides: Partial<DiscoveryJob> = {}): DiscoveryJob => ({
  id: "job-1",
  input: { url: "https://example.com/watch", mode: "browser" },
  status: "completed",
  sources: [],
  partial: false,
  createdAt: new Date(0).toISOString(),
  expiresAt: new Date(60_000).toISOString(),
  ...overrides,
});

describe("runSmartStreamDiscovery", () => {
  it("returns a direct HLS source without starting browser discovery", async () => {
    const inspect = vi
      .fn()
      .mockResolvedValue(
        inspection({ url: "https://cdn.example/final/stream" }),
      );
    const createDiscovery = vi.fn();

    const result = await runSmartStreamDiscovery(
      { headers: [], isWeb: false, url: "https://media.example/play" },
      { createDiscovery, getDiscovery: vi.fn(), inspect, wait: vi.fn() },
    );
    expect(result).toMatchObject({
      kind: "sources",
      sources: [
        { id: "homepage-source", url: "https://cdn.example/final/stream" },
      ],
    });
    expect(result.discoveryId).toBeUndefined();
    expect(createDiscovery).not.toHaveBeenCalled();
  });

  it("falls through from HTML inspection to browser discovery", async () => {
    const controller = new AbortController();
    const onDiscoveryCreated = vi.fn();
    const createDiscovery = vi
      .fn()
      .mockResolvedValue(job({ status: "pending" }));
    const getDiscovery = vi.fn().mockResolvedValue(
      job({
        sources: [
          {
            id: "source-1",
            url: "https://cdn.example.com/stream",
            pageUrl: "https://example.com/watch",
            title: "Episode",
            type: "m3u8",
            detectedAt: new Date(0).toISOString(),
          },
        ],
      }),
    );

    await expect(
      runSmartStreamDiscovery(
        {
          headers: [],
          isWeb: false,
          onDiscoveryCreated,
          signal: controller.signal,
          url: "https://example.com/watch",
        },
        {
          createDiscovery,
          getDiscovery,
          inspect: vi.fn().mockResolvedValue(
            inspection({
              error: "response is not an M3U8 playlist",
              errorCode: "not_hls",
              playlistType: "unknown",
            }),
          ),
          wait: vi.fn(),
        },
      ),
    ).resolves.toMatchObject({
      kind: "sources",
      discoveryId: "job-1",
      sources: [{ id: "source-1" }],
    });
    expect(createDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "browser", useSessionCookies: true }),
      expect.any(AbortSignal),
    );
    expect(onDiscoveryCreated).toHaveBeenCalledExactlyOnceWith("job-1");
  });

  it("returns fallback in web mode or when desktop discovery has no resources", async () => {
    const inspect = vi
      .fn()
      .mockResolvedValue(
        inspection({ error: "not HLS", errorCode: "not_hls" }),
      );
    await expect(
      runSmartStreamDiscovery(
        { headers: [], isWeb: true, url: "https://example.com/watch" },
        {
          createDiscovery: vi.fn(),
          getDiscovery: vi.fn(),
          inspect,
          wait: vi.fn(),
        },
      ),
    ).resolves.toMatchObject({ kind: "fallback", reason: "not_hls" });

    await expect(
      runSmartStreamDiscovery(
        { headers: [], isWeb: false, url: "https://example.com/watch" },
        {
          createDiscovery: vi.fn().mockResolvedValue(job()),
          getDiscovery: vi.fn(),
          inspect,
          wait: vi.fn(),
        },
      ),
    ).resolves.toMatchObject({ kind: "fallback", discoveryId: "job-1" });
  });

  it("does not start hidden browser discovery when the interactive window owns webpage sniffing", async () => {
    const createDiscovery = vi.fn();

    await expect(
      runSmartStreamDiscovery(
        {
          allowBrowserDiscovery: false,
          headers: [],
          isWeb: false,
          url: "https://example.com/watch",
        },
        {
          createDiscovery,
          getDiscovery: vi.fn(),
          inspect: vi.fn().mockResolvedValue(
            inspection({
              error: "not HLS",
              errorCode: "not_hls",
              playlistType: "unknown",
            }),
          ),
          wait: vi.fn(),
        },
      ),
    ).resolves.toMatchObject({ kind: "fallback", reason: "not_hls" });
    expect(createDiscovery).not.toHaveBeenCalled();
  });

  it("keeps partial resources returned by a failed discovery", async () => {
    await expect(
      runSmartStreamDiscovery(
        { headers: [], isWeb: false, url: "https://example.com/watch" },
        {
          createDiscovery: vi.fn().mockResolvedValue(
            job({
              status: "failed",
              partial: true,
              sources: [
                {
                  id: "source-partial",
                  url: "https://cdn.example.com/partial",
                  pageUrl: "https://example.com/watch",
                  title: "Partial",
                  type: "direct",
                  detectedAt: new Date(0).toISOString(),
                },
              ],
            }),
          ),
          getDiscovery: vi.fn(),
          inspect: vi
            .fn()
            .mockResolvedValue(
              inspection({ error: "not HLS", errorCode: "not_hls" }),
            ),
          wait: vi.fn(),
        },
      ),
    ).resolves.toMatchObject({
      kind: "sources",
      partial: true,
      sources: [{ id: "source-partial" }],
    });
  });
});
