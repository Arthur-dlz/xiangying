import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type DesktopRunMode = "test" | "release";
export type DesktopReleaseChannel = "test" | "beta" | "latest";

export interface DesktopBuildRequest {
  runMode: string;
  version: string;
  releaseChannel: string;
  sourceSha: string;
  testReleaseId?: string;
  testBuildTarget?: string;
}

export interface VerifySourceOptions {
  runMode: DesktopRunMode;
  version: string;
  sourceSha: string;
  gitToken?: string;
  serverUrl?: string;
  workspaceRoot?: string;
  githubOutput?: string;
}

export interface ApplyVersionOptions {
  runMode: DesktopRunMode;
  version: string;
  workspaceRoot?: string;
}

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const DEFAULT_WORKSPACE_ROOT = resolve(dirname(SCRIPT_FILE), "../../../..");
const PRODUCT_VERSION_FILE = "apps/electron/app/package.json";
const SOURCE_SHA_PATTERN = /^[0-9a-fA-F]{40}$/;
const CORE_PATTERN = "(0|[1-9][0-9]*)";
const SEMVER_PATTERN = new RegExp(
  `^${CORE_PATTERN}\\.${CORE_PATTERN}\\.${CORE_PATTERN}` +
    "(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$",
);

export function validateDesktopBuildRequest(
  request: DesktopBuildRequest,
): asserts request is DesktopBuildRequest & {
  runMode: DesktopRunMode;
  releaseChannel: DesktopReleaseChannel;
} {
  if (request.runMode !== "test" && request.runMode !== "release") {
    throw new Error(`Unsupported run_mode: ${request.runMode}`);
  }
  if (
    request.releaseChannel !== "test" &&
    request.releaseChannel !== "beta" &&
    request.releaseChannel !== "latest"
  ) {
    throw new Error(`Unsupported release_channel: ${request.releaseChannel}`);
  }
  if (!SOURCE_SHA_PATTERN.test(request.sourceSha)) {
    throw new Error("source_sha must be a full 40-character commit SHA");
  }
  if (!SEMVER_PATTERN.test(request.version)) {
    throw new Error("version must be a SemVer value without build metadata");
  }
  if (request.runMode === "release") {
    const channelSuffix =
      request.releaseChannel === "latest"
        ? ""
        : `-${request.releaseChannel}\\.${CORE_PATTERN}`;
    const channelPattern = new RegExp(
      `^${CORE_PATTERN}\\.${CORE_PATTERN}\\.${CORE_PATTERN}${channelSuffix}$`,
    );
    if (!channelPattern.test(request.version)) {
      throw new Error(
        `version ${request.version} does not match release channel ${request.releaseChannel}`,
      );
    }
    if (request.releaseChannel === "test") {
      throw new Error("release mode cannot use the test channel");
    }
  } else {
    if (request.releaseChannel !== "test") {
      throw new Error("test mode requires release_channel test");
    }
    const testPattern = new RegExp(
      `^${CORE_PATTERN}\\.${CORE_PATTERN}\\.${CORE_PATTERN}-test\\.${CORE_PATTERN}$`,
    );
    if (!testPattern.test(request.version)) {
      throw new Error(`version ${request.version} does not match test.N`);
    }
    if (!/^[1-9]\d*$/.test(request.testReleaseId ?? "")) {
      throw new Error(
        "test_release_id must be a positive integer in test mode",
      );
    }
    if (
      request.testBuildTarget !== "all" &&
      request.testBuildTarget !== "desktop"
    ) {
      throw new Error("test_build_target must be all or desktop");
    }
  }
}

const DESKTOP_RUNNERS = [
  "windows-latest",
  "macos-15",
  "macos-15-intel",
  "ubuntu-latest",
] as const;

export function testStageAssetName(runId: string, runner: string): string {
  if (!/^[1-9]\d*$/.test(runId)) {
    throw new Error("run ID must be a positive integer");
  }
  if (!DESKTOP_RUNNERS.includes(runner as (typeof DESKTOP_RUNNERS)[number])) {
    throw new Error(`Unsupported desktop runner: ${runner}`);
  }
  return `test-stage-${runId}-${runner}.tar.gz`;
}

