import { expect, test } from "vitest";
import {
  createSmartStreamSubmitState,
  formatSmartStreamVariant,
  prepareSmartStreamSources,
  selectableSmartStreamVariants,
  selectedSmartStreamSourceURL,
  transitionSmartStreamSubmit,
} from "./smart-stream-submit-logic";

const intent = {
  startDownload: true,
  target: "docker" as const,
};

test("preserves the submission intent through probing and discovery", () => {
  const editing = createSmartStreamSubmitState();
  const probing = transitionSmartStreamSubmit(editing, {
    type: "submit",
    intent,
    startedAt: 1_000,
  });
  const discovering = transitionSmartStreamSubmit(probing, {
    type: "probeNeedsDiscovery",
  });
  const selecting = transitionSmartStreamSubmit(discovering, {
    type: "sourcesFound",
  });
  const creating = transitionSmartStreamSubmit(selecting, {
    type: "create",
  });

  expect(probing).toMatchObject({ phase: "probing", intent });
  expect(discovering).toMatchObject({ phase: "discovering", intent });
  expect(selecting).toMatchObject({ phase: "selecting", intent });
  expect(creating).toMatchObject({ phase: "creating", intent });
  expect(
    transitionSmartStreamSubmit(creating, {
      type: "createFailed",
      reason: "remote unavailable",
    }),
  ).toMatchObject({
    phase: "selecting",
    intent,
    reason: "remote unavailable",
  });
});

test("moves a direct HLS probe to source selection", () => {
  const probing = transitionSmartStreamSubmit(createSmartStreamSubmitState(), {
    type: "submit",
    intent,
    startedAt: 1_000,
  });

  expect(
    transitionSmartStreamSubmit(probing, { type: "probeFoundHls" }),
  ).toMatchObject({ phase: "selecting", intent });
});

test("cancel, failure, and expiry return to editing without losing context", () => {
  const probing = transitionSmartStreamSubmit(createSmartStreamSubmitState(), {
    type: "submit",
    intent,
    startedAt: 1_000,
  });
  const discovering = transitionSmartStreamSubmit(probing, {
    type: "probeNeedsDiscovery",
  });

  expect(
    transitionSmartStreamSubmit(discovering, { type: "cancel" }),
  ).toMatchObject({ phase: "editing", intent, reason: "cancelled" });
  expect(
    transitionSmartStreamSubmit(discovering, {
      type: "fail",
      reason: "network error",
    }),
  ).toMatchObject({ phase: "editing", intent, reason: "network error" });
  expect(
    transitionSmartStreamSubmit(discovering, { type: "expire" }),
  ).toMatchObject({ phase: "editing", intent, reason: "expired" });
});

test("deduplicates sources, limits them, and disables existing task URLs", () => {
  const inputs = Array.from({ length: 22 }, (_, index) => ({
    id: `source-${index}`,
    url: `https://media.example/${index}`,
    quality: index === 0 ? "1080p" : undefined,
  }));
  inputs.splice(1, 0, {
    id: "duplicate",
    url: "https://media.example/0",
    quality: "1080p",
  });

  const sources = prepareSmartStreamSources(inputs, {
    existingUrls: new Set(["https://media.example/2"]),
    requestedName: "Episode",
  });

  expect(sources).toHaveLength(20);
  expect(sources.map(({ url }) => url)).toHaveLength(
    new Set(sources.map(({ url }) => url)).size,
  );
  expect(sources[0]).toMatchObject({
    available: true,
    name: "Episode - 1080p",
  });
  expect(sources[2]).toMatchObject({
    available: false,
    unavailableReason: "duplicate",
  });
});

test("uses the requested name unchanged for a single source", () => {
  expect(
    prepareSmartStreamSources(
      [{ id: "only", url: "https://media.example/play" }],
      { requestedName: "Episode" },
    ),
  ).toStrictEqual([
    {
      available: true,
      id: "only",
      name: "Episode",
      url: "https://media.example/play",
    },
  ]);
});

test("prioritizes an HLS master and folds its separately detected variants", () => {
  const sources = prepareSmartStreamSources([
    {
      id: "variant",
      playlistType: "media",
      url: "https://media.example/720",
    },
    {
      id: "master",
      playlistType: "master",
      url: "https://media.example/master",
      variants: [{ url: "https://media.example/720" }],
    },
    {
      id: "other",
      playlistType: "media",
      url: "https://media.example/other",
    },
  ]);

  expect(sources.map((source) => source.id)).toStrictEqual(["master", "other"]);
});

test("sorts HLS variants by quality and formats useful selection metadata", () => {
  const source = {
    id: "master",
    url: "https://media.example/master",
    variants: [
      {
        url: "https://media.example/720",
        quality: "720p",
        width: 1280,
        height: 720,
        bandwidth: 2_800_000,
        codecs: "avc1.4d401f,mp4a.40.2",
      },
      {
        url: "https://media.example/1080",
        quality: "1080p",
        width: 1920,
        height: 1080,
        bandwidth: 5_000_000,
      },
    ],
  };

  const variants = selectableSmartStreamVariants(source);
  expect(variants.map((variant) => variant.quality)).toStrictEqual([
    "1080p",
    "720p",
  ]);
  expect(formatSmartStreamVariant(variants[0])).toBe(
    "1080p · 1920×1080 · 5 Mbps",
  );
  expect(formatSmartStreamVariant(variants[1])).toBe(
    "720p · 1280×720 · 2.8 Mbps · avc1.4d401f,mp4a.40.2",
  );
});

test("uses only a variant advertised by the selected master source", () => {
  const source = {
    id: "master",
    url: "https://media.example/master",
    variants: [{ url: "https://media.example/720", quality: "720p" }],
  };

  expect(
    selectedSmartStreamSourceURL(source, {
      master: "https://media.example/720",
    }),
  ).toBe("https://media.example/720");
  expect(
    selectedSmartStreamSourceURL(source, {
      master: "https://attacker.example/not-advertised",
    }),
  ).toBe(source.url);
});
