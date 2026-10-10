import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import {
  assertTagAvailable,
  compareSemVer,
  executeReleaseVersion,
  formatSemVer,
  parseSemVer,
  planRelease,
  type VersionIncrement,
} from "./index.ts";

test("strictly parses and compares SemVer", () => {
  const parsed = parseSemVer("3.6.0-beta.2+sha.abc");
  expect(formatSemVer(parsed)).toBe("3.6.0-beta.2+sha.abc");
  expect(
    compareSemVer(parseSemVer("3.6.0-alpha.9"), parseSemVer("3.6.0-beta.0")) <
      0,
  ).toBeTruthy();
  expect(
    compareSemVer(parseSemVer("3.6.0-beta.9"), parseSemVer("3.6.0")) < 0,
  ).toBeTruthy();
  for (const invalid of [
    "",
    "1.2",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-beta.01",
    "1.2.3-",
    "1.2.3+",
    "v1.2.3",
  ]) {
    expect(() => parseSemVer(invalid)).toThrow(/Invalid SemVer|leading zeroes/);
  }
});

test("calculates stable patch, minor, and major versions", () => {
  const cases: Array<[VersionIncrement, string]> = [
    ["patch", "3.5.1"],
    ["minor", "3.6.0"],
    ["major", "4.0.0"],
  ];
  for (const [increment, expected] of cases) {
    expect(
      planRelease({
        currentVersion: "3.5.0",
        tags: ["v3.5.0", "v3.5.0-alpha.1"],
        channel: "latest",
        increment,
      }).version,
    ).toBe(expected);
  }
});

test("allocates private test counters per requested core starting at zero", () => {
  expect(
    planRelease({
      currentVersion: "3.5.0",
      tags: ["v3.5.0"],
      channel: "test",
      increment: "patch",
    }).version,
  ).toBe("3.5.1-test.0");
  expect(
    planRelease({
      currentVersion: "3.5.0",
      tags: ["v3.5.0", "v3.5.1-beta.3"],
      testVersions: ["3.5.1-test.0", "3.5.1-test.1", "3.6.0-test.7"],
      channel: "test",
      increment: "patch",
    }).version,
  ).toBe("3.5.1-test.2");
  expect(
    planRelease({
      currentVersion: "3.5.0",
      tags: ["v3.5.0"],
      testVersions: ["3.5.1-test.9"],
      channel: "test",
      increment: "minor",
    }).version,
  ).toBe("3.6.0-test.0");
});

test("advances beta independently from private tests", () => {
  expect(
    planRelease({
      currentVersion: "3.5.0",
      tags: ["v3.5.0"],
      testVersions: ["3.5.1-test.4"],
      channel: "beta",
      increment: "patch",
    }).version,
  ).toBe("3.5.1-beta.0");
  expect(
    planRelease({
      currentVersion: "3.5.1-beta.1",
      tags: ["v3.5.0", "v3.5.1-beta.0", "v3.5.1-beta.1"],
      channel: "beta",
      increment: "patch",
    }).version,
  ).toBe("3.5.1-beta.2");
});

test("promotes and recovers a locked official core", () => {
  expect(
    planRelease({
      currentVersion: "3.6.0-beta.2",
      tags: ["v3.5.0", "v3.6.0-beta.2"],
      channel: "latest",
      increment: "minor",
    }).version,
  ).toBe("3.6.0");
  const pendingBeta = planRelease({
    currentVersion: "3.6.0-beta.0",
    tags: ["v3.5.0"],
    channel: "beta",
    increment: "minor",
  });
  expect(pendingBeta.version).toBe("3.6.0-beta.0");
  expect(pendingBeta.pending).toBe(true);
  const pendingStable = planRelease({
    currentVersion: "3.5.1",
    tags: ["v3.5.0"],
    channel: "latest",
    increment: "patch",
  });
  expect(pendingStable.version).toBe("3.5.1");
  expect(pendingStable.pending).toBe(true);
});

test("rejects conflicting increments and unsupported future prereleases", () => {
  expect(() =>
    planRelease({
      currentVersion: "3.6.0-beta.0",
      tags: ["v3.5.0", "v3.6.0-beta.0"],
      channel: "latest",
      increment: "patch",
    }),
  ).toThrow(/locks the official core/);
  expect(() =>
    planRelease({
      currentVersion: "3.5.0",
      tags: ["v3.5.0", "v3.5.1-alpha.0"],
      channel: "beta",
      increment: "patch",
    }),
  ).toThrow(/Unsupported official prerelease/);
  expect(() =>
    planRelease({
      currentVersion: "3.5.0",
      tags: ["v3.5.0"],
      testVersions: ["3.5.1-test.0", "3.5.1-test.0"],
      channel: "test",
      increment: "patch",
    }),
  ).toThrow(/Duplicate version/);
  expect(() => assertTagAvailable("3.5.0", ["v3.5.0+existing-build"])).toThrow(
    /conflicts with existing tag/,
  );
});

test("test mode is read-only and official mode writes the product version", () => {
  const root = createRepository("3.5.0", ["v3.5.0"]);
  const versionFile = join(root, "apps", "electron", "app", "package.json");
  const preview = executeReleaseVersion({
    workspaceRoot: root,
    mode: "test",
    channel: "test",
    increment: "patch",
    testVersions: ["3.5.1-test.0"],
  });
  expect(preview.version).toBe("3.5.1-test.1");
  expect(preview.written).toBe(false);
  expect(readPackageVersion(versionFile)).toBe("3.5.0");
  const release = executeReleaseVersion({
    workspaceRoot: root,
    mode: "release",
    channel: "beta",
    increment: "minor",
  });
  expect(release.version).toBe("3.6.0-beta.0");
  expect(release.written).toBe(true);
  expect(readPackageVersion(versionFile)).toBe("3.6.0-beta.0");
});

test("preserves the GitHub output contract", () => {
  const root = createRepository("3.5.0", ["v3.5.0"]);
  const output = join(root, "github-output.txt");
  executeReleaseVersion({
    workspaceRoot: root,
    githubOutput: output,
    mode: "test",
    channel: "test",
    increment: "patch",
  });
  expect(
    readFileSync(output, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => line.slice(0, line.indexOf("="))),
  ).toStrictEqual([
    "version",
    "tag",
    "current_version",
    "base_version",
    "channel",
    "increment",
    "mode",
    "release_type",
    "prerelease",
    "changed",
    "written",
    "pending",
    "resumed",
    "version_file",
  ]);
});

test("rejects contradictory mode and channel combinations", () => {
  const root = createRepository("3.5.0", ["v3.5.0"]);
  expect(() =>
    executeReleaseVersion({
      workspaceRoot: root,
      mode: "test",
      channel: "beta",
      increment: "patch",
    }),
  ).toThrow(/requires mode release/);
});

function createRepository(version: string, tags: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "mediago-release-version-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const appDirectory = join(root, "apps", "electron", "app");
  mkdirSync(appDirectory, { recursive: true });
  writeFileSync(
    join(appDirectory, "package.json"),
    `${JSON.stringify({ name: "mediago-community", version }, null, 2)}\n`,
    "utf8",
  );
  runGit(root, ["init", "--quiet"]);
  runGit(root, ["config", "user.email", "release-version@example.com"]);
  runGit(root, ["config", "user.name", "Release Version Test"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "--quiet", "-m", "initial"]);
  for (const tag of tags) runGit(root, ["tag", tag]);
  return root;
}

function runGit(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function readPackageVersion(file: string): string {
  return JSON.parse(readFileSync(file, "utf8")).version as string;
}
