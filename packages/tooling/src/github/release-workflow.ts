import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  executeReleaseVersion,
  parseSemVer,
  planRelease,
  readGitTags,
  type ReleaseChannel,
  type ReleaseMode,
  type VersionIncrement,
} from "../release/index.ts";

const PRODUCT_VERSION_FILE = "apps/electron/app/package.json";
const SCRIPT_FILE = fileURLToPath(import.meta.url);

export type BuildTarget = "all" | "desktop" | "docker";

export type GitHubReleaseRecord = {
  id?: number;
  tag_name: string;
  name?: string | null;
  body?: string | null;
  draft: boolean;
  prerelease?: boolean;
  target_commitish: string;
  upload_url?: string;
  html_url?: string;
};

export type TestReservation = {
  schema: 1;
  runId: string;
  sourceSha: string;
  buildTarget: BuildTarget;
  version: string;
};

export type TestReservationDecision = {
  action: "create" | "reuse";
  reservation: TestReservation;
  release?: GitHubReleaseRecord;
  existingTag: boolean;
};

export type DesktopReleasePlan = {
  tag: string;
  title: string;
  createArguments: string[];
};

type GitHubReleaseAsset = {
  id: number;
  name: string;
  size: number;
};

type TestAssetInventory = {
  schema: 1;
  reservation: TestReservation;
  assets: Array<{ name: string; sha256: string }>;
};

type CommandOptions = {
  inherit?: boolean;
  env?: NodeJS.ProcessEnv;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnvironment(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function parseChoice<const T extends readonly string[]>(
  name: string,
  value: string,
  choices: T,
): T[number] {
  if (!choices.includes(value)) {
    throw new Error(
      `${name} must be one of ${choices.join(", ")}; received '${value}'`,
    );
  }
  return value as T[number];
}

function parseAttempt(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(
      `RUN_ATTEMPT must be a positive integer; received '${value}'`,
    );
  }
  return Number(value);
}

function parseBoolean(name: string, value: string): boolean {
  if (value === "true") return true;
  if (value === "false" || value === "") return false;
  throw new Error(`${name} must be true or false; received '${value}'`);
}

function run(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): string {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = options.inherit
      ? ""
      : (result.stderr || result.stdout || "").trim();
    throw new Error(
      `${command} failed with exit code ${result.status}${details ? `: ${details}` : ""}`,
    );
  }
  return options.inherit ? "" : (result.stdout ?? "").trimEnd();
}

function commandStatus(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): { status: number; stderr: string } {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status === null) {
    throw new Error(`${command} terminated without an exit status`);
  }
  return { status: result.status, stderr: (result.stderr ?? "").trim() };
}

function git(args: readonly string[], options: CommandOptions = {}): string {
  return run("git", args, options);
}

function gh(args: readonly string[], options: CommandOptions = {}): string {
  return run("gh", args, {
    ...options,
    env: options.env ?? authenticatedGhEnvironment(),
  });
}

function authenticatedGitEnvironment(token: string): NodeJS.ProcessEnv {
  const serverUrl = new URL(requiredEnvironment("GITHUB_SERVER_URL"));
  if (serverUrl.protocol !== "https:") {
    throw new Error("GITHUB_SERVER_URL must use HTTPS");
  }
  const authorization = Buffer.from(`x-access-token:${token}`).toString(
    "base64",
  );
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${serverUrl.origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
  };
}

function authenticatedGhEnvironment(): NodeJS.ProcessEnv {
  const token = requiredEnvironment("GH_TOKEN");
  const hostname = new URL(requiredEnvironment("GITHUB_SERVER_URL")).hostname;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GH_HOST: hostname,
  };
  if (hostname === "github.com" || hostname.endsWith(".ghe.com")) {
    environment.GH_TOKEN = token;
  } else {
    delete environment.GH_TOKEN;
    environment.GH_ENTERPRISE_TOKEN = token;
  }
  return environment;
}

function appendOutput(name: string, value: string | boolean): void {
  if (/[\r\n]/.test(name) || /[\r\n]/.test(String(value))) {
    throw new Error(`GitHub output ${name} contains a newline`);
  }
  appendFileSync(
    requiredEnvironment("GITHUB_OUTPUT"),
    `${name}=${String(value)}\n`,
    "utf8",
  );
}

function appendSummary(markdown: string): void {
  appendFileSync(
    requiredEnvironment("GITHUB_STEP_SUMMARY"),
    markdown.endsWith("\n") ? markdown : `${markdown}\n`,
    "utf8",
  );
}

function readProductVersion(source: string, description: string): string {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${description} is not valid JSON`);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    typeof value.version !== "string"
  ) {
    throw new Error(`${description} does not contain a string version`);
  }
  return value.version;
}

function currentProductVersion(): string {
  return readProductVersion(
    readFileSync(PRODUCT_VERSION_FILE, "utf8"),
    PRODUCT_VERSION_FILE,
  );
}

function productVersionAt(reference: string, versionFile: string): string {
  return readProductVersion(
    git(["show", `${reference}:${versionFile}`]),
    `${reference}:${versionFile}`,
  );
}

function gitTrailer(commit: string, key: string): string {
  return git([
    "show",
    "-s",
    `--format=%(trailers:key=${key},valueonly)`,
    commit,
  ]).replaceAll(/\s/g, "");
}

function gitCommitForRef(reference: string): string | undefined {
  const commitReference = `${reference}^{commit}`;
  const result = commandStatus("git", [
    "rev-parse",
    "-q",
    "--verify",
    commitReference,
  ]);
  if (result.status !== 0) {
    if (result.status === 1) return undefined;
    throw new Error(
      `Could not resolve ${reference}: ${result.stderr || `git exited ${result.status}`}`,
    );
  }
  return git(["rev-parse", commitReference]);
}

function isAncestor(ancestor: string, descendant: string): boolean {
  const result = commandStatus("git", [
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  ]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(
    `Could not compare ${ancestor} and ${descendant}: ${result.stderr || `git exited ${result.status}`}`,
  );
}

function remoteTagExists(tag: string, token: string): boolean {
  const result = commandStatus(
    "git",
    ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`],
    authenticatedGitEnvironment(token),
  );
  if (result.status === 0) return true;
  if (result.status === 2) return false;
  throw new Error(
    `Could not query remote tag ${tag}: ${result.stderr || `git exited ${result.status}`}`,
  );
}

function pushWithToken(args: readonly string[], token: string): void {
  git(["push", ...args], {
    env: authenticatedGitEnvironment(token),
    inherit: true,
  });
}

function listGitHubReleases(repository: string): GitHubReleaseRecord[] {
  const response = gh([
    "api",
    "--paginate",
    `repos/${repository}/releases?per_page=100`,
    "--jq",
    ".[] | {id, tag_name, name, body, draft, prerelease, target_commitish, upload_url, html_url}",
  ]);
  return response
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => parseGitHubReleaseResponse(line, "Release listing"));
}

