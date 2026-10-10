import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  _electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { trustedCoreClient } from "../support/xiangying-core-client.ts";
import { scrubElectronEnvironment } from "../support/electron-network.ts";
import { waitForPortFree } from "../support/ports.ts";
import {
  readWindowsProcessIdentity,
  waitForWindowsProcessExit,
  type WindowsProcessIdentity,
} from "../support/xiangying-windows-process.ts";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEFAULT_BINDING_PATH = path.join(
  ROOT,
  ".task/remediation-20261006/root/candidate-binding.json",
);
const SAMPLE_PATH = path.join(ROOT, "tests/media-service/public/v1/sample.mp4");
const EVIDENCE_DIRECTORY = path.join(
  ROOT,
  ".task/remediation-20261006/library/evidence",
);
const CORE_PORT = Number(process.env.MEDIAGO_CORE_PORT || 39_929);
const EXEC_FILE = path.join(
  process.env.ProgramFiles || "C:/Program Files",
  "PowerShell/7/pwsh.exe",
);

interface CandidateBinding {
  candidate: string;
  asarSha256: string;
  coreSha256: string;
}

interface LibraryItem {
  id: string;
  title: string;
  path: string;
  safety: {
    status: "unscanned" | "clean" | "blocked" | "unavailable";
    checkedAt?: string;
    fingerprint?: string;
    message?: string;
  };
}

interface LibraryApi {
  list(): Promise<unknown>;
  importFiles(
    paths: string[],
    source?: "import" | "download",
  ): Promise<unknown>;
  play(id: string): Promise<unknown>;
  exportFiles(ids: string[]): Promise<unknown>;
  remove(id: string): Promise<unknown>;
  update(
    id: string,
    patch: { category?: string; screened?: boolean },
  ): Promise<unknown>;
}

interface RendererBridge {
  electron?: {
    app?: { getEnvPath(): Promise<unknown> };
    library?: LibraryApi;
  };
}

