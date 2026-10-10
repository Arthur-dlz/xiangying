import { execFile } from "node:child_process";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  _electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { attachBoundedProcessLogs } from "../support/artifacts.ts";
import { scrubElectronEnvironment } from "../support/electron-network.ts";
import {
  readWindowsProcessIdentity,
  terminateOwnedWindowsProcess,
  waitForWindowsProcessExit,
  type WindowsProcessIdentity,
} from "../support/xiangying-windows-process.ts";
import { waitForPortFree } from "../support/ports.ts";
import type { ResourceProvider } from "../../../packages/common/src/types/resource-search.ts";
import {
  captureProcessOutput,
  type ProcessOutput,
} from "../support/process.ts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEFAULT_EXECUTABLE = path.join(
  REPOSITORY_ROOT,
  "apps/electron/release/win-unpacked/乡映.exe",
);
const CORE_EXECUTABLE = path.join(
  REPOSITORY_ROOT,
  "apps/electron/release/win-unpacked/resources/bin/mediago-core.exe",
);
const DEPS_DIRECTORY = path.join(REPOSITORY_ROOT, ".deps/win32-x64");
const CORE_PORT = Number(process.env.MEDIAGO_CORE_PORT || 39_719);
const execFileAsync = promisify(execFile);

interface RuntimeMockState {
  importPath: string;
  exportDirectory: string;
  cancelExport: boolean;
  playedPaths: string[];
  confirmationCount: number;
}

interface ElectronWindowApi {
  electron?: {
    resourceSearch?: {
      listProviders(): Promise<unknown>;
      saveProviders(providers: ResourceProvider[]): Promise<unknown>;
    };
    library?: {
      list(): Promise<unknown>;
      exportFiles(ids: string[]): Promise<unknown>;
      play(id: string): Promise<unknown>;
    };
  };
}

interface LibraryItemView {
  id: string;
  title: string;
  path: string;
  category: string;
  tags: string[];
  screened: boolean;
}

interface LibrarySnapshotView {
  items: LibraryItemView[];
  totalBytes: number;
}

interface ExportView {
  cancelled: boolean;
  results: { id: string; copied: boolean; path?: string; error?: string }[];
}

function packagedExecutablePath(): string {
  return process.env.XIANGYING_E2E_EXECUTABLE || DEFAULT_EXECUTABLE;
}

function normalizeExecutablePath(value: string): string {
  return path.resolve(value).toLocaleLowerCase("en-US");
}

function unwrap<T>(result: unknown): T {
  if (typeof result !== "object" || result === null || !("code" in result)) {
    return result as T;
  }
  const response = result as {
    code?: unknown;
    data?: unknown;
    message?: unknown;
  };
  if (response.code !== 0) {
    throw new Error(
      `Library IPC failed: ${String(response.message ?? response.code)}`,
    );
  }
  return response.data as T;
}

async function generateFixture(fixturePath: string): Promise<void> {
  const ffmpeg = path.join(DEPS_DIRECTORY, "ffmpeg.exe");
  await execFileAsync(
    ffmpeg,
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=teal:s=160x90:r=24",
      "-frames:v",
      "24",
      "-c:v",
      "mpeg4",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-y",
      fixturePath,
    ],
    { timeout: 30_000, windowsHide: true },
  );
  const bytes = await readFile(fixturePath);
  expect(bytes.byteLength).toBeGreaterThan(100);
  expect(bytes.toString("ascii", 4, 8)).toBe("ftyp");
}

function electronEnvironment(runtimeRoot: string): Record<string, string> {
  return {
    ...scrubElectronEnvironment(process.env),
    APP_NAME: "xiangying",
    APP_TARGET: "electron",
    NODE_ENV: "production",
    ELECTRON_IS_DEV: "0",
    MEDIAGO_RUNTIME_ROOT: runtimeRoot,
    APPDATA: path.join(runtimeRoot, "appdata"),
    LOCALAPPDATA: path.join(runtimeRoot, "localappdata"),
  };
}