function parseGitHubReleaseResponse(
  response: string,
  context: string,
): GitHubReleaseRecord {
  let entry: unknown;
  try {
    entry = JSON.parse(response);
  } catch {
    throw new Error(`GitHub returned invalid JSON for ${context}`);
  }
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("id" in entry) ||
    typeof entry.id !== "number" ||
    !("tag_name" in entry) ||
    typeof entry.tag_name !== "string" ||
    !("draft" in entry) ||
    typeof entry.draft !== "boolean" ||
    !("target_commitish" in entry) ||
    typeof entry.target_commitish !== "string" ||
    !("prerelease" in entry) ||
    typeof entry.prerelease !== "boolean"
  ) {
    throw new Error(`GitHub ${context} contained an invalid Release record`);
  }
  return {
    id: entry.id,
    tag_name: entry.tag_name,
    name: "name" in entry && typeof entry.name === "string" ? entry.name : null,
    body: "body" in entry && typeof entry.body === "string" ? entry.body : null,
    draft: entry.draft,
    prerelease: entry.prerelease,
    target_commitish: entry.target_commitish,
    upload_url:
      "upload_url" in entry && typeof entry.upload_url === "string"
        ? entry.upload_url
        : undefined,
    html_url:
      "html_url" in entry && typeof entry.html_url === "string"
        ? entry.html_url
        : undefined,
  };
}

export function mergeCreatedRelease(
  releases: readonly GitHubReleaseRecord[],
  created: GitHubReleaseRecord,
): GitHubReleaseRecord[] {
  if (created.id === undefined) {
    throw new Error("Created GitHub Release has no ID");
  }
  return [...releases.filter((release) => release.id !== created.id), created];
}

export function resolveBuildTargets(target: BuildTarget): {
  buildDesktop: boolean;
  buildDocker: boolean;
} {
  switch (target) {
    case "desktop":
      return { buildDesktop: true, buildDocker: false };
    case "docker":
      return { buildDesktop: false, buildDocker: true };
    case "all":
      return { buildDesktop: true, buildDocker: true };
  }
}

export function findUniqueRelease(
  releases: readonly GitHubReleaseRecord[],
  tag: string,
): GitHubReleaseRecord | undefined {
  const matches = releases.filter((release) => release.tag_name === tag);
  if (matches.length > 1) {
    throw new Error(`Found multiple GitHub Releases for ${tag}`);
  }
  return matches[0];
}

const TEST_TAG_PATTERN = /^test-run-([1-9]\d*)$/;
const TEST_MARKER_PATTERN = /<!-- mediago-test-reservation:(\{[^\r\n]*\}) -->/g;
const LOWERCASE_SHA_PATTERN = /^[0-9a-f]{40}$/;

export function formatTestReservationMarker(
  reservation: TestReservation,
): string {
  validateTestReservation(reservation);
  return `<!-- mediago-test-reservation:${JSON.stringify(reservation)} -->`;
}

export function testDraftReleaseIdentityArguments(
  reservation: TestReservation,
): string[] {
  validateTestReservation(reservation);
  return [
    "-f",
    `tag_name=test-run-${reservation.runId}`,
    "-f",
    `target_commitish=${reservation.sourceSha}`,
    "-f",
    `name=${reservation.version}`,
  ];
}