interface StartedCandidate {
  app: ElectronApplication;
  page: Page;
  runtimeRoot: string;
  downloadsPath: string;
  exportPath: string;
  executablePath: string;
  environment: Record<string, string>;
  identity: WindowsProcessIdentity;
  coreUrl: string;
  binding: CandidateBinding;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function unwrap<T>(value: unknown): T {
  if (typeof value !== "object" || value === null || !("code" in value))
    return value as T;
  const result = value as { code?: number; data?: unknown; message?: unknown };
  if (result.code !== 0)
    throw new Error(
      `Candidate IPC failed: ${String(result.message ?? result.code)}`,
    );
  return result.data as T;
}

async function seedHistoricalNoFileTask(
  databasePath: string,
  name: string,
): Promise<void> {
  const database = new DatabaseSync(databasePath);
  try {
    // This is the pre-outputPath Video table shape used by the migration test.
    // Core performs its real migration after launch; the historical successful
    // row has no output path and has never produced a media file.
    database.exec(`
      CREATE TABLE video (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'm3u8',
        url TEXT NOT NULL,
        folder TEXT,
        headers TEXT,
        isLive NUMERIC NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ready',
        createdDate DATETIME,
        updatedDate DATETIME
      );
      CREATE UNIQUE INDEX idx_video_name ON video(name);
    `);
    database
      .prepare(
        `INSERT INTO video (name, type, url, status, createdDate, updatedDate)
         VALUES (?, 'direct', ?, 'success', datetime('now'), datetime('now'))`,
      )
      .run(name, `http://127.0.0.1:9/${encodeURIComponent(name)}.mp4`);
  } finally {
    database.close();
  }
}

async function prepareIsolatedRuntime(): Promise<{
  runtimeRoot: string;
  downloadsPath: string;
  exportPath: string;
  environment: Record<string, string>;
  historicalTaskName: string;
}> {
  await mkdir(EVIDENCE_DIRECTORY, { recursive: true });
  const runtimeRoot = await mkdtemp(
    path.join(EVIDENCE_DIRECTORY, "runtime-library-lifecycle-"),
  );
  const dataPath = path.join(runtimeRoot, "data");
  const downloadsPath = path.join(runtimeRoot, "downloads");
  const exportPath = path.join(runtimeRoot, "export");
  const tempPath = path.join(EVIDENCE_DIRECTORY, "temp");
  await Promise.all(
    [
      "appdata",
      "localappdata",
      "data",
      "downloads",
      "export",
      "temp",
      "media",
    ].map((directory) =>
      mkdir(path.join(runtimeRoot, directory), { recursive: true }),
    ),
  );
  await mkdir(tempPath, { recursive: true });

  const historicalTaskName = `remediation-no-file-${Date.now()}`;
  await seedHistoricalNoFileTask(
    path.join(dataPath, "mediago.db"),
    historicalTaskName,
  );
  // Pre-seed only this disposable profile so Core never falls back to the
  // user's Downloads directory while resolving the historical row.
  await writeFile(
    path.join(dataPath, "config.json"),
    JSON.stringify(
      { local: downloadsPath, closeMainWindow: false, language: "zh" },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const inheritedEnvironment = {
    ...scrubElectronEnvironment(process.env),
    APP_NAME: "xiangying",
    APP_TARGET: "electron",
    NODE_ENV: "production",
    ELECTRON_IS_DEV: "0",
    MEDIAGO_RUNTIME_ROOT: runtimeRoot,
    MEDIAGO_CORE_PORT: String(CORE_PORT),
    APPDATA: path.join(runtimeRoot, "appdata"),
    LOCALAPPDATA: path.join(runtimeRoot, "localappdata"),
    TEMP: tempPath,
    TMP: tempPath,
  };
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(inheritedEnvironment)) {
    if (typeof value === "string") environment[key] = value;
  }
  return {
    runtimeRoot,
    downloadsPath,
    exportPath,
    environment,
    historicalTaskName,
  };
}

async function currentMainPage(
  application: ElectronApplication,
): Promise<Page> {
  await expect
    .poll(
      () =>
        application
          .windows()
          .some((page) => page.url().startsWith("xiangying://index.html/")),
      { timeout: 15_000 },
    )
    .toBe(true);
  const page = application
    .windows()
    .find(
      (candidate) =>
        !candidate.isClosed() &&
        candidate.url().startsWith("xiangying://index.html/"),
    );
  if (!page) throw new Error("Candidate main page did not appear");
  return page;
}

async function startCandidate(): Promise<StartedCandidate> {
  const configuredBindingPath = process.env.MEDIAGO_REMEDIATION_BINDING?.trim();
  if (configuredBindingPath && !path.isAbsolute(configuredBindingPath)) {
    throw new Error("MEDIAGO_REMEDIATION_BINDING must be an absolute path");
  }
  const bindingPath = configuredBindingPath
    ? path.resolve(configuredBindingPath)
    : DEFAULT_BINDING_PATH;
  const binding = JSON.parse(
    await readFile(bindingPath, "utf8"),
  ) as CandidateBinding;
  const executablePath = path.join(path.resolve(binding.candidate), "乡映.exe");
  expect(
    path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "").toLowerCase(),
  ).toBe(executablePath.toLowerCase());
  expect(
    digest(
      await readFile(
        path.join(path.dirname(executablePath), "resources/app.asar"),
      ),
    ),
  ).toBe(binding.asarSha256.toLowerCase());
  expect(
    digest(
      await readFile(
        path.join(
          path.dirname(executablePath),
          "resources/bin/mediago-core.exe",
        ),
      ),
    ),
  ).toBe(binding.coreSha256.toLowerCase());

  const runtime = await prepareIsolatedRuntime();
  await waitForPortFree("127.0.0.1", CORE_PORT, 1_000);
  let application: ElectronApplication | undefined;
  let identity: WindowsProcessIdentity | undefined;
  try {
    application = await _electron.launch({
      executablePath,
      args: [],
      timeout: 30_000,
      env: runtime.environment,
    });
    const main = await application.evaluate(({ app }) => ({
      pid: process.pid,
      executablePath: process.execPath,
      userDataPath: app.getPath("userData"),
    }));
    expect(path.resolve(main.executablePath)).toBe(executablePath);
    identity = await readWindowsProcessIdentity(main.pid);
    if (!identity) throw new Error("Candidate owner process is not verifiable");
    const normalizedRuntime = path.resolve(runtime.runtimeRoot).toLowerCase();
    expect(path.resolve(main.userDataPath).toLowerCase()).toBe(
      path.join(normalizedRuntime, "data"),
    );
    const page = await currentMainPage(application);
    const bridge = await page.evaluate(() => {
      const electronBridge = (window as Window & RendererBridge).electron;
      return electronBridge?.app?.getEnvPath();
    });
    const env = unwrap<{ coreUrl: string; workspace: string }>(bridge);
    expect(path.resolve(env.workspace).toLowerCase()).toBe(
      path.join(normalizedRuntime, "data"),
    );
    const coreUrl = env.coreUrl;
    if (!coreUrl) throw new Error("Candidate Core URL is unavailable");

    const libraryNavigation = page.locator('nav a[href="/"]').first();
    await expect(libraryNavigation).toBeVisible();
    return {
      app: application,
      page,
      runtimeRoot: runtime.runtimeRoot,
      downloadsPath: runtime.downloadsPath,
      exportPath: runtime.exportPath,
      executablePath,
      environment: runtime.environment,
      identity,
      coreUrl,
      binding,
    };
  } catch (error) {
    if (application) {
      await application
        .evaluate(({ app }) => app.quit())
        .catch(() => undefined);
      await application.close().catch(() => undefined);
    }
    const ownerExited = identity
      ? await waitForWindowsProcessExit(identity, 15_000).catch(() => false)
      : false;
    const corePortReleased = await waitForPortFree(
      "127.0.0.1",
      CORE_PORT,
      15_000,
    ).then(
      () => true,
      () => false,
    );
    if (ownerExited && corePortReleased) {
      await rm(runtime.runtimeRoot, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 250,
      });
    }
    throw error;
  }
}

