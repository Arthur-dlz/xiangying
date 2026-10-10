import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
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
  captureProcessOutput,
  type ProcessOutput,
} from "../support/process.ts";
import {
  readWindowsProcessIdentity,
  terminateOwnedWindowsProcess,
  waitForWindowsProcessExit,
  type WindowsProcessIdentity,
} from "../support/xiangying-windows-process.ts";
import { waitForPortFree } from "../support/ports.ts";
import { resolveMpCmdRunPath } from "../../../apps/electron/src/services/library-defender.ts";

const execFileAsync = promisify(execFile);

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const EXECUTABLE = path.join(
  ROOT,
  "apps/electron/release-slim/win-unpacked/乡映.exe",
);
const EXPECTED_EXE_SHA256 =
  "2AD5E2599471100B3F46482FB1997DC85352BFA9F2A879FED5766B6970352E45";
const CORE_PORT = Number(process.env.MEDIAGO_CORE_PORT || 39_739);
const FIXTURE_SOURCE = path.join(
  ROOT,
  "tests/media-service/public/v1/sample.mp4",
);
const EVIDENCE_DIRECTORY = path.join(ROOT, ".task/regression-20261006/library");

interface LibraryApi {
  list(): Promise<unknown>;
  importFiles(
    paths: string[],
    source?: "import" | "download",
  ): Promise<unknown>;
  play(id: string): Promise<unknown>;
  update(
    id: string,
    patch: {
      category?: "movie" | "documentary" | "children" | "other";
      screened?: boolean;
    },
  ): Promise<unknown>;
}

interface ElectronWindowApi {
  electron?: { library?: LibraryApi };
}

interface LibraryIndex {
  version: number;
  items: {
    id: string;
    title: string;
    path: string;
    bytes: number;
    category: string;
    tags: string[];
    screened: boolean;
    source: "import" | "download";
    addedAt: string;
    updatedAt: string;
    safety: {
      status: "unscanned" | "clean" | "blocked" | "unavailable";
      checkedAt?: string;
      fingerprint?: string;
      message?: string;
    };
    missing: boolean;
  }[];
}

interface RunningApp {
  application: ElectronApplication;
  page: Page;
  identity: WindowsProcessIdentity;
  output: ProcessOutput;
  runtimeRoot: string;
  userDataPath: string;
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
      "Library IPC failed: " + String(response.message ?? response.code),
    );
  }
  return response.data as T;
}

async function launchIsolatedApp(): Promise<RunningApp> {
  const runtimeRoot = await mkdtemp(
    path.join(tmpdir(), "xiangying-library-state-"),
  );
  await Promise.all([
    mkdir(path.join(runtimeRoot, "appdata"), { recursive: true }),
    mkdir(path.join(runtimeRoot, "localappdata"), { recursive: true }),
    mkdir(EVIDENCE_DIRECTORY, { recursive: true }),
  ]);
  await waitForPortFree("127.0.0.1", CORE_PORT, 1_000);
  const executable = path.resolve(
    process.env.XIANGYING_E2E_EXECUTABLE || EXECUTABLE,
  );
  expect(executable.toLocaleLowerCase("en-US")).toBe(
    path.resolve(EXECUTABLE).toLocaleLowerCase("en-US"),
  );
  expect(
    createHash("sha256")
      .update(await readFile(executable))
      .digest("hex")
      .toUpperCase(),
  ).toBe(EXPECTED_EXE_SHA256);

  const application = await _electron.launch({
    executablePath: executable,
    args: [],
    timeout: 30_000,
    env: {
      ...scrubElectronEnvironment(process.env),
      APP_NAME: "xiangying",
      APP_TARGET: "electron",
      NODE_ENV: "production",
      ELECTRON_IS_DEV: "0",
      MEDIAGO_RUNTIME_ROOT: runtimeRoot,
      MEDIAGO_CORE_PORT: String(CORE_PORT),
      APPDATA: path.join(runtimeRoot, "appdata"),
      LOCALAPPDATA: path.join(runtimeRoot, "localappdata"),
    },
  });
  const output = captureProcessOutput(application.process());
  try {
    const main = await application.evaluate(({ app }) => ({
      pid: process.pid,
      executablePath: process.execPath,
      userDataPath: app.getPath("userData"),
    }));
    expect(main.executablePath.toLocaleLowerCase("en-US")).toBe(
      executable.toLocaleLowerCase("en-US"),
    );
    const identity = await readWindowsProcessIdentity(main.pid);
    if (!identity)
      throw new Error("Candidate main process exited during startup");
    const page = application
      .windows()
      .find((candidate) =>
        /^xiangying:\/\/index\.html\/(?:library)?$/.test(candidate.url()),
      );
    if (!page) throw new Error("Candidate library page was not created");
    await expect(page.getByRole("heading", { name: "我的片库" })).toBeVisible();

    const normalizedRuntime = path
      .resolve(runtimeRoot)
      .toLocaleLowerCase("en-US");
    const normalizedUserData = path
      .resolve(main.userDataPath)
      .toLocaleLowerCase("en-US");
    expect(normalizedUserData.startsWith(normalizedRuntime + path.sep)).toBe(
      true,
    );
    return {
      application,
      page,
      identity,
      output,
      runtimeRoot,
      userDataPath: main.userDataPath,
    };
  } catch (error) {
    output.dispose();
    await application.evaluate(({ app }) => app.quit()).catch(() => undefined);
    await application.close().catch(() => undefined);
    throw error;
  }
}