export function parseTestReservation(
  release: GitHubReleaseRecord,
): TestReservation | undefined {
  if (!release.tag_name.startsWith("test-run-")) return undefined;
  const tagMatch = TEST_TAG_PATTERN.exec(release.tag_name);
  if (!tagMatch) {
    throw new Error(`Malformed owned test tag: ${release.tag_name}`);
  }
  if (!release.draft || release.prerelease !== true) {
    throw new Error(
      `Owned test Release ${release.tag_name} must remain draft and prerelease`,
    );
  }
  const body = release.body ?? "";
  const markerPrefixes = body.match(/<!-- mediago-test-reservation:/g) ?? [];
  const matches = [...body.matchAll(TEST_MARKER_PATTERN)];
  if (markerPrefixes.length !== 1 || matches.length !== 1) {
    throw new Error(
      `Owned test Release ${release.tag_name} must contain exactly one reservation marker`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(matches[0][1]);
  } catch {
    throw new Error(
      `Owned test Release ${release.tag_name} contains invalid reservation JSON`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Owned test Release ${release.tag_name} has an invalid marker`,
    );
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).toSorted().join(",");
  if (keys !== "buildTarget,runId,schema,sourceSha,version") {
    throw new Error(
      `Owned test Release ${release.tag_name} has an unexpected reservation schema`,
    );
  }
  const reservation = {
    schema: record.schema,
    runId: record.runId,
    sourceSha: record.sourceSha,
    buildTarget: record.buildTarget,
    version: record.version,
  } as TestReservation;
  validateTestReservation(reservation);
  if (reservation.runId !== tagMatch[1]) {
    throw new Error(
      `Owned test Release ${release.tag_name} marker belongs to run ${reservation.runId}`,
    );
  }
  if (release.name !== reservation.version) {
    throw new Error(
      `Owned test Release ${release.tag_name} title must equal ${reservation.version}`,
    );
  }
  if (!LOWERCASE_SHA_PATTERN.test(release.target_commitish)) {
    throw new Error(
      `Owned test Release ${release.tag_name} must target a full lowercase SHA`,
    );
  }
  if (release.target_commitish !== reservation.sourceSha) {
    throw new Error(
      `Owned test Release ${release.tag_name} targets ${release.target_commitish} instead of ${reservation.sourceSha}`,
    );
  }
  return reservation;
}

export function decideTestReservation(options: {
  releases: readonly GitHubReleaseRecord[];
  officialTags: readonly string[];
  currentVersion: string;
  increment: VersionIncrement;
  runId: string;
  sourceSha: string;
  currentMasterSha: string;
  buildTarget: BuildTarget;
  tagTarget?: string;
}): TestReservationDecision {
  if (!/^[1-9]\d*$/.test(options.runId)) {
    throw new Error("Test reservation run ID must be a positive integer");
  }
  if (!LOWERCASE_SHA_PATTERN.test(options.sourceSha)) {
    throw new Error("Test reservation source must be a full lowercase SHA");
  }
  const owned = options.releases.flatMap((release) => {
    const reservation = parseTestReservation(release);
    return reservation ? [{ release, reservation }] : [];
  });
  const versionOwners = new Map<string, string>();
  for (const { release, reservation } of owned) {
    const existingOwner = versionOwners.get(reservation.version);
    if (existingOwner) {
      throw new Error(
        `Duplicate test version ${reservation.version} is reserved by ${existingOwner} and ${release.tag_name}`,
      );
    }
    versionOwners.set(reservation.version, release.tag_name);
  }
  const technicalTag = `test-run-${options.runId}`;
  const matching = owned.filter(
    ({ release }) => release.tag_name === technicalTag,
  );
  if (matching.length > 1) {
    throw new Error(`Found duplicate test reservations for ${technicalTag}`);
  }
  const existing = matching[0];
  if (existing) {
    assertSameTestRequest(existing.reservation, options);
    if (options.tagTarget && options.tagTarget !== options.sourceSha) {
      throw new Error(
        `Existing tag ${technicalTag} points to ${options.tagTarget} instead of ${options.sourceSha}`,
      );
    }
    return {
      action: "reuse",
      reservation: existing.reservation,
      release: existing.release,
      existingTag: options.tagTarget !== undefined,
    };
  }
  if (options.tagTarget && options.tagTarget !== options.sourceSha) {
    throw new Error(
      `Existing tag ${technicalTag} points to ${options.tagTarget} instead of ${options.sourceSha}`,
    );
  }
  if (!options.tagTarget && options.sourceSha !== options.currentMasterSha) {
    throw new Error(
      `Master advanced from ${options.sourceSha} to ${options.currentMasterSha}; dispatch a new test run`,
    );
  }
  const plan = planRelease({
    currentVersion: options.currentVersion,
    tags: options.officialTags,
    testVersions: owned.map(({ reservation }) => reservation.version),
    channel: "test",
    increment: options.increment,
  });
  return {
    action: "create",
    reservation: {
      schema: 1,
      runId: options.runId,
      sourceSha: options.sourceSha,
      buildTarget: options.buildTarget,
      version: plan.version,
    },
    existingTag: options.tagTarget !== undefined,
  };
}

function validateTestReservation(
  reservation: TestReservation,
): asserts reservation is TestReservation {
  if (
    reservation.schema !== 1 ||
    !/^[1-9]\d*$/.test(reservation.runId) ||
    !LOWERCASE_SHA_PATTERN.test(reservation.sourceSha) ||
    !["all", "desktop", "docker"].includes(reservation.buildTarget)
  ) {
    throw new Error("Invalid MediaGo test reservation marker");
  }
  let parsed;
  try {
    parsed = parseSemVer(reservation.version);
  } catch {
    throw new Error("Invalid MediaGo test reservation marker");
  }
  if (
    parsed.prerelease.length !== 2 ||
    parsed.prerelease[0] !== "test" ||
    !/^(0|[1-9]\d*)$/.test(parsed.prerelease[1]) ||
    parsed.build.length !== 0
  ) {
    throw new Error("Invalid MediaGo test reservation marker");
  }
}

function assertSameTestRequest(
  reservation: TestReservation,
  request: Pick<
    Parameters<typeof decideTestReservation>[0],
    "runId" | "sourceSha" | "buildTarget"
  >,
): void {
  if (reservation.runId !== request.runId) {
    throw new Error("Test reservation run ID changed on rerun");
  }
  if (reservation.sourceSha !== request.sourceSha) {
    throw new Error(
      `Test reservation source changed from ${reservation.sourceSha} to ${request.sourceSha}`,
    );
  }
  if (reservation.buildTarget !== request.buildTarget) {
    throw new Error(
      `Test reservation build target changed from ${reservation.buildTarget} to ${request.buildTarget}`,
    );
  }
}

export function decideReleaseRecovery(options: {
  currentTag: string;
  release?: GitHubReleaseRecord;
  tagTarget?: string;
  tagOwnerTarget?: string;
  tagOwnerRunId?: string;
  buildTarget: BuildTarget;
  runAttempt: number;
  runId: string;
}): { resume: boolean; targetCommitish?: string } {
  if (options.release) {
    if (options.release.draft) {
      return {
        resume: true,
        targetCommitish: options.tagTarget ?? options.release.target_commitish,
      };
    }
    if (options.runAttempt !== 1) {
      throw new Error(
        `${options.currentTag} is already published; do not rerun this completed release`,
      );
    }
    return { resume: false };
  }

  if (!options.tagTarget) return { resume: false };
  if (
    options.tagOwnerTarget === "desktop" ||
    options.tagOwnerTarget === "all"
  ) {
    if (options.tagOwnerTarget !== options.buildTarget) {
      throw new Error(
        `${options.currentTag} is an unfinished ${options.tagOwnerTarget} release; rerun it with the same build target`,
      );
    }
    return { resume: true, targetCommitish: options.tagTarget };
  }
  if (
    options.tagOwnerTarget === "docker" &&
    options.tagOwnerRunId === options.runId
  ) {
    throw new Error(
      `Docker-only release ${options.currentTag} was already completed by this workflow run`,
    );
  }
  return { resume: false };
}

export function chooseReleaseSource(options: {
  head: string;
  resumeDraft: boolean;
  draftTarget?: string;
  pending: boolean;
  pendingCommits: readonly string[];
  version: string;
}): string {
  if (options.resumeDraft) {
    if (!options.draftTarget) {
      throw new Error("A resumed draft Release has no target commit");
    }
    return options.draftTarget;
  }
  if (!options.pending) return options.head;
  if (options.pendingCommits.length !== 1) {
    throw new Error(
      `Expected exactly one release commit for v${options.version}; found ${options.pendingCommits.length}`,
    );
  }
  return options.pendingCommits[0];
}

export function selectOwnedRerunCommit(options: {
  ownedCommits: readonly string[];
  ownedVersion?: string;
  masterVersion?: string;
  runId: string;
}): string {
  if (options.ownedCommits.length !== 1) {
    throw new Error(
      `Master moved after this run started, and no unique version commit owned by run ${options.runId} was found`,
    );
  }
  if (
    options.ownedVersion !== undefined &&
    options.masterVersion !== undefined &&
    options.ownedVersion !== options.masterVersion
  ) {
    throw new Error(
      `This run prepared v${options.ownedVersion}, but master is already v${options.masterVersion}. Old release runs cannot publish a newer version`,
    );
  }
  return options.ownedCommits[0];
}

export function buildDesktopReleasePlan(options: {
  mode: ReleaseMode;
  channel: ReleaseChannel;
  version: string;
  officialTag: string;
  sourceSha: string;
  runId: string;
}): DesktopReleasePlan {
  if (options.mode === "test") {
    const tag = `test-run-${options.runId}`;
    return {
      tag,
      title: options.version,
      createArguments: [],
    };
  }

  const title = options.version;
  const createArguments = [
    options.officialTag,
    "--draft",
    "--verify-tag",
    "--target",
    options.sourceSha,
    "--title",
    title,
    "--generate-notes",
  ];
  if (options.channel !== "latest") {
    createArguments.push("--prerelease", "--latest=false");
  }
  return { tag: options.officialTag, title, createArguments };
}

function validateRequest(): void {
  const mode = parseChoice("RUN_MODE", requiredEnvironment("RUN_MODE"), [
    "test",
    "release",
  ] as const);
  const channel = parseChoice(
    "RELEASE_CHANNEL",
    requiredEnvironment("RELEASE_CHANNEL"),
    ["test", "beta", "latest"] as const,
  );
  const expectedMode = channel === "test" ? "test" : "release";
  if (mode !== expectedMode) {
    throw new Error(
      `Release channel ${channel} requires internal mode ${expectedMode}`,
    );
  }
  const target = parseChoice(
    "BUILD_TARGET",
    requiredEnvironment("BUILD_TARGET"),
    ["all", "desktop", "docker"] as const,
  );
  const selectedRef = requiredEnvironment("SELECTED_REF");
  const selectedSha = requiredEnvironment("SELECTED_SHA");
  const token = requiredEnvironment("GH_TOKEN");
  const attempt = parseAttempt(requiredEnvironment("RUN_ATTEMPT"));
  const targets = resolveBuildTargets(target);
  appendOutput("build_desktop", targets.buildDesktop);
  appendOutput("build_docker", targets.buildDocker);

  if (selectedRef !== "refs/heads/master") {
    throw new Error(
      "Build and release runs must use the master branch in 'Use workflow from'",
    );
  }

  git(
    [
      "fetch",
      "--force",
      "--tags",
      "origin",
      "master:refs/remotes/origin/master",
    ],
    { env: authenticatedGitEnvironment(token), inherit: true },
  );
  const remoteMaster = git(["rev-parse", "refs/remotes/origin/master"]);
  const checkedOutSha = git(["rev-parse", "HEAD"]);
  if (mode === "test") {
    if (checkedOutSha !== selectedSha) {
      throw new Error(
        `Checked out ${checkedOutSha} instead of selected source ${selectedSha}`,
      );
    }
    return;
  }
  if (checkedOutSha !== remoteMaster) {
    throw new Error(
      `Checked out master ${checkedOutSha} is not current origin/master ${remoteMaster}`,
    );
  }
  if (attempt === 1 && selectedSha !== remoteMaster) {
    throw new Error(
      `Selected master commit ${selectedSha} is not current origin/master ${remoteMaster}`,
    );
  }
  if (attempt === 1 || selectedSha === remoteMaster) return;
  if (!isAncestor(selectedSha, remoteMaster)) {
    throw new Error(
      `Original source ${selectedSha} is not in current master history`,
    );
  }

  const runId = requiredEnvironment("GITHUB_RUN_ID");
  const commits = git([
    "rev-list",
    `${selectedSha}..${remoteMaster}`,
    "--",
    PRODUCT_VERSION_FILE,
  ])
    .split(/\r?\n/)
    .filter(Boolean);
  const ownedCommits = commits.filter(
    (commit) =>
      gitTrailer(commit, "MediaGo-Release-Run-Id") === runId &&
      gitTrailer(commit, "MediaGo-Release-Target") === target,
  );
  const ownedCommit = selectOwnedRerunCommit({ ownedCommits, runId });
  const ownedVersion = productVersionAt(ownedCommit, PRODUCT_VERSION_FILE);
  const masterVersion = productVersionAt(
    "refs/remotes/origin/master",
    PRODUCT_VERSION_FILE,
  );
  selectOwnedRerunCommit({
    ownedCommits,
    ownedVersion,
    masterVersion,
    runId,
  });
}

function reserveTestVersion(): void {
  const channel = parseChoice(
    "RELEASE_CHANNEL",
    requiredEnvironment("RELEASE_CHANNEL"),
    ["test", "beta", "latest"] as const,
  );
  if (channel !== "test") {
    throw new Error("reserve-test-version is only valid for channel test");
  }
  const increment = parseChoice(
    "VERSION_INCREMENT",
    requiredEnvironment("VERSION_INCREMENT"),
    ["patch", "minor", "major"] as const,
  );
  const buildTarget = parseChoice(
    "BUILD_TARGET",
    requiredEnvironment("BUILD_TARGET"),
    ["all", "desktop", "docker"] as const,
  );
  const repository = requiredEnvironment("REPOSITORY");
  const runId = requiredEnvironment("GITHUB_RUN_ID");
  const sourceSha = requiredEnvironment("SELECTED_SHA").toLowerCase();
  const masterSha = git(["rev-parse", "refs/remotes/origin/master"]);
  const technicalTag = `test-run-${runId}`;
  const token = requiredEnvironment("GH_TOKEN");
  let releases = listGitHubReleases(repository);
  let tagTarget = resolveRemoteTagTarget(technicalTag, token);
  let decision = decideTestReservation({
    releases,
    officialTags: readGitTags(process.cwd()),
    currentVersion: currentProductVersion(),
    increment,
    runId,
    sourceSha,
    currentMasterSha: masterSha,
    buildTarget,
    tagTarget,
  });

  if (decision.action === "create") {
    let createdRelease: GitHubReleaseRecord | undefined;
    try {
      createdRelease = createTestDraftRelease(repository, decision.reservation);
    } catch (error) {
      process.stderr.write(
        `[release-workflow] Create Release returned an ambiguous failure; reconciling ${technicalTag}\n`,
      );
      releases = listGitHubReleases(repository);
      tagTarget = resolveRemoteTagTarget(technicalTag, token);
      const recovered = findUniqueRelease(releases, technicalTag);
      if (!recovered && !tagTarget) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Test reservation was not created. The source may be stale; dispatch a new run. ${message}`,
          { cause: error },
        );
      }
    }
    const listedReleases = listGitHubReleases(repository);
    releases = createdRelease
      ? mergeCreatedRelease(listedReleases, createdRelease)
      : listedReleases;
    tagTarget = resolveRemoteTagTarget(technicalTag, token);
    decision = decideTestReservation({
      releases,
      officialTags: readGitTags(process.cwd()),
      currentVersion: currentProductVersion(),
      increment,
      runId,
      sourceSha,
      currentMasterSha: masterSha,
      buildTarget,
      tagTarget,
    });
    if (decision.action === "create" && decision.existingTag) {
      let createdReleaseForExistingTag: GitHubReleaseRecord | undefined;
      try {
        createdReleaseForExistingTag = createTestDraftRelease(
          repository,
          decision.reservation,
        );
      } catch (error) {
        releases = listGitHubReleases(repository);
        if (!findUniqueRelease(releases, technicalTag)) throw error;
      }
      const refreshedReleases = listGitHubReleases(repository);
      releases = createdReleaseForExistingTag
        ? mergeCreatedRelease(refreshedReleases, createdReleaseForExistingTag)
        : refreshedReleases;
      tagTarget = resolveRemoteTagTarget(technicalTag, token);
      decision = decideTestReservation({
        releases,
        officialTags: readGitTags(process.cwd()),
        currentVersion: currentProductVersion(),
        increment,
        runId,
        sourceSha,
        currentMasterSha: masterSha,
        buildTarget,
        tagTarget,
      });
    }
  }

  if (decision.action !== "reuse") {
    throw new Error(`Could not materialize test reservation ${technicalTag}`);
  }

  const release = decision.release ?? findUniqueRelease(releases, technicalTag);
  if (!release?.id) {
    throw new Error(
      `Test reservation ${technicalTag} has no GitHub Release ID`,
    );
  }
  const reservation = parseTestReservation(release);
  if (!reservation) throw new Error(`Invalid test reservation ${technicalTag}`);
  assertSameTestRequest(reservation, { runId, sourceSha, buildTarget });

  appendOutput("version", reservation.version);
  appendOutput("tag", technicalTag);
  appendOutput("source_sha", sourceSha);
  appendOutput("release_id", String(release.id));
  appendOutput("release_url", release.html_url ?? "");
  appendOutput("current_version", currentProductVersion());
  appendOutput("base_version", reservation.version.split("-")[0]);
  appendOutput("channel", "test");
  appendOutput("increment", increment);
  appendOutput("mode", "test");
  appendOutput("release_type", "draft");
  appendOutput("prerelease", "true");
  appendOutput("changed", "false");
  appendOutput("written", "false");
  appendOutput("pending", "false");
  appendOutput("resumed", decision.action === "reuse");
  appendOutput("version_file", PRODUCT_VERSION_FILE);
}