const WINDOW_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class RemediationOwnedWindow {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr extra);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extra);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out int pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
  public static string Find(int expectedPid) {
    var handles = new List<string>();
    EnumWindows((hwnd, extra) => {
      int pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if (pid != expectedPid || !IsWindowVisible(hwnd)) return true;
      var className = new StringBuilder(256);
      GetClassName(hwnd, className, className.Capacity);
      if (className.ToString() == "Chrome_WidgetWin_1") handles.Add(hwnd.ToInt64().ToString());
      return true;
    }, IntPtr.Zero);
    return String.Join("\n", handles);
  }
  public static bool Close(int expectedPid, long rawHwnd) {
    var hwnd = new IntPtr(rawHwnd);
    int pid;
    GetWindowThreadProcessId(hwnd, out pid);
    var className = new StringBuilder(256);
    GetClassName(hwnd, className, className.Capacity);
    return pid == expectedPid && IsWindowVisible(hwnd) && className.ToString() == "Chrome_WidgetWin_1" && PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
  }
  public static bool Exists(int expectedPid, long rawHwnd) {
    var hwnd = new IntPtr(rawHwnd);
    if (!IsWindow(hwnd)) return false;
    int pid;
    GetWindowThreadProcessId(hwnd, out pid);
    var className = new StringBuilder(256);
    GetClassName(hwnd, className, className.Capacity);
    return pid == expectedPid && className.ToString() == "Chrome_WidgetWin_1";
  }
}
'@
Add-Type -TypeDefinition $source
`;

async function invokePowerShell(expression: string): Promise<string> {
  const executable = existsPowerShell7() ? EXEC_FILE : "powershell.exe";
  const { stdout } = await execFileAsync(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `${WINDOW_PROBE}\n${expression}`,
    ],
    { timeout: 15_000, windowsHide: true, encoding: "utf8" },
  );
  return stdout.trim();
}

function existsPowerShell7(): boolean {
  return process.env.ProgramFiles
    ? path.isAbsolute(EXEC_FILE) && requireFileExists(EXEC_FILE)
    : requireFileExists(EXEC_FILE);
}

function requireFileExists(filePath: string): boolean {
  return existsSync(filePath);
}

async function closeOnlyOwnedMainWindow(
  identity: WindowsProcessIdentity,
): Promise<number> {
  const currentIdentity = await readWindowsProcessIdentity(identity.pid);
  if (
    !currentIdentity ||
    currentIdentity.creationFileTime !== identity.creationFileTime
  ) {
    throw new Error("Candidate owner identity changed before WM_CLOSE");
  }
  const output = await invokePowerShell(
    `[Console]::Out.Write([RemediationOwnedWindow]::Find(${identity.pid}))`,
  );
  const handles = output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number(value));
  const [hwnd] = handles;
  if (
    handles.length !== 1 ||
    hwnd === undefined ||
    !Number.isSafeInteger(hwnd)
  ) {
    throw new Error(
      `Expected exactly one visible candidate-owned main window; found ${handles.length}`,
    );
  }
  const accepted = await invokePowerShell(
    `[Console]::Out.Write([RemediationOwnedWindow]::Close(${identity.pid}, [long]${hwnd}))`,
  );
  if (accepted !== "True")
    throw new Error(
      "Windows rejected WM_CLOSE for the verified candidate window",
    );
  return hwnd;
}

async function ownedMainWindowExists(
  identity: WindowsProcessIdentity,
  hwnd: number,
): Promise<boolean> {
  const output = await invokePowerShell(
    `[Console]::Out.Write([RemediationOwnedWindow]::Exists(${identity.pid}, [long]${hwnd}))`,
  );
  return output === "True";
}

async function visibleOwnedMainWindowHandles(
  identity: WindowsProcessIdentity,
): Promise<number[]> {
  const output = await invokePowerShell(
    `[Console]::Out.Write([RemediationOwnedWindow]::Find(${identity.pid}))`,
  );
  return output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number(value));
}

async function coreHealthIsReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthy`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Second candidate instance did not exit")),
      timeoutMs,
    );
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function cleanupCandidate(
  running: StartedCandidate,
): Promise<{ ownerExited: boolean; corePortReleased: boolean }> {
  await running.app.evaluate(({ app }) => app.quit()).catch(() => undefined);
  await running.app.close().catch(() => undefined);
  const ownerExited = await waitForWindowsProcessExit(running.identity, 15_000);
  const corePortReleased = await waitForPortFree(
    "127.0.0.1",
    CORE_PORT,
    15_000,
  ).then(
    () => true,
    () => false,
  );
  return { ownerExited, corePortReleased };
}

