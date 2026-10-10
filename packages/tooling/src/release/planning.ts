import type {
  ParsedSemVer,
  ReleaseChannel,
  ReleasePlan,
  ReleasePlanInput,
  VersionIncrement,
} from "./contracts.ts";
import {
  compareSemVer,
  formatSemVer,
  hasSameSemVerCore,
  isNumericIdentifier,
  parseSemVer,
} from "./semver.ts";
import {
  assertTagAvailable,
  findHighestTag,
  nextPrereleaseNumber,
  parseVersionTags,
} from "./tags.ts";

export function bumpCore(
  base: ParsedSemVer,
  increment: VersionIncrement,
): ParsedSemVer {
  const next = {
    major: base.major,
    minor: base.minor,
    patch: base.patch,
    prerelease: [],
    build: [],
  } satisfies ParsedSemVer;

  if (increment === "major") {
    next.major += 1;
    next.minor = 0;
    next.patch = 0;
  } else if (increment === "minor") {
    next.minor += 1;
    next.patch = 0;
  } else {
    next.patch += 1;
  }
  if (![next.major, next.minor, next.patch].every(Number.isSafeInteger)) {
    throw new Error("Calculated version exceeds the safe integer range");
  }
  return next;
}

export function validateChannelVersion(
  version: ParsedSemVer,
  channel: ReleaseChannel,
): void {
  if (channel === "latest") {
    if (version.prerelease.length !== 0) {
      throw new Error(
        `Pending version ${formatSemVer(version)} does not match channel latest`,
      );
    }
    return;
  }

  if (
    version.prerelease.length !== 2 ||
    version.prerelease[0] !== channel ||
    !isNumericIdentifier(version.prerelease[1])
  ) {
    throw new Error(
      `Pending version ${formatSemVer(version)} must use ${channel}.N`,
    );
  }
  if (!Number.isSafeInteger(Number(version.prerelease[1]))) {
    throw new Error(
      `Prerelease number exceeds the safe integer range: ${formatSemVer(version)}`,
    );
  }
}

export function planRelease(input: ReleasePlanInput): ReleasePlan {
  const current = parseSemVer(input.currentVersion);
  const currentVersion = formatSemVer(current);
  const parsedTags = parseVersionTags(input.tags);
  const latestStableTag = findHighestTag(
    parsedTags,
    (tag) => tag.version.prerelease.length === 0,
  );

  if (latestStableTag === null) {
    throw new Error(
      "No stable SemVer tag found; set the initial product version before releasing",
    );
  }
  assertNoDuplicateVersions(parsedTags.map((tag) => formatSemVer(tag.version)));
  const requestedCore = bumpCore(latestStableTag.version, input.increment);
  assertSupportedOfficialPrereleases(parsedTags, requestedCore);

  if (input.channel === "test") {
    const testVersions = (input.testVersions ?? []).map((version) => {
      const parsed = parseSemVer(version);
      validateChannelVersion(parsed, "test");
      if (parsed.build.length !== 0) {
        throw new Error(
          `Private test version cannot use build metadata: ${version}`,
        );
      }
      return parsed;
    });
    assertNoDuplicateVersions(testVersions.map(formatSemVer));
    const next = nextPrivateTestNumber(testVersions, requestedCore);
    const candidate = {
      ...requestedCore,
      prerelease: ["test", String(next)],
    } satisfies ParsedSemVer;
    const version = formatSemVer(candidate);
    return {
      currentVersion,
      version,
      tag: "",
      baseVersion: formatSemVer(latestStableTag.version),
      changed: false,
      pending: false,
      resumed: false,
    };
  }

  if (compareSemVer(current, latestStableTag.version) < 0) {
    throw new Error(
      `Product version ${currentVersion} is behind latest stable tag ${latestStableTag.name}`,
    );
  }

  const currentOfficialTag = parsedTags.find(
    (tag) => compareSemVer(current, tag.version) === 0,
  );
  const locked = resolveLockedOfficialCore(
    current,
    latestStableTag.version,
    currentOfficialTag !== undefined,
  );
  if (locked && !hasSameSemVerCore(locked.core, requestedCore)) {
    const requiredIncrement = matchingIncrement(
      latestStableTag.version,
      locked.core,
    );
    throw new Error(
      `version_increment '${input.increment}' selects ${formatCore(requestedCore)}, ` +
        `but committed version ${currentVersion} locks the official core to ${formatCore(locked.core)}` +
        (requiredIncrement
          ? `; select version_increment '${requiredIncrement}'`
          : ""),
    );
  }

  if (locked?.kind === "stable") {
    if (input.channel !== "latest") {
      throw new Error(
        `Committed stable version ${currentVersion} can only be resumed with channel latest`,
      );
    }
    assertTagAvailable(currentVersion, input.tags);
    return releasePlan(currentVersion, currentVersion, latestStableTag, true);
  }

  const targetCore = locked?.core ?? requestedCore;
  assertSupportedOfficialPrereleases(parsedTags, targetCore);
  if (
    locked?.kind === "beta" &&
    currentOfficialTag === undefined &&
    input.channel === "beta"
  ) {
    assertTagAvailable(currentVersion, input.tags);
    return releasePlan(currentVersion, currentVersion, latestStableTag, true);
  }

  const candidate: ParsedSemVer = {
    ...targetCore,
    prerelease: [],
    build: [],
  };
  if (input.channel === "beta") {
    candidate.prerelease = [
      "beta",
      String(nextPrereleaseNumber(parsedTags, candidate, "beta")),
    ];
  }
  const version = formatSemVer(candidate);
  assertTagAvailable(version, input.tags);
  return releasePlan(currentVersion, version, latestStableTag, false);
}

