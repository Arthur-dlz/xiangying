import settingsPromoPreviewImageUrl from "../../../../remote-config/assets/settings-promo-drama.webp?url";
import settingsPromoSidebarPreviewImageUrl from "../../../../remote-config/assets/settings-promo-drama-sidebar.webp?url";

export const SETTINGS_PROMO_URL =
  import.meta.env.APP_SETTINGS_PROMO_URL ||
  "https://raw.githubusercontent.com/mediago-dev/mediago/master/remote-config/settings-promo.json";

const CACHE_KEY = "mediago.settings-promo.cache.v5";
const CACHE_SCHEMA_VERSION = 5;
const DEFAULT_CACHE_SECONDS = 30 * 60;
const MIN_CACHE_SECONDS = 60;
const MAX_CACHE_SECONDS = 24 * 60 * 60;
const REQUEST_TIMEOUT_MS = 2_500;
const SUPPORTED_LOCALES = ["en", "zh", "it"] as const;
const SUPPORTED_PLATFORMS = ["electron", "web"] as const;

export type SettingsPromoLocale = (typeof SUPPORTED_LOCALES)[number];
export type SettingsPromoPlatform = (typeof SUPPORTED_PLATFORMS)[number];

export interface SettingsPromoContent {
  imageUrl: string;
  sidebarImageUrl: string;
  title: string;
  buttonText: string;
}

export interface SettingsPromoManifest {
  schemaVersion: 5;
  enabled: boolean;
  campaignId: string;
  cacheSeconds: number;
  actionUrl: string;
  startsAt?: string;
  endsAt?: string;
  minVersion?: string;
  maxVersion?: string;
  platforms?: SettingsPromoPlatform[];
  content: Partial<Record<SettingsPromoLocale, SettingsPromoContent>>;
}

interface CachedSettingsPromo {
  schemaVersion: 5;
  sourceUrl: string;
  fetchedAt: number;
  manifest: SettingsPromoManifest;
}

interface LoadSettingsPromoOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximumLength
  );
}

function parseHttpsUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

function parseDate(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return value;
}

function parseVersion(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(value)) {
    return null;
  }
  return value;
}

function parseContent(
  value: unknown,
  source: URL,
): SettingsPromoManifest["content"] | null {
  if (!isRecord(value)) return null;

  const content: SettingsPromoManifest["content"] = {};
  for (const locale of SUPPORTED_LOCALES) {
    const candidate = value[locale];
    if (candidate === undefined) continue;
    if (!isRecord(candidate)) return null;

    const imageUrl = parseHttpsUrl(candidate.imageUrl);
    const sidebarImageUrl =
      candidate.sidebarImageUrl === undefined
        ? imageUrl
        : parseHttpsUrl(candidate.sidebarImageUrl);
    if (
      !imageUrl ||
      imageUrl.origin !== source.origin ||
      !sidebarImageUrl ||
      sidebarImageUrl.origin !== source.origin
    ) {
      return null;
    }
    if (!isBoundedText(candidate.title, 100)) return null;
    if (!isBoundedText(candidate.buttonText, 40)) return null;

    content[locale] = {
      imageUrl: imageUrl.href,
      sidebarImageUrl: sidebarImageUrl.href,
      title: candidate.title,
      buttonText: candidate.buttonText,
    };
  }

  return Object.keys(content).length > 0 ? content : null;
}

function parsePlatforms(
  value: unknown,
): SettingsPromoPlatform[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) return null;
  const platforms = value.filter(
    (platform): platform is SettingsPromoPlatform =>
      typeof platform === "string" &&
      SUPPORTED_PLATFORMS.includes(platform as SettingsPromoPlatform),
  );
  if (platforms.length !== value.length) return null;
  return [...new Set(platforms)];
}

export function parseSettingsPromoManifest(
  value: unknown,
  sourceUrl = SETTINGS_PROMO_URL,
): SettingsPromoManifest | null {
  if (!isRecord(value) || value.schemaVersion !== 5) return null;
  if (typeof value.enabled !== "boolean") return null;
  if (!isBoundedText(value.campaignId, 80)) return null;

  const source = parseHttpsUrl(sourceUrl);
  const actionUrl = parseHttpsUrl(value.actionUrl);
  const content = source ? parseContent(value.content, source) : null;
  const startsAt = parseDate(value.startsAt);
  const endsAt = parseDate(value.endsAt);
  const minVersion = parseVersion(value.minVersion);
  const maxVersion = parseVersion(value.maxVersion);
  const platforms = parsePlatforms(value.platforms);
  if (
    !source ||
    !actionUrl ||
    !content ||
    startsAt === null ||
    endsAt === null ||
    minVersion === null ||
    maxVersion === null ||
    platforms === null
  ) {
    return null;
  }

  const cacheSeconds =
    value.cacheSeconds === undefined
      ? DEFAULT_CACHE_SECONDS
      : value.cacheSeconds;
  if (
    typeof cacheSeconds !== "number" ||
    !Number.isInteger(cacheSeconds) ||
    cacheSeconds < MIN_CACHE_SECONDS ||
    cacheSeconds > MAX_CACHE_SECONDS
  ) {
    return null;
  }

  return {
    schemaVersion: 5,
    enabled: value.enabled,
    campaignId: value.campaignId,
    cacheSeconds,
    actionUrl: actionUrl.href,
    content,
    ...(startsAt ? { startsAt } : {}),
    ...(endsAt ? { endsAt } : {}),
    ...(minVersion ? { minVersion } : {}),
    ...(maxVersion ? { maxVersion } : {}),
    ...(platforms ? { platforms } : {}),
  };
}

function numericVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: string, right: string): number | null {
  const leftParts = numericVersion(left);
  const rightParts = numericVersion(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

export function isSettingsPromoEligible(
  manifest: SettingsPromoManifest,
  options: {
    appVersion: string;
    now: number;
    platform: SettingsPromoPlatform;
  },
): boolean {
  if (!manifest.enabled) return false;
  if (manifest.platforms && !manifest.platforms.includes(options.platform)) {
    return false;
  }
  if (manifest.startsAt && options.now < Date.parse(manifest.startsAt)) {
    return false;
  }
  if (manifest.endsAt && options.now >= Date.parse(manifest.endsAt)) {
    return false;
  }
  if (manifest.minVersion) {
    const comparison = compareVersions(options.appVersion, manifest.minVersion);
    if (comparison === null || comparison < 0) return false;
  }
  if (manifest.maxVersion) {
    const comparison = compareVersions(options.appVersion, manifest.maxVersion);
    if (comparison === null || comparison > 0) return false;
  }
  return true;
}

export function selectSettingsPromoContent(
  manifest: SettingsPromoManifest,
  language: string,
): SettingsPromoContent | null {
  const normalizedLanguage = language.toLowerCase();
  const locale: SettingsPromoLocale = normalizedLanguage.startsWith("zh")
    ? "zh"
    : normalizedLanguage.startsWith("it")
      ? "it"
      : "en";
  return (
    manifest.content[locale] ??
    manifest.content.en ??
    manifest.content.zh ??
    manifest.content.it ??
    null
  );
}

function browserStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readCache(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  sourceUrl: string,
): CachedSettingsPromo | null {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(CACHE_KEY) || "null") as unknown;
    if (
      !isRecord(value) ||
      value.schemaVersion !== CACHE_SCHEMA_VERSION ||
      value.sourceUrl !== sourceUrl ||
      typeof value.fetchedAt !== "number"
    ) {
      return null;
    }
    const manifest = parseSettingsPromoManifest(value.manifest, sourceUrl);
    if (!manifest) return null;
    return {
      schemaVersion: 5,
      sourceUrl,
      fetchedAt: value.fetchedAt,
      manifest,
    };
  } catch {
    return null;
  }
}

function writeCache(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  value: CachedSettingsPromo,
): void {
  if (!storage) return;
  try {
    storage.setItem(CACHE_KEY, JSON.stringify(value));
  } catch {
    // A valid remote promotion can still be displayed when storage is unavailable.
  }
}

export async function loadSettingsPromoManifest(
  sourceUrl = SETTINGS_PROMO_URL,
  options: LoadSettingsPromoOptions = {},
): Promise<SettingsPromoManifest | null> {
  // Temporary local preview. Remove after the promotion artwork is approved.
  if (
    import.meta.env.DEV &&
    sourceUrl === SETTINGS_PROMO_URL &&
    options.fetcher === undefined
  ) {
    return {
      schemaVersion: 5,
      enabled: true,
      campaignId: "local-drama-preview-v1",
      cacheSeconds: 900,
      actionUrl:
        "https://mediago.torchstellar.com/?utm_source=mediago&utm_medium=in_app_promo&utm_campaign=drama_launch_2026_08",
      platforms: ["electron", "web"],
      content: {
        zh: {
          imageUrl: settingsPromoPreviewImageUrl,
          sidebarImageUrl: settingsPromoSidebarPreviewImageUrl,
          title: "一站式 AI 漫剧创作工作台",
          buttonText: "立即体验",
        },
        en: {
          imageUrl: settingsPromoPreviewImageUrl,
          sidebarImageUrl: settingsPromoSidebarPreviewImageUrl,
          title: "All-in-one AI comic-drama workspace",
          buttonText: "Try Drama",
        },
        it: {
          imageUrl: settingsPromoPreviewImageUrl,
          sidebarImageUrl: settingsPromoSidebarPreviewImageUrl,
          title: "Workspace AI per comic drama",
          buttonText: "Prova Drama",
        },
      },
    };
  }

  const now = options.now ?? Date.now;
  const storage =
    options.storage === undefined ? browserStorage() : options.storage;
  const cached = readCache(storage, sourceUrl);
  if (
    cached &&
    now() - cached.fetchedAt < cached.manifest.cacheSeconds * 1_000
  ) {
    return cached.manifest;
  }

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await (options.fetcher ?? fetch)(sourceUrl, {
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "application/json" },
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok) return cached?.manifest ?? null;
    const manifest = parseSettingsPromoManifest(
      await response.json(),
      sourceUrl,
    );
    if (!manifest) return cached?.manifest ?? null;
    writeCache(storage, {
      schemaVersion: 5,
      sourceUrl,
      fetchedAt: now(),
      manifest,
    });
    return manifest;
  } catch {
    return cached?.manifest ?? null;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
