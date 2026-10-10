import { afterEach, expect, test, vi } from "vitest";
import {
  spawn as realSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";

const accessProbe = vi.hoisted(() => ({
  deniedTarget: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    copyFile: async (
      source: string,
      destination: string,
      mode?: number,
    ): Promise<void> => {
      if (destination.toLocaleLowerCase("en-US") === accessProbe.deniedTarget) {
        const error = Object.assign(
          new Error(
            `EACCES: permission denied, copy '${source}' -> '${destination}'`,
          ),
          { code: "EACCES" },
        );
        throw error;
      }
      await actual.copyFile(source, destination, mode);
    },
  };
});

import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LibraryService } from "./library.service";
import { MAX_IMPORT_PATHS } from "./library-files";
import {
  scanWithMicrosoftDefender,
  type DefenderScanResult,
} from "./library-defender";

let fixtureRoot: string | undefined;

afterEach(async () => {
  accessProbe.deniedTarget = "";
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

test("an EACCES export remains item-scoped and later files still export", async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "library-eacces-"));
  const mediaDirectory = path.join(fixtureRoot, "media");
  const userDataDirectory = path.join(fixtureRoot, "user-data");
  const exportDirectory = path.join(fixtureRoot, "export");
  await Promise.all([
    mkdir(mediaDirectory),
    mkdir(userDataDirectory),
    mkdir(exportDirectory),
  ]);

  const deniedSource = path.join(mediaDirectory, "restricted.mp4");
  const allowedSource = path.join(mediaDirectory, "allowed.mp4");
  const deniedTarget = path.join(exportDirectory, "restricted.mp4");
  const allowedTarget = path.join(exportDirectory, "allowed.mp4");
  const mediaHeader = Buffer.alloc(64);
  mediaHeader.write("ftyp", 4, "ascii");
  mediaHeader.write("isom", 8, "ascii");
  await Promise.all([
    writeFile(deniedSource, mediaHeader),
    writeFile(allowedSource, mediaHeader),
  ]);
  accessProbe.deniedTarget = deniedTarget.toLocaleLowerCase("en-US");

  const dialogs = {
    showOpenDialog: vi.fn(async () => ({
      canceled: false,
      filePaths: [exportDirectory],
    })),
    showMessageBox: vi.fn(async () => ({ response: 1 })),
  };
  const service = new LibraryService(userDataDirectory, { dialogs });
  const imported = await service.importFiles([deniedSource, allowedSource]);
  const result = await service.exportFiles(
    imported.items.map((item) => item.id),
  );

  expect(result.results).toMatchObject([
    {
      id: imported.items[0]?.id,
      copied: false,
      error: expect.stringMatching(/EACCES/),
    },
    {
      id: imported.items[1]?.id,
      copied: true,
      path: allowedTarget,
    },
  ]);
  await expect(readFile(deniedTarget)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(allowedTarget)).toEqual(await readFile(allowedSource));
  expect(await readFile(deniedSource)).toEqual(mediaHeader);
  expect(await readFile(allowedSource)).toEqual(mediaHeader);
});

test("inert executable signatures and mismatched containers are rejected", async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "library-inert-"));
  const mediaDirectory = path.join(fixtureRoot, "media");
  const userDataDirectory = path.join(fixtureRoot, "user-data");
  await Promise.all([mkdir(mediaDirectory), mkdir(userDataDirectory)]);

  const samples = [
    ["elf.mp4", Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
    ["script.mp4", Buffer.from("#!/bin/sh\n", "ascii")],
    ["shortcut.mp4", Buffer.from([0x4c, 0x4e, 0x4b, 0x00])],
    ["wrong-container.mp4", Buffer.from([0x1a, 0x45, 0xdf, 0xa3])],
  ] as const;
  const paths = await Promise.all(
    samples.map(async ([name, prefix]) => {
      const samplePath = path.join(mediaDirectory, name);
      await writeFile(samplePath, Buffer.concat([prefix, Buffer.alloc(64)]));
      return samplePath;
    }),
  );
  const service = new LibraryService(userDataDirectory);

  const result = await service.importFiles([...paths]);

  expect(result.added).toBe(0);
  expect(result.rejected).toHaveLength(samples.length);
  for (const rejected of result.rejected.slice(0, 3)) {
    expect(rejected.reason).toMatch(/可执行文件或快捷方式/);
  }
  expect(result.rejected[3]?.reason).toMatch(/内容与视频扩展名不匹配/);
  expect((await service.list()).items).toEqual([]);
});

test("rejects import batches above the 500-path limit before filesystem access", async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "library-limit-"));
  const userDataDirectory = path.join(fixtureRoot, "user-data");
  await mkdir(userDataDirectory);
  const service = new LibraryService(userDataDirectory);
  const paths = Array.from({ length: MAX_IMPORT_PATHS + 1 }, (_, index) =>
    path.join(fixtureRoot!, "inert-" + index + ".mp4"),
  );

  await expect(service.importFiles(paths)).rejects.toThrow(/最多导入 500/);
  expect(await service.list()).toMatchObject({ items: [], totalBytes: 0 });
});

