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
  applyDesktopBuildVersion,
  createDesktopArtifactPrefix,
  testStageAssetName,
  validateDesktopBuildRequest,
} from "./desktop-workflow.ts";

const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";

test("validates desktop build requests and release channels", () => {
  validateDesktopBuildRequest({
    runMode: "test",
    version: "3.6.0-test.0",
    releaseChannel: "test",
    sourceSha: SOURCE_SHA,
    testReleaseId: "42",
    testBuildTarget: "all",
  });
  validateDesktopBuildRequest({
    runMode: "release",
    version: "3.6.0-beta.2",
    releaseChannel: "beta",
    sourceSha: SOURCE_SHA.toUpperCase(),
  });

  expect(() =>
    validateDesktopBuildRequest({
      runMode: "publish",
      version: "3.6.0",
      releaseChannel: "latest",
      sourceSha: SOURCE_SHA,
    }),
  ).toThrow(/Unsupported run_mode/);
  expect(() =>
    validateDesktopBuildRequest({
      runMode: "release",
      version: "3.6.0-beta.2",
      releaseChannel: "latest",
      sourceSha: SOURCE_SHA,
    }),
  ).toThrow(/does not match release channel/);
  expect(() =>
    validateDesktopBuildRequest({
      runMode: "test",
      version: "3.6.0+build.1",
      releaseChannel: "test",
      sourceSha: "abc",
      testReleaseId: "42",
      testBuildTarget: "desktop",
    }),
  ).toThrow(/source_sha/);
});

test("uses deterministic and runner-specific private stage names", () => {
  expect(testStageAssetName("123", "macos-15")).toBe(
    "test-stage-123-macos-15.tar.gz",
  );
  expect(testStageAssetName("123", "macos-15-intel")).toBe(
    "test-stage-123-macos-15-intel.tar.gz",
  );
  expect(() => testStageAssetName("123", "macos-latest")).toThrow(
    /Unsupported desktop runner/,
  );
});

test("creates the existing desktop artifact prefix and output", () => {
  const root = createWorkspace("3.5.0");
  const output = join(root, "github-output.txt");
  const prefix = createDesktopArtifactPrefix({
    runMode: "test",
    version: "3.5.0-test.42",
    sourceSha: SOURCE_SHA,
    runId: "12345",
    runAttempt: "2",
    githubOutput: output,
  });

  expect(prefix).toBe("mediago-test-3.5.0-test.42-0123456789ab-12345-2");
  expect(readFileSync(output, "utf8")).toBe(`artifact_prefix=${prefix}\n`);
});

test("applies test versions but protects committed release versions", () => {
  const root = createWorkspace("3.5.0");
  const versionFile = join(root, "apps", "electron", "app", "package.json");

  applyDesktopBuildVersion({
    runMode: "test",
    version: "3.5.0-test.42",
    workspaceRoot: root,
  });
  expect(readPackageVersion(versionFile)).toBe("3.5.0-test.42");

  expect(() =>
    applyDesktopBuildVersion({
      runMode: "release",
      version: "3.5.1",
      workspaceRoot: root,
    }),
  ).toThrow(/does not match/);
});

function createWorkspace(version: string): string {
  const root = mkdtempSync(join(tmpdir(), "mediago-desktop-workflow-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const appDirectory = join(root, "apps", "electron", "app");
  mkdirSync(appDirectory, { recursive: true });
  writeFileSync(
    join(appDirectory, "package.json"),
    `${JSON.stringify({ name: "mediago-community", version }, null, 2)}\n`,
    "utf8",
  );
  return root;
}

function readPackageVersion(file: string): string {
  return JSON.parse(readFileSync(file, "utf8")).version;
}