export function planResumedRelease(
  currentVersion: string,
  channel: ReleaseChannel,
): ReleasePlan {
  const current = parseSemVer(currentVersion);
  validateChannelVersion(current, channel);
  return {
    currentVersion,
    version: currentVersion,
    tag: `v${currentVersion}`,
    baseVersion: `${current.major}.${current.minor}.${current.patch}`,
    changed: false,
    pending: true,
    resumed: true,
  };
}

function resolveLockedOfficialCore(
  current: ParsedSemVer,
  latestStable: ParsedSemVer,
  currentTagExists: boolean,
): { core: ParsedSemVer; kind: "beta" | "stable" } | undefined {
  if (current.prerelease.length === 0) {
    if (compareSemVer(current, latestStable) > 0 && !currentTagExists) {
      return { core: current, kind: "stable" };
    }
    return undefined;
  }
  validateChannelVersion(current, "beta");
  if (compareCore(current, latestStable) <= 0) {
    throw new Error(
      `Committed prerelease ${formatSemVer(current)} is not ahead of latest stable ${formatSemVer(latestStable)}`,
    );
  }
  return { core: { ...current, prerelease: [], build: [] }, kind: "beta" };
}

function assertSupportedOfficialPrereleases(
  tags: ReturnType<typeof parseVersionTags>,
  targetCore: ParsedSemVer,
): void {
  for (const tag of tags) {
    if (!hasSameSemVerCore(tag.version, targetCore)) continue;
    if (tag.version.prerelease.length === 0) continue;
    const [channel, number] = tag.version.prerelease;
    if (
      tag.version.prerelease.length !== 2 ||
      channel !== "beta" ||
      !isNumericIdentifier(number) ||
      !Number.isSafeInteger(Number(number))
    ) {
      throw new Error(
        `Unsupported official prerelease on requested core ${formatCore(targetCore)}: ${tag.name}`,
      );
    }
  }
}

function nextPrivateTestNumber(
  versions: readonly ParsedSemVer[],
  targetCore: ParsedSemVer,
): number {
  let highest = -1;
  for (const version of versions) {
    if (!hasSameSemVerCore(version, targetCore)) continue;
    const value = Number(version.prerelease[1]);
    highest = Math.max(highest, value);
  }
  const next = highest + 1;
  if (!Number.isSafeInteger(next)) {
    throw new Error("Calculated test number exceeds the safe integer range");
  }
  return next;
}

function assertNoDuplicateVersions(versions: readonly string[]): void {
  const seen: ParsedSemVer[] = [];
  for (const version of versions) {
    const parsed = parseSemVer(version);
    if (seen.some((entry) => compareSemVer(entry, parsed) === 0)) {
      throw new Error(`Duplicate version record: ${version}`);
    }
    seen.push(parsed);
  }
}

function compareCore(left: ParsedSemVer, right: ParsedSemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

function formatCore(version: ParsedSemVer): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function matchingIncrement(
  stable: ParsedSemVer,
  target: ParsedSemVer,
): VersionIncrement | undefined {
  for (const increment of VERSION_INCREMENT_ORDER) {
    if (hasSameSemVerCore(bumpCore(stable, increment), target))
      return increment;
  }
  return undefined;
}

const VERSION_INCREMENT_ORDER = ["patch", "minor", "major"] as const;

function releasePlan(
  currentVersion: string,
  version: string,
  latestStableTag: NonNullable<ReturnType<typeof findHighestTag>>,
  pending: boolean,
): ReleasePlan {
  return {
    currentVersion,
    version,
    tag: `v${version}`,
    baseVersion: formatSemVer(latestStableTag.version),
    changed: version !== currentVersion,
    pending,
    resumed: pending,
  };
}