test("deduplicates repeated IDs within one partial export request", async () => {
  fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "library-duplicate-export-"),
  );
  const mediaDirectory = path.join(fixtureRoot, "media");
  const userDataDirectory = path.join(fixtureRoot, "user-data");
  const exportDirectory = path.join(fixtureRoot, "export");
  await Promise.all([
    mkdir(mediaDirectory),
    mkdir(userDataDirectory),
    mkdir(exportDirectory),
  ]);
  const source = path.join(mediaDirectory, "sample.mp4");
  const header = Buffer.alloc(64);
  header.write("ftyp", 4, "ascii");
  header.write("isom", 8, "ascii");
  await writeFile(source, header);
  const dialogs = {
    showOpenDialog: vi.fn(async () => ({
      canceled: false,
      filePaths: [exportDirectory],
    })),
    showMessageBox: vi.fn(async () => ({ response: 1 })),
  };
  const service = new LibraryService(userDataDirectory, { dialogs });
  const [item] = (await service.importFiles([source])).items;

  const result = await service.exportFiles(["missing-id", item!.id, item!.id]);

  expect(result.results).toHaveLength(2);
  expect(result.results[0]).toMatchObject({
    id: "missing-id",
    copied: false,
    error: "片库条目不存在",
  });
  expect(result.results[1]).toMatchObject({
    id: item!.id,
    copied: true,
    path: path.join(exportDirectory, "sample.mp4"),
  });
  expect(await readFile(path.join(exportDirectory, "sample.mp4"))).toEqual(
    header,
  );
});

test.skipIf(
  process.platform !== "win32" ||
    process.env.RUN_LOCAL_DEFENDER_ACCEPTANCE !== "1",
)("real Microsoft Defender scans an isolated benign MP4", async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "library-defender-real-"));
  const mediaDirectory = path.join(fixtureRoot, "media");
  const userDataDirectory = path.join(fixtureRoot, "user-data");
  await Promise.all([mkdir(mediaDirectory), mkdir(userDataDirectory)]);
  const source = path.resolve("tests/media-service/public/v1/sample.mp4");
  const fixture = path.join(mediaDirectory, "benign-sample.mp4");
  await copyFile(source, fixture);
  let processEvidence:
    | {
        executable: string;
        args: string[];
        pid?: number;
        exitCode?: number | null;
        signal?: NodeJS.Signals | null;
        stdout: string;
        stderr: string;
        adapterResult?: DefenderScanResult;
      }
    | undefined;
  const observedSpawn = (
    executable: string,
    args: string[],
    options: SpawnOptions,
  ): ChildProcess => {
    const child = realSpawn(executable, args, options);
    processEvidence = {
      executable,
      args,
      stdout: "",
      stderr: "",
    };
    child.once("spawn", () => {
      if (processEvidence) processEvidence.pid = child.pid;
    });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (processEvidence)
        processEvidence.stdout += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : chunk;
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (processEvidence)
        processEvidence.stderr += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : chunk;
    });
    child.once("close", (exitCode, signal) => {
      if (processEvidence) {
        processEvidence.exitCode = exitCode;
        processEvidence.signal = signal;
      }
    });
    return child;
  };
  const service = new LibraryService(userDataDirectory, {
    scan: async (filePath) => {
      const result = await scanWithMicrosoftDefender(filePath, {
        spawn: observedSpawn,
      });
      if (processEvidence) processEvidence.adapterResult = result;
      return result;
    },
  });
  const imported = await service.importFiles([fixture]);
  expect(imported.added).toBe(1);

  const scanned = await service.scan(imported.items[0]!.id);
  const captured = processEvidence;
  const output = (captured?.stdout ?? "") + "\n" + (captured?.stderr ?? "");
  const normalizedFixture = path
    .resolve(fixture)
    .replace(/\//g, "\\")
    .toLocaleLowerCase("en-US");
  const evidence = {
    executable: captured?.executable ?? null,
    pid: captured?.pid ?? null,
    exitCode: captured?.exitCode ?? null,
    signal: captured?.signal ?? null,
    args: captured?.args ?? [],
    scanFinished: output
      .split(/\r?\n/)
      .some((line) => /^\s*scan finished\.\s*$/i.test(line)),
    targetNoThreatLine: output.split(/\r?\n/).some((line) => {
      const match = line.match(
        /^\s*Scanning\s+(.+?)\s+found no threats\.?\s*$/i,
      );
      return (
        match !== null &&
        match[1]
          ?.replace(/^['"]|['"]$/g, "")
          .replace(/\//g, "\\")
          .toLocaleLowerCase("en-US") === normalizedFixture
      );
    }),
    adapterStatus: captured?.adapterResult?.status ?? "unavailable",
    trusted: captured?.adapterResult?.trusted ?? false,
    fixturePath: fixture,
    fixtureSha256: (await import("node:crypto"))
      .createHash("sha256")
      .update(await readFile(fixture))
      .digest("hex"),
  };
  const evidencePath = path.resolve(
    ".task/regression-20261006/library/library-defender-benign-observation.json",
  );
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), "utf8");
  expect(captured?.executable).toMatch(/MpCmdRun\.exe$/i);
  expect(captured?.pid).toEqual(expect.any(Number));
  expect(captured?.exitCode).toBe(0);
  expect(captured?.args).toEqual([
    "-Scan",
    "-ScanType",
    "3",
    "-File",
    fixture,
    "-DisableRemediation",
  ]);
  expect(evidence.scanFinished).toBe(true);
  expect(evidence.targetNoThreatLine).toBe(true);
  expect(evidence.adapterStatus).toBe("clean");
  expect(evidence.trusted).toBe(true);
  expect(scanned.safety.status).toBe("clean");
  expect(scanned.safety.fingerprint).toMatch(/^[a-f\d]{64}$/i);
  expect(scanned.path).toBe(fixture);
});
