export const MAX_SMART_STREAM_SOURCES = 20;

export type SmartStreamSubmitTarget = "local" | "docker";

export interface SubmissionIntent {
  startDownload: boolean;
  target: SmartStreamSubmitTarget;
}

export type SmartStreamSubmitPhase =
  | "editing"
  | "probing"
  | "discovering"
  | "selecting"
  | "creating";

export interface SmartStreamSubmitState {
  intent?: SubmissionIntent;
  phase: SmartStreamSubmitPhase;
  reason?: string;
  startedAt?: number;
}

export type SmartStreamSubmitEvent =
  | { type: "submit"; intent: SubmissionIntent; startedAt: number }
  | { type: "probeFoundHls" }
  | { type: "probeNeedsDiscovery" }
  | { type: "sourcesFound" }
  | { type: "create" }
  | { type: "createFailed"; reason: string }
  | { type: "cancel" }
  | { type: "expire" }
  | { type: "fail"; reason: string }
  | { type: "reset" };

export interface SmartStreamSourceInput {
  headers?: string[];
  id: string;
  playlistType?: "master" | "media" | "unknown";
  quality?: string;
  title?: string;
  type?: "m3u8" | "bilibili" | "direct" | "mediago" | "youtube" | "xiaohongshu";
  url: string;
  variants?: SmartStreamVariant[];
}

export interface SmartStreamVariant {
  bandwidth?: number;
  codecs?: string;
  height?: number;
  quality?: string;
  url: string;
  width?: number;
}

export interface PreparedSmartStreamSource extends SmartStreamSourceInput {
  available: boolean;
  name: string;
  unavailableReason?: "duplicate";
}

export interface PrepareSmartStreamSourcesOptions {
  existingUrls?: ReadonlySet<string>;
  maxSources?: number;
  requestedName?: string;
}

export function createSmartStreamSubmitState(): SmartStreamSubmitState {
  return { phase: "editing" };
}

function assertPhase(
  state: SmartStreamSubmitState,
  event: SmartStreamSubmitEvent,
  expected: SmartStreamSubmitPhase,
): void {
  if (state.phase !== expected) {
    throw new Error(
      `Cannot handle ${event.type} while smart stream submission is ${state.phase}`,
    );
  }
}

export function transitionSmartStreamSubmit(
  state: SmartStreamSubmitState,
  event: SmartStreamSubmitEvent,
): SmartStreamSubmitState {
  switch (event.type) {
    case "submit":
      assertPhase(state, event, "editing");
      return {
        intent: event.intent,
        phase: "probing",
        startedAt: event.startedAt,
      };
    case "probeFoundHls":
      assertPhase(state, event, "probing");
      return { ...state, phase: "selecting", reason: undefined };
    case "probeNeedsDiscovery":
      assertPhase(state, event, "probing");
      return { ...state, phase: "discovering", reason: undefined };
    case "sourcesFound":
      assertPhase(state, event, "discovering");
      return { ...state, phase: "selecting", reason: undefined };
    case "create":
      assertPhase(state, event, "selecting");
      return { ...state, phase: "creating", reason: undefined };
    case "createFailed":
      assertPhase(state, event, "creating");
      return { ...state, phase: "selecting", reason: event.reason };
    case "cancel":
      return { ...state, phase: "editing", reason: "cancelled" };
    case "expire":
      return { ...state, phase: "editing", reason: "expired" };
    case "fail":
      return { ...state, phase: "editing", reason: event.reason };
    case "reset":
      return createSmartStreamSubmitState();
  }
}

function sourceName(
  source: SmartStreamSourceInput,
  index: number,
  count: number,
  requestedName?: string,
): string {
  const requested = requestedName?.trim();
  const fallback = source.title?.trim() || "Media";
  if (count === 1) return requested || fallback;

  const base = requested || fallback;
  return `${base} - ${source.quality?.trim() || index + 1}`;
}

function playlistRank(source: SmartStreamSourceInput): number {
  if (source.playlistType === "master") return 0;
  if (source.playlistType === "media") return 1;
  return 2;
}