function createTestDraftRelease(
  repository: string,
  reservation: TestReservation,
): GitHubReleaseRecord {
  const response = gh([
    "api",
    "--method",
    "POST",
    `repos/${repository}/releases`,
    ...testDraftReleaseIdentityArguments(reservation),
    "-f",
    `body=${formatTestReservationMarker(reservation)}`,
    "-F",
    "draft=true",
    "-F",
    "prerelease=true",
    "--jq",
    "{id, tag_name, name, body, draft, prerelease, target_commitish, upload_url, html_url}",
  ]);
  return parseGitHubReleaseResponse(response, "create Release response");
}

function resolveRemoteTagTarget(
  tag: string,
  token: string,
): string | undefined {
  if (!remoteTagExists(tag, token)) return undefined;
  git(["fetch", "--force", "origin", `refs/tags/${tag}:refs/tags/${tag}`], {
    env: authenticatedGitEnvironment(token),
  });
  return gitCommitForRef(`refs/tags/${tag}`);
}

function detectReleaseState(): void {
  const target = parseChoice(
    "BUILD_TARGET",
    requiredEnvironment("BUILD_TARGET"),
    ["all", "desktop", "docker"] as const,
  );
  const attempt = parseAttempt(requiredEnvironment("RUN_ATTEMPT"));
  const runId = requiredEnvironment("GITHUB_RUN_ID");
  const repository = requiredEnvironment("REPOSITORY");
  const currentTag = `v${currentProductVersion()}`;
  const release = findUniqueRelease(listGitHubReleases(repository), currentTag);

  const tagTarget = gitCommitForRef(`refs/tags/${currentTag}`);
  const decision = decideReleaseRecovery({
    currentTag,
    release,
    tagTarget,
    tagOwnerTarget:
      !release && tagTarget
        ? gitTrailer(tagTarget, "MediaGo-Release-Target")
        : undefined,
    tagOwnerRunId:
      !release && tagTarget
        ? gitTrailer(tagTarget, "MediaGo-Release-Run-Id")
        : undefined,
    buildTarget: target,
    runAttempt: attempt,
    runId,
  });
  appendOutput("resume", decision.resume);
  if (decision.targetCommitish) {
    appendOutput("target_commitish", decision.targetCommitish);
  }
}

