import { describe, expect, it } from "vitest";

import type {
  BridgeDiscoveryCompleteParams,
  CreateDiscoveryParams,
  DiscoveryJob,
  DiscoverySource,
} from "../src/types";

describe("discovery public contracts", () => {
  it("keeps public jobs free of private request headers", () => {
    const input = {
      url: "https://example.com/watch/1",
      mode: "browser",
      timeoutMs: 20_000,
      useSessionCookies: false,
    } satisfies CreateDiscoveryParams;

    const source = {
      id: "source-1",
      url: "https://cdn.example.com/master.m3u8",
      pageUrl: input.url,
      title: "Example",
      type: "m3u8",
      playlistType: "master",
      variants: [],
      detectedAt: "2026-08-26T00:00:00Z",
    } satisfies DiscoverySource;

    const job = {
      id: "discovery-1",
      input,
      status: "completed",
      sources: [source],
      partial: false,
      createdAt: "2026-08-26T00:00:00Z",
      completedAt: "2026-08-26T00:00:01Z",
      expiresAt: "2026-08-26T00:10:01Z",
    } satisfies DiscoveryJob;

    expect(job.sources[0]).not.toHaveProperty("headers");
  });

  it("keeps bridge-only headers on the private completion contract", () => {
    const completion = {
      sources: [
        {
          id: "source-1",
          url: "https://cdn.example.com/master.m3u8",
          pageUrl: "https://example.com/watch/1",
          title: "Example",
          type: "m3u8",
          detectedAt: "2026-08-26T00:00:00Z",
          headers: ["Cookie: secret"],
        },
      ],
      partial: false,
    } satisfies BridgeDiscoveryCompleteParams;

    expect(completion.sources[0].headers).toHaveLength(1);
  });
});