export function prepareSmartStreamSources(
  inputs: readonly SmartStreamSourceInput[],
  options: PrepareSmartStreamSourcesOptions = {},
): PreparedSmartStreamSource[] {
  const maxSources = Math.max(
    0,
    Math.min(
      options.maxSources ?? MAX_SMART_STREAM_SOURCES,
      MAX_SMART_STREAM_SOURCES,
    ),
  );
  const masterVariantURLs = new Set(
    inputs
      .filter((input) => input.playlistType === "master")
      .flatMap((input) => input.variants ?? [])
      .map((variant) => variant.url.trim())
      .filter(Boolean),
  );
  // oxlint-disable-next-line unicorn/no-array-sort -- The spread creates a copy; ES2023 toSorted is outside the UI target.
  const prioritizedInputs = [...inputs].sort(
    (left, right) => playlistRank(left) - playlistRank(right),
  );
  const seen = new Set<string>();
  const unique: SmartStreamSourceInput[] = [];

  for (const input of prioritizedInputs) {
    const url = input.url.trim();
    if (
      !url ||
      seen.has(url) ||
      (input.playlistType !== "master" && masterVariantURLs.has(url))
    )
      continue;
    seen.add(url);
    unique.push({ ...input, url });
    if (unique.length >= maxSources) break;
  }

  const prepared: PreparedSmartStreamSource[] = [];
  for (const [index, source] of unique.entries()) {
    const duplicate = options.existingUrls?.has(source.url) ?? false;
    prepared.push({
      ...source,
      available: !duplicate,
      name: sourceName(source, index, unique.length, options.requestedName),
      ...(duplicate ? { unavailableReason: "duplicate" as const } : {}),
    });
  }
  return prepared;
}

function variantHeight(variant: SmartStreamVariant): number {
  if (variant.height && variant.height > 0) return variant.height;
  const quality = variant.quality?.trim().match(/^(\d+)p$/i);
  return quality ? Number(quality[1]) : 0;
}

export function selectableSmartStreamVariants(
  source: SmartStreamSourceInput,
): SmartStreamVariant[] {
  const seen = new Set<string>();
  const variants = (source.variants ?? []).filter((variant) => {
    const url = variant.url.trim();
    if (!url || url === source.url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
  // oxlint-disable-next-line unicorn/no-array-sort -- The spread creates a copy; ES2023 toSorted is outside the UI target.
  return [...variants].sort(
    (left, right) =>
      variantHeight(right) - variantHeight(left) ||
      (right.bandwidth ?? 0) - (left.bandwidth ?? 0),
  );
}

function formatVariantBandwidth(bandwidth?: number): string | undefined {
  if (!bandwidth || bandwidth <= 0) return undefined;
  if (bandwidth >= 1_000_000) {
    const mbps = bandwidth / 1_000_000;
    return `${Number(mbps.toFixed(1))} Mbps`;
  }
  return `${Math.round(bandwidth / 1_000)} kbps`;
}

export function formatSmartStreamVariant(variant: SmartStreamVariant): string {
  const quality =
    variant.quality?.trim() ||
    (variantHeight(variant) > 0 ? `${variantHeight(variant)}p` : undefined);
  const resolution =
    variant.width && variant.height
      ? `${variant.width}\u00d7${variant.height}`
      : undefined;
  const bandwidth = formatVariantBandwidth(variant.bandwidth);
  const codecs = variant.codecs?.trim();
  return [quality, resolution, bandwidth, codecs]
    .filter(Boolean)
    .join(" \u00b7 ");
}

export function selectedSmartStreamSourceURL(
  source: SmartStreamSourceInput,
  variantURLs: Readonly<Record<string, string>>,
): string {
  const selectedURL = variantURLs[source.id];
  if (
    selectedURL &&
    selectableSmartStreamVariants(source).some(
      (variant) => variant.url === selectedURL,
    )
  ) {
    return selectedURL;
  }
  return source.url;
}
