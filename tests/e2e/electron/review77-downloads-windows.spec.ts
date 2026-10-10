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
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { scrubElectronEnvironment } from "../support/regression-downloads-electron-network.ts";
import { trustedCoreClient } from "../support/xiangying-core-client.ts";
import { assertPortFree, reserveLoopbackPort } from "../support/ports.ts";
import {
  readWindowsProcessIdentity,
  waitForWindowsProcessExit,
  type WindowsProcessIdentity,
} from "../support/xiangying-windows-process.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BINDING_PATH = path.join(
  ROOT,
  ".task/repair-20261006/candidate-ui-binding.json",
);
const SAMPLE_PATH = path.join(ROOT, "tests/media-service/public/v1/sample.mp4");
const EVIDENCE_DIR = path.join(ROOT, ".task/review77-20261006/downloads");

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
  "candidate-bound Windows download lifecycle acceptance",
);

test("candidate download stop/retry/record removal, multi-segment live HLS, and one-format conversion lifecycle", async () => {
  test.setTimeout(240_000);
  const binding = JSON.parse(await readFile(BINDING_PATH, "utf8")) as {
    candidate: string;
    coreSha256: string;
    asarSha256: string;
  };
  const expectedExecutable = path.join(binding.candidate, "乡映.exe");
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    path.resolve(expectedExecutable),
  );

  const runtimeRoot = await mkdtemp(
    path.join(ROOT, ".task/review77-20261006/downloads/runtime-"),
  );
  const downloads = path.join(runtimeRoot, "downloads");
  const fixtures = path.join(runtimeRoot, "fixtures");
  const ffmpeg = path.join(binding.candidate, "resources/deps/ffmpeg.exe");
  await Promise.all([
    mkdir(downloads, { recursive: true }),
    mkdir(fixtures, { recursive: true }),
    mkdir(path.join(runtimeRoot, "appdata"), { recursive: true }),
    mkdir(path.join(runtimeRoot, "localappdata"), { recursive: true }),
    mkdir(path.join(runtimeRoot, "temp"), { recursive: true }),
  ]);

  const segmentPattern = path.join(fixtures, "segment-%02d.ts");
  await promisify(execFile)(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-stream_loop",
      "8",
      "-i",
      SAMPLE_PATH,
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
      segmentPattern,
    ],
    { timeout: 30_000, windowsHide: true },
  );
  const segments = (await readdir(fixtures))
    .filter((name) => /^segment-\d+\.ts$/.test(name))
    .sort()
    .map((name) => path.join(fixtures, name));
  expect(segments.length).toBeGreaterThanOrEqual(3);
  const segmentBytes = await Promise.all(
    segments.map((segment) => readFile(segment)),
  );
  const sampleHash = createHash("sha256")
    .update(await readFile(SAMPLE_PATH))
    .digest("hex");

  let holdFirstResponse = true;
  let heldResponse: ServerResponse | undefined;
  let heldRemovalResponse: ServerResponse | undefined;
  let removalHits = 0;
  let directHits = 0;
  let livePlaylistHits = 0;
  const servedSegments = new Set<number>();
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
      if (pathname === "/stop-retry.mp4") {
        directHits++;
        if (holdFirstResponse && directHits === 1) {
          heldResponse = response;
          response.writeHead(200, {
            "Content-Type": "video/mp4",
            "Content-Length": String(Buffer.byteLength("held")),
          });
          response.write("h");
          return;
        }
        const body = awaitlessSample;
        response.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": String(body.length),
        });
        response.end(body);
        return;
      }
      if (pathname.startsWith("/remove-active-")) {
        removalHits++;
        heldRemovalResponse = response;
        response.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": String(awaitlessSample.length),
        });
        response.write(awaitlessSample.subarray(0, 1));
        return;
      }
      if (pathname === "/live.m3u8") {
        livePlaylistHits++;
        response.writeHead(200, {
          "Content-Type": "application/vnd.apple.mpegurl",
        });
        response.end(
          `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n${segments.map((_, index) => `#EXTINF:1.0,\nsegment/${index}`).join("\n")}\n`,
        );
        return;
      }
      const segmentMatch = /^\/segment\/(\d+)$/.exec(pathname);
      if (segmentMatch) {
        const index = Number(segmentMatch[1]);
        const body = segmentBytes[index];
        if (!body) {
          response.writeHead(404).end();
          return;
        }
        servedSegments.add(index);
        response.writeHead(200, {
          "Content-Type": "video/mp2t",
          "Content-Length": String(body.length),
        });
        response.end(body);
        return;
      }
      response.writeHead(404).end();
    },
  );
  const awaitlessSample = await readFile(SAMPLE_PATH);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("local fixture server did not bind");
  const origin = `http://127.0.0.1:${address.port}`;
  const corePort = process.env.MEDIAGO_CORE_PORT
    ? Number(process.env.MEDIAGO_CORE_PORT)
    : await reserveLoopbackPort();

  let application: ElectronApplication | undefined;
  let ownerIdentity: WindowsProcessIdentity | undefined;
  let page: Page | undefined;
  try {
    application = await _electron.launch({
      executablePath: expectedExecutable,
      args: [],
      timeout: 30_000,
      env: {
        ...scrubElectronEnvironment(process.env),
        APP_NAME: "xiangying",
        APP_TARGET: "electron",
        NODE_ENV: "production",
        ELECTRON_IS_DEV: "0",
        MEDIAGO_RUNTIME_ROOT: runtimeRoot,
        MEDIAGO_CORE_PORT: String(corePort),
        APPDATA: path.join(runtimeRoot, "appdata"),
        LOCALAPPDATA: path.join(runtimeRoot, "localappdata"),
        TEMP: path.join(runtimeRoot, "temp"),
        TMP: path.join(runtimeRoot, "temp"),
      },
    });
    ownerIdentity = await readWindowsProcessIdentity(
      await application.evaluate(() => process.pid),
    );
    if (!ownerIdentity)
      throw new Error("candidate Electron owner exited during startup");
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
    if (!page) throw new Error("candidate library window not found");
    const appEnv = await page.evaluate(async () =>
      (
        window as Window & {
          electron?: { app?: { getEnvPath(): Promise<unknown> } };
        }
      ).electron?.app?.getEnvPath(),
    );
    const coreURL = coreURLFromIpc(appEnv);
    if (!coreURL) throw new Error("trusted Core URL unavailable");
    const client = trustedCoreClient(page, coreURL);
    expect((await client.setConfigKey("local", downloads)).success).toBe(true);
    expect((await client.setConfigKey("maxRunner", 1)).success).toBe(true);

    const created = await client.addDownloadTasks({
      startDownload: false,
      tasks: [
        {
          type: "direct",
          name: "review77-stop-retry",
          url: `${origin}/stop-retry.mp4`,
        },
      ],
    });
    expect(created.success).toBe(true);
    const directId = created.data[0]!.id;
    expect(
      (
        await client.startDownload(directId, {
          localPath: downloads,
          deleteSegments: false,
        })
      ).success,
    ).toBe(true);
    await expect.poll(() => directHits, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(heldResponse).toBeDefined();
    expect((await client.stopDownload(directId)).success).toBe(true);
    heldResponse?.destroy();
    await expect
      .poll(async () => (await client.getDownloadTask(directId)).data.status, {
        timeout: 15_000,
      })
      .toMatch(/stopped|failed/);
    holdFirstResponse = false;
    expect(
      (
        await client.startDownload(directId, {
          localPath: downloads,
          deleteSegments: false,
        })
      ).success,
    ).toBe(true);
    await expect
      .poll(async () => (await client.getDownloadTask(directId)).data.status, {
        timeout: 45_000,
      })
      .toBe("success");
    const directTask = (await client.getDownloadTask(directId)).data;
    expect(directTask.outputPath).toBeTruthy();
    const directOutput = path.resolve(directTask.outputPath!);
    expect(path.relative(downloads, directOutput).startsWith("..")).toBe(false);
    expect(
      createHash("sha256")
        .update(await readFile(directOutput))
        .digest("hex"),
    ).toBe(sampleHash);

    const removalTasks = await client.addDownloadTasks({
      startDownload: false,
      tasks: [
        {
          type: "direct",
          name: "review77-remove-active",
          url: `${origin}/remove-active-active.mp4`,
        },
        {
          type: "direct",
          name: "review77-remove-pending",
          url: `${origin}/remove-active-pending.mp4`,
        },
      ],
    });
    expect(removalTasks.success).toBe(true);
    const [activeRemovalId, pendingRemovalId] = removalTasks.data.map(
      (task) => task.id,
    );
    expect(
      (
        await client.startDownload(activeRemovalId!, {
          localPath: downloads,
          deleteSegments: false,
        })
      ).success,
    ).toBe(true);
    await expect
      .poll(() => removalHits, { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(
      (
        await client.startDownload(pendingRemovalId!, {
          localPath: downloads,
          deleteSegments: false,
        })
      ).success,
    ).toBe(true);
    await expect
      .poll(
        async () =>
          (await client.getActiveTasks()).data.some(
            (task) => task.id === pendingRemovalId,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    expect((await client.deleteDownloadTask(pendingRemovalId!)).success).toBe(
      true,
    );
    expect((await client.deleteDownloadTask(activeRemovalId!)).success).toBe(
      true,
    );
    heldRemovalResponse?.destroy();
    await expect
      .poll(
        async () => {
          const tasks = (
            await client.getDownloadTasks({
              current: 1,
              pageSize: 100,
            })
          ).data.list;
          return tasks.some(
            (task) =>
              task.id === activeRemovalId || task.id === pendingRemovalId,
          );
        },
        { timeout: 15_000 },
      )
      .toBe(false);
    expect(
      createHash("sha256")
        .update(await readFile(directOutput))
        .digest("hex"),
    ).toBe(sampleHash);

    const live = await client.addDownloadTasks({
      startDownload: true,
      tasks: [
        {
          type: "m3u8",
          name: "review77-multisegment-live",
          url: `${origin}/live.m3u8`,
        },
      ],
    });
    expect(live.success).toBe(true);
    const liveId = live.data[0]!.id;
    await expect
      .poll(() => servedSegments.size, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(3);
    expect(livePlaylistHits).toBeGreaterThan(0);
    expect((await client.stopDownload(liveId)).success).toBe(true);
    await expect
      .poll(async () => (await client.getDownloadTask(liveId)).data.status, {
        timeout: 45_000,
      })
      .toBe("success");
    const liveTask = (await client.getDownloadTask(liveId)).data;
    expect(liveTask.outputPath).toBeTruthy();
    const liveOutput = path.resolve(liveTask.outputPath!);
    await promisify(execFile)(
      ffmpeg,
      ["-hide_banner", "-v", "error", "-i", liveOutput, "-f", "null", "-"],
      { timeout: 30_000, windowsHide: true },
    );

    const conversionInput = path.join(
      downloads,
      "review77-conversion-input.mov",
    );
    await promisify(execFile)(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-stream_loop",
        "79",
        "-i",
        SAMPLE_PATH,
        "-c",
        "copy",
        conversionInput,
      ],
      { timeout: 30_000, windowsHide: true },
    );
    const conversion = await client.addConversion({
      path: conversionInput,
      outputFormat: "mp4",
      quality: "medium",
    });
    expect(conversion.success).toBe(true);
    const conversionId = conversion.data.id;
    expect((await client.startConversion(conversionId)).success).toBe(true);
    await expect
      .poll(
        async () => (await client.getConversion(conversionId)).data.status,
        { timeout: 10_000 },
      )
      .toBe("converting");
    expect((await client.stopConversion(conversionId)).success).toBe(true);
    await expect
      .poll(
        async () => (await client.getConversion(conversionId)).data.status,
        { timeout: 15_000 },
      )
      .toBe("failed");
    expect((await client.startConversion(conversionId)).success).toBe(true);
    await expect
      .poll(
        async () => (await client.getConversion(conversionId)).data.status,
        { timeout: 60_000 },
      )
      .toMatch(/^(done|failed)$/);
    const converted = (await client.getConversion(conversionId)).data;
    expect(converted.status).toBe("done");
    expect(converted.outputPath).toBeTruthy();
    await promisify(execFile)(
      ffmpeg,
      [
        "-hide_banner",
        "-v",
        "error",
        "-i",
        converted.outputPath,
        "-f",
        "null",
        "-",
      ],
      { timeout: 30_000, windowsHide: true },
    );
    expect((await client.deleteConversion(conversionId)).success).toBe(true);

    // Product deletion removes the task record only; output bytes remain available.
    const beforeDelete = createHash("sha256")
      .update(await readFile(directOutput))
      .digest("hex");
    expect((await client.deleteDownloadTask(directId)).success).toBe(true);
    expect(
      createHash("sha256")
        .update(await readFile(directOutput))
        .digest("hex"),
    ).toBe(beforeDelete);
    expect(
      await client.getDownloadTask(directId).then(
        () => false,
        () => true,
      ),
    ).toBe(true);
    await writeFile(
      path.join(EVIDENCE_DIR, "review77-downloads-runtime.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          runtimeOwnerPid: ownerIdentity.pid,
          runtimeOwnerCreationFileTime: ownerIdentity.creationFileTime,
          corePort,
          directHits,
          removalHits,
          livePlaylistHits,
          servedSegments: [...servedSegments].sort((a, b) => a - b),
          liveOutput,
          convertedOutput: converted.outputPath,
          outputRecordDeletePreservedSha256: beforeDelete,
        },
        null,
        2,
      ),
    );
  } finally {
    if (application) await application.close().catch(() => undefined);
    if (ownerIdentity)
      expect(
        await waitForWindowsProcessExit(ownerIdentity, 10_000),
        "owned candidate Electron process exited after close",
      ).toBe(true);
    await assertPortFree(
      "127.0.0.1",
      corePort,
      "review77 candidate Core cleanup",
    );
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("local direct redirect fake-header probe and URL-edit credential invalidation", async () => {
  test.setTimeout(120_000);
  const binding = JSON.parse(await readFile(BINDING_PATH, "utf8")) as {
    candidate: string;
    coreSha256: string;
    asarSha256: string;
  };
  const expectedExecutable = path.join(binding.candidate, "乡映.exe");
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    path.resolve(expectedExecutable),
  );
  const runtimeRoot = await mkdtemp(
    path.join(ROOT, ".task/review77-20261006/downloads/header-runtime-"),
  );
  const downloads = path.join(runtimeRoot, "downloads");
  const temp = path.join(runtimeRoot, "temp");
  const appdata = path.join(runtimeRoot, "appdata");
  const localappdata = path.join(runtimeRoot, "localappdata");
  await Promise.all(
    [downloads, temp, appdata, localappdata].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  const payload = await readFile(SAMPLE_PATH);
  const dummyCookie = "review77-cookie-dummy-only";
  const dummyAuthorization = "Bearer review77-auth-dummy-only";
  const observations = {
    sourceRequests: 0,
    sourceCookieHeader: false,
    sourceAuthorizationHeader: false,
    redirectTargetRequests: 0,
    targetCookieHeader: false,
    targetAuthorizationHeader: false,
    editedURLRequests: 0,
  };
  let targetOrigin = "";
  const targetServer = createServer((request, response) => {
    observations.redirectTargetRequests++;
    observations.targetCookieHeader ||= String(
      request.headers.cookie || "",
    ).includes(dummyCookie);
    observations.targetAuthorizationHeader ||= String(
      request.headers.authorization || "",
    ).includes(dummyAuthorization);
    response.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const sourceServer = createServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    if (pathname === "/redirect.mp4") {
      observations.sourceRequests++;
      observations.sourceCookieHeader ||= String(
        request.headers.cookie || "",
      ).includes(dummyCookie);
      observations.sourceAuthorizationHeader ||= String(
        request.headers.authorization || "",
      ).includes(dummyAuthorization);
      response.writeHead(302, { Location: `${targetOrigin}/payload.mp4` });
      response.end();
      return;
    }
    if (pathname === "/after-edit.mp4") {
      observations.editedURLRequests++;
      response.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    response.writeHead(404).end();
  });
  const listenLoopback = async (server: ReturnType<typeof createServer>) => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("local header fixture failed to bind");
    return address.port;
  };
  const targetPort = await listenLoopback(targetServer);
  targetOrigin = `http://127.0.0.1:${targetPort}`;
  const sourcePort = await listenLoopback(sourceServer);
  const corePort = process.env.MEDIAGO_CORE_PORT
    ? Number(process.env.MEDIAGO_CORE_PORT)
    : await reserveLoopbackPort();
  let application: ElectronApplication | undefined;
  let ownerIdentity: WindowsProcessIdentity | undefined;
  try {
    application = await _electron.launch({
      executablePath: expectedExecutable,
      args: [],
      timeout: 30_000,
      env: {
        ...scrubElectronEnvironment(process.env),
        APP_NAME: "xiangying",
        APP_TARGET: "electron",
        NODE_ENV: "production",
        ELECTRON_IS_DEV: "0",
        MEDIAGO_RUNTIME_ROOT: runtimeRoot,
        MEDIAGO_CORE_PORT: String(corePort),
        APPDATA: appdata,
        LOCALAPPDATA: localappdata,
        TEMP: temp,
        TMP: temp,
      },
    });
    ownerIdentity = await readWindowsProcessIdentity(
      await application.evaluate(() => process.pid),
    );
    if (!ownerIdentity)
      throw new Error(
        "candidate Electron owner exited during header probe startup",
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
    const page = application
      .windows()
      .find((window) =>
        /^xiangying:\/\/index\.html\/(?:library)?$/.test(window.url()),
      );
    if (!page) throw new Error("candidate library window not found");
    const appEnv = await page.evaluate(async () =>
      (
        window as Window & {
          electron?: { app?: { getEnvPath(): Promise<unknown> } };
        }
      ).electron?.app?.getEnvPath(),
    );
    const coreURL = coreURLFromIpc(appEnv);
    if (!coreURL) throw new Error("trusted Core URL unavailable");
    const client = trustedCoreClient(page, coreURL);
    expect((await client.setConfigKey("local", downloads)).success).toBe(true);
    const created = await client.addDownloadTasks({
      startDownload: true,
      tasks: [
        {
          type: "direct",
          name: "review77-local-header-redirect",
          url: `http://localhost:${sourcePort}/redirect.mp4`,
          headers: `Cookie: ${dummyCookie}\nAuthorization: ${dummyAuthorization}`,
        },
      ],
    });
    expect(created.success).toBe(true);
    const taskId = created.data[0]!.id;
    await expect
      .poll(async () => (await client.getDownloadTask(taskId)).data.status, {
        timeout: 45_000,
      })
      .toMatch(/^(success|failed)$/);
    const taskAfterDownload = (await client.getDownloadTask(taskId)).data;
    const logAfterDownload = (await client.getDownloadLogs(taskId)).data.log;
    const changedUrl = `http://localhost:${sourcePort}/after-edit.mp4`;
    expect(
      (
        await client.editDownloadTask(taskId, {
          url: changedUrl,
        })
      ).success,
    ).toBe(true);
    let editedRetryRejected = false;
    try {
      await client.startDownload(taskId, {
        localPath: downloads,
        deleteSegments: false,
      });
    } catch {
      editedRetryRejected = true;
    }
    const taskAfterEdit = (await client.getDownloadTask(taskId)).data;
    const logAfterEdit = (await client.getDownloadLogs(taskId)).data.log;
    const secretAbsentFromTaskAndLogs = ![
      JSON.stringify(taskAfterDownload),
      JSON.stringify(taskAfterEdit),
      logAfterDownload,
      logAfterEdit,
    ].some(
      (text) => text.includes(dummyCookie) || text.includes(dummyAuthorization),
    );
    await writeFile(
      path.join(EVIDENCE_DIR, "review77-direct-header-probe.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          runtimeOwnerPid: ownerIdentity.pid,
          runtimeOwnerCreationFileTime: ownerIdentity.creationFileTime,
          corePort,
          sourceHost: "localhost",
          redirectTargetHost: "127.0.0.1",
          taskStatus: taskAfterDownload.status,
          redirectTargetRequests: observations.redirectTargetRequests,
          sourceCookieHeader: observations.sourceCookieHeader,
          sourceAuthorizationHeader: observations.sourceAuthorizationHeader,
          targetCookieHeader: observations.targetCookieHeader,
          targetAuthorizationHeader: observations.targetAuthorizationHeader,
          editedRetryRejected,
          editedURLRequests: observations.editedURLRequests,
          secretAbsentFromTaskAndLogs,
        },
        null,
        2,
      ),
    );
    expect(observations.sourceRequests).toBeGreaterThan(0);
    expect(observations.redirectTargetRequests).toBeGreaterThan(0);
    expect(observations.targetCookieHeader).toBe(false);
    expect(observations.targetAuthorizationHeader).toBe(false);
    expect(editedRetryRejected).toBe(true);
    expect(observations.editedURLRequests).toBe(0);
    expect(secretAbsentFromTaskAndLogs).toBe(true);
  } finally {
    if (application) await application.close().catch(() => undefined);
    if (ownerIdentity)
      expect(
        await waitForWindowsProcessExit(ownerIdentity, 10_000),
        "owned candidate Electron process exited after header probe",
      ).toBe(true);
    await assertPortFree(
      "127.0.0.1",
      corePort,
      "review77 header probe Core cleanup",
    );
    sourceServer.closeAllConnections();
    targetServer.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => sourceServer.close(() => resolve())),
      new Promise<void>((resolve) => targetServer.close(() => resolve())),
    ]);
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("candidate multi-segment VOD completes naturally and pending stop is distinct from deletion", async () => {
  test.setTimeout(180_000);
  const binding = JSON.parse(await readFile(BINDING_PATH, "utf8")) as {
    candidate: string;
    coreSha256: string;
    asarSha256: string;
  };
  const expectedExecutable = path.join(binding.candidate, "乡映.exe");
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    path.resolve(expectedExecutable),
  );
  const runtimeRoot = await mkdtemp(
    path.join(ROOT, ".task/review77-20261006/downloads/vod-runtime-"),
  );
  const downloads = path.join(runtimeRoot, "downloads");
  const fixtures = path.join(runtimeRoot, "fixtures");
  const temp = path.join(runtimeRoot, "temp");
  const ffmpeg = path.join(binding.candidate, "resources/deps/ffmpeg.exe");
  await Promise.all(
    [
      downloads,
      fixtures,
      temp,
      path.join(runtimeRoot, "appdata"),
      path.join(runtimeRoot, "localappdata"),
    ].map((directory) => mkdir(directory, { recursive: true })),
  );
  await promisify(execFile)(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-stream_loop",
      "8",
      "-i",
      SAMPLE_PATH,
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
      path.join(fixtures, "vod-%02d.ts"),
    ],
    { timeout: 30_000, windowsHide: true },
  );
  const segments = (await readdir(fixtures))
    .filter((name) => /^vod-\d+\.ts$/.test(name))
    .sort()
    .map((name) => path.join(fixtures, name));
  expect(segments.length).toBeGreaterThanOrEqual(3);
  const segmentBytes = await Promise.all(
    segments.map((segment) => readFile(segment)),
  );
  let activeHits = 0;
  let pendingHits = 0;
  let heldActiveResponse: ServerResponse | undefined;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (pathname === "/vod.m3u8") {
      response.writeHead(200, {
        "Content-Type": "application/vnd.apple.mpegurl",
      });
      response.end(
        `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n${segments.map((_, index) => `#EXTINF:1.0,\nsegment/${index}`).join("\n")}\n#EXT-X-ENDLIST\n`,
      );
      return;
    }
    const segmentMatch = /^\/segment\/(\d+)$/.exec(pathname);
    if (segmentMatch) {
      const bytes = segmentBytes[Number(segmentMatch[1])];
      if (!bytes) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": "video/mp2t",
        "Content-Length": String(bytes.length),
      });
      response.end(bytes);
      return;
    }
    if (pathname === "/active.mp4") {
      activeHits++;
      heldActiveResponse = response;
      response.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": "1024",
      });
      response.write("x");
      return;
    }
    if (pathname === "/pending.mp4") {
      pendingHits++;
      response.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": "1024",
      });
      response.end(Buffer.alloc(1024));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("local VOD fixture failed to bind");
  const origin = `http://127.0.0.1:${address.port}`;
  const corePort = process.env.MEDIAGO_CORE_PORT
    ? Number(process.env.MEDIAGO_CORE_PORT)
    : await reserveLoopbackPort();
  let application: ElectronApplication | undefined;
  let ownerIdentity: WindowsProcessIdentity | undefined;
  try {
    application = await _electron.launch({
      executablePath: expectedExecutable,
      args: [],
      timeout: 30_000,
      env: {
        ...scrubElectronEnvironment(process.env),
        APP_NAME: "xiangying",
        APP_TARGET: "electron",
        NODE_ENV: "production",
        ELECTRON_IS_DEV: "0",
        MEDIAGO_RUNTIME_ROOT: runtimeRoot,
        MEDIAGO_CORE_PORT: String(corePort),
        APPDATA: path.join(runtimeRoot, "appdata"),
        LOCALAPPDATA: path.join(runtimeRoot, "localappdata"),
        TEMP: temp,
        TMP: temp,
      },
    });
    ownerIdentity = await readWindowsProcessIdentity(
      await application.evaluate(() => process.pid),
    );
    if (!ownerIdentity)
      throw new Error("candidate Electron owner exited during VOD startup");
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
    const page = application
      .windows()
      .find((window) =>
        /^xiangying:\/\/index\.html\/(?:library)?$/.test(window.url()),
      );
    if (!page) throw new Error("candidate library window not found");
    const appEnv = await page.evaluate(async () =>
      (
        window as Window & {
          electron?: { app?: { getEnvPath(): Promise<unknown> } };
        }
      ).electron?.app?.getEnvPath(),
    );
    const coreURL = coreURLFromIpc(appEnv);
    if (!coreURL) throw new Error("trusted Core URL unavailable");
    const client = trustedCoreClient(page, coreURL);
    expect((await client.setConfigKey("local", downloads)).success).toBe(true);
    expect((await client.setConfigKey("maxRunner", 1)).success).toBe(true);
    const vod = await client.addDownloadTasks({
      startDownload: false,
      tasks: [
        {
          type: "m3u8",
          name: "review77-multisegment-vod",
          url: `${origin}/vod.m3u8`,
        },
      ],
    });
    expect(vod.success).toBe(true);
    const vodId = vod.data[0]!.id;
    expect(
      (
        await client.startDownload(vodId, {
          localPath: downloads,
          deleteSegments: false,
        })
      ).success,
    ).toBe(true);
    await expect
      .poll(async () => (await client.getDownloadTask(vodId)).data.status, {
        timeout: 60_000,
      })
      .toBe("success");
    const vodTask = (await client.getDownloadTask(vodId)).data;
    expect(vodTask.outputPath).toBeTruthy();
    const vodBytes = await readFile(vodTask.outputPath!);
    const vodSha256 = createHash("sha256").update(vodBytes).digest("hex");
    await promisify(execFile)(
      ffmpeg,
      [
        "-hide_banner",
        "-v",
        "error",
        "-i",
        vodTask.outputPath!,
        "-f",
        "null",
        "-",
      ],
      { timeout: 30_000, windowsHide: true },
    );

    const stopTasks = await client.addDownloadTasks({
      startDownload: false,
      tasks: [
        {
          type: "direct",
          name: "review77-active-for-pending-stop",
          url: `${origin}/active.mp4`,
        },
        {
          type: "direct",
          name: "review77-pending-stop",
          url: `${origin}/pending.mp4`,
        },
      ],
    });
    expect(stopTasks.success).toBe(true);
    const [activeId, pendingId] = stopTasks.data.map((task) => task.id);
    expect(
      (
        await client.startDownload(activeId!, {
          localPath: downloads,
          deleteSegments: false,
        })
      ).success,
    ).toBe(true);
    await expect.poll(() => activeHits, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(
      (
        await client.startDownload(pendingId!, {
          localPath: downloads,
          deleteSegments: false,
        })
      ).success,
    ).toBe(true);
    await expect
      .poll(
        async () =>
          (await client.getActiveTasks()).data.some(
            (task) => task.id === pendingId,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    expect((await client.stopDownload(pendingId!)).success).toBe(true);
    await expect
      .poll(
        async () => (await client.getDownloadTask(pendingId!)).data.status,
        { timeout: 10_000 },
      )
      .toBe("stopped");
    expect(pendingHits).toBe(0);
    expect((await client.stopDownload(activeId!)).success).toBe(true);
    heldActiveResponse?.destroy();
    await writeFile(
      path.join(EVIDENCE_DIR, "review77-vod-pending-stop.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          runtimeOwnerPid: ownerIdentity.pid,
          runtimeOwnerCreationFileTime: ownerIdentity.creationFileTime,
          corePort,
          vodStatus: vodTask.status,
          vodSegments: segments.length,
          vodSha256,
          vodFullDecode: true,
          activeHits,
          pendingHits,
          pendingStopStatus: (await client.getDownloadTask(pendingId!)).data
            .status,
        },
        null,
        2,
      ),
    );
  } finally {
    if (application) await application.close().catch(() => undefined);
    if (ownerIdentity)
      expect(
        await waitForWindowsProcessExit(ownerIdentity, 10_000),
        "owned candidate Electron process exited after VOD/pending-stop test",
      ).toBe(true);
    await assertPortFree(
      "127.0.0.1",
      corePort,
      "review77 VOD candidate Core cleanup",
    );
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("deferred policy rejects credentials for every engine and keeps public direct/HLS downloads working", async () => {
  test.skip(
    process.env.MEDIAGO_REVIEW_HEADERS_DEFERRED !== "1",
    "deferred all-engine sensitive-header policy acceptance is opt-in",
  );
  test.skip(
    process.platform !== "win32",
    "candidate-bound Windows sensitive-header policy acceptance",
  );
  test.setTimeout(180_000);
  const binding = JSON.parse(await readFile(BINDING_PATH, "utf8")) as {
    candidate: string;
    coreSha256: string;
    asarSha256: string;
  };
  const expectedExecutable = path.join(binding.candidate, "乡映.exe");
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    path.resolve(expectedExecutable),
  );
  const runtimeRoot = await mkdtemp(
    path.join(
      ROOT,
      ".task/review77-20261006/downloads/deferred-headers-runtime-",
    ),
  );
  const downloads = path.join(runtimeRoot, "downloads");
  const temp = path.join(runtimeRoot, "temp");
  const appdata = path.join(runtimeRoot, "appdata");
  const localappdata = path.join(runtimeRoot, "localappdata");
  const ffmpeg = path.join(binding.candidate, "resources/deps/ffmpeg.exe");
  const publicMedia = await readFile(SAMPLE_PATH);
  const hlsSegment = path.join(runtimeRoot, "public.ts");
  await Promise.all(
    [downloads, temp, appdata, localappdata].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  await promisify(execFile)(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      SAMPLE_PATH,
      "-c",
      "copy",
      "-f",
      "mpegts",
      hlsSegment,
    ],
    { timeout: 30_000, windowsHide: true },
  );
  const segmentBytes = await readFile(hlsSegment);
  const dummyCookie = "review77-deferred-cookie-dummy";
  const dummyAuthorization = "Bearer review77-deferred-auth-dummy";
  let sourceHits = 0;
  let publicDirectHits = 0;
  let publicPlaylistHits = 0;
  let publicSegmentHits = 0;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (
      pathname !== "/public.mp4" &&
      pathname !== "/public.m3u8" &&
      pathname !== "/public.ts"
    )
      sourceHits++;
    if (pathname === "/public.mp4") {
      publicDirectHits++;
      response.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": String(publicMedia.length),
      });
      response.end(publicMedia);
      return;
    }
    if (pathname === "/public.m3u8") {
      publicPlaylistHits++;
      response.writeHead(200, {
        "Content-Type": "application/vnd.apple.mpegurl",
      });
      response.end(
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:9.0,\n/public.ts\n#EXT-X-ENDLIST\n",
      );
      return;
    }
    if (pathname === "/public.ts") {
      publicSegmentHits++;
      response.writeHead(200, {
        "Content-Type": "video/mp2t",
        "Content-Length": String(segmentBytes.length),
      });
      response.end(segmentBytes);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("deferred-header fixture failed to bind");
  const origin = `http://127.0.0.1:${address.port}`;
  const corePort = process.env.MEDIAGO_CORE_PORT
    ? Number(process.env.MEDIAGO_CORE_PORT)
    : await reserveLoopbackPort();
  let application: ElectronApplication | undefined;
  let ownerIdentity: WindowsProcessIdentity | undefined;
  try {
    application = await _electron.launch({
      executablePath: expectedExecutable,
      args: [],
      timeout: 30_000,
      env: {
        ...scrubElectronEnvironment(process.env),
        APP_NAME: "xiangying",
        APP_TARGET: "electron",
        NODE_ENV: "production",
        ELECTRON_IS_DEV: "0",
        MEDIAGO_RUNTIME_ROOT: runtimeRoot,
        MEDIAGO_CORE_PORT: String(corePort),
        APPDATA: appdata,
        LOCALAPPDATA: localappdata,
        TEMP: temp,
        TMP: temp,
      },
    });
    ownerIdentity = await readWindowsProcessIdentity(
      await application.evaluate(() => process.pid),
    );
    if (!ownerIdentity)
      throw new Error(
        "candidate Electron owner exited during deferred-header startup",
      );
    await expect
      .poll(
        () =>
          application!.windows().some((window) => {
            try {
              const url = new URL(window.url());
              return (
                url.protocol === "xiangying:" && url.hostname === "index.html"
              );
            } catch {
              return false;
            }
          }),
        { timeout: 10_000 },
      )
      .toBe(true);
    const page = application.windows().find((window) => {
      try {
        const url = new URL(window.url());
        return url.protocol === "xiangying:" && url.hostname === "index.html";
      } catch {
        return false;
      }
    });
    if (!page) throw new Error("candidate library window not found");
    const appEnv = await page.evaluate(async () =>
      (
        window as Window & {
          electron?: { app?: { getEnvPath(): Promise<unknown> } };
        }
      ).electron?.app?.getEnvPath(),
    );
    const coreURL = coreURLFromIpc(appEnv);
    if (!coreURL) throw new Error("trusted Core URL unavailable");
    const client = trustedCoreClient(page, coreURL);
    expect((await client.setConfigKey("local", downloads)).success).toBe(true);
    const types = [
      "direct",
      "m3u8",
      "bilibili",
      "mediago",
      "youtube",
      "xiaohongshu",
    ] as const;
    const rejectionCases = [
      ...types.map((type) => ({
        type,
        name: `review77-deferred-${type}`,
        url: `${origin}/rejected-${type}.mp4`,
        headers: `Cookie: ${dummyCookie}\nAuthorization: ${dummyAuthorization}`,
      })),
      {
        type: "direct" as const,
        name: "review77-deferred-custom-auth",
        url: `${origin}/rejected-custom-auth.mp4`,
        headers: "X-Private-Session: review77-custom-auth-dummy",
      },
    ];
    const rejectAtCreate = async (
      startDownload: boolean,
      tasks: typeof rejectionCases,
    ) => {
      let errorMessage = "";
      try {
        await client.addDownloadTasks({ startDownload, tasks });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      expect(errorMessage).toContain("HTTP 400");
      expect(errorMessage).not.toContain(dummyCookie);
      expect(errorMessage).not.toContain(dummyAuthorization);
      expect(errorMessage).not.toContain("review77-custom-auth-dummy");
      const rows = (
        await client.getDownloadTasks({ current: 1, pageSize: 100 })
      ).data.list;
      expect(rows).toHaveLength(0);
      return {
        startDownload,
        types: tasks.map((task) => task.type),
        status: "HTTP 400",
        rowsCreated: 0,
        errorAbsentFromSecrets: true,
      };
    };
    const rejectedBatches = [];
    rejectedBatches.push(await rejectAtCreate(false, rejectionCases));
    const mixedActiveBatch = [
      {
        type: "bilibili" as const,
        name: "",
        url: `${origin}/title`,
        headers: "Referer: public-fixture",
      },
      {
        type: "direct" as const,
        name: "review77-active-private-header",
        url: `${origin}/rejected-mixed.mp4`,
        headers: "X-Private-Session: review77-mixed-auth-dummy",
      },
    ];
    let mixedError = "";
    try {
      await client.addDownloadTasks({
        startDownload: true,
        tasks: mixedActiveBatch,
      });
    } catch (error) {
      mixedError = error instanceof Error ? error.message : String(error);
    }
    expect(mixedError).toContain("HTTP 400");
    expect(mixedError).not.toContain("review77-mixed-auth-dummy");
    const mixedRows = (
      await client.getDownloadTasks({ current: 1, pageSize: 100 })
    ).data.list;
    expect(mixedRows).toHaveLength(0);
    rejectedBatches.push({
      startDownload: true,
      types: mixedActiveBatch.map((task) => task.type),
      status: "HTTP 400",
      rowsCreated: 0,
      errorAbsentFromSecrets: true,
    });
    const rejectedSourceHits = sourceHits;
    expect(rejectedSourceHits).toBe(0);

    const publicTasks = await client.addDownloadTasks({
      startDownload: true,
      tasks: [
        {
          type: "direct",
          name: "review77-public-direct",
          url: `${origin}/public.mp4`,
        },
        {
          type: "m3u8",
          name: "review77-public-hls",
          url: `${origin}/public.m3u8`,
        },
      ],
    });
    expect(publicTasks.success).toBe(true);
    await expect
      .poll(
        async () =>
          Promise.all(
            publicTasks.data.map(
              async (task) =>
                (await client.getDownloadTask(task.id)).data.status,
            ),
          ),
        { timeout: 60_000 },
      )
      .toEqual(["success", "success"]);
    const publicResults = await Promise.all(
      publicTasks.data.map(async (task) => {
        const result = (await client.getDownloadTask(task.id)).data;
        if (!result.outputPath)
          throw new Error(`public ${result.type} task has no output path`);
        await promisify(execFile)(
          ffmpeg,
          [
            "-hide_banner",
            "-v",
            "error",
            "-i",
            result.outputPath,
            "-f",
            "null",
            "-",
          ],
          { timeout: 30_000, windowsHide: true },
        );
        return { type: result.type, outputPath: result.outputPath };
      }),
    );
    expect(publicDirectHits).toBeGreaterThan(0);
    expect(publicPlaylistHits).toBeGreaterThan(0);
    expect(publicSegmentHits).toBeGreaterThan(0);
    await writeFile(
      path.join(EVIDENCE_DIR, "review77-deferred-header-policy.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          runtimeOwnerPid: ownerIdentity.pid,
          runtimeOwnerCreationFileTime: ownerIdentity.creationFileTime,
          corePort,
          rejectedBatches,
          rejectedSourceHits,
          public: {
            results: publicResults,
            directHits: publicDirectHits,
            playlistHits: publicPlaylistHits,
            segmentHits: publicSegmentHits,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    if (application) await application.close().catch(() => undefined);
    if (ownerIdentity)
      expect(
        await waitForWindowsProcessExit(ownerIdentity, 10_000),
        "owned candidate Electron process exited after deferred-header policy probe",
      ).toBe(true);
    await assertPortFree(
      "127.0.0.1",
      corePort,
      "review77 deferred-header probe Core cleanup",
    );
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