function calculateVersion(): void {
  const mode = parseChoice("RUN_MODE", requiredEnvironment("RUN_MODE"), [
    "test",
    "release",
  ] as const);
  const channel = parseChoice(
    "RELEASE_CHANNEL",
    requiredEnvironment("RELEASE_CHANNEL"),
    ["beta", "latest"] as const,
  );
  const increment = parseChoice(
    "VERSION_INCREMENT",
    requiredEnvironment("VERSION_INCREMENT"),
    ["patch", "minor", "major"] as const,
  );
  const result = executeReleaseVersion({
    mode,
    channel,
    increment,
    resumeCurrent: parseBoolean(
      "RESUME_CURRENT",
      optionalEnvironment("RESUME_CURRENT", "false"),
    ),
    githubOutput: requiredEnvironment("GITHUB_OUTPUT"),
  });
  process.stdout.write(
    `[release-version] ${result.currentVersion} -> ${result.version}` +
      `${result.pending ? " (pending retry)" : ""}${result.written ? " (written)" : ""}\n`,
  );
}

function commitVersion(): void {
  const token = requiredEnvironment("GH_TOKEN");
  const target = requiredEnvironment("BUILD_TARGET");
  const version = requiredEnvironment("VERSION");
  const versionFile = requiredEnvironment("VERSION_FILE");
  const runId = requiredEnvironment("GITHUB_RUN_ID");
  const changedFiles = git(["status", "--short"]);
  if (changedFiles !== ` M ${versionFile}`) {
    throw new Error(
      `Version calculation changed unexpected files:\n${changedFiles || "(none)"}`,
    );
  }

  git(["config", "user.name", "github-actions[bot]"]);
  git([
    "config",
    "user.email",
    "41898282+github-actions[bot]@users.noreply.github.com",
  ]);
  git(["add", "--", versionFile]);
  git(
    [
      "commit",
      "-m",
      `chore(release): v${version}`,
      "-m",
      `MediaGo-Release-Run-Id: ${runId}\nMediaGo-Release-Target: ${target}`,
    ],
    { inherit: true },
  );
  pushWithToken(["origin", "HEAD:master"], token);
}

