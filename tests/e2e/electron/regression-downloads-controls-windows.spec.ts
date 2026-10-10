import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DownloadFilter } from "../../../packages/common/src/types/index.ts";
import {
  _electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { scrubElectronEnvironment } from "../support/regression-downloads-electron-network.ts";
import { trustedCoreClient } from "../support/xiangying-core-client.ts";
import {
  readWindowsProcessIdentity,
  waitForWindowsProcessExit,
  type WindowsProcessIdentity,
} from "../support/xiangying-windows-process.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const EXECUTABLE = path.join(
  ROOT,
  "apps/electron/release-slim/win-unpacked/乡映.exe",
);
const ARTIFACTS = path.join(
  ROOT,
  ".task/regression-20261006/downloads/artifacts/controls",
);

function coreURLFromIpc(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result = value as { code?: unknown; data?: unknown; coreUrl?: unknown };
  const payload =
    typeof result.code === "number"
      ? (result.data as { coreUrl?: unknown } | undefined)
      : result;
  if (typeof result.code === "number" && result.code !== 0) return undefined;
  return typeof payload?.coreUrl === "string" && payload.coreUrl
    ? payload.coreUrl
    : undefined;
}

test.skip(
  process.platform !== "win32",
  "Windows packaged candidate download controls",
);

