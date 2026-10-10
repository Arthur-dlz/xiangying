import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
const EVIDENCE = path.join(
  ROOT,
  ".task/regression-20261006/downloads/artifacts/startup-diagnostic",
);
const LAUNCH_MODE = process.env.XIANGYING_E2E_LAUNCH_MODE || "default-sandbox";

test.skip(
  process.platform !== "win32",
  "Windows packaged candidate diagnostic",
);

test("record bounded startup state for the frozen release-slim candidate", async () => {
  test.setTimeout(50_000);
  if (
    path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "") !==
    path.resolve(EXECUTABLE)
  ) {
    throw new Error(
      "XIANGYING_E2E_EXECUTABLE must be the frozen release-slim candidate",
    );
  }
  const runtimeRoot = await mkdtemp(
    path.join(
      ROOT,
      ".task/regression-20261006/downloads/runtime/startup-diagnostic-",
    ),
  );
  await mkdir(path.join(runtimeRoot, "appdata"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "localappdata"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "temp"), { recursive: true });
  await mkdir(EVIDENCE, { recursive: true });

  let application: ElectronApplication | undefined;
  let processOutput: ProcessOutput | undefined;
  let identity: WindowsProcessIdentity | undefined;
  const rendererErrors: string[] = [];
  let appCloseEvent: unknown = null;
  const trackedPages = new WeakSet<object>();
  const trackPage = (page: Page) => {
    if (trackedPages.has(page)) return;
    trackedPages.add(page);
    page.on("console", (message) => {
      if (message.type() === "error") rendererErrors.push(message.text());
    });
    page.on("pageerror", (error: Error) => rendererErrors.push(error.message));
  };
  const redact = (value: string) =>
    value
      .replace(
        /(authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]*/gi,
        "$1: [REDACTED]",
      )
      .replace(/(bearer\s+)[A-Za-z0-9._~-]+/gi, "$1[REDACTED]");
  const launchStartedAt = Date.now();

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
    processOutput = captureProcessOutput(application.process());
    identity = await readWindowsProcessIdentity(
      await application.evaluate(() => process.pid),
    );
    application.on("window", (page: Page) => trackPage(page));
    application.process().on("close", (code) => {
      appCloseEvent = { code, elapsedMs: Date.now() - launchStartedAt };
    });

    const startedAt = launchStartedAt;
    let firstExpectedWindowMs: number | null = null;
    const snapshots: Array<Record<string, unknown>> = [];
    while (Date.now() - startedAt < 30_000) {
      let playwrightWindows: Array<Record<string, unknown>> = [];
      let nativeWindows: Array<Record<string, unknown>> = [];
      let nativeError: string | null = null;
      try {
        for (const page of application.windows()) trackPage(page);
        playwrightWindows = application.windows().map((page) => ({
          url: page.url(),
          closed: page.isClosed(),
        }));
        nativeWindows = await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((window) => ({
            url: window.webContents.getURL(),
            title: window.webContents.getTitle(),
            visible: window.isVisible(),
            loading: window.webContents.isLoading(),
            loadingMainFrame: window.webContents.isLoadingMainFrame(),
            crashed: window.webContents.isCrashed(),
          })),
        );
      } catch (error) {
        nativeError = error instanceof Error ? error.message : String(error);
      }
      const expected = playwrightWindows.some((window) =>
        /^xiangying:\/\/index\.html\/(?:library)?$/.test(String(window.url)),
      );
      if (expected && firstExpectedWindowMs === null)
        firstExpectedWindowMs = Date.now() - startedAt;
      snapshots.push({
        elapsedMs: Date.now() - startedAt,
        playwrightWindows,
        nativeWindows,
        nativeError,
        appCloseEvent,
      });
      if (expected) break;
      if (nativeError) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const result = {
      executable: EXECUTABLE,
      launchConditions: {
        mode: LAUNCH_MODE,
        args: [],
        gpuProbe: false,
        publicProbe: false,
        appName: "xiangying",
        appTarget: "electron",
        nodeEnv: "production",
        electronIsDev: "0",
        runtimeRoot,
        appDataRoot: path.join(runtimeRoot, "appdata"),
        localAppDataRoot: path.join(runtimeRoot, "localappdata"),
        tempRoot: path.join(runtimeRoot, "temp"),
      },
      corePort: process.env.MEDIAGO_CORE_PORT || "39729",
      firstExpectedWindowMs,
      firstCheckThresholdMs: 10_000,
      readyWithinOriginalThreshold:
        firstExpectedWindowMs !== null && firstExpectedWindowMs <= 10_000,
      snapshots,
      rendererErrors: rendererErrors.map(redact),
      appCloseEvent,
      mainProcessOutputTail: processOutput?.logTail() || "",
    };
    await writeFile(
      path.join(EVIDENCE, `startup-diagnostic-${LAUNCH_MODE}.json`),
      JSON.stringify(result, null, 2),
      "utf8",
    );
    await test.info().attach(`startup-diagnostic-${LAUNCH_MODE}.json`, {
      body: Buffer.from(JSON.stringify(result, null, 2)),
      contentType: "application/json",
    });
    expect(firstExpectedWindowMs).not.toBeNull();
    expect(firstExpectedWindowMs).toBeLessThanOrEqual(10_000);
  } finally {
    if (application) {
      await application
        .evaluate(({ app }) => app.quit())
        .catch(() => undefined);
      await application.close().catch(() => undefined);
      if (identity)
        expect(await waitForWindowsProcessExit(identity, 5_000)).toBe(true);
    }
    processOutput?.dispose();
  }
});