function resolveSource(): void {
  const mode = parseChoice("RUN_MODE", requiredEnvironment("RUN_MODE"), [
    "test",
    "release",
  ] as const);
  const target = requiredEnvironment("BUILD_TARGET");
  const version = requiredEnvironment("VERSION");
  const versionFile = requiredEnvironment("VERSION_FILE");
  const pending = parseBoolean("PENDING", optionalEnvironment("PENDING"));
  const resumeDraft = parseBoolean(
    "RESUME_DRAFT",
    optionalEnvironment("RESUME_DRAFT"),
  );
  const attempt = parseAttempt(requiredEnvironment("RUN_ATTEMPT"));
  const head = git(["rev-parse", "HEAD"]);
  let pendingCommits: string[] = [];

  if (mode === "release" && pending && !resumeDraft) {
    const expectedSubject = `chore(release): v${version}`;
    pendingCommits = git(["log", "--format=%H%x09%s", "--", versionFile])
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        return {
          commit: tab === -1 ? line : line.slice(0, tab),
          subject: tab === -1 ? "" : line.slice(tab + 1),
        };
      })
      .filter((entry) => entry.subject === expectedSubject)
      .map((entry) => entry.commit);
  }

  const sourceSha =
    mode === "release"
      ? chooseReleaseSource({
          head,
          resumeDraft,
          draftTarget: optionalEnvironment("DRAFT_TARGET") || undefined,
          pending,
          pendingCommits,
          version,
        })
      : head;

  if (mode === "release") {
    if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
      throw new Error(
        `Release source must be a full commit SHA; received '${sourceSha}'`,
      );
    }
    if (!isAncestor(sourceSha, "refs/remotes/origin/master")) {
      throw new Error(
        `Release source ${sourceSha} is not in current master history`,
      );
    }
    const changedFiles = git([
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      sourceSha,
    ]);
    if (changedFiles !== versionFile) {
      throw new Error(
        `Release commit ${sourceSha} changed files other than ${versionFile}: ${changedFiles || "(none)"}`,
      );
    }
    const sourceVersion = productVersionAt(sourceSha, versionFile);
    if (sourceVersion !== version) {
      throw new Error(
        `Release source ${sourceSha} contains version ${sourceVersion} instead of ${version}`,
      );
    }

    const ownerRunId = gitTrailer(sourceSha, "MediaGo-Release-Run-Id");
    const ownerTarget = gitTrailer(sourceSha, "MediaGo-Release-Target");
    if (!ownerRunId) {
      throw new Error(
        `Release commit ${sourceSha} has no MediaGo-Release-Run-Id trailer`,
      );
    }
    if (ownerTarget !== target) {
      throw new Error(
        `v${version} was prepared for target '${ownerTarget}', not '${target}'`,
      );
    }
    if (attempt !== 1 && ownerRunId !== requiredEnvironment("GITHUB_RUN_ID")) {
      throw new Error(
        `This rerun belongs to run ${requiredEnvironment("GITHUB_RUN_ID")}, but v${version} belongs to run ${ownerRunId}`,
      );
    }
  }

  appendOutput("source_sha", sourceSha);
}

function writePrepareSummary(): void {
  appendSummary(`### Build request

- **Mode:** \`${requiredEnvironment("RUN_MODE")}\`
- **Target:** \`${requiredEnvironment("BUILD_TARGET")}\`
- **Version:** \`${requiredEnvironment("VERSION")}\`
- **Channel:** \`${requiredEnvironment("RELEASE_CHANNEL")}\`
- **Commit:** \`${requiredEnvironment("SOURCE_SHA")}\`
- **Pending retry:** \`${requiredEnvironment("PENDING")}\`
`);
}

function ensureRemoteAnnotatedTag(options: {
  tag: string;
  sourceSha: string;
  title: string;
  token: string;
}): void {
  if (remoteTagExists(options.tag, options.token)) {
    git(
      [
        "fetch",
        "--force",
        "origin",
        `refs/tags/${options.tag}:refs/tags/${options.tag}`,
      ],
      {
        env: authenticatedGitEnvironment(options.token),
        inherit: true,
      },
    );
    const existingSha = git(["rev-parse", `refs/tags/${options.tag}^{commit}`]);
    if (existingSha !== options.sourceSha) {
      throw new Error(
        `Existing tag ${options.tag} points to ${existingSha} instead of ${options.sourceSha}`,
      );
    }
    return;
  }

  git(["config", "user.name", "github-actions[bot]"]);
  git([
    "config",
    "user.email",
    "41898282+github-actions[bot]@users.noreply.github.com",
  ]);
  git(["tag", "-a", options.tag, options.sourceSha, "-m", options.title]);
  pushWithToken(["origin", `refs/tags/${options.tag}`], options.token);
}

const TEST_DESKTOP_RUNNERS = [
  "windows-latest",
  "macos-15",
  "macos-15-intel",
  "ubuntu-latest",
] as const;

export function expectedTestStageAssets(runId: string): string[] {
  if (!/^[1-9]\d*$/.test(runId)) {
    throw new Error("Test run ID must be a positive integer");
  }
  return TEST_DESKTOP_RUNNERS.map(
    (runner) => `test-stage-${runId}-${runner}.tar.gz`,
  );
}

function listReleaseAssets(
  repository: string,
  releaseId: string,
): GitHubReleaseAsset[] {
  const output = gh([
    "api",
    "--paginate",
    `repos/${repository}/releases/${releaseId}/assets?per_page=100`,
    "--jq",
    ".[] | {id, name, size}",
  ]);
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line) as Partial<GitHubReleaseAsset>;
      if (
        !Number.isSafeInteger(parsed.id) ||
        typeof parsed.name !== "string" ||
        !Number.isSafeInteger(parsed.size)
      ) {
        throw new Error("GitHub returned an invalid Release asset record");
      }
      return parsed as GitHubReleaseAsset;
    });
}

function uniqueAsset(
  assets: readonly GitHubReleaseAsset[],
  name: string,
): GitHubReleaseAsset | undefined {
  const matches = assets.filter((asset) => asset.name === name);
  if (matches.length > 1) {
    throw new Error(`Found duplicate assets named ${name}`);
  }
  return matches[0];
}

function downloadReleaseAsset(options: {
  repository: string;
  asset: GitHubReleaseAsset;
  destination: string;
}): void {
  mkdirSync(path.dirname(options.destination), { recursive: true });
  const descriptor = openSync(options.destination, "w");
  try {
    const result = spawnSync(
      "gh",
      [
        "api",
        `repos/${options.repository}/releases/assets/${options.asset.id}`,
        "-H",
        "Accept: application/octet-stream",
      ],
      {
        env: authenticatedGhEnvironment(),
        stdio: ["ignore", descriptor, "pipe"],
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `Could not download ${options.asset.name}: ${String(result.stderr).trim()}`,
      );
    }
  } finally {
    closeSync(descriptor);
  }
}

function uploadReleaseAsset(options: {
  repository: string;
  release: GitHubReleaseRecord;
  file: string;
}): void {
  if (!options.release.id || !options.release.upload_url) {
    throw new Error("GitHub Release is missing its ID or upload URL");
  }
  const name = path.basename(options.file);
  const existing = uniqueAsset(
    listReleaseAssets(options.repository, String(options.release.id)),
    name,
  );
  if (existing) {
    gh([
      "api",
      "--method",
      "DELETE",
      `repos/${options.repository}/releases/assets/${existing.id}`,
    ]);
  }
  const uploadUrl = options.release.upload_url.replace(/\{\?name,label\}$/, "");
  gh([
    "api",
    "--method",
    "POST",
    `${uploadUrl}?name=${encodeURIComponent(name)}`,
    "-H",
    "Content-Type: application/octet-stream",
    "--input",
    options.file,
  ]);
}

function sha256(file: string): string {
  const digest = run("sha256sum", [file]).split(/\s+/, 1)[0];
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`Could not calculate SHA-256 for ${file}`);
  }
  return digest;
}

function inventoryAssetName(runId: string): string {
  return `test-inventory-${runId}.json`;
}