async function closeIsolatedApp(
  running: RunningApp,
  testInfo: TestInfo,
): Promise<void> {
  await running.application
    .evaluate(({ app }) => app.quit())
    .catch(() => undefined);
  await running.application.close().catch(() => undefined);
  if (!(await waitForWindowsProcessExit(running.identity, 5_000))) {
    await terminateOwnedWindowsProcess(running.identity);
    expect(await waitForWindowsProcessExit(running.identity, 5_000)).toBe(true);
  }
  await waitForPortFree("127.0.0.1", CORE_PORT, 10_000);
  await attachBoundedProcessLogs(testInfo, { electron: running.output });
  running.output.dispose();
  await rm(running.runtimeRoot, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 300,
  });
}

async function importFixture(
  page: Page,
  fixturePath: string,
): Promise<{ id: string; title: string }> {
  const result = await page.evaluate(async (mediaPath) => {
    const api = (window as unknown as ElectronWindowApi).electron?.library;
    if (!api) throw new Error("Production preload library API is unavailable");
    return api.importFiles([mediaPath], "import");
  }, fixturePath);
  const imported = unwrap<{ items: { id: string; title: string }[] }>(result);
  const item = imported.items[0];
  if (!item) throw new Error("Fixture import returned no library item");
  return item;
}

async function readDefenderHostContext(): Promise<{
  machine: string;
  executable: string;
  version: string;
}> {
  const executable = await resolveMpCmdRunPath();
  if (!executable) throw new Error("Windows Defender MpCmdRun.exe unavailable");
  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  const script =
    '$ProgressPreference = "SilentlyContinue"; $item = Get-Item -LiteralPath $env:XIANGYING_DEFENDER_EXE; [pscustomobject]@{ machine=$env:COMPUTERNAME; version=$item.VersionInfo.FileVersion } | ConvertTo-Json -Compress';
  const { stdout } = await execFileAsync(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      windowsHide: true,
      timeout: 10_000,
      env: { ...process.env, XIANGYING_DEFENDER_EXE: executable },
    },
  );
  const info = JSON.parse(stdout.trim()) as {
    machine: string;
    version: string;
  };
  expect(info.machine.toLocaleLowerCase("en-US")).toBe(
    hostname().toLocaleLowerCase("en-US"),
  );
  return { ...info, executable };
}