export function createTestStageArchive(options: {
  runId: string;
  runner: string;
  releaseDirectory?: string;
  outputDirectory?: string;
}): string {
  const releaseDirectory = resolve(
    options.releaseDirectory ?? "apps/electron/release",
  );
  const outputDirectory = resolve(options.outputDirectory ?? "test-stage");
  const name = testStageAssetName(options.runId, options.runner);
  const files = readdirSync(releaseDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !/^builder-/i.test(entry.name))
    .map((entry) => entry.name)
    .filter((file) => /\.(?:exe|dmg|zip|deb|blockmap|ya?ml)$/i.test(file))
    .filter((file) => statSync(join(releaseDirectory, file)).isFile());
  if (files.length === 0) {
    throw new Error("No desktop files were produced for the test stage");
  }
  mkdirSync(outputDirectory, { recursive: true });
  const archive = join(outputDirectory, name);
  const result = spawnSync("tar", ["-czf", archive, "--", ...files], {
    cwd: releaseDirectory,
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Could not create test stage archive: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return archive;
}

export function uploadTestStageAsset(options: {
  repository: string;
  releaseId: string;
  archive: string;
  runId: string;
  sourceSha: string;
  version: string;
  buildTarget: string;
}): void {
  if (!/^[1-9]\d*$/.test(options.releaseId)) {
    throw new Error("test Release ID must be a positive integer");
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(options.repository)) {
    throw new Error("repository must use owner/name format");
  }
  const archive = resolve(options.archive);
  const assetName = basename(archive);
  validateTestReleaseForUpload(options);
  const assets = runGh([
    "api",
    "--paginate",
    `repos/${options.repository}/releases/${options.releaseId}/assets?per_page=100`,
    "--jq",
    ".[] | [.id, .name] | @tsv",
  ]);
  for (const line of assets.split(/\r?\n/).filter(Boolean)) {
    const [id, name] = line.split("\t");
    if (name === assetName && /^[1-9]\d*$/.test(id)) {
      runGh([
        "api",
        "--method",
        "DELETE",
        `repos/${options.repository}/releases/assets/${id}`,
      ]);
    }
  }
  const uploadTemplate = runGh([
    "api",
    `repos/${options.repository}/releases/${options.releaseId}`,
    "--jq",
    ".upload_url",
  ]);
  const uploadUrl = uploadTemplate.replace(/\{\?name,label\}$/, "");
  runGh([
    "api",
    "--method",
    "POST",
    `${uploadUrl}?name=${encodeURIComponent(assetName)}`,
    "-H",
    "Content-Type: application/gzip",
    "--input",
    archive,
  ]);
}

function validateTestReleaseForUpload(options: {
  repository: string;
  releaseId: string;
  runId: string;
  sourceSha: string;
  version: string;
  buildTarget: string;
}): void {
  const release = JSON.parse(
    runGh(["api", `repos/${options.repository}/releases/${options.releaseId}`]),
  ) as Record<string, unknown>;
  const body = typeof release.body === "string" ? release.body : "";
  const markerPrefixes = body.match(/<!-- mediago-test-reservation:/g) ?? [];
  const markerMatches = [
    ...body.matchAll(/<!-- mediago-test-reservation:(\{[^\r\n]*\}) -->/g),
  ];
  if (markerPrefixes.length !== 1 || markerMatches.length !== 1) {
    throw new Error("Test Release has an invalid ownership marker");
  }
  let marker: unknown;
  try {
    marker = JSON.parse(markerMatches[0][1]);
  } catch {
    throw new Error("Test Release has invalid ownership JSON");
  }
  const expected = {
    schema: 1,
    runId: options.runId,
    sourceSha: options.sourceSha,
    buildTarget: options.buildTarget,
    version: options.version,
  };
  if (
    release.tag_name !== `test-run-${options.runId}` ||
    release.name !== options.version ||
    release.target_commitish !== options.sourceSha ||
    release.draft !== true ||
    release.prerelease !== true ||
    JSON.stringify(marker) !== JSON.stringify(expected)
  ) {
    throw new Error("Test Release does not match this desktop build request");
  }
}

export function verifyDesktopSource(options: VerifySourceOptions): string {
  const workspaceRoot = resolve(
    options.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
  );
  const actualSha = runGit(workspaceRoot, ["rev-parse", "HEAD"]);
  const expectedSha = options.sourceSha.toLowerCase();
  if (actualSha !== expectedSha) {
    throw new Error(
      `Checked out ${actualSha} instead of requested SHA ${expectedSha}`,
    );
  }

  if (options.runMode === "release") {
    runGit(
      workspaceRoot,
      ["fetch", "--no-tags", "origin", "master:refs/remotes/origin/master"],
      authenticatedGitEnvironment(
        options.gitToken ?? requiredEnvironment("GH_TOKEN"),
        options.serverUrl ?? requiredEnvironment("GITHUB_SERVER_URL"),
      ),
    );
    if (!isGitAncestor(workspaceRoot, actualSha, "origin/master")) {
      throw new Error(
        "Release builds must use a commit from the master branch history",
      );
    }

    const committedVersion = readProductVersion(workspaceRoot);
    if (committedVersion !== options.version) {
      throw new Error(
        `Committed version ${committedVersion} does not match requested version ${options.version}`,
      );
    }
  }

  appendGithubOutput(
    "source_sha",
    actualSha,
    options.githubOutput ?? process.env.GITHUB_OUTPUT,
  );
  return actualSha;
}

export function createDesktopArtifactPrefix(input: {
  runMode: DesktopRunMode;
  version: string;
  sourceSha: string;
  runId: string;
  runAttempt: string;
  githubOutput?: string;
}): string {
  const prefix =
    `mediago-${input.runMode}-${input.version}-${input.sourceSha.slice(0, 12)}` +
    `-${input.runId}-${input.runAttempt}`;
  appendGithubOutput("artifact_prefix", prefix, input.githubOutput);
  return prefix;
}

export function applyDesktopBuildVersion(options: ApplyVersionOptions): void {
  const workspaceRoot = resolve(
    options.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
  );
  const versionFile = resolve(workspaceRoot, PRODUCT_VERSION_FILE);
  const source = readFileSync(versionFile, "utf8");
  const parsed: unknown = JSON.parse(source);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${PRODUCT_VERSION_FILE} must contain a JSON object`);
  }

  const productPackage = parsed as Record<string, unknown>;
  const committedVersion = productPackage.version;
  if (typeof committedVersion !== "string") {
    throw new Error(`${PRODUCT_VERSION_FILE} must contain a string version`);
  }
  if (options.runMode === "release" && committedVersion !== options.version) {
    throw new Error(
      `Committed version ${committedVersion} does not match ${options.version}`,
    );
  }

  productPackage.version = options.version;
  writeFileSync(
    versionFile,
    `${JSON.stringify(productPackage, null, 2)}\n`,
    "utf8",
  );
}

function readProductVersion(workspaceRoot: string): string {
  const versionFile = resolve(workspaceRoot, PRODUCT_VERSION_FILE);
  const parsed: unknown = JSON.parse(readFileSync(versionFile, "utf8"));
  const version =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { version?: unknown }).version
      : undefined;
  if (typeof version !== "string") {
    throw new Error(`${PRODUCT_VERSION_FILE} must contain a string version`);
  }
  return version;
}

function authenticatedGitEnvironment(
  token: string,
  serverUrlValue: string,
): NodeJS.ProcessEnv {
  const serverUrl = new URL(serverUrlValue);
  if (serverUrl.protocol !== "https:") {
    throw new Error("GITHUB_SERVER_URL must use HTTPS");
  }
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${serverUrl.origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(
      `x-access-token:${token}`,
    ).toString("base64")}`,
  };
}

function runGit(
  workspaceRoot: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): string {
  try {
    return execFileSync("git", args, {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "inherit"],
    }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Git command failed (${args.join(" ")}): ${message}`, {
      cause: error,
    });
  }
}

function runGh(args: string[]): string {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GitHub command failed: ${message}`, { cause: error });
  }
}