function validateInventory(
  value: unknown,
  reservation: TestReservation,
): TestAssetInventory {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Test inventory must contain a JSON object");
  }
  const inventory = value as Partial<TestAssetInventory>;
  if (
    inventory.schema !== 1 ||
    JSON.stringify(inventory.reservation) !== JSON.stringify(reservation) ||
    !Array.isArray(inventory.assets) ||
    inventory.assets.length === 0
  ) {
    throw new Error("Test inventory does not match its reservation");
  }
  const names = new Set<string>();
  for (const asset of inventory.assets) {
    if (
      typeof asset !== "object" ||
      asset === null ||
      typeof asset.name !== "string" ||
      !/^[0-9a-f]{64}$/.test(asset.sha256) ||
      names.has(asset.name) ||
      asset.name.startsWith("test-stage-") ||
      asset.name === inventoryAssetName(reservation.runId)
    ) {
      throw new Error("Test inventory contains an invalid asset entry");
    }
    names.add(asset.name);
  }
  return inventory as TestAssetInventory;
}

function verifyRemoteInventory(options: {
  repository: string;
  releaseId: string;
  reservation: TestReservation;
  workDirectory: string;
}): TestAssetInventory | undefined {
  const assets = listReleaseAssets(options.repository, options.releaseId);
  const inventoryAsset = uniqueAsset(
    assets,
    inventoryAssetName(options.reservation.runId),
  );
  if (!inventoryAsset) return undefined;
  const inventoryFile = path.join(options.workDirectory, inventoryAsset.name);
  downloadReleaseAsset({
    repository: options.repository,
    asset: inventoryAsset,
    destination: inventoryFile,
  });
  const inventory = validateInventory(
    JSON.parse(readFileSync(inventoryFile, "utf8")),
    options.reservation,
  );
  for (const expected of inventory.assets) {
    const remote = uniqueAsset(assets, expected.name);
    if (!remote) {
      throw new Error(`Inventory asset ${expected.name} is missing remotely`);
    }
    const destination = path.join(
      options.workDirectory,
      "verified",
      expected.name,
    );
    downloadReleaseAsset({
      repository: options.repository,
      asset: remote,
      destination,
    });
    if (sha256(destination) !== expected.sha256) {
      throw new Error(`Remote digest mismatch for ${expected.name}`);
    }
  }
  return inventory;
}

function ownedTestRelease(
  repository: string,
  releaseId: string,
): { release: GitHubReleaseRecord; reservation: TestReservation } {
  if (!/^[1-9]\d*$/.test(releaseId)) {
    throw new Error("Test Release ID must be a positive integer");
  }
  const release = listGitHubReleases(repository).find(
    (entry) => String(entry.id) === releaseId,
  );
  if (!release) throw new Error(`Test Release ${releaseId} was not found`);
  const reservation = parseTestReservation(release);
  if (!reservation) throw new Error(`Release ${releaseId} is not test-owned`);
  return { release, reservation };
}

function downloadTestStages(): void {
  const repository = requiredEnvironment("REPOSITORY");
  const releaseId = requiredEnvironment("TEST_RELEASE_ID");
  const { reservation } = ownedTestRelease(repository, releaseId);
  assertSameTestRequest(reservation, {
    runId: requiredEnvironment("GITHUB_RUN_ID"),
    sourceSha: requiredEnvironment("SOURCE_SHA"),
    buildTarget: parseChoice(
      "BUILD_TARGET",
      requiredEnvironment("BUILD_TARGET"),
      ["all", "desktop", "docker"] as const,
    ),
  });
  if (reservation.version !== requiredEnvironment("VERSION")) {
    throw new Error("Test reservation version changed before finalization");
  }
  const workDirectory = resolve(
    optionalEnvironment("TEST_WORK_DIR", "test-release-work"),
  );
  mkdirSync(workDirectory, { recursive: true });
  const inventory = verifyRemoteInventory({
    repository,
    releaseId,
    reservation,
    workDirectory,
  });
  if (inventory) {
    appendOutput("complete", true);
    return;
  }

  const assets = listReleaseAssets(repository, releaseId);
  for (const name of expectedTestStageAssets(reservation.runId)) {
    const asset = uniqueAsset(assets, name);
    if (!asset) throw new Error(`Required private stage ${name} is missing`);
    const runner = name.slice(
      `test-stage-${reservation.runId}-`.length,
      -".tar.gz".length,
    );
    const runnerDirectory = resolve("electron-artifacts", runner);
    mkdirSync(runnerDirectory, { recursive: true });
    const archive = path.join(workDirectory, name);
    downloadReleaseAsset({ repository, asset, destination: archive });
    run("tar", ["-xzf", archive, "-C", runnerDirectory], { inherit: true });
  }
  appendOutput("complete", false);
}

function cleanupTestStages(
  repository: string,
  releaseId: string,
  runId: string,
): void {
  const expected = new Set(expectedTestStageAssets(runId));
  for (const asset of listReleaseAssets(repository, releaseId)) {
    if (!expected.has(asset.name)) continue;
    gh([
      "api",
      "--method",
      "DELETE",
      `repos/${repository}/releases/assets/${asset.id}`,
    ]);
  }
}

function publishDesktop(): void {
  const mode = parseChoice("RUN_MODE", requiredEnvironment("RUN_MODE"), [
    "test",
    "release",
  ] as const);
  const channel = parseChoice(
    "RELEASE_CHANNEL",
    requiredEnvironment("RELEASE_CHANNEL"),
    ["test", "beta", "latest"] as const,
  );
  const version = requiredEnvironment("VERSION");
  const officialTag = requiredEnvironment("OFFICIAL_TAG");
  const repository = requiredEnvironment("REPOSITORY");
  const sourceSha = requiredEnvironment("SOURCE_SHA");
  if (mode === "test") {
    if (channel !== "test") {
      throw new Error("Test desktop publication requires channel test");
    }
    publishTestDesktop({ repository, version, sourceSha });
    return;
  }
  if (channel === "test") {
    throw new Error("Official desktop publication cannot use channel test");
  }
  const token = requiredEnvironment("GH_TOKEN");
  const plan = buildDesktopReleasePlan({
    mode,
    channel,
    version,
    officialTag,
    sourceSha,
    runId: requiredEnvironment("GITHUB_RUN_ID"),
  });

  ensureRemoteAnnotatedTag({
    tag: plan.tag,
    sourceSha,
    title: plan.title,
    token,
  });

  const existingRelease = findUniqueRelease(
    listGitHubReleases(repository),
    plan.tag,
  );
  if (existingRelease && !existingRelease.draft) {
    throw new Error(`Release ${plan.tag} already exists and is published`);
  }
  if (!existingRelease) {
    gh(["release", "create", ...plan.createArguments, "--repo", repository], {
      inherit: true,
    });
  }

  const releaseFilesDirectory = optionalEnvironment(
    "RELEASE_FILES_DIR",
    "release-files",
  );
  const assets = readdirSync(releaseFilesDirectory, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(releaseFilesDirectory, entry.name))
    .filter((file) => statSync(file).isFile());
  if (assets.length === 0) {
    throw new Error("No desktop release files were collected");
  }
  gh(
    [
      "release",
      "upload",
      plan.tag,
      ...assets,
      "--clobber",
      "--repo",
      repository,
    ],
    { inherit: true },
  );

  if (mode === "release") {
    if (channel === "latest") {
      gh(
        [
          "release",
          "edit",
          plan.tag,
          "--draft=false",
          "--latest",
          "--repo",
          repository,
        ],
        { inherit: true },
      );
    } else {
      gh(
        [
          "release",
          "edit",
          plan.tag,
          "--draft=false",
          "--prerelease",
          "--latest=false",
          "--repo",
          repository,
        ],
        { inherit: true },
      );
    }
  }

  const serverUrl = requiredEnvironment("SERVER_URL");
  const url = `${serverUrl}/${repository}/releases/tag/${plan.tag}`;
  appendOutput("tag", plan.tag);
  appendOutput("url", url);
}

