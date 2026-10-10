import { expect, test } from "vitest";
import {
  buildDesktopReleasePlan,
  chooseReleaseSource,
  decideTestReservation,
  decideReleaseRecovery,
  expectedTestStageAssets,
  findUniqueRelease,
  formatTestReservationMarker,
  mergeCreatedRelease,
  parseTestReservation,
  resolveBuildTargets,
  selectOwnedRerunCommit,
  testDraftReleaseIdentityArguments,
  type GitHubReleaseRecord,
} from "./release-workflow.ts";

test("maps each build target to the requested workers", () => {
  expect(resolveBuildTargets("desktop")).toStrictEqual({
    buildDesktop: true,
    buildDocker: false,
  });
  expect(resolveBuildTargets("docker")).toStrictEqual({
    buildDesktop: false,
    buildDocker: true,
  });
  expect(resolveBuildTargets("all")).toStrictEqual({
    buildDesktop: true,
    buildDocker: true,
  });
});

test("finds one Release by tag and rejects ambiguous state", () => {
  const release: GitHubReleaseRecord = {
    tag_name: "v3.6.0",
    draft: true,
    target_commitish: "a".repeat(40),
  };
  expect(findUniqueRelease([release], "v3.6.0")).toBe(release);
  expect(findUniqueRelease([release], "v3.6.1")).toBe(undefined);
  expect(() => findUniqueRelease([release, { ...release }], "v3.6.0")).toThrow(
    /multiple GitHub Releases/,
  );
});

test("builds an isolated draft plan for desktop tests", () => {
  const version = "3.5.1-test.0";
  const plan = buildDesktopReleasePlan({
    mode: "test",
    channel: "test",
    version,
    officialTag: "unused",
    sourceSha: "a".repeat(40),
    runId: "1234",
  });
  expect(plan.tag).toBe("test-run-1234");
  expect(plan.title).toBe(version);
  expect(plan.createArguments).toStrictEqual([]);
});

test("parses strict private test reservations and allocates per-core counters", () => {
  const sourceSha = "a".repeat(40);
  const first = {
    schema: 1,
    runId: "100",
    sourceSha,
    buildTarget: "all",
    version: "3.5.1-test.0",
  } as const;
  const release: GitHubReleaseRecord = {
    id: 10,
    tag_name: "test-run-100",
    name: first.version,
    body: formatTestReservationMarker(first),
    draft: true,
    prerelease: true,
    target_commitish: sourceSha,
  };
  expect(parseTestReservation(release)).toStrictEqual(first);
  const decision = decideTestReservation({
    releases: [release],
    officialTags: ["v3.5.0"],
    currentVersion: "3.5.0",
    increment: "patch",
    runId: "101",
    sourceSha,
    currentMasterSha: sourceSha,
    buildTarget: "desktop",
  });
  expect(decision.action).toBe("create");
  expect(decision.reservation.version).toBe("3.5.1-test.1");
});

test("uses the create response while the Release listing is temporarily stale", () => {
  const sourceSha = "a".repeat(40);
  const reservation = {
    schema: 1,
    runId: "102",
    sourceSha,
    buildTarget: "all",
    version: "3.5.1-test.0",
  } as const;
  const created: GitHubReleaseRecord = {
    id: 102,
    tag_name: "test-run-102",
    name: reservation.version,
    body: formatTestReservationMarker(reservation),
    draft: true,
    prerelease: true,
    target_commitish: sourceSha,
  };

  const releases = mergeCreatedRelease([], created);
  expect(
    decideTestReservation({
      releases,
      officialTags: ["v3.5.0"],
      currentVersion: "3.5.0",
      increment: "patch",
      runId: reservation.runId,
      sourceSha,
      currentMasterSha: sourceSha,
      buildTarget: reservation.buildTarget,
    }),
  ).toMatchObject({ action: "reuse", release: created, reservation });
});

test("preserves test Release identity whenever a draft is updated", () => {
  const reservation = {
    schema: 1,
    runId: "103",
    sourceSha: "a".repeat(40),
    buildTarget: "all",
    version: "3.5.1-test.0",
  } as const;

  expect(testDraftReleaseIdentityArguments(reservation)).toStrictEqual([
    "-f",
    "tag_name=test-run-103",
    "-f",
    `target_commitish=${reservation.sourceSha}`,
    "-f",
    "name=3.5.1-test.0",
  ]);
});