async function launchPackagedApp(runtimeRoot: string): Promise<{
  application: ElectronApplication;
  identity: WindowsProcessIdentity;
  page: Page;
  output: ProcessOutput;
}> {
  const application = await _electron.launch({
    executablePath: packagedExecutablePath(),
    args: [],
    env: electronEnvironment(runtimeRoot),
    timeout: 30_000,
  });
  const output = captureProcessOutput(application.process());
  let identity: WindowsProcessIdentity | undefined;
  try {
    const mainProcess = await application.evaluate(() => ({
      pid: process.pid,
      executablePath: process.execPath,
    }));
    expect(normalizeExecutablePath(mainProcess.executablePath)).toBe(
      normalizeExecutablePath(packagedExecutablePath()),
    );
    identity = await readWindowsProcessIdentity(mainProcess.pid);
    if (!identity) throw new Error("Packaged Electron exited during startup");
    await expect
      .poll(() =>
        application.windows().some((candidate) => {
          const url = new URL(candidate.url());
          return (
            url.protocol === "xiangying:" &&
            url.hostname === "index.html" &&
            ["/", "/library"].includes(url.pathname)
          );
        }),
      )
      .toBe(true);
    const page = application.windows().find((candidate) => {
      const url = new URL(candidate.url());
      return (
        url.protocol === "xiangying:" &&
        url.hostname === "index.html" &&
        ["/", "/library"].includes(url.pathname)
      );
    });
    if (!page) throw new Error("Packaged main library page not found");
    await page.waitForLoadState("domcontentloaded", { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "我的片库" })).toBeVisible({
      timeout: 20_000,
    });
    return { application, identity, page, output };
  } catch (error) {
    output.dispose();
    await closeOwnedElectron(application, identity);
    throw error;
  }
}

async function closeOwnedElectron(
  application: ElectronApplication | undefined,
  identity: WindowsProcessIdentity | undefined,
): Promise<void> {
  if (!application) return;
  const closeErrors: unknown[] = [];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Exercise the application's quit lifecycle before closing the test transport.
    await application.evaluate(({ app }) => app.quit()).catch(() => undefined);
    await Promise.race([
      application.close(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Electron graceful close timed out")),
          8_000,
        );
      }),
    ]);
  } catch (error) {
    closeErrors.push(error);
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  if (identity) {
    let exited = await waitForWindowsProcessExit(identity, 5_000);
    if (!exited) {
      await terminateOwnedWindowsProcess(identity);
      exited = await waitForWindowsProcessExit(identity, 5_000);
    }
    if (!exited)
      throw new Error(`Owned Electron PID ${identity.pid} did not exit`);
  }
  if (closeErrors.length > 0) {
    throw new Error("Electron required PID-identity-checked cleanup", {
      cause: new AggregateError(closeErrors),
    });
  }
}

async function installDialogAndShellStubs(
  application: ElectronApplication,
  initialState: RuntimeMockState,
): Promise<void> {
  await application.evaluate(({ dialog, shell }, state) => {
    type MutableRuntime = {
      xiangyingE2eRuntime?: RuntimeMockState;
    };
    const runtime = globalThis as typeof globalThis & MutableRuntime;
    runtime.xiangyingE2eRuntime = state;

    const mutableDialog = dialog as unknown as {
      showOpenDialog: (...args: unknown[]) => Promise<unknown>;
      showMessageBox: (...args: unknown[]) => Promise<unknown>;
    };
    Object.defineProperty(mutableDialog, "showOpenDialog", {
      configurable: true,
      value: async (...args: unknown[]) => {
        const current = runtime.xiangyingE2eRuntime;
        const options = args.at(-1) as { properties?: string[] } | undefined;
        if (options?.properties?.includes("openDirectory")) {
          return current?.cancelExport
            ? { canceled: true, filePaths: [] }
            : {
                canceled: false,
                filePaths: current?.exportDirectory
                  ? [current.exportDirectory]
                  : [],
              };
        }
        return {
          canceled: false,
          filePaths: current?.importPath ? [current.importPath] : [],
        };
      },
    });
    Object.defineProperty(mutableDialog, "showMessageBox", {
      configurable: true,
      value: async () => {
        const current = runtime.xiangyingE2eRuntime;
        if (current) current.confirmationCount += 1;
        return { response: 1 };
      },
    });
    Object.defineProperty(shell, "openPath", {
      configurable: true,
      value: async (filePath: string) => {
        runtime.xiangyingE2eRuntime?.playedPaths.push(filePath);
        return "";
      },
    });
  }, initialState);
}

