import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runReleaseVersionCli } from "./cli.ts";

export type {
  ExecuteReleaseVersionOptions,
  ParsedSemVer,
  ReleaseChannel,
  ReleaseMode,
  ReleasePlan,
  ReleasePlanInput,
  ReleaseVersionResult,
  VersionIncrement,
} from "./contracts.ts";
export {
  executeReleaseVersion,
  readGitTags,
} from "./execute.ts";
export { bumpCore, planRelease } from "./planning.ts";
export {
  compareSemVer,
  formatSemVer,
  parseSemVer,
} from "./semver.ts";
export { assertTagAvailable } from "./tags.ts";

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) runReleaseVersionCli(process.argv.slice(2));
