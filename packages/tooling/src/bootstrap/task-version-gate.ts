import { pathToFileURL } from "node:url";

export const MINIMUM_TASK_VERSION = "3.51.1";

const TASK_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export type TaskVersionGateResult =
  | { exitCode: 0; version: string }
  | { exitCode: 1; message: string };

export function evaluateTaskVersion(
  actualVersion: unknown,
  minimumVersion: unknown,
): TaskVersionGateResult {
  if (minimumVersion !== MINIMUM_TASK_VERSION) {
    return {
      exitCode: 1,
      message: `Task version gate is misconfigured; the repository minimum must remain ${MINIMUM_TASK_VERSION}.`,
    };
  }
  if (typeof actualVersion !== "string") {
    return {
      exitCode: 1,
      message: "Invalid Task version received from the Task runner.",
    };
  }
  const parsedActualVersion = parseTaskVersion(actualVersion);
  if (parsedActualVersion === undefined) {
    return {
      exitCode: 1,
      message: "Invalid Task version received from the Task runner.",
    };
  }
  const parsedMinimumVersion = parseTaskVersion(MINIMUM_TASK_VERSION);
  if (parsedMinimumVersion === undefined) {
    return {
      exitCode: 1,
      message: "Task version gate is misconfigured.",
    };
  }
  const nextMajorVersion = `${parsedMinimumVersion[0] + 1n}.0.0`;
  const supportedRange = `>=${MINIMUM_TASK_VERSION} and <${nextMajorVersion}`;
  if (compareTaskVersions(parsedActualVersion, parsedMinimumVersion) < 0) {
    return {
      exitCode: 1,
      message: [
        `Task ${actualVersion} is installed; MediaGo requires ${supportedRange}.`,
        `Install or switch Task: https://taskfile.dev/installation/ (mise: mise use task@${MINIMUM_TASK_VERSION}).`,
      ].join(" "),
    };
  }
  if (parsedActualVersion[0] !== parsedMinimumVersion[0]) {
    return {
      exitCode: 1,
      message: [
        `Task ${actualVersion} is installed; MediaGo supports ${supportedRange}.`,
        `Install or switch to Task v3: https://taskfile.dev/installation/ (mise: mise use task@${MINIMUM_TASK_VERSION}).`,
      ].join(" "),
    };
  }
  return { exitCode: 0, version: actualVersion };
}

type TaskVersion = readonly [major: bigint, minor: bigint, patch: bigint];

function parseTaskVersion(version: string): TaskVersion | undefined {
  const match = TASK_VERSION_PATTERN.exec(version);
  if (match === null) return undefined;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }
  return [BigInt(major), BigInt(minor), BigInt(patch)];
}

function compareTaskVersions(left: TaskVersion, right: TaskVersion): number {
  for (const index of [0, 1, 2] as const) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

export function runTaskVersionGate(
  environment: NodeJS.ProcessEnv = process.env,
  writeError: (message: string) => void = (message) =>
    process.stderr.write(`${message}\n`),
): number {
  const result = evaluateTaskVersion(
    environment.MEDIAGO_TASK_VERSION,
    environment.MEDIAGO_REQUIRED_TASK_VERSION,
  );
  if (result.exitCode !== 0) writeError(result.message);
  return result.exitCode;
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined &&
    import.meta.url === pathToFileURL(entrypoint).href
  );
}

if (isMainModule()) process.exitCode = runTaskVersionGate();