async function assertWindowSize(
  application: ElectronApplication,
): Promise<void> {
  const size = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getSize(),
  );
  expect(size).toBeDefined();
  if (!size) throw new Error("Packaged Electron window is unavailable");
  expect(
    Math.abs(size[0] - 1100),
    `actual window size: ${size}`,
  ).toBeLessThanOrEqual(4);
  expect(
    Math.abs(size[1] - 680),
    `actual window size: ${size}`,
  ).toBeLessThanOrEqual(2);
}

async function setRuntimeMockState(
  application: ElectronApplication,
  patch: Partial<RuntimeMockState>,
): Promise<void> {
  await application.evaluate((electronModule, updates) => {
    void electronModule;
    type MutableRuntime = { xiangyingE2eRuntime?: RuntimeMockState };
    const state = (globalThis as typeof globalThis & MutableRuntime)
      .xiangyingE2eRuntime;
    if (!state) throw new Error("Electron runtime stubs are not installed");
    Object.assign(state, updates);
  }, patch);
}

async function libraryList(page: Page): Promise<LibrarySnapshotView> {
  const result = await page.evaluate(() => {
    const api = (window as unknown as ElectronWindowApi).electron?.library;
    if (!api) throw new Error("Production preload library API is unavailable");
    return api.list();
  });
  return unwrap<LibrarySnapshotView>(result);
}

async function libraryExport(page: Page, ids: string[]): Promise<ExportView> {
  const result = await page.evaluate((itemIds) => {
    const api = (window as unknown as ElectronWindowApi).electron?.library;
    if (!api) throw new Error("Production preload library API is unavailable");
    return api.exportFiles(itemIds);
  }, ids);
  return unwrap<ExportView>(result);
}

async function mockPlayback(page: Page, id: string): Promise<unknown> {
  return page.evaluate((itemId) => {
    const api = (window as unknown as ElectronWindowApi).electron?.library;
    if (!api) throw new Error("Production preload library API is unavailable");
    return api.play(itemId);
  }, id);
}

async function attachRuntimeNotes(
  testInfo: TestInfo,
  consoleErrors: string[],
): Promise<void> {
  await testInfo.attach("xiangying-windows-runtime-notes.txt", {
    body: [
      "Windows packaged Electron candidate exercised through the production preload and library IPC.",
      "Open-file, export-directory, and unscanned-play confirmation dialogs were mocked in the Electron main process.",
      "shell.openPath was mocked and its media path was asserted; OS default-player playback is NOT_PROVEN.",
      "Renderer console errors:",
      ...(consoleErrors.length ? consoleErrors : ["none"]),
    ].join("\n"),
    contentType: "text/plain; charset=utf-8",
  });
}

test.skip(
  process.platform !== "win32",
  "乡映 packaged runtime acceptance is Windows-only",
);