test.skip(
  process.platform !== "win32",
  "candidate-bound library/lifecycle remediation requires Windows",
);

test("current candidate excludes migrated no-file tasks, guards library states, and restores its owned window", async () => {
  test.setTimeout(180_000);
  expect(CORE_PORT).toBe(39_929);
  let running: StartedCandidate | undefined;
  let secondaryPid: number | undefined;
  let evidence: Record<string, unknown> = {
    candidateRunStarted: false,
    corePort: CORE_PORT,
  };

  try {
    running = await startCandidate();
    evidence = {
      candidateRunStarted: true,
      candidate: running.executablePath,
      coreSha256: running.binding.coreSha256,
      asarSha256: running.binding.asarSha256,
      mainPid: running.identity.pid,
      mainCreationFileTime: running.identity.creationFileTime,
      corePort: CORE_PORT,
      runtimeRoot: running.runtimeRoot,
      historicalNoFileTaskSeededBeforeCoreStart: true,
    };

    const client = trustedCoreClient(running.page, running.coreUrl);
    const config = await client.getConfig();
    expect(config.data.local).toBe(running.downloadsPath);
    expect(config.data.closeMainWindow).toBe(false);
    expect(await readdir(running.downloadsPath)).toEqual([]);
    const historicalTasks = await client.getDownloadTasks({
      current: 1,
      pageSize: 100,
      filter: "done",
      localPath: running.downloadsPath,
    });
    const historicalTask = historicalTasks.data.list.find((task) =>
      task.name.startsWith("remediation-no-file-"),
    );
    expect(historicalTask).toMatchObject({ status: "success", exists: false });
    expect(historicalTask?.outputPath || "").toBe("");
    expect(historicalTask?.file || "").toBe("");

    await running.page.locator('nav a[href="/"]').first().click();
    await expect(
      running.page.getByRole("heading", { name: "我的片库" }),
    ).toBeVisible();
    await running.page
      .getByRole("button", { name: "同步完整下载", exact: true })
      .click();
    await expect(
      running.page.getByText("还没有可加入片库的本地完整下载。", {
        exact: true,
      }),
    ).toBeVisible();
    const initialLibrary = unwrap<{ items: LibraryItem[] }>(
      await running.page.evaluate(async () => {
        const api = (window as Window & RendererBridge).electron?.library;
        if (!api) throw new Error("Candidate library bridge is unavailable");
        return api.list();
      }),
    );
    expect(initialLibrary.items).toEqual([]);

    const mediaRoot = path.join(running.runtimeRoot, "media");
    const fixtureNames = [
      "remediation-blocked-synthetic.mp4",
      "remediation-unavailable-synthetic.mp4",
      "remediation-ambiguous-synthetic.mp4",
      "remediation-missing-removal.mp4",
      "remediation-persisted-library-item.mp4",
    ];
    const fixturePaths = await Promise.all(
      fixtureNames.map(async (name) => {
        const fixturePath = path.join(mediaRoot, name);
        await copyFile(SAMPLE_PATH, fixturePath);
        return fixturePath;
      }),
    );
    const sourceHashes = new Map(
      await Promise.all(
        fixturePaths.map(
          async (fixturePath) =>
            [fixturePath, digest(await readFile(fixturePath))] as const,
        ),
      ),
    );
    const imported = unwrap<{ items: LibraryItem[] }>(
      await running.page.evaluate(async (paths) => {
        const api = (window as Window & RendererBridge).electron?.library;
        if (!api) throw new Error("Candidate library bridge is unavailable");
        return api.importFiles(paths, "import");
      }, fixturePaths),
    );
    expect(imported.items).toHaveLength(fixturePaths.length);

    const byFilename = new Map(
      imported.items.map((item) => [path.basename(item.path), item]),
    );
    const [
      blockedName,
      unavailableName,
      ambiguousName,
      missingName,
      persistedName,
    ] = fixtureNames;
    if (
      !blockedName ||
      !unavailableName ||
      !ambiguousName ||
      !missingName ||
      !persistedName
    ) {
      throw new Error("Library fixture names are incomplete");
    }
    const blocked = byFilename.get(blockedName);
    const unavailable = byFilename.get(unavailableName);
    const ambiguous = byFilename.get(ambiguousName);
    const missing = byFilename.get(missingName);
    const persisted = byFilename.get(persistedName);
    if (!blocked || !unavailable || !ambiguous || !missing || !persisted)
      throw new Error("Candidate library import did not return every fixture");

    const indexPath = path.join(running.runtimeRoot, "data", "library-v1.json");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as {
      version: number;
      items: Array<{
        id: string;
        path: string;
        safety: LibraryItem["safety"];
      }>;
    };
    const seededStatuses = [
      {
        id: blocked.id,
        safety: {
          status: "blocked" as const,
          checkedAt: new Date().toISOString(),
          message: "synthetic test-only blocked state; no Defender scan",
        },
      },
      {
        id: unavailable.id,
        safety: {
          status: "unavailable" as const,
          checkedAt: new Date().toISOString(),
          message: "synthetic test-only scanner timeout",
        },
      },
      {
        id: ambiguous.id,
        safety: {
          status: "unavailable" as const,
          checkedAt: new Date().toISOString(),
          message: "synthetic test-only ambiguous scanner result",
        },
      },
    ];
    for (const seed of seededStatuses) {
      const stored = index.items.find((item) => item.id === seed.id);
      if (!stored) throw new Error("Test-owned library index item disappeared");
      stored.safety = seed.safety;
    }
    await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n", "utf8");

    const missingPath = missing.path;
    const displacedPath = path.join(
      mediaRoot,
      "remediation-displaced-missing.mp4",
    );
    await rename(missingPath, displacedPath);
    await running.page
      .getByRole("button", { name: "刷新", exact: true })
      .click();

    const libraryPage = running.page;
    const cardFor = (title: string) =>
      libraryPage.locator("article").filter({
        has: libraryPage.getByRole("heading", { name: title, exact: true }),
      });
    const blockedCard = cardFor(blocked.title);
    const unavailableCard = cardFor(unavailable.title);
    const ambiguousCard = cardFor(ambiguous.title);
    const missingCard = cardFor(missing.title);
    await expect(
      blockedCard.getByText("已阻止", { exact: true }),
    ).toBeVisible();
    await expect(
      unavailableCard.getByText("无法扫描", { exact: true }),
    ).toBeVisible();
    await expect(
      ambiguousCard.getByText("无法扫描", { exact: true }),
    ).toBeVisible();
    await expect(
      blockedCard.getByRole("button", { name: "播放" }),
    ).toBeDisabled();
    await expect(
      blockedCard.getByRole("button", { name: "扫描" }),
    ).toBeDisabled();
    await expect(
      blockedCard.getByRole("checkbox", { name: `选择${blocked.title}` }),
    ).toBeDisabled();

    await running.app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selectedPath],
      });
    }, running.exportPath);
    const blockedExport = unwrap<{
      cancelled: boolean;
      results: Array<{ copied: boolean; error?: string }>;
    }>(
      await running.page.evaluate(async (id) => {
        const api = (window as Window & RendererBridge).electron?.library;
        if (!api) throw new Error("Candidate library bridge is unavailable");
        return api.exportFiles([id]);
      }, blocked.id),
    );
    expect(blockedExport.cancelled).toBe(false);
    expect(blockedExport.results).toMatchObject([
      { copied: false, error: expect.stringMatching(/阻止/) },
    ]);
    expect(await readdir(running.exportPath)).toEqual([]);

    const blockedPlay = await running.page.evaluate(async (id) => {
      const api = (window as Window & RendererBridge).electron?.library;
      if (!api) throw new Error("Candidate library bridge is unavailable");
      const result: unknown = await api.play(id);
      return {
        resolved: result === undefined,
        code:
          typeof result === "object" && result !== null && "code" in result
            ? (result as { code?: number }).code
            : undefined,
      };
    }, blocked.id);
    expect(blockedPlay.resolved).toBe(false);
    expect(blockedPlay.code).not.toBe(0);

    await expect(
      missingCard.getByText("文件已移走", { exact: true }),
    ).toBeVisible();
    await expect(
      missingCard.getByRole("button", { name: "播放" }),
    ).toBeDisabled();
    await expect(
      missingCard.getByRole("checkbox", { name: `选择${missing.title}` }),
    ).toBeDisabled();
    const missingExport = unwrap<{
      results: Array<{ copied: boolean; error?: string }>;
    }>(
      await running.page.evaluate(async (id) => {
        const api = (window as Window & RendererBridge).electron?.library;
        if (!api) throw new Error("Candidate library bridge is unavailable");
        return api.exportFiles([id]);
      }, missing.id),
    );
    expect(missingExport.results).toMatchObject([
      { copied: false, error: expect.any(String) },
    ]);
    expect(await readdir(running.exportPath)).toEqual([]);
    const removeMissing = missingCard.getByRole("button", {
      name: `从片库移除${missing.title}`,
    });
    await expect(removeMissing).toBeEnabled();
    await removeMissing.click();
    await expect(
      running.page.getByRole("heading", { name: "从片库移除？" }),
    ).toBeVisible();
    await running.page.getByRole("button", { name: "移除条目" }).click();
    await expect(missingCard).toHaveCount(0);
    expect(await readFile(displacedPath)).toEqual(await readFile(SAMPLE_PATH));
    await Promise.all(
      fixturePaths
        .filter((fixturePath) => fixturePath !== missingPath)
        .map(async (fixturePath) => {
          expect(digest(await readFile(fixturePath))).toBe(
            sourceHashes.get(fixturePath),
          );
        }),
    );
    const afterRemoval = unwrap<{ items: LibraryItem[] }>(
      await running.page.evaluate(async () => {
        const api = (window as Window & RendererBridge).electron?.library;
        if (!api) throw new Error("Candidate library bridge is unavailable");
        return api.list();
      }),
    );
    expect(afterRemoval.items.some((item) => item.id === missing.id)).toBe(
      false,
    );

    await running.page.evaluate(async (id) => {
      const api = (window as Window & RendererBridge).electron?.library;
      if (!api) throw new Error("Candidate library bridge is unavailable");
      return api.update(id, { category: "documentary", screened: true });
    }, persisted.id);
    const beforeClose = unwrap<{ items: LibraryItem[] }>(
      await running.page.evaluate(async () => {
        const api = (window as Window & RendererBridge).electron?.library;
        if (!api) throw new Error("Candidate library bridge is unavailable");
        return api.list();
      }),
    );
    expect(
      beforeClose.items.find((item) => item.id === persisted.id),
    ).toMatchObject({
      safety: { status: "unscanned" },
    });

    const originalIdentity = running.identity;
    const originalPid = originalIdentity.pid;
    const firstApplication = running.app;
    const closedWindowHandle = await closeOnlyOwnedMainWindow(originalIdentity);
    await expect
      .poll(() => ownedMainWindowExists(originalIdentity, closedWindowHandle))
      .toBe(false);
    expect(await waitForWindowsProcessExit(originalIdentity, 1_000)).toBe(
      false,
    );
    expect(await coreHealthIsReady(CORE_PORT)).toBe(true);

    const restoredPagePromise = firstApplication.waitForEvent("window", {
      timeout: 15_000,
    });
    const secondary = spawn(running.executablePath, [], {
      env: running.environment,
      windowsHide: true,
      stdio: "ignore",
    });
    secondaryPid = secondary.pid;
    if (!secondaryPid) throw new Error("Second candidate PID was not assigned");
    const secondaryExit = await waitForChildExit(secondary, 15_000);
    expect(secondaryExit.code).toBe(0);
    expect(await waitForWindowsProcessExit(originalIdentity, 1_000)).toBe(
      false,
    );
    await expect
      .poll(() => visibleOwnedMainWindowHandles(originalIdentity), {
        timeout: 15_000,
      })
      .toHaveLength(1);
    expect(await readWindowsProcessIdentity(originalPid)).toMatchObject({
      creationFileTime: originalIdentity.creationFileTime,
    });
    const restoredPage = await restoredPagePromise;
    await expect
      .poll(() => restoredPage.url().startsWith("xiangying://index.html/"), {
        timeout: 15_000,
      })
      .toBe(true);
    await expect(restoredPage.locator('nav a[href="/"]').first()).toBeVisible();
    const afterRestore = unwrap<{ items: LibraryItem[] }>(
      await restoredPage.evaluate(async () => {
        const api = (window as Window & RendererBridge).electron?.library;
        if (!api) throw new Error("Candidate library bridge is unavailable");
        return api.list();
      }),
    );
    expect(
      afterRestore.items.find((item) => item.id === persisted.id),
    ).toMatchObject({
      title: persisted.title,
      safety: { status: "unscanned" },
    });
    expect(afterRestore.items.some((item) => item.id === missing.id)).toBe(
      false,
    );

    evidence = {
      ...evidence,
      historicalTask: {
        name: historicalTask?.name,
        status: historicalTask?.status,
        exists: historicalTask?.exists,
        outputPath: historicalTask?.outputPath ?? "",
        file: historicalTask?.file ?? "",
        excludedFromLibrarySync: initialLibrary.items.length === 0,
      },
      syntheticScannerStatesOnly: [
        "blocked",
        "unavailable-timeout",
        "ambiguous-mapped-to-unavailable",
      ],
      realDefenderInvoked: false,
      blockedUiAndExportGuarded: true,
      missingRowRemovedFromIndex: true,
      displacedFixtureBytesPreserved: digest(await readFile(displacedPath)),
      persistedLibraryItemId: persisted.id,
      normalWmCloseHandle: closedWindowHandle,
      nativeWindowDestroyedAfterWmClose: true,
      ownerPidSurvivedWindowClose: originalPid,
      coreHealthSurvivedWindowClose: true,
      secondInstancePid: secondaryPid,
      secondInstanceExitCode: secondaryExit.code,
      originalOwnerRestoredSameProfile: true,
    };
  } finally {
    if (running) {
      const cleanup = await cleanupCandidate(running);
      evidence = { ...evidence, ...cleanup };
      if (cleanup.ownerExited && cleanup.corePortReleased) {
        await rm(running.runtimeRoot, {
          recursive: true,
          force: true,
          maxRetries: 8,
          retryDelay: 250,
        });
        evidence.runtimeCleaned = true;
      } else {
        evidence.runtimeCleaned = false;
      }
      expect(cleanup.ownerExited).toBe(true);
      expect(cleanup.corePortReleased).toBe(true);
    }
    const filePath = path.join(
      EVIDENCE_DIRECTORY,
      `remediation-library-lifecycle-${Date.now()}.json`,
    );
    await writeFile(filePath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  }
});