test("controlled live stop/finalize, safe headers, and download/conversion batch controls", async () => {
  test.setTimeout(240_000);
  const stage = process.env.XIANGYING_CONTROLS_STAGE || "full";
  expect(["full", "live", "headers", "ui", "storage"]).toContain(stage);
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    path.resolve(EXECUTABLE),
  );
  const sourceHost =
    stage === "ui" || stage === "live" || stage === "storage"
      ? "127.0.0.1"
      : "localhost";
  const sourceListenHost =
    sourceHost === "localhost" ? "127.0.0.1" : sourceHost;

  const runtimeRoot = await mkdtemp(
    path.join(ROOT, ".task/regression-20261006/downloads/runtime/controls-"),
  );
  const downloads = path.join(runtimeRoot, "downloads");
  const segmentDirectory = path.join(runtimeRoot, "fixture-segments");
  const samplePath = path.join(
    ROOT,
    "tests/media-service/public/v1/sample.mp4",
  );
  const ffmpeg = path.join(
    path.dirname(EXECUTABLE),
    "resources/deps/ffmpeg.exe",
  );
  await Promise.all([
    mkdir(path.join(runtimeRoot, "appdata"), { recursive: true }),
    mkdir(path.join(runtimeRoot, "localappdata"), { recursive: true }),
    mkdir(path.join(runtimeRoot, "temp"), { recursive: true }),
    mkdir(downloads, { recursive: true }),
    mkdir(segmentDirectory, { recursive: true }),
    mkdir(ARTIFACTS, { recursive: true }),
  ]);
  await promisify(execFile)(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-stream_loop",
      "6",
      "-i",
      samplePath,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-c",
      "copy",
      "-f",
      "segment",
      "-segment_time",
      "1",
      "-reset_timestamps",
      "1",
      path.join(segmentDirectory, "segment-%02d.ts"),
    ],
    { timeout: 30_000, windowsHide: true },
  );
  const segments = await Promise.all(
    Array.from({ length: 7 }, (_, index) =>
      readFile(
        path.join(
          segmentDirectory,
          `segment-${String(index).padStart(2, "0")}.ts`,
        ),
      ),
    ),
  );

  let publishedSegments = 1;
  const liveSegmentHits = new Set<number>();
  const batchRequests = new Set<string>();
  const heldBatchResponses = new Map<string, () => void>();
  let sourceHeaderObservation = { authorization: false, cookie: false };
  const targetHeaderObservations: Array<{
    pathname: string;
    authorization: boolean;
    cookie: boolean;
  }> = [];
  let targetOrigin = "";
  const media = await readFile(samplePath);
  const storageVariantPath = path.join(runtimeRoot, "storage-variant.mp4");
  if (stage === "storage") {
    await promisify(execFile)(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        samplePath,
        "-map",
        "0",
        "-c",
        "copy",
        "-metadata",
        "comment=download-regression-variant",
        "-movflags",
        "+faststart",
        storageVariantPath,
      ],
      { timeout: 30_000, windowsHide: true },
    );
  }
  const storageVariant =
    stage === "storage" ? await readFile(storageVariantPath) : media;
  if (stage === "storage") {
    expect(createHash("sha256").update(storageVariant).digest("hex")).not.toBe(
      createHash("sha256").update(media).digest("hex"),
    );
    await promisify(execFile)(
      ffmpeg,
      [
        "-hide_banner",
        "-v",
        "error",
        "-i",
        storageVariantPath,
        "-f",
        "null",
        "-",
      ],
      { timeout: 30_000, windowsHide: true },
    );
  }
  const storagePayloads = new Map<string, Buffer>([
    ["record-only", media],
    ["file-only", storageVariant],
    ["duplicate-url", media],
    ["same-title-a", media],
    ["same-title-b", storageVariant],
  ]);
  const storageHits = new Map<string, number>();
  const sendRange = (
    request: IncomingMessage,
    response: ServerResponse,
    pathKey: string,
  ) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(
      String(request.headers.range || ""),
    );
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2]
      ? Math.min(Number(range[2]), media.length - 1)
      : media.length - 1;
    response.writeHead(range ? 206 : 200, {
      "Content-Type": "video/mp4",
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      ...(range
        ? { "Content-Range": `bytes ${start}-${end}/${media.length}` }
        : {}),
    });
    batchRequests.add(pathKey);
    const first = Math.min(start + 256, end + 1);
    response.write(media.subarray(start, first));
    heldBatchResponses.set(pathKey, () =>
      response.end(media.subarray(first, end + 1)),
    );
    response.once("close", () => heldBatchResponses.delete(pathKey));
  };
  const source = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://fixture");
    if (url.pathname === "/redirect.m3u8") {
      sourceHeaderObservation = {
        authorization: Boolean(request.headers.authorization),
        cookie: Boolean(request.headers.cookie),
      };
      response
        .writeHead(302, {
          Location: `${targetOrigin}/target.m3u8`,
          "Cache-Control": "no-store",
        })
        .end();
      return;
    }
    if (url.pathname === "/live.m3u8") {
      const list = segments
        .slice(0, publishedSegments)
        .map(
          (_, index) =>
            `#EXTINF:1.0,\nlive-segment-${String(index).padStart(2, "0")}.ts`,
        )
        .join("\n");
      response
        .writeHead(200, {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-store",
        })
        .end(
          `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n${list}\n`,
        );
      return;
    }
    const storagePath = /^\/storage\/([a-z0-9-]+)\.mp4$/.exec(url.pathname);
    if (storagePath) {
      const body = storagePayloads.get(storagePath[1]!);
      if (!body) {
        response.writeHead(404).end();
        return;
      }
      storageHits.set(
        storagePath[1]!,
        (storageHits.get(storagePath[1]!) ?? 0) + 1,
      );
      response
        .writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": body.length,
          "Cache-Control": "no-store",
        })
        .end(body);
      return;
    }
    const liveSegment = /^\/live-segment-(\d+)\.ts$/.exec(url.pathname);
    if (liveSegment) {
      const index = Number(liveSegment[1]);
      liveSegmentHits.add(index);
      response
        .writeHead(200, {
          "Content-Type": "video/mp2t",
          "Content-Length": segments[index]!.length,
        })
        .end(segments[index]);
      return;
    }
    const batch = /^\/batch-(\d+)\.mp4$/.exec(url.pathname);
    if (batch) {
      sendRange(request, response, batch[1]!);
      return;
    }
    response.writeHead(404).end();
  });
  const target = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://target");
    targetHeaderObservations.push({
      pathname: url.pathname,
      authorization: Boolean(request.headers.authorization),
      cookie: Boolean(request.headers.cookie),
    });
    if (url.pathname === "/target.m3u8") {
      response
        .writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" })
        .end(
          "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1.0,\nsegment.ts\n#EXT-X-ENDLIST\n",
        );
      return;
    }
    if (url.pathname === "/segment.ts") {
      response
        .writeHead(200, {
          "Content-Type": "video/mp2t",
          "Content-Length": segments[0]!.length,
        })
        .end(segments[0]);
      return;
    }
    response.writeHead(404).end();
  });
  await Promise.all([
    new Promise<void>((resolve) => source.listen(0, sourceListenHost, resolve)),
    new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve)),
  ]);
  const sourceAddress = source.address();
  const targetAddress = target.address();
  if (
    !sourceAddress ||
    typeof sourceAddress === "string" ||
    !targetAddress ||
    typeof targetAddress === "string"
  )
    throw new Error("Local fixture servers did not bind");
  const origin = `http://${sourceHost}:${sourceAddress.port}`;
  targetOrigin = `http://127.0.0.1:${targetAddress.port}`;
  const publishTimer = setInterval(() => {
    publishedSegments = Math.min(segments.length, publishedSegments + 1);
  }, 700);

  let application: ElectronApplication | undefined;
  let identity: WindowsProcessIdentity | undefined;
  let page: Page | undefined;
  const findings: Record<string, unknown> = {};
  const countFrames = (text: string) =>
    text.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#"))
      .length;
  const clientFor = async (targetPage: Page) => {
    const env = await targetPage.evaluate(async () =>
      (
        window as Window & {
          electron?: { app?: { getEnvPath(): Promise<unknown> } };
        }
      ).electron?.app?.getEnvPath(),
    );
    const coreUrl = coreURLFromIpc(env);
    if (!coreUrl)
      throw new Error("Core URL unavailable from trusted renderer response");
    return trustedCoreClient(targetPage, coreUrl);
  };
  try {
    application = await _electron.launch({
      executablePath: process.env.XIANGYING_E2E_EXECUTABLE!,
      args: [],
      timeout: 30_000,
      env: {
        ...scrubElectronEnvironment(process.env),
        APP_NAME: "xiangying",
        APP_TARGET: "electron",
        NODE_ENV: "production",
        ELECTRON_IS_DEV: "0",
        MEDIAGO_RUNTIME_ROOT: runtimeRoot,
        MEDIAGO_CORE_PORT: process.env.MEDIAGO_CORE_PORT || "39729",
        APPDATA: path.join(runtimeRoot, "appdata"),
        LOCALAPPDATA: path.join(runtimeRoot, "localappdata"),
        TEMP: path.join(runtimeRoot, "temp"),
        TMP: path.join(runtimeRoot, "temp"),
      },
    });
    identity = await readWindowsProcessIdentity(
      await application.evaluate(() => process.pid),
    );
    await expect
      .poll(
        () =>
          application!
            .windows()
            .some((window) =>
              /^xiangying:\/\/index\.html\/(?:library)?$/.test(window.url()),
            ),
        { timeout: 10_000 },
      )
      .toBe(true);
    page = application
      .windows()
      .find((window) =>
        /^xiangying:\/\/index\.html\/(?:library)?$/.test(window.url()),
      );
    if (!page) throw new Error("Packaged library page not found");
    const client = await clientFor(page);
    expect((await client.setConfigKey("local", downloads)).success).toBe(true);
    expect((await client.setConfigKey("maxRunner", 2)).success).toBe(true);

    if (stage === "storage") {
      const sha256 = (content: Buffer) =>
        createHash("sha256").update(content).digest("hex");
      const ensureOwnedOutput = (outputPath: string) => {
        const relative = path.relative(downloads, path.resolve(outputPath));
        if (
          !relative ||
          relative.startsWith(`..${path.sep}`) ||
          relative === ".." ||
          path.isAbsolute(relative)
        ) {
          throw new Error(
            "Candidate output escaped the isolated download directory",
          );
        }
        return path.resolve(outputPath);
      };
      const listTasks = async () =>
        (
          await client.getDownloadTasks({
            current: 1,
            pageSize: 100,
          })
        ).data.list;
      const waitForSuccess = async (id: number) =>
        expect
          .poll(async () => (await client.getDownloadTask(id)).data.status, {
            timeout: 45_000,
            intervals: [250, 500, 1_000],
          })
          .toBe("success");

      const sampleHash = sha256(media);
      const variantHash = sha256(storageVariant);
      findings.storageFixtures = {
        sampleSha256: sampleHash,
        variantSha256: variantHash,
        distinctValidMedia: sampleHash !== variantHash,
        variantDecodedByBundledFfmpeg: true,
      };
      const recordOnlyCreated = await client.addDownloadTasks({
        startDownload: true,
        tasks: [
          {
            type: "direct",
            name: "storage-record-only",
            url: `${origin}/storage/record-only.mp4`,
          },
        ],
      });
      expect(recordOnlyCreated.success).toBe(true);
      const recordOnlyId = recordOnlyCreated.data[0]!.id;
      await waitForSuccess(recordOnlyId);
      const recordOnlyTask = (await client.getDownloadTask(recordOnlyId)).data;
      if (!recordOnlyTask.outputPath)
        throw new Error("Completed record-only fixture has no outputPath");
      const recordOnlyPath = ensureOwnedOutput(recordOnlyTask.outputPath);
      const recordOnlyBeforeDelete = await readFile(recordOnlyPath);
      expect(sha256(recordOnlyBeforeDelete)).toBe(sampleHash);
      expect((await client.deleteDownloadTask(recordOnlyId)).success).toBe(
        true,
      );
      const recordAfterDelete = (await listTasks()).some(
        (task) => task.id === recordOnlyId,
      );
      const fileAfterRecordDelete = await readFile(recordOnlyPath);
      const recordOnlyOutcome = {
        id: recordOnlyId,
        path: recordOnlyPath,
        bytesBeforeDelete: recordOnlyBeforeDelete.length,
        sha256BeforeDelete: sha256(recordOnlyBeforeDelete),
        recordPresentAfterDelete: recordAfterDelete,
        filePresentAfterRecordDelete: true,
        sha256AfterRecordDelete: sha256(fileAfterRecordDelete),
      };
      findings.deleteRecordOnly = recordOnlyOutcome;
      await writeFile(
        path.join(ARTIFACTS, "controls-storage-runtime.json"),
        JSON.stringify(findings, null, 2),
        "utf8",
      );
      expect(recordAfterDelete).toBe(false);
      expect(sha256(fileAfterRecordDelete)).toBe(sampleHash);
      await unlink(recordOnlyPath);

      const fileOnlyCreated = await client.addDownloadTasks({
        startDownload: true,
        tasks: [
          {
            type: "direct",
            name: "storage-file-only",
            url: `${origin}/storage/file-only.mp4`,
          },
        ],
      });
      expect(fileOnlyCreated.success).toBe(true);
      const fileOnlyId = fileOnlyCreated.data[0]!.id;
      await waitForSuccess(fileOnlyId);
      const fileOnlyTask = (await client.getDownloadTask(fileOnlyId)).data;
      if (!fileOnlyTask.outputPath)
        throw new Error("Completed file-only fixture has no outputPath");
      const fileOnlyPath = ensureOwnedOutput(fileOnlyTask.outputPath);
      const fileOnlyBeforeDelete = await readFile(fileOnlyPath);
      expect(sha256(fileOnlyBeforeDelete)).toBe(variantHash);
      await unlink(fileOnlyPath);
      const fileAfterDelete = await readFile(fileOnlyPath)
        .then(() => true)
        .catch(() => false);
      const recordAfterFileDelete = (await listTasks()).some(
        (task) => task.id === fileOnlyId,
      );
      const fileOnlyOutcome = {
        id: fileOnlyId,
        path: fileOnlyPath,
        bytesBeforeDelete: fileOnlyBeforeDelete.length,
        sha256BeforeDelete: sha256(fileOnlyBeforeDelete),
        filePresentAfterDelete: fileAfterDelete,
        recordPresentAfterFileDelete: recordAfterFileDelete,
      };
      findings.externalFileRemoval = {
        mechanism: "test-owned unlink; no product file-delete control found",
        ...fileOnlyOutcome,
      };
      await writeFile(
        path.join(ARTIFACTS, "controls-storage-runtime.json"),
        JSON.stringify(findings, null, 2),
        "utf8",
      );
      expect(fileAfterDelete).toBe(false);
      expect(recordAfterFileDelete).toBe(true);
      expect((await client.deleteDownloadTask(fileOnlyId)).success).toBe(true);

      const duplicateURL = `${origin}/storage/duplicate-url.mp4`;
      const firstDuplicate = await client.addDownloadTasks({
        startDownload: true,
        tasks: [
          {
            type: "direct",
            name: "storage-duplicate-url-first",
            url: duplicateURL,
          },
        ],
      });
      expect(firstDuplicate.success).toBe(true);
      const duplicateIds = [firstDuplicate.data[0]!.id];
      let duplicateAdmission: "accepted" | "rejected" = "rejected";
      let duplicateRejection: string | undefined;
      try {
        const duplicate = await client.addDownloadTasks({
          startDownload: true,
          tasks: [
            {
              type: "direct",
              name: "storage-duplicate-url-second",
              url: duplicateURL,
            },
          ],
        });
        expect(duplicate.success).toBe(true);
        duplicateAdmission = "accepted";
        duplicateIds.push(...duplicate.data.map((task) => task.id));
      } catch (error) {
        duplicateRejection =
          error instanceof Error ? error.message : String(error);
      }
      await expect
        .poll(
          async () => {
            const statuses = await Promise.all(
              duplicateIds.map(
                async (id) => (await client.getDownloadTask(id)).data.status,
              ),
            );
            return statuses.every((status) => status === "success");
          },
          { timeout: 45_000, intervals: [250, 500, 1_000] },
        )
        .toBe(true);
      const duplicateOutputs = await Promise.all(
        duplicateIds.map(async (id) => {
          const task = (await client.getDownloadTask(id)).data;
          const outputPath = task.outputPath
            ? ensureOwnedOutput(task.outputPath)
            : undefined;
          const output = outputPath ? await readFile(outputPath) : undefined;
          return {
            id,
            name: task.name,
            status: task.status,
            outputPath,
            outputSha256: output ? sha256(output) : undefined,
          };
        }),
      );
      findings.duplicateURL = {
        url: duplicateURL,
        admission: duplicateAdmission,
        rejection: duplicateRejection,
        taskIds: duplicateIds,
        fixtureRequests: storageHits.get("duplicate-url") ?? 0,
        outputs: duplicateOutputs,
      };
      await writeFile(
        path.join(ARTIFACTS, "controls-storage-runtime.json"),
        JSON.stringify(findings, null, 2),
        "utf8",
      );
      expect(
        duplicateOutputs.every(
          (output) =>
            output.status !== "success" || output.outputSha256 === sampleHash,
        ),
      ).toBe(true);

      const sentinelPath = path.join(downloads, "same-title-different-url.mp4");
      const sentinelBytes = Buffer.from(
        "download-regression-existing-output-sentinel",
        "utf8",
      );
      await writeFile(sentinelPath, sentinelBytes);
      const sentinelHash = sha256(sentinelBytes);
      const sourceHashesBefore = {
        sample: sha256(await readFile(samplePath)),
        variant: sha256(await readFile(storageVariantPath)),
      };
      const sameTitleCreated = await client.addDownloadTasks({
        startDownload: false,
        tasks: [
          {
            type: "direct",
            name: "same-title-different-url",
            url: `${origin}/storage/same-title-a.mp4`,
          },
          {
            type: "direct",
            name: "same-title-different-url",
            url: `${origin}/storage/same-title-b.mp4`,
          },
        ],
      });
      expect(sameTitleCreated.success).toBe(true);
      const sameTitleIds = sameTitleCreated.data.map((task) => task.id);
      const starts = await Promise.all(
        sameTitleIds.map((id) =>
          client.startDownload(id, {
            localPath: downloads,
            deleteSegments: false,
          }),
        ),
      );
      expect(starts.every((response) => response.success)).toBe(true);
      await expect
        .poll(
          async () => {
            const tasks = await Promise.all(
              sameTitleIds.map(
                async (id) => (await client.getDownloadTask(id)).data,
              ),
            );
            return tasks.every(
              (task) => task.status === "success" || task.status === "failed",
            );
          },
          { timeout: 45_000, intervals: [250, 500, 1_000] },
        )
        .toBe(true);
      const sameTitleOutputs = await Promise.all(
        sameTitleIds.map(async (id) => {
          const task = (await client.getDownloadTask(id)).data;
          const expectedHash = task.url.endsWith("same-title-a.mp4")
            ? sampleHash
            : variantHash;
          let outputPath: string | undefined;
          let outputSha256: string | undefined;
          if (task.outputPath) {
            outputPath = ensureOwnedOutput(task.outputPath);
            outputSha256 = await readFile(outputPath)
              .then(sha256)
              .catch(() => undefined);
          }
          return {
            id,
            name: task.name,
            url: task.url,
            status: task.status,
            outputPath,
            expectedSha256: expectedHash,
            outputSha256,
            matchesSource: outputSha256 === expectedHash,
          };
        }),
      );
      const sentinelAfterHash = await readFile(sentinelPath)
        .then(sha256)
        .catch(() => undefined);
      const sourceHashesAfter = {
        sample: sha256(await readFile(samplePath)),
        variant: sha256(await readFile(storageVariantPath)),
      };
      findings.sameTitleDifferentURL = {
        taskIds: sameTitleIds,
        tasks: sameTitleOutputs,
        sentinelPath,
        sentinelSha256Before: sentinelHash,
        sentinelSha256After: sentinelAfterHash,
        sentinelPreserved: sentinelAfterHash === sentinelHash,
        sourceHashesBefore,
        sourceHashesAfter,
      };
      await writeFile(
        path.join(ARTIFACTS, "controls-storage-runtime.json"),
        JSON.stringify(findings, null, 2),
        "utf8",
      );
      expect(sourceHashesAfter).toEqual(sourceHashesBefore);
      expect(sentinelAfterHash).toBe(sentinelHash);
      expect(
        sameTitleOutputs.every(
          (output) => output.status !== "success" || output.matchesSource,
        ),
      ).toBe(true);
    }

    if (stage === "full" || stage === "live") {
      const liveCreated = await client.addDownloadTasks({
        startDownload: true,
        tasks: [
          {
            type: "m3u8",
            name: "controlled-live-recording",
            url: `${origin}/live.m3u8`,
          },
        ],
      });
      expect(liveCreated.success).toBe(true);
      const liveId = liveCreated.data[0]!.id;
      await expect
        .poll(() => liveSegmentHits.size, {
          timeout: 30_000,
          intervals: [250, 500, 1_000],
        })
        .toBeGreaterThanOrEqual(3);
      const liveObserved = (await client.getDownloadTask(liveId)).data;
      expect(liveObserved.isLive).toBe(true);
      expect((await client.stopDownload(liveId)).success).toBe(true);
      await expect
        .poll(async () => (await client.getDownloadTask(liveId)).data.status, {
          timeout: 40_000,
          intervals: [250, 500, 1_000],
        })
        .toBe("success");
      const liveFinal = (await client.getDownloadTask(liveId)).data;
      if (!liveFinal.outputPath)
        throw new Error("Finalized live task has no output path");
      const liveInfo = await stat(liveFinal.outputPath);
      expect(liveInfo.size).toBeGreaterThan(0);
      const liveVideo = await promisify(execFile)(
        ffmpeg,
        [
          "-v",
          "error",
          "-i",
          liveFinal.outputPath,
          "-map",
          "0:v:0",
          "-f",
          "framemd5",
          "-",
        ],
        { timeout: 30_000, windowsHide: true },
      );
      const liveAudio = await promisify(execFile)(
        ffmpeg,
        [
          "-v",
          "error",
          "-i",
          liveFinal.outputPath,
          "-map",
          "0:a:0",
          "-f",
          "framemd5",
          "-",
        ],
        { timeout: 30_000, windowsHide: true },
      );
      expect(countFrames(liveVideo.stdout)).toBeGreaterThan(0);
      expect(countFrames(liveAudio.stdout)).toBeGreaterThan(0);
      findings.live = {
        id: liveId,
        isLive: liveObserved.isLive,
        stopStatus: liveFinal.status,
        segmentsPublished: publishedSegments,
        segmentsFetched: [...liveSegmentHits].sort((a, b) => a - b),
        outputPath: liveFinal.outputPath,
        outputBytes: liveInfo.size,
        decodedVideoFrames: countFrames(liveVideo.stdout),
        decodedAudioFrames: countFrames(liveAudio.stdout),
      };

      findings.live = findings.live || null;
    }

    if (stage === "full" || stage === "headers") {
      const fakeHeaders =
        "Cookie: session=download-regression-sentinel\nAuthorization: Bearer download-regression-sentinel";
      const redirectCreated = await client.addDownloadTasks({
        startDownload: true,
        tasks: [
          {
            type: "m3u8",
            name: "controlled-header-redirect",
            url: `${origin}/redirect.m3u8`,
            headers: fakeHeaders,
          },
        ],
      });
      expect(redirectCreated.success).toBe(true);
      const redirectId = redirectCreated.data[0]!.id;
      await expect
        .poll(
          async () => (await client.getDownloadTask(redirectId)).data.status,
          { timeout: 30_000, intervals: [250, 500, 1_000] },
        )
        .toBe("success");
      const redirectTask = (await client.getDownloadTask(redirectId)).data;
      const publicTaskJson = JSON.stringify(redirectTask);
      findings.redirectHeaderBoundary = {
        taskId: redirectId,
        sourceOrigin: origin,
        targetOrigin,
        suppliedBy: "explicit controlled Core task headers",
        sourceObservedAuthorization: sourceHeaderObservation.authorization,
        sourceObservedCookie: sourceHeaderObservation.cookie,
        targetRequestObservations: targetHeaderObservations,
        apiResponseContainsFakeSecret: publicTaskJson.includes(
          "download-regression-sentinel",
        ),
      };
    }

    if (stage === "full" || stage === "ui") {
      const batchCreated = await client.addDownloadTasks({
        startDownload: false,
        tasks: [1, 2].map((id) => ({
          type: "direct",
          name: `controlled-batch-${id}`,
          url: `${origin}/batch-${id}.mp4`,
        })),
      });
      expect(batchCreated.success).toBe(true);
      const batchIds = batchCreated.data.map((task) => task.id);
      const edited = await client.editDownloadTask(batchIds[0]!, {
        name: "controlled-batch-edited",
        folder: "regression-folder",
      });
      expect(edited.success).toBe(true);
      const firstPage = await client.getDownloadTasks({
        current: 1,
        pageSize: 1,
        filter: DownloadFilter.list,
      });
      const secondPage = await client.getDownloadTasks({
        current: 2,
        pageSize: 1,
        filter: DownloadFilter.list,
      });
      expect(firstPage.data.total).toBeGreaterThanOrEqual(2);
      expect(firstPage.data.list[0]?.id).not.toBe(secondPage.data.list[0]?.id);
      const exported = await client.exportDownloadList();
      expect(exported.success).toBe(true);
      expect(exported.data).toContain("controlled-batch-edited");
      expect(exported.data).toContain("controlled-batch-2");
      findings.downloadApi = {
        taskIds: batchIds,
        editedName: edited.data.name,
        page1Ids: firstPage.data.list.map((task) => task.id),
        page2Ids: secondPage.data.list.map((task) => task.id),
        exportContainsExpectedNames:
          exported.data.includes("controlled-batch-edited") &&
          exported.data.includes("controlled-batch-2"),
      };
      await writeFile(
        path.join(ARTIFACTS, `controls-${stage}-runtime.json`),
        JSON.stringify(findings, null, 2),
        "utf8",
      );

      await page.getByRole("link", { name: /下载任务/ }).click();
      await expect(
        page.getByRole("article", { name: "controlled-batch-edited" }),
      ).toBeVisible();
      await expect(
        page.getByRole("article", { name: "controlled-batch-2" }),
      ).toBeVisible();
      await page.getByText("全选", { exact: true }).click();
      const bulkDownloadButtons = page.getByRole("button", {
        name: "下载",
        exact: true,
      });
      await expect(bulkDownloadButtons).toHaveCount(3);
      // Current list DOM exposes one toolbar action followed by one action per row.
      await bulkDownloadButtons.nth(0).click();
      await expect
        .poll(
          async () => {
            const tasks = await Promise.all(
              batchIds.map(
                async (id) => (await client.getDownloadTask(id)).data,
              ),
            );
            return (
              batchRequests.size === 2 ||
              tasks.every(
                (task) => task.status === "failed" || task.status === "success",
              )
            );
          },
          { timeout: 20_000 },
        )
        .toBe(true);
      const startObservation = await Promise.all(
        batchIds.map(async (id) => (await client.getDownloadTask(id)).data),
      );
      findings.downloadStartObservation = {
        requestPaths: [...batchRequests].sort(),
        taskStatuses: startObservation.map((task) => task.status),
      };
      await writeFile(
        path.join(ARTIFACTS, `controls-${stage}-runtime.json`),
        JSON.stringify(findings, null, 2),
        "utf8",
      );
      expect(batchRequests.size).toBe(2);
      await expect
        .poll(
          async () =>
            Promise.all(
              batchIds.map(
                async (id) => (await client.getDownloadTask(id)).data.status,
              ),
            ),
          { timeout: 20_000 },
        )
        .toEqual(["downloading", "downloading"]);
      const selectAllCheckbox = page.getByRole("checkbox").first();
      if (!(await selectAllCheckbox.isChecked()))
        await selectAllCheckbox.check();
      const bulkCancelButtons = page.getByRole("button", {
        name: "取消",
        exact: true,
      });
      await expect(bulkCancelButtons).toHaveCount(1);
      await expect(bulkCancelButtons).toBeEnabled();
      await bulkCancelButtons.click();
      await expect(
        page.getByRole("article", { name: "controlled-batch-edited" }),
      ).toBeVisible();
      for (const id of batchIds)
        expect((await client.stopDownload(id)).success).toBe(true);
      await expect
        .poll(
          async () =>
            Promise.all(
              batchIds.map(
                async (id) => (await client.getDownloadTask(id)).data.status,
              ),
            ),
          { timeout: 20_000 },
        )
        .toEqual(["stopped", "stopped"]);
      await expect(
        page.getByRole("article", { name: "controlled-batch-edited" }),
      ).toBeVisible();
      const rowCheckbox = page
        .getByRole("article", { name: "controlled-batch-edited" })
        .getByRole("checkbox");
      await rowCheckbox.click();
      await page
        .getByRole("button", { name: "删除", exact: true })
        .last()
        .click();
      const remaining = (
        await client.getDownloadTasks({
          current: 1,
          pageSize: 50,
          filter: DownloadFilter.list,
        })
      ).data.list;
      expect(remaining.some((task) => task.id === batchIds[0])).toBe(false);
      expect(remaining.some((task) => task.id === batchIds[1])).toBe(true);
      findings.downloadControls = {
        taskIds: batchIds,
        editedName: edited.data.name,
        page1Ids: firstPage.data.list.map((task) => task.id),
        page2Ids: secondPage.data.list.map((task) => task.id),
        exportIncludesOnlyExpectedBatchNames:
          exported.data.includes("controlled-batch-edited") &&
          exported.data.includes("controlled-batch-2"),
        uiBatchStartObserved: [...batchRequests].sort(),
        selectionCancelKeptTasks: true,
        deleteRemovedOnlySelected: true,
      };
      await writeFile(
        path.join(ARTIFACTS, "controls-runtime.json"),
        JSON.stringify(findings, null, 2),
        "utf8",
      );

      const qualities = ["low", "medium", "high"] as const;
      const qualityInputs = new Map(
        qualities.map((quality) => [
          quality,
          path.join(downloads, `controlled-quality-${quality}.mov`),
        ]),
      );
      const inputHashes = new Map<string, string>();
      for (const [quality, inputPath] of qualityInputs) {
        await writeFile(inputPath, media);
        inputHashes.set(
          quality,
          createHash("sha256")
            .update(await readFile(inputPath))
            .digest("hex"),
        );
      }
      const qualityJobs = await Promise.all(
        qualities.map((quality) =>
          client.addConversion({
            path: qualityInputs.get(quality)!,
            outputFormat: "mkv",
            quality,
            name: `controlled-quality-${quality}`,
          }),
        ),
      );
      expect(qualityJobs.every((job) => job.success)).toBe(true);
      const conversionIds = qualityJobs.map((job) => job.data.id);
      const starts = await Promise.all(
        conversionIds.map((id) => client.startConversion(id)),
      );
      expect(starts.every((response) => response.success)).toBe(true);
      await expect
        .poll(
          async () =>
            Promise.all(
              conversionIds.map(
                async (id) => (await client.getConversion(id)).data.status,
              ),
            ),
          { timeout: 45_000, intervals: [250, 500, 1_000] },
        )
        .toEqual(["done", "done", "done"]);
      const conversionResults = [];
      for (const id of conversionIds) {
        const item = (await client.getConversion(id)).data;
        const videoFrames = await promisify(execFile)(
          ffmpeg,
          [
            "-v",
            "error",
            "-i",
            item.outputPath,
            "-map",
            "0:v:0",
            "-f",
            "framemd5",
            "-",
          ],
          { timeout: 30_000, windowsHide: true },
        );
        const audioFrames = await promisify(execFile)(
          ffmpeg,
          [
            "-v",
            "error",
            "-i",
            item.outputPath,
            "-map",
            "0:a:0",
            "-f",
            "framemd5",
            "-",
          ],
          { timeout: 30_000, windowsHide: true },
        );
        expect(countFrames(videoFrames.stdout)).toBeGreaterThan(0);
        expect(countFrames(audioFrames.stdout)).toBeGreaterThan(0);
        conversionResults.push({
          id,
          quality: item.quality,
          status: item.status,
          outputPath: item.outputPath,
          outputBytes: (await stat(item.outputPath)).size,
          decodedVideoFrames: countFrames(videoFrames.stdout),
          decodedAudioFrames: countFrames(audioFrames.stdout),
        });
        expect((await client.deleteConversion(id)).success).toBe(true);
      }
      for (const quality of qualities)
        expect(
          createHash("sha256")
            .update(await readFile(qualityInputs.get(quality)!))
            .digest("hex"),
        ).toBe(inputHashes.get(quality));
      findings.conversionQualityBatch = {
        inputSha256: Object.fromEntries(inputHashes),
        jobs: conversionResults,
        recordsDeleted: conversionIds.length,
      };
      await writeFile(
        path.join(ARTIFACTS, `controls-${stage}-runtime.json`),
        JSON.stringify(findings, null, 2),
        "utf8",
      );
    }

    if (stage === "full" || stage === "headers") {
      expect(
        targetHeaderObservations.some((entry) => entry.authorization),
      ).toBe(false);
      expect(targetHeaderObservations.some((entry) => entry.cookie)).toBe(
        false,
      );
      expect(sourceHeaderObservation.authorization).toBe(true);
      expect(sourceHeaderObservation.cookie).toBe(true);
      expect(findings.redirectHeaderBoundary).toMatchObject({
        apiResponseContainsFakeSecret: false,
      });
    }
  } finally {
    clearInterval(publishTimer);
    for (const finish of heldBatchResponses.values()) finish();
    if (application) {
      await application
        .evaluate(({ app }) => app.quit())
        .catch(() => undefined);
      await application.close().catch(() => undefined);
      if (identity)
        expect(await waitForWindowsProcessExit(identity, 5_000)).toBe(true);
    }
    await Promise.all([
      new Promise<void>((resolve) => source.close(() => resolve())),
      new Promise<void>((resolve) => target.close(() => resolve())),
    ]);
    await writeFile(
      path.join(ARTIFACTS, `controls-${stage}-final.json`),
      JSON.stringify(
        {
          findings,
          sourceHeaderObservation,
          targetHeaderObservations,
          appExited: !application || Boolean(identity),
        },
        null,
        2,
      ),
      "utf8",
    );
    await test.info().attach(`controls-${stage}-final.json`, {
      body: JSON.stringify(
        { findings, sourceHeaderObservation, targetHeaderObservations },
        null,
        2,
      ),
      contentType: "application/json",
    });
  }
});