// oxlint-disable-next-line eslint/no-empty-pattern -- Playwright requires fixture arguments to be destructured.
test("乡映 Windows packaged library imports, edits, exports, persists, and removes a local fixture", async ({}, testInfo) => {
  test.setTimeout(150_000);
  const executable = packagedExecutablePath();
  await expect
    .poll(
      async () =>
        stat(executable).then(
          () => true,
          () => false,
        ),
      {
        message: `Packaged candidate executable must exist at ${executable}`,
      },
    )
    .toBe(true);
  await expect
    .poll(
      async () =>
        stat(CORE_EXECUTABLE).then(
          () => true,
          () => false,
        ),
      {
        message: `Local Core executable must exist at ${CORE_EXECUTABLE}`,
      },
    )
    .toBe(true);
  await waitForPortFree("127.0.0.1", CORE_PORT, 1_000);

  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "xiangying-e2e-"));
  const fixtureDirectory = path.join(runtimeRoot, "fixture");
  const exportDirectory = path.join(runtimeRoot, "export");
  const fixturePath = path.join(fixtureDirectory, "乡映验收样片.mp4");
  const consoleErrors: string[] = [];
  let application: ElectronApplication | undefined;
  let electronIdentity: WindowsProcessIdentity | undefined;
  let electronOutput: ProcessOutput | undefined;
  let primaryError: unknown;
  const cleanupErrors: string[] = [];

  try {
    await Promise.all([
      mkdir(fixtureDirectory, { recursive: true }),
      mkdir(exportDirectory, { recursive: true }),
      mkdir(path.join(runtimeRoot, "appdata"), { recursive: true }),
      mkdir(path.join(runtimeRoot, "localappdata"), { recursive: true }),
    ]);
    await generateFixture(fixturePath);

    let launched = await launchPackagedApp(runtimeRoot);
    application = launched.application;
    electronIdentity = launched.identity;
    electronOutput = launched.output;
    let page = launched.page;
    const initialProviders = unwrap<ResourceProvider[]>(
      await page.evaluate(async () => {
        const api = (window as Window & ElectronWindowApi).electron
          ?.resourceSearch;
        if (!api) throw new Error("Trusted resource search API missing");
        return api.listProviders();
      }),
    );
    const savedProviders = initialProviders.map((provider) => ({
      ...provider,
      enabled: provider.id === "bfzy",
    }));
    expect(
      unwrap(
        await page.evaluate(async (providers) => {
          const api = (window as Window & ElectronWindowApi).electron
            ?.resourceSearch;
          if (!api) throw new Error("Trusted resource search API missing");
          return api.saveProviders(providers);
        }, savedProviders),
      ),
    ).toEqual(savedProviders);
    await assertWindowSize(application);
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    await installDialogAndShellStubs(application, {
      importPath: fixturePath,
      exportDirectory,
      cancelExport: false,
      playedPaths: [],
      confirmationCount: 0,
    });

    await expect(page.getByText("片库还空着")).toBeVisible();
    await testInfo.attach("xiangying-library-empty-window.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    // The UI invokes the app's real dialog IPC; only the native picker result is stubbed.
    await page.getByRole("button", { name: "导入视频" }).first().click();
    await expect(
      page.getByRole("heading", { name: "乡映验收样片" }),
    ).toBeVisible();
    let snapshot = await libraryList(page);
    expect(snapshot.items).toHaveLength(1);
    const item = snapshot.items[0];
    expect(item.path).toBe(fixturePath);
    expect(item.title).toBe("乡映验收样片");

    await page.getByRole("button", { name: /编辑乡映验收样片/ }).click();
    await page.getByRole("textbox", { name: "片名" }).fill("乡映活动记录");
    await page.getByRole("combobox", { name: "分类" }).click();
    await page.getByRole("option", { name: "纪录片" }).click();
    await page.getByRole("textbox", { name: "标签" }).fill("校园，验收活动");
    await page.getByRole("checkbox", { name: "已放映" }).click();
    await page.getByRole("button", { name: "保存" }).click();
    await expect(
      page.getByRole("heading", { name: "乡映活动记录" }),
    ).toBeVisible();

    await page
      .getByRole("textbox", { name: "搜索片名或标签" })
      .fill("验收活动");
    await expect(
      page.getByRole("heading", { name: "乡映活动记录" }),
    ).toBeVisible();
    await expect(page.locator("article")).toContainText("纪录片");
    await expect(page.locator("article")).toContainText("已放映");
    await page
      .getByRole("textbox", { name: "搜索片名或标签" })
      .fill("没有这部片");
    await expect(page.getByText("没有找到匹配的影片")).toBeVisible();
    await page.getByRole("button", { name: "清除筛选" }).click();
    await page.getByRole("checkbox", { name: "选择乡映活动记录" }).click();
    await page.getByRole("button", { name: "导出所选" }).click();
    const exportedPath = path.join(exportDirectory, "乡映验收样片.mp4");
    await expect
      .poll(async () =>
        stat(exportedPath).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    expect(await readFile(exportedPath)).toEqual(await readFile(fixturePath));

    const conflict = await libraryExport(page, [item.id]);
    expect(conflict.cancelled).toBe(false);
    expect(conflict.results).toMatchObject([{ id: item.id, copied: true }]);
    expect(conflict.results[0].path).toBe(
      path.join(exportDirectory, "乡映验收样片 (1).mp4"),
    );
    expect(await readFile(conflict.results[0].path!)).toEqual(
      await readFile(fixturePath),
    );
    expect(await readFile(exportedPath)).toEqual(await readFile(fixturePath));

    const thirdExport = await libraryExport(page, [item.id]);
    expect(thirdExport.cancelled).toBe(false);
    expect(thirdExport.results).toMatchObject([{ id: item.id, copied: true }]);
    expect(thirdExport.results[0].path).toBe(
      path.join(exportDirectory, "乡映验收样片 (2).mp4"),
    );
    expect(await readFile(thirdExport.results[0].path!)).toEqual(
      await readFile(fixturePath),
    );
    const filesBeforeCancel = await readdir(exportDirectory);
    await setRuntimeMockState(application, { cancelExport: true });
    const canceled = await libraryExport(page, [item.id]);
    expect(canceled).toEqual({ cancelled: true, results: [] });
    expect(await readdir(exportDirectory)).toEqual(filesBeforeCancel);
    await setRuntimeMockState(application, { cancelExport: false });

    // Playback is verified only to the shell boundary; the OS player is never launched.
    await setRuntimeMockState(application, { confirmationCount: 0 });
    unwrap<void>(await mockPlayback(page, item.id));
    const playbackObservation = await application.evaluate(() => {
      type MutableRuntime = { xiangyingE2eRuntime?: RuntimeMockState };
      return (globalThis as typeof globalThis & MutableRuntime)
        .xiangyingE2eRuntime;
    });
    expect(playbackObservation?.confirmationCount).toBe(1);
    expect(playbackObservation?.playedPaths).toEqual([fixturePath]);

    await testInfo.attach("xiangying-library-nonempty-window.png", {
      body: await page.screenshot({
        path: path.join(
          REPOSITORY_ROOT,
          ".task/xiangying-evidence/library-window.png",
        ),
      }),
      contentType: "image/png",
    });
    await attachRuntimeNotes(testInfo, consoleErrors);

    await closeOwnedElectron(application, electronIdentity);
    electronOutput.dispose();
    application = undefined;
    electronIdentity = undefined;
    await waitForPortFree("127.0.0.1", CORE_PORT, 10_000);

    launched = await launchPackagedApp(runtimeRoot);
    application = launched.application;
    electronIdentity = launched.identity;
    electronOutput = launched.output;
    page = launched.page;
    expect(
      unwrap(
        await page.evaluate(async () => {
          const api = (window as Window & ElectronWindowApi).electron
            ?.resourceSearch;
          if (!api) throw new Error("Trusted resource search API missing");
          return api.listProviders();
        }),
      ),
    ).toEqual(savedProviders);
    await assertWindowSize(application);
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    snapshot = await libraryList(page);
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({
      id: item.id,
      title: "乡映活动记录",
      category: "documentary",
      tags: ["校园", "验收活动"],
      screened: true,
    });
    await expect(
      page.getByRole("heading", { name: "乡映活动记录" }),
    ).toBeVisible();

    await page.getByRole("button", { name: /从片库移除乡映活动记录/ }).click();
    await page.getByRole("button", { name: "移除条目" }).click();
    await expect(page.getByText("片库还空着")).toBeVisible();
    expect((await libraryList(page)).items).toHaveLength(0);
    expect(await readFile(fixturePath)).toEqual(await readFile(exportedPath));
    const scalePaths = await Promise.all(
      Array.from({ length: 500 }, async (_unused, index) => {
        const target = path.join(fixtureDirectory, `规模验收${index}.mp4`);
        await copyFile(fixturePath, target);
        return target;
      }),
    );
    const loadStarted = Date.now();
    const scaleImport = await page.evaluate(
      async (paths) => window.electron.library.importFiles(paths, "import"),
      scalePaths,
    );
    expect(unwrap<{ added: number }>(scaleImport).added).toBe(500);
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(page.locator("article")).toHaveCount(500, { timeout: 10_000 });
    const loadMs = Date.now() - loadStarted;
    const searchStarted = Date.now();
    await page
      .getByRole("textbox", { name: "搜索片名或标签" })
      .fill("规模验收499");
    await expect(page.locator("article")).toHaveCount(1);
    const searchMs = Date.now() - searchStarted;
    expect(searchMs).toBeLessThan(2_000);
    await page.getByRole("textbox", { name: "搜索片名或标签" }).press("Tab");
    await expect(page.getByRole("combobox").first()).toBeFocused();
    await writeFile(
      path.join(
        REPOSITORY_ROOT,
        ".task/xiangying-evidence/library-scale-500.json",
      ),
      JSON.stringify({
        count: 500,
        loadMs,
        searchMs,
        platform: process.platform,
      }),
    );
    await testInfo.attach("library-scale-500.json", {
      body: JSON.stringify({
        count: 500,
        loadMs,
        searchMs,
        platform: process.platform,
      }),
      contentType: "application/json",
    });
    await attachRuntimeNotes(testInfo, consoleErrors);
  } catch (error) {
    primaryError = error;
    if (electronOutput) {
      try {
        await attachBoundedProcessLogs(testInfo, { electron: electronOutput });
      } catch (attachmentError) {
        cleanupErrors.push(`Attach Electron logs: ${String(attachmentError)}`);
      }
    }
    try {
      await attachRuntimeNotes(testInfo, consoleErrors);
    } catch (attachmentError) {
      cleanupErrors.push(`Attach runtime notes: ${String(attachmentError)}`);
    }
  } finally {
    try {
      await closeOwnedElectron(application, electronIdentity);
    } catch (error) {
      cleanupErrors.push(`Close owned Electron process: ${String(error)}`);
    }
    try {
      await waitForPortFree("127.0.0.1", CORE_PORT, 10_000);
    } catch (error) {
      cleanupErrors.push(`Wait for owned Core port to close: ${String(error)}`);
    }
    electronOutput?.dispose();

    if (primaryError === undefined && cleanupErrors.length === 0) {
      try {
        await rm(runtimeRoot, {
          recursive: true,
          force: true,
          maxRetries: 8,
          retryDelay: 500,
        });
      } catch (error) {
        cleanupErrors.push(`Remove successful runtime root: ${String(error)}`);
      }
    }
    if (primaryError !== undefined || cleanupErrors.length > 0) {
      const detail = [
        `Isolated runtime root retained for diagnosis: ${runtimeRoot}`,
        `Electron PID identity: ${electronIdentity ? `${electronIdentity.pid}/${electronIdentity.creationFileTime}` : "unavailable"}`,
        ...cleanupErrors,
      ].join("\n");
      try {
        await testInfo.attach("xiangying-runtime-cleanup.txt", {
          body: detail,
          contentType: "text/plain; charset=utf-8",
        });
      } catch {
        // Preserve the test error; the retained runtime path remains in the thrown error below.
      }
    }
  }

  if (primaryError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, new Error(cleanupErrors.join("\n"))],
      `Xiangying acceptance failed and cleanup had errors; runtime retained at ${runtimeRoot}`,
      { cause: primaryError },
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors.map((message) => new Error(message)),
      `Xiangying cleanup failed; runtime retained at ${runtimeRoot}`,
    );
  }
});