test("reuses reservations and rejects changed rerun identity", () => {
  const sourceSha = "b".repeat(40);
  const reservation = {
    schema: 1,
    runId: "200",
    sourceSha,
    buildTarget: "docker",
    version: "3.6.0-test.0",
  } as const;
  const release: GitHubReleaseRecord = {
    id: 20,
    tag_name: "test-run-200",
    name: reservation.version,
    body: formatTestReservationMarker(reservation),
    draft: true,
    prerelease: true,
    target_commitish: sourceSha,
  };
  expect(
    decideTestReservation({
      releases: [release],
      officialTags: ["v3.5.0"],
      currentVersion: "3.5.0",
      increment: "minor",
      runId: "200",
      sourceSha,
      currentMasterSha: "c".repeat(40),
      buildTarget: "docker",
      tagTarget: sourceSha,
    }).action,
  ).toBe("reuse");
  expect(() =>
    decideTestReservation({
      releases: [release],
      officialTags: ["v3.5.0"],
      currentVersion: "3.5.0",
      increment: "minor",
      runId: "200",
      sourceSha,
      currentMasterSha: sourceSha,
      buildTarget: "all",
      tagTarget: sourceSha,
    }),
  ).toThrow(/build target changed/);
  expect(() =>
    decideTestReservation({
      releases: [],
      officialTags: ["v3.5.0"],
      currentVersion: "3.5.0",
      increment: "minor",
      runId: "201",
      sourceSha,
      currentMasterSha: "c".repeat(40),
      buildTarget: "all",
    }),
  ).toThrow(/Master advanced/);
  const duplicate = {
    ...release,
    id: 21,
    tag_name: "test-run-201",
    body: formatTestReservationMarker({ ...reservation, runId: "201" }),
  };
  expect(() =>
    decideTestReservation({
      releases: [release, duplicate],
      officialTags: ["v3.5.0"],
      currentVersion: "3.5.0",
      increment: "minor",
      runId: "200",
      sourceSha,
      currentMasterSha: sourceSha,
      buildTarget: "docker",
      tagTarget: sourceSha,
    }),
  ).toThrow(/Duplicate test version/);
});

test("uses four unique private stage names", () => {
  const names = expectedTestStageAssets("123");
  expect(names).toHaveLength(4);
  expect(new Set(names).size).toBe(4);
  expect(names).toContain("test-stage-123-macos-15.tar.gz");
  expect(names).toContain("test-stage-123-macos-15-intel.tar.gz");
});

test("marks only prerelease channels as prereleases", () => {
  const stable = buildDesktopReleasePlan({
    mode: "release",
    channel: "latest",
    version: "3.6.0",
    officialTag: "v3.6.0",
    sourceSha: "b".repeat(40),
    runId: "1",
  });
  expect(stable.title).toBe("3.6.0");
  expect(
    stable.createArguments.filter((argument) => argument === "--title"),
  ).toHaveLength(1);
  expect(
    stable.createArguments[stable.createArguments.indexOf("--title") + 1],
  ).toBe("3.6.0");
  expect(stable.createArguments.includes("--generate-notes")).toBeTruthy();
  expect(!stable.createArguments.includes("--prerelease")).toBeTruthy();

  const beta = buildDesktopReleasePlan({
    mode: "release",
    channel: "beta",
    version: "3.6.0-beta.0",
    officialTag: "v3.6.0-beta.0",
    sourceSha: "c".repeat(40),
    runId: "2",
  });
  expect(beta.title).toBe("3.6.0-beta.0");
  expect(
    beta.createArguments.filter((argument) => argument === "--title"),
  ).toHaveLength(1);
  expect(
    beta.createArguments[beta.createArguments.indexOf("--title") + 1],
  ).toBe("3.6.0-beta.0");
  expect(beta.createArguments.includes("--prerelease")).toBeTruthy();
  expect(beta.createArguments.includes("--latest=false")).toBeTruthy();
});