// oxlint-disable-next-line eslint/no-empty-pattern -- Playwright requires fixture arguments to be destructured.
test("alpha3 reflects missing files and fails closed for injected blocked and changed-scan states", async ({}, testInfo) => {
  const running = await launchIsolatedApp();
  try {
    const fixturePath = path.join(
      running.runtimeRoot,
      "media",
      "library-state-benign.mp4",
    );
    await mkdir(path.dirname(fixturePath), { recursive: true });
    await copyFile(FIXTURE_SOURCE, fixturePath);
    const item = await importFixture(running.page, fixturePath);
    await running.page
      .getByRole("button", { name: "刷新", exact: true })
      .click();
    const card = running.page.locator("article").filter({
      has: running.page.getByRole("heading", { name: item.title, exact: true }),
    });
    await expect(card).toBeVisible();

    const defender = await readDefenderHostContext();
    await card.getByRole("button", { name: "扫描", exact: true }).click();
    await expect(card.getByText("扫描未发现威胁", { exact: true })).toBeVisible(
      { timeout: 30_000 },
    );
    await writeFile(
      path.join(
        EVIDENCE_DIRECTORY,
        "library-defender-candidate-ui-observation.json",
      ),
      JSON.stringify(
        {
          candidate: EXECUTABLE,
          machine: defender.machine,
          defenderExecutable: defender.executable,
          defenderVersion: defender.version,
          fixtureSha256: createHash("sha256")
            .update(await readFile(fixturePath))
            .digest("hex"),
          uiStatus: "扫描未发现威胁",
          invokedFromCandidateUi: true,
        },
        null,
        2,
      ),
      "utf8",
    );

    await rm(fixturePath);
    await running.page
      .getByRole("button", { name: "刷新", exact: true })
      .click();
    await expect(card.getByText("文件已移走", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "播放" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "打开位置" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "扫描" })).toBeDisabled();
    await expect(
      card.getByRole("checkbox", { name: "选择" + item.title }),
    ).toBeDisabled();

    await copyFile(FIXTURE_SOURCE, fixturePath);
    await running.page
      .getByRole("button", { name: "刷新", exact: true })
      .click();
    await expect(card.getByText("文件已移走", { exact: true })).toHaveCount(0);

    const indexPath = path.join(running.userDataPath, "library-v1.json");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as LibraryIndex;
    const storedItem = index.items.find((entry) => entry.id === item.id);
    if (!storedItem)
      throw new Error("Imported item is missing from isolated index");
    const originalBytes = await readFile(fixturePath);
    storedItem.safety = {
      status: "clean",
      checkedAt: new Date("2000-01-01T00:00:00.000Z").toISOString(),
      fingerprint: createHash("sha256").update(originalBytes).digest("hex"),
    };
    await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n", "utf8");
    await appendFile(
      fixturePath,
      Buffer.from(" changed after injected clean scan"),
    );
    await running.page
      .getByRole("button", { name: "刷新", exact: true })
      .click();
    await expect(card.getByText("尚未扫描", { exact: true })).toBeVisible();
    const changedState = unwrap<{ items: { safety: { status: string } }[] }>(
      await running.page.evaluate(async () => {
        const api = (window as unknown as ElectronWindowApi).electron?.library;
        if (!api)
          throw new Error("Production preload library API is unavailable");
        return api.list();
      }),
    );
    expect(changedState.items[0]?.safety.status).toBe("unscanned");

    const blockedIndex = JSON.parse(
      await readFile(indexPath, "utf8"),
    ) as LibraryIndex;
    const blockedItem = blockedIndex.items.find(
      (entry) => entry.id === item.id,
    );
    if (!blockedItem) throw new Error("Blocked seed target is missing");
    blockedItem.safety = {
      status: "blocked",
      checkedAt: new Date().toISOString(),
      message: "Test-only injected Defender blocked state",
    };
    await writeFile(
      indexPath,
      JSON.stringify(blockedIndex, null, 2) + "\n",
      "utf8",
    );
    await running.application.evaluate(({ shell }) => {
      const globalState = globalThis as typeof globalThis & {
        libraryStateTestHook?: { shellOpenCalls: string[] };
      };
      const state = { shellOpenCalls: [] as string[] };
      globalState.libraryStateTestHook = state;
      Object.defineProperty(shell, "openPath", {
        configurable: true,
        value: async (mediaPath: string) => {
          state.shellOpenCalls.push(mediaPath);
          return "";
        },
      });
    });
    await running.page
      .getByRole("button", { name: "刷新", exact: true })
      .click();
    await expect(card.getByText("已阻止", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "播放" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "扫描" })).toBeDisabled();
    await expect(
      card.getByRole("checkbox", { name: "选择" + item.title }),
    ).toBeDisabled();

    const blockedPlay = await running.page.evaluate(async (id) => {
      const api = (window as unknown as ElectronWindowApi).electron?.library;
      if (!api)
        throw new Error("Production preload library API is unavailable");
      try {
        const result = await api.play(id);
        if (
          typeof result === "object" &&
          result !== null &&
          "code" in result &&
          (result as { code?: number }).code !== 0
        ) {
          return { rejected: true };
        }
        return { rejected: false };
      } catch {
        return { rejected: true };
      }
    }, item.id);
    const shellCalls = await running.application.evaluate(() => {
      const state = (
        globalThis as typeof globalThis & {
          libraryStateTestHook?: { shellOpenCalls: string[] };
        }
      ).libraryStateTestHook;
      return state?.shellOpenCalls ?? [];
    });
    expect(blockedPlay.rejected).toBe(true);
    expect(shellCalls).toEqual([]);
    await writeFile(
      path.join(
        EVIDENCE_DIRECTORY,
        "library-state-injection-observations.json",
      ),
      JSON.stringify(
        {
          candidate: EXECUTABLE,
          userDataPath: running.userDataPath,
          injectedStates: [
            "missing",
            "clean fingerprint invalidated after fixture append",
            "blocked",
          ],
          missingActionsDisabled: true,
          blockedPlayRejectedBeforeShell:
            blockedPlay.rejected && shellCalls.length === 0,
          scanStateInjection: true,
        },
        null,
        2,
      ),
      "utf8",
    );
  } finally {
    await closeIsolatedApp(running, testInfo);
  }
});