function isGitAncestor(
  workspaceRoot: string,
  ancestor: string,
  descendant: string,
): boolean {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { cwd: workspaceRoot, encoding: "utf8" },
  );
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  if (result.error) throw result.error;
  throw new Error(
    `Git merge-base failed with status ${String(result.status)}: ${result.stderr.trim()}`,
  );
}

function appendGithubOutput(
  name: string,
  value: string,
  githubOutput: string | undefined,
): void {
  if (!githubOutput) throw new Error("GITHUB_OUTPUT is required");
  if (/\r|\n/.test(value)) {
    throw new Error(`GitHub output ${name} must be a single line`);
  }
  appendFileSync(githubOutput, `${name}=${value}\n`, "utf8");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requestFromEnvironment(): DesktopBuildRequest {
  return {
    runMode: requiredEnvironment("REQUESTED_RUN_MODE"),
    version: requiredEnvironment("REQUESTED_VERSION"),
    releaseChannel: requiredEnvironment("REQUESTED_CHANNEL"),
    sourceSha: requiredEnvironment("REQUESTED_SOURCE_SHA"),
    testReleaseId: process.env.REQUESTED_TEST_RELEASE_ID,
    testBuildTarget: process.env.REQUESTED_TEST_BUILD_TARGET,
  };
}

function runCommand(command: string | undefined): void {
  if (command === "validate-request") {
    validateDesktopBuildRequest(requestFromEnvironment());
    return;
  }

  if (command === "verify-source") {
    const request = requestFromEnvironment();
    validateDesktopBuildRequest(request);
    verifyDesktopSource({
      runMode: request.runMode,
      version: request.version,
      sourceSha: request.sourceSha,
      gitToken: process.env.GH_TOKEN,
      serverUrl: process.env.GITHUB_SERVER_URL,
    });
    return;
  }

  if (command === "artifact-prefix") {
    const runMode = requiredEnvironment("REQUESTED_RUN_MODE");
    if (runMode !== "test" && runMode !== "release") {
      throw new Error(`Unsupported run_mode: ${runMode}`);
    }
    createDesktopArtifactPrefix({
      runMode,
      version: requiredEnvironment("REQUESTED_VERSION"),
      sourceSha: requiredEnvironment("VERIFIED_SOURCE_SHA"),
      runId: requiredEnvironment("GITHUB_RUN_ID"),
      runAttempt: requiredEnvironment("GITHUB_RUN_ATTEMPT"),
      githubOutput: requiredEnvironment("GITHUB_OUTPUT"),
    });
    return;
  }

  if (command === "apply-version") {
    const runMode = requiredEnvironment("RUN_MODE");
    if (runMode !== "test" && runMode !== "release") {
      throw new Error(`Unsupported run_mode: ${runMode}`);
    }
    applyDesktopBuildVersion({
      runMode,
      version: requiredEnvironment("BUILD_VERSION"),
    });
    return;
  }

  if (command === "create-test-stage") {
    const archive = createTestStageArchive({
      runId: requiredEnvironment("GITHUB_RUN_ID"),
      runner: requiredEnvironment("DESKTOP_RUNNER"),
    });
    appendGithubOutput(
      "archive",
      archive,
      requiredEnvironment("GITHUB_OUTPUT"),
    );
    return;
  }

  if (command === "upload-test-stage") {
    uploadTestStageAsset({
      repository: requiredEnvironment("REPOSITORY"),
      releaseId: requiredEnvironment("TEST_RELEASE_ID"),
      archive: requiredEnvironment("STAGE_ARCHIVE"),
      runId: requiredEnvironment("GITHUB_RUN_ID"),
      sourceSha: requiredEnvironment("SOURCE_SHA"),
      version: requiredEnvironment("VERSION"),
      buildTarget: requiredEnvironment("BUILD_TARGET"),
    });
    return;
  }

  throw new Error(
    "Usage: node packages/tooling/src/github/desktop-workflow.ts " +
      "<validate-request|verify-source|artifact-prefix|apply-version|create-test-stage|upload-test-stage>",
  );
}

function main(): void {
  try {
    runCommand(process.argv[2]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[desktop-workflow] ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_FILE) {
  main();
}