test("resumes drafts and unfinished desktop tags at their fixed source", () => {
  const draft = decideReleaseRecovery({
    currentTag: "v3.6.0",
    release: {
      tag_name: "v3.6.0",
      draft: true,
      target_commitish: "a".repeat(40),
    },
    tagTarget: "b".repeat(40),
    buildTarget: "desktop",
    runAttempt: 2,
    runId: "100",
  });
  expect(draft).toStrictEqual({
    resume: true,
    targetCommitish: "b".repeat(40),
  });

  const unfinished = decideReleaseRecovery({
    currentTag: "v3.6.0",
    tagTarget: "c".repeat(40),
    tagOwnerTarget: "all",
    tagOwnerRunId: "90",
    buildTarget: "all",
    runAttempt: 1,
    runId: "100",
  });
  expect(unfinished).toStrictEqual({
    resume: true,
    targetCommitish: "c".repeat(40),
  });
});

test("rejects incompatible or completed release recovery", () => {
  expect(() =>
    decideReleaseRecovery({
      currentTag: "v3.6.0",
      tagTarget: "a".repeat(40),
      tagOwnerTarget: "desktop",
      buildTarget: "all",
      runAttempt: 1,
      runId: "100",
    }),
  ).toThrow(/same build target/);
  expect(() =>
    decideReleaseRecovery({
      currentTag: "v3.6.0",
      tagTarget: "a".repeat(40),
      tagOwnerTarget: "docker",
      tagOwnerRunId: "100",
      buildTarget: "docker",
      runAttempt: 2,
      runId: "100",
    }),
  ).toThrow(/already completed/);
  expect(
    decideReleaseRecovery({
      currentTag: "v3.6.0",
      tagTarget: "a".repeat(40),
      tagOwnerTarget: "docker",
      tagOwnerRunId: "99",
      buildTarget: "docker",
      runAttempt: 1,
      runId: "100",
    }),
  ).toStrictEqual({ resume: false });
  expect(() =>
    decideReleaseRecovery({
      currentTag: "v3.6.0",
      release: {
        tag_name: "v3.6.0",
        draft: false,
        target_commitish: "master",
      },
      buildTarget: "desktop",
      runAttempt: 2,
      runId: "100",
    }),
  ).toThrow(/already published/);
});

test("selects draft and pending sources without silently changing commits", () => {
  expect(
    chooseReleaseSource({
      head: "a".repeat(40),
      resumeDraft: true,
      draftTarget: "b".repeat(40),
      pending: true,
      pendingCommits: ["c".repeat(40)],
      version: "3.6.0",
    }),
  ).toBe("b".repeat(40));
  expect(
    chooseReleaseSource({
      head: "a".repeat(40),
      resumeDraft: false,
      pending: true,
      pendingCommits: ["c".repeat(40)],
      version: "3.6.0",
    }),
  ).toBe("c".repeat(40));
  expect(() =>
    chooseReleaseSource({
      head: "a".repeat(40),
      resumeDraft: false,
      pending: true,
      pendingCommits: [],
      version: "3.6.0",
    }),
  ).toThrow(/exactly one release commit/);
  expect(() =>
    chooseReleaseSource({
      head: "a".repeat(40),
      resumeDraft: false,
      pending: true,
      pendingCommits: ["b".repeat(40), "c".repeat(40)],
      version: "3.6.0",
    }),
  ).toThrow(/found 2/);
});

test("rejects reruns without one owned commit or after master advances", () => {
  expect(() =>
    selectOwnedRerunCommit({ ownedCommits: [], runId: "100" }),
  ).toThrow(/no unique version commit/);
  expect(() =>
    selectOwnedRerunCommit({
      ownedCommits: ["a".repeat(40), "b".repeat(40)],
      runId: "100",
    }),
  ).toThrow(/no unique version commit/);
  expect(() =>
    selectOwnedRerunCommit({
      ownedCommits: ["a".repeat(40)],
      ownedVersion: "3.6.0",
      masterVersion: "3.7.0",
      runId: "100",
    }),
  ).toThrow(/cannot publish a newer version/);
  expect(
    selectOwnedRerunCommit({
      ownedCommits: ["a".repeat(40)],
      ownedVersion: "3.6.0",
      masterVersion: "3.6.0",
      runId: "100",
    }),
  ).toBe("a".repeat(40));
});