function publishTestDesktop(options: {
  repository: string;
  version: string;
  sourceSha: string;
}): void {
  const releaseId = requiredEnvironment("TEST_RELEASE_ID");
  const { release, reservation } = ownedTestRelease(
    options.repository,
    releaseId,
  );
  assertSameTestRequest(reservation, {
    runId: requiredEnvironment("GITHUB_RUN_ID"),
    sourceSha: options.sourceSha,
    buildTarget: parseChoice(
      "BUILD_TARGET",
      requiredEnvironment("BUILD_TARGET"),
      ["all", "desktop", "docker"] as const,
    ),
  });
  if (reservation.version !== options.version) {
    throw new Error(
      `Test reservation version ${reservation.version} does not match ${options.version}`,
    );
  }

  const workDirectory = resolve(
    optionalEnvironment("TEST_WORK_DIR", "test-release-work"),
  );
  mkdirSync(workDirectory, { recursive: true });
  const releaseFilesDirectory = optionalEnvironment(
    "RELEASE_FILES_DIR",
    "release-files",
  );
  const localAssets = existsSync(releaseFilesDirectory)
    ? readdirSync(releaseFilesDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(releaseFilesDirectory, entry.name))
        .filter((file) => statSync(file).isFile())
    : [];

  if (localAssets.length > 0) {
    for (const asset of localAssets) {
      uploadReleaseAsset({
        repository: options.repository,
        release,
        file: asset,
      });
    }
    const inventory: TestAssetInventory = {
      schema: 1,
      reservation,
      assets: localAssets
        .map((file) => ({ name: path.basename(file), sha256: sha256(file) }))
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    };
    const inventoryFile = path.join(
      workDirectory,
      inventoryAssetName(reservation.runId),
    );
    writeFileSync(
      inventoryFile,
      `${JSON.stringify(inventory, null, 2)}\n`,
      "utf8",
    );
    uploadReleaseAsset({
      repository: options.repository,
      release,
      file: inventoryFile,
    });
  }

  const verified = verifyRemoteInventory({
    repository: options.repository,
    releaseId,
    reservation,
    workDirectory,
  });
  if (!verified) {
    throw new Error("No verified test desktop inventory is available");
  }
  cleanupTestStages(options.repository, releaseId, reservation.runId);
  appendOutput("tag", release.tag_name);
  appendOutput(
    "url",
    release.html_url ??
      `${requiredEnvironment("SERVER_URL")}/${options.repository}/releases/tag/${release.tag_name}`,
  );
}

function recordTestDocker(): void {
  const repository = requiredEnvironment("REPOSITORY");
  const releaseId = requiredEnvironment("TEST_RELEASE_ID");
  const { reservation } = ownedTestRelease(repository, releaseId);
  assertSameTestRequest(reservation, {
    runId: requiredEnvironment("GITHUB_RUN_ID"),
    sourceSha: requiredEnvironment("SOURCE_SHA"),
    buildTarget: parseChoice(
      "BUILD_TARGET",
      requiredEnvironment("BUILD_TARGET"),
      ["all", "desktop", "docker"] as const,
    ),
  });
  if (reservation.version !== requiredEnvironment("VERSION")) {
    throw new Error(
      "Docker result does not match its test reservation version",
    );
  }
  const imageRef = requiredEnvironment("IMAGE_REF");
  const digest = requiredEnvironment("DIGEST");
  if (
    !imageRef.includes("/mediago-preview:") ||
    !/^sha256:[0-9a-f]+$/.test(digest)
  ) {
    throw new Error("Refusing to record a non-private or invalid test image");
  }
  const body = `${formatTestReservationMarker(reservation)}\n\n### Private preview image\n\n- Image: \`${imageRef}\`\n- Digest: \`${digest}\`\n`;
  gh([
    "api",
    "--method",
    "PATCH",
    `repos/${repository}/releases/${releaseId}`,
    ...testDraftReleaseIdentityArguments(reservation),
    "-f",
    `body=${body}`,
    "-F",
    "draft=true",
    "-F",
    "prerelease=true",
  ]);
  const updated = ownedTestRelease(repository, releaseId).release;
  if (!updated.draft || updated.prerelease !== true) {
    throw new Error("Test Release unexpectedly left private draft state");
  }
}

function writeDesktopSummary(): void {
  const visibility =
    requiredEnvironment("RUN_MODE") === "test"
      ? "\n- **Visibility:** draft; repository collaborators only"
      : "";
  appendSummary(`### Desktop result

- **Version:** \`${requiredEnvironment("VERSION")}\`
- **Tag:** \`${requiredEnvironment("TAG")}\`
- **URL:** ${requiredEnvironment("URL")}${visibility}
`);
}

function tagDockerRelease(): void {
  ensureRemoteAnnotatedTag({
    tag: requiredEnvironment("TAG"),
    sourceSha: requiredEnvironment("SOURCE_SHA"),
    title: `MediaGo ${requiredEnvironment("VERSION")}`,
    token: requiredEnvironment("GH_TOKEN"),
  });
}

export function runReleaseWorkflowCommand(command: string): void {
  switch (command) {
    case "validate-request":
      validateRequest();
      return;
    case "detect-release-state":
      detectReleaseState();
      return;
    case "reserve-test-version":
      reserveTestVersion();
      return;
    case "calculate-version":
      calculateVersion();
      return;
    case "commit-version":
      commitVersion();
      return;
    case "resolve-source":
      resolveSource();
      return;
    case "write-prepare-summary":
      writePrepareSummary();
      return;
    case "download-test-stages":
      downloadTestStages();
      return;
    case "publish-desktop":
      publishDesktop();
      return;
    case "write-desktop-summary":
      writeDesktopSummary();
      return;
    case "record-test-docker":
      recordTestDocker();
      return;
    case "tag-docker-release":
      tagDockerRelease();
      return;
    default:
      throw new Error(`Unknown release workflow command: ${command}`);
  }
}

function main(): void {
  try {
    runReleaseWorkflowCommand(process.argv[2] ?? "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`::error::${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_FILE) {
  main();
}