// oxlint-disable-next-line eslint/no-empty-pattern -- Playwright requires fixture arguments to be destructured.
test("alpha3 reports a corrupt isolated library index without rewriting it", async ({}, testInfo) => {
  const running = await launchIsolatedApp();
  try {
    const indexPath = path.join(running.userDataPath, "library-v1.json");
    const corruptContents = "{ deliberately invalid test index";
    await writeFile(indexPath, corruptContents, "utf8");

    await running.page
      .getByRole("button", { name: "刷新", exact: true })
      .click();
    await expect(running.page.getByText(/片库索引损坏/)).toBeVisible();
    expect(await readFile(indexPath, "utf8")).toBe(corruptContents);

    const incompatibleContents = JSON.stringify({ version: 999, items: [] });
    await writeFile(indexPath, incompatibleContents, "utf8");
    await running.page
      .getByRole("button", { name: "重新加载", exact: true })
      .click();
    await expect(
      running.page.getByText(/片库索引版本不兼容或字段无效/),
    ).toBeVisible();
    expect(await readFile(indexPath, "utf8")).toBe(incompatibleContents);

    await writeFile(
      path.join(EVIDENCE_DIRECTORY, "library-corrupt-index-observation.json"),
      JSON.stringify(
        {
          candidate: EXECUTABLE,
          userDataPath: running.userDataPath,
          uiError: "片库索引损坏",
          originalBytesPreserved: true,
          unsupportedVersion: 999,
          unsupportedVersionUiError: "片库索引版本不兼容或字段无效",
          unsupportedVersionBytesPreserved: true,
        },
        null,
        2,
      ),
      "utf8",
    );
  } finally {
    await closeIsolatedApp(running, testInfo);
  }
});

