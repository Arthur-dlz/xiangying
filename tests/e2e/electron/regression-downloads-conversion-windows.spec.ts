import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  stat,
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
import {
  captureProcessOutput,
  type ProcessOutput,
} from "../support/process.ts";
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
  ".task/regression-20261006/downloads/artifacts/conversion",
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
  "Windows packaged candidate conversion check",
);

test("converts a controlled sample to every supported format and preserves each input", async () => {
  test.setTimeout(210_000);
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    path.resolve(EXECUTABLE),
  );
  const runtimeRoot = await mkdtemp(
    path.join(ROOT, ".task/regression-20261006/downloads/runtime/conversion-"),
  );
  const downloads = path.join(runtimeRoot, "downloads");
  await mkdir(path.join(runtimeRoot, "appdata"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "localappdata"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "temp"), { recursive: true });
  await mkdir(downloads, { recursive: true });
  await mkdir(ARTIFACTS, { recursive: true });
  const formats = ["mp4", "mkv", "webm", "mp3", "aac", "flac", "wav"] as const;
  const inputs = new Map<string, { path: string; sha256: string }>();
  for (const format of formats) {
    const inputPath = path.join(
      downloads,
      `regression-controlled-input-${format}.mov`,
    );
    await copyFile(
      path.join(ROOT, "tests/media-service/public/v1/sample.mp4"),
      inputPath,
    );
    inputs.set(format, {
      path: inputPath,
      sha256: createHash("sha256")
        .update(await readFile(inputPath))
        .digest("hex"),
    });
  }
  let application: ElectronApplication | undefined;
  let output: ProcessOutput | undefined;
  let identity: WindowsProcessIdentity | undefined;
  let page: Page | undefined;
  const formatResults: Record<string, unknown>[] = [];
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
    output = captureProcessOutput(application.process());
    const pid = await application.evaluate(() => process.pid);
    identity = await readWindowsProcessIdentity(pid);
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
    if (!page) throw new Error("Packaged library window not found");
    const env = await page.evaluate(async () =>
      (
        window as Window & {
          electron?: { app?: { getEnvPath(): Promise<unknown> } };
        }
      ).electron?.app?.getEnvPath(),
    );
    const coreUrl = coreURLFromIpc(env);
    if (!coreUrl) throw new Error("Core URL unavailable from trusted renderer");
    const client = trustedCoreClient(page, coreUrl);
    const ffmpeg = path.join(
      path.dirname(EXECUTABLE),
      "resources/deps/ffmpeg.exe",
    );
    const inspectPresentation = async (
      filePath: string,
      stream: "video" | "audio",
    ) => {
      const inspectedArgs = [
        "-v",
        "verbose",
        "-debug_ts",
        "-i",
        filePath,
        "-map",
        `0:${stream === "video" ? "v:0" : "a:0"}`,
      ];
      if (stream === "video") inspectedArgs.push("-an");
      inspectedArgs.push("-f", "null", "-");
      const inspected = await promisify(execFile)(ffmpeg, inspectedArgs, {
        timeout: 30_000,
        windowsHide: true,
      });
      const frames = inspected.stderr.split(/\r?\n/).flatMap((line) => {
        if (
          !new RegExp(
            `decoder -> ist_index:\\d+ type:${stream} frame_pts:`,
          ).test(line)
        )
          return [];
        const match =
          /best_effort_ts:(-?\d+) best_effort_ts_time:([^ ]+).*?time_base:([^ ]+)/.exec(
            line,
          );
        if (!match)
          throw new Error(
            `ffmpeg debug_ts ${stream} decoder frame had no best-effort PTS`,
          );
        return [
          { pts: Number(match[1]), time: Number(match[2]), timeBase: match[3] },
        ];
      });
      let nonMonotonicOrDuplicate = 0;
      for (let index = 1; index < frames.length; index++)
        if (frames[index]!.pts <= frames[index - 1]!.pts)
          nonMonotonicOrDuplicate++;
      return {
        decodedFrameCount: frames.length,
        timeBase: frames[0]?.timeBase || null,
        firstTime: frames[0]?.time ?? null,
        lastTime: frames.at(-1)?.time ?? null,
        nonMonotonicOrDuplicate,
        nullMuxerDtsWarnings: (
          inspected.stderr.match(/non monotonically increasing dts/gi) || []
        ).length,
        duration: /Duration:\s*([\d:.]+)/.exec(inspected.stderr)?.[1] || null,
      };
    };
    const inspectAudioFrames = async (filePath: string) => {
      const result = await promisify(execFile)(
        ffmpeg,
        ["-v", "error", "-i", filePath, "-map", "0:a:0", "-f", "framemd5", "-"],
        { timeout: 30_000, windowsHide: true },
      );
      const frameRows = result.stdout
        .split(/\r?\n/)
        .filter((line) => line.trim() && !line.startsWith("#"));
      const pts = frameRows
        .map((line) => Number(line.split(",")[2]?.trim()))
        .filter(Number.isFinite);
      let nonMonotonicOrDuplicate = 0;
      for (let index = 1; index < pts.length; index++)
        if (pts[index]! <= pts[index - 1]!) nonMonotonicOrDuplicate++;
      return {
        decodedFrameCount: frameRows.length,
        nonMonotonicOrDuplicate,
        framemd5: true,
        stderr: result.stderr.trim(),
      };
    };
    const collisionInput = path.join(downloads, "controlled-collision.mov");
    const collisionTarget = path.join(downloads, "controlled-collision.mp4");
    await copyFile(
      path.join(ROOT, "tests/media-service/public/v1/sample.mp4"),
      collisionInput,
    );
    await writeFile(collisionTarget, "REGRESSION_SENTINEL_DO_NOT_PRESERVE");
    const collisionBefore = createHash("sha256")
      .update(await readFile(collisionTarget))
      .digest("hex");
    const collisionCreated = await client.addConversion({
      path: collisionInput,
      outputFormat: "mp4",
      quality: "medium",
      name: "Controlled output collision",
    });
    expect(collisionCreated.success).toBe(true);
    const collisionId = collisionCreated.data.id;
    expect((await client.startConversion(collisionId)).success).toBe(true);
    await expect
      .poll(async () => (await client.getConversion(collisionId)).data.status, {
        timeout: 45_000,
        intervals: [250, 500, 1_000],
      })
      .toMatch(/^(done|failed)$/);
    const collisionTask = (await client.getConversion(collisionId)).data;
    const collisionAfter = createHash("sha256")
      .update(await readFile(collisionTarget))
      .digest("hex");
    const collisionEvidence = {
      inputPath: collisionInput,
      targetPath: collisionTarget,
      sentinelSha256Before: collisionBefore,
      targetSha256After: collisionAfter,
      targetOverwritten: collisionAfter !== collisionBefore,
      taskStatus: collisionTask.status,
      taskOutputPath: collisionTask.outputPath || null,
    };
    await writeFile(
      path.join(ARTIFACTS, "controlled-output-collision.json"),
      JSON.stringify(collisionEvidence, null, 2),
      "utf8",
    );
    formatResults.push({
      id: collisionId,
      format: "mp4-collision",
      ...collisionEvidence,
    });
    if (collisionTask.status === "done")
      expect(collisionAfter).not.toBe(collisionBefore);
    expect((await client.deleteConversion(collisionId)).success).toBe(true);
    for (const format of formats) {
      const input = inputs.get(format)!;
      const created = await client.addConversion({
        path: input.path,
        outputFormat: format,
        quality: "medium",
        name: `Controlled regression ${format}`,
      });
      expect(created.success).toBe(true);
      const id = created.data.id;
      expect((await client.startConversion(id)).success).toBe(true);
      await expect
        .poll(async () => (await client.getConversion(id)).data.status, {
          timeout: 45_000,
          intervals: [250, 500, 1_000],
        })
        .toMatch(/^(done|failed)$/);
      const finished = (await client.getConversion(id)).data;
      expect(finished.status).toBe("done");
      if (!finished.outputPath)
        throw new Error(`Completed ${format} conversion has no output path`);
      const outputStat = await stat(finished.outputPath);
      expect(outputStat.size).toBeGreaterThan(0);
      const streams =
        format === "mp3" ||
        format === "aac" ||
        format === "flac" ||
        format === "wav"
          ? (["audio"] as const)
          : (["video", "audio"] as const);
      const decodes = [];
      for (const stream of streams) {
        const args = [
          "-v",
          "error",
          "-i",
          finished.outputPath,
          "-map",
          `0:${stream === "video" ? "v:0" : "a:0"}`,
          "-f",
          "null",
          "-",
        ];
        const decoded = await promisify(execFile)(ffmpeg, args, {
          timeout: 30_000,
          windowsHide: true,
        });
        const timing =
          stream === "audio"
            ? await inspectAudioFrames(finished.outputPath)
            : await inspectPresentation(finished.outputPath, stream);
        expect(timing.decodedFrameCount).toBeGreaterThan(0);
        expect(timing.nonMonotonicOrDuplicate).toBe(0);
        decodes.push({ stream, stderr: decoded.stderr.trim(), timing });
      }
      const inputHashAfter = createHash("sha256")
        .update(await readFile(input.path))
        .digest("hex");
      expect(inputHashAfter).toBe(input.sha256);
      formatResults.push({
        id,
        format,
        inputPath: input.path,
        inputSha256: input.sha256,
        inputSha256After: inputHashAfter,
        outputPath: finished.outputPath,
        outputBytes: outputStat.size,
        quality: finished.quality,
        status: finished.status,
        decodedStreams: decodes,
      });
      await writeFile(
        path.join(ARTIFACTS, "controlled-conversions.json"),
        JSON.stringify(
          {
            launchMode:
              process.env.XIANGYING_E2E_LAUNCH_MODE || "require_escalated",
            formats: formatResults,
          },
          null,
          2,
        ),
        "utf8",
      );
      expect((await client.deleteConversion(id)).success).toBe(true);
    }
  } finally {
    if (application) {
      await application
        .evaluate(({ app }) => app.quit())
        .catch(() => undefined);
      await application.close().catch(() => undefined);
      if (identity)
        expect(await waitForWindowsProcessExit(identity, 5_000)).toBe(true);
    }
    output?.dispose();
    if (formatResults.length > 0) {
      const evidence = {
        launchMode:
          process.env.XIANGYING_E2E_LAUNCH_MODE || "require_escalated",
        formats: formatResults,
        processOutputTail: output?.logTail() || "",
      };
      await writeFile(
        path.join(ARTIFACTS, "controlled-conversions.json"),
        JSON.stringify(evidence, null, 2),
        "utf8",
      );
      await test.info().attach("controlled-conversions.json", {
        body: JSON.stringify(evidence, null, 2),
        contentType: "application/json",
      });
    }
  }
});