// oxlint-disable-next-line eslint/no-empty-pattern -- Playwright requires fixture arguments to be destructured.
test("alpha3 deduplicates NTFS path aliases, combines filters, and resizes only its own window", async ({}, testInfo) => {
  const running = await launchIsolatedApp();
  try {
    const fixturePath = path.join(
      running.runtimeRoot,
      "media",
      "library-path-alias.mp4",
    );
    await mkdir(path.dirname(fixturePath), { recursive: true });
    await copyFile(FIXTURE_SOURCE, fixturePath);
    const original = await importFixture(running.page, fixturePath);
    const pathAliases = [
      fixturePath.toLocaleUpperCase("en-US"),
      fixturePath.replaceAll("\\", "/"),
    ];
    const aliasResult = unwrap<{
      added: number;
      skipped: number;
      rejected: unknown[];
    }>(
      await running.page.evaluate(async (paths) => {
        const api = (window as unknown as ElectronWindowApi).electron?.library;
        if (!api) throw new Error("Production preload library API unavailable");
        return api.importFiles(paths, "import");
      }, pathAliases),
    );
    expect(aliasResult).toMatchObject({ added: 0, skipped: 2, rejected: [] });

    const filteredFixtures = [
      {
        name: "library-filter-movie-screened.mp4",
        category: "movie",
        screened: true,
      },
      {
        name: "library-filter-documentary-unseen.mp4",
        category: "documentary",
        screened: false,
      },
      {
        name: "library-filter-children-unseen.mp4",
        category: "children",
        screened: false,
      },
    ] as const;
    const fixturePaths = filteredFixtures.map((fixture) =>
      path.join(running.runtimeRoot, "media", fixture.name),
    );
    await Promise.all(
      fixturePaths.map((mediaPath) => copyFile(FIXTURE_SOURCE, mediaPath)),
    );
    const imported = unwrap<{ items: { id: string; title: string }[] }>(
      await running.page.evaluate(async (paths) => {
        const api = (window as unknown as ElectronWindowApi).electron?.library;
        if (!api) throw new Error("Production preload library API unavailable");
        return api.importFiles(paths, "import");
      }, fixturePaths),
    );
    expect(imported.items).toHaveLength(3);
    const updateResults = await Promise.all(
      imported.items.map(async (item, index) => {
        const fixture = filteredFixtures[index];
        if (!fixture) throw new Error("Filter fixture mapping is incomplete");
        return running.page.evaluate(
          async ({ id, category, screened }) => {
            const api = (window as unknown as ElectronWindowApi).electron
              ?.library;
            if (!api)
              throw new Error("Production preload library API unavailable");
            return api.update(id, { category, screened });
          },
          {
            id: item.id,
            category: fixture.category,
            screened: fixture.screened,
          },
        );
      }),
    );
    updateResults.forEach((updateResult) => unwrap(updateResult));
    await running.page
      .getByRole("button", { name: "刷新", exact: true })
      .click();
    const search = running.page.getByRole("textbox", {
      name: "搜索片名或标签",
    });
    await search.fill("library-filter-");
    const cards = running.page.locator("article");
    await expect(cards).toHaveCount(3);

    const categoryFilter = running.page.getByRole("combobox", {
      name: "按分类筛选",
    });
    const screenedFilter = running.page.getByRole("combobox", {
      name: "按放映状态筛选",
    });
    await categoryFilter.click();
    await running.page
      .getByRole("option", { name: "电影", exact: true })
      .click();
    await screenedFilter.click();
    await running.page
      .getByRole("option", { name: "已放映", exact: true })
      .click();
    await expect(cards).toHaveCount(1);
    await expect(
      cards.getByRole("heading", {
        name: "library-filter-movie-screened",
        exact: true,
      }),
    ).toBeVisible();

    await categoryFilter.click();
    await running.page
      .getByRole("option", { name: "全部分类", exact: true })
      .click();
    await screenedFilter.click();
    await running.page
      .getByRole("option", { name: "未放映", exact: true })
      .click();
    await expect(cards).toHaveCount(2);
    await categoryFilter.click();
    await running.page
      .getByRole("option", { name: "纪录片", exact: true })
      .click();
    await expect(cards).toHaveCount(1);
    await expect(
      cards.getByRole("heading", {
        name: "library-filter-documentary-unseen",
        exact: true,
      }),
    ).toBeVisible();

    await categoryFilter.click();
    await running.page
      .getByRole("option", { name: "全部分类", exact: true })
      .click();
    await screenedFilter.click();
    await running.page
      .getByRole("option", { name: "全部状态", exact: true })
      .click();
    await search.fill("");
    await expect(cards).toHaveCount(4);

    const windowResize = await running.application.evaluate(
      ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window) throw new Error("Candidate main window is unavailable");
        const originalBounds = window.getBounds();
        window.setSize(900, 620);
        return {
          requestedSize: { width: 900, height: 620 },
          immediateBounds: window.getBounds(),
          originalBounds,
        };
      },
    );
    await expect
      .poll(() => running.page.evaluate(() => window.innerWidth))
      .toBeGreaterThan(800);
    const layout = await running.page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      libraryHeadingVisible: Boolean(
        document.querySelector("h1")?.getBoundingClientRect().width,
      ),
    }));
    expect(layout.libraryHeadingVisible).toBe(true);
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    const actualWindowBounds = await running.application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBounds(),
    );
    await running.application.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setBounds(size);
    }, windowResize.originalBounds);
    await writeFile(
      path.join(
        EVIDENCE_DIRECTORY,
        "library-alias-filter-window-observation.json",
      ),
      JSON.stringify(
        {
          candidate: EXECUTABLE,
          pathAliasImport: aliasResult,
          uniqueAliasItemTitle: original.title,
          filterResults: {
            movieAndScreened: 1,
            allCategoriesAndUnscreened: 2,
            documentaryAndUnscreened: 1,
            clearedFilters: 4,
          },
          windowResize,
          actualWindowBounds,
          resizedLayout: layout,
          operatingSystemDisplaySettingsChanged: false,
        },
        null,
        2,
      ),
      "utf8",
    );
  } finally {
    await closeIsolatedApp(running, testInfo);
  }
});
