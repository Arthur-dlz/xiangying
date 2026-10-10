import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { scrubElectronEnvironment } from "../support/electron-network.ts";
import { trustedCoreClient } from "../support/xiangying-core-client.ts";
import {
  readWindowsProcessIdentity,
  terminateOwnedWindowsProcess,
  waitForWindowsProcessExit,
  type WindowsProcessIdentity,
} from "../support/xiangying-windows-process.ts";
import { waitForPortFree } from "../support/ports.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BINDING_PATH = path.join(
  ROOT,
  ".task/repair-20261006/candidate-ui-binding.json",
);
const SAMPLE_PATH = path.join(ROOT, "tests/media-service/public/v1/sample.mp4");
const EVIDENCE_DIRECTORY = path.join(ROOT, ".task/review77-20261006/library");
const CORE_PORT = Number(process.env.MEDIAGO_CORE_PORT || 39_829);

interface LibraryApi {
  list(): Promise<unknown>;
  importFiles(
    paths: string[],
    source?: "import" | "download",
  ): Promise<unknown>;
  update(
    id: string,
    patch: { category?: string; screened?: boolean },
  ): Promise<unknown>;
  play(id: string): Promise<unknown>;
}

interface CandidateBinding {
  candidate: string;
  asarSha256: string;
  coreSha256: string;
}

interface StartedCandidate {
  app: ElectronApplication;
  page: Page;
  runtimeRoot: string;
  userDataPath: string;
  executablePath: string;
  identity: WindowsProcessIdentity;
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
      `IPC call failed: ${String(result.message ?? result.code)}`,
    );
  return result.data as T;
}

async function startCandidate(): Promise<StartedCandidate> {
  const binding = JSON.parse(
    await readFile(BINDING_PATH, "utf8"),
  ) as CandidateBinding;
  const candidate = path.resolve(binding.candidate);
  const expectedExecutable = path.join(candidate, "乡映.exe");
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    expectedExecutable,
  );
  const asarPath = path.join(candidate, "resources/app.asar");
  const corePath = path.join(candidate, "resources/bin/mediago-core.exe");
  expect(digest(await readFile(asarPath))).toBe(
    binding.asarSha256.toLowerCase(),
  );
  expect(digest(await readFile(corePath))).toBe(
    binding.coreSha256.toLowerCase(),
  );

  await mkdir(EVIDENCE_DIRECTORY, { recursive: true });
  const runtimeRoot = await mkdtemp(path.join(EVIDENCE_DIRECTORY, "runtime-"));
  await Promise.all([
    mkdir(path.join(runtimeRoot, "appdata"), { recursive: true }),
    mkdir(path.join(runtimeRoot, "localappdata"), { recursive: true }),
    mkdir(path.join(runtimeRoot, "temp"), { recursive: true }),
  ]);
  let app: ElectronApplication | undefined;
  try {
    const candidateApp = await _electron.launch({
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
        MEDIAGO_CORE_PORT: String(CORE_PORT),
        APPDATA: path.join(runtimeRoot, "appdata"),
        LOCALAPPDATA: path.join(runtimeRoot, "localappdata"),
        TEMP: path.join(runtimeRoot, "temp"),
        TMP: path.join(runtimeRoot, "temp"),
      },
    });
    app = candidateApp;
    await expect
      .poll(
        () =>
          candidateApp
            .windows()
            .some((window) =>
              /^xiangying:\/\/index\.html\/(?:library)?$/.test(window.url()),
            ),
        { timeout: 15_000 },
      )
      .toBe(true);
    const page = candidateApp
      .windows()
      .find((window) =>
        /^xiangying:\/\/index\.html\/(?:library)?$/.test(window.url()),
      );
    if (!page) throw new Error("Current candidate library window did not open");
    // A persisted open-in-new-window transition can redirect the initial route to /source.
    // Always enter the library through the app's own navigation before asserting its UI.
    const libraryNavigation = page.getByRole("link", {
      name: "我的片库",
      exact: true,
    });
    await expect(libraryNavigation).toBeVisible();
    await libraryNavigation.click();
    await expect(page.getByRole("heading", { name: "我的片库" })).toBeVisible();
    const main = await candidateApp.evaluate(({ app: electronApp }) => ({
      pid: process.pid,
      executablePath: process.execPath,
      userDataPath: electronApp.getPath("userData"),
    }));
    expect(path.resolve(main.executablePath)).toBe(expectedExecutable);
    const identity = await readWindowsProcessIdentity(main.pid);
    if (!identity)
      throw new Error(
        "Candidate main process identity disappeared during startup",
      );
    const normalizedRoot =
      path.resolve(runtimeRoot).toLocaleLowerCase("en-US") + path.sep;
    expect(
      path
        .resolve(main.userDataPath)
        .toLocaleLowerCase("en-US")
        .startsWith(normalizedRoot),
    ).toBe(true);
    return {
      app: candidateApp,
      page,
      runtimeRoot,
      userDataPath: main.userDataPath,
      executablePath: expectedExecutable,
      identity,
    };
  } catch (error) {
    if (app) {
      await app
        .evaluate(({ app: electronApp }) => electronApp.quit())
        .catch(() => undefined);
      await app.close().catch(() => undefined);
    }
    await rm(runtimeRoot, { recursive: true, force: true });
    throw error;
  }
}

async function closeCandidate(running: StartedCandidate): Promise<void> {
  await running.app.evaluate(({ app }) => app.quit()).catch(() => undefined);
  await running.app.close().catch(() => undefined);
  if (!(await waitForWindowsProcessExit(running.identity, 8_000))) {
    await terminateOwnedWindowsProcess(running.identity);
    expect(await waitForWindowsProcessExit(running.identity, 5_000)).toBe(true);
  }
  await waitForPortFree("127.0.0.1", CORE_PORT, 10_000);
  await rm(running.runtimeRoot, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 300,
  });
}

test.skip(
  process.platform !== "win32",
  "candidate-bound library acceptance requires Windows",
);

test("current candidate sync imports only completed existing download outputs", async () => {
  test.setTimeout(180_000);
  const running = await startCandidate();
  const downloadRoot = path.join(running.runtimeRoot, "downloads");
  await mkdir(downloadRoot, { recursive: true });
  const sample = await readFile(SAMPLE_PATH);
  const sampleHash = digest(sample);
  let successfulHits = 0;
  let partialHits = 0;
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      if (request.url?.startsWith("/complete.mp4")) {
        successfulHits++;
        response.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": String(sample.length),
        });
        response.end(sample);
        return;
      }
      if (request.url?.startsWith("/partial.mp4")) {
        partialHits++;
        response.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": String(sample.length + 1024),
        });
        response.end(
          sample.subarray(0, Math.max(32, Math.floor(sample.length / 2))),
        );
        return;
      }
      response.writeHead(404).end();
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Local download fixture did not bind");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const appState = await running.page.evaluate(async () =>
      (
        window as Window & {
          electron?: { app?: { getEnvPath(): Promise<unknown> } };
        }
      ).electron?.app?.getEnvPath(),
    );
    const payload = appState as { code?: number; data?: { coreUrl?: string } };
    const coreURL = payload?.data?.coreUrl;
    if (!coreURL)
      throw new Error("Trusted Core URL was not available from the candidate");
    const client = trustedCoreClient(running.page, coreURL);
    expect((await client.setConfigKey("local", downloadRoot)).success).toBe(
      true,
    );
    expect((await client.setConfigKey("maxRunner", 1)).success).toBe(true);

    const collisionName = "review77-numbered-library-output";
    const reservedPath = path.join(downloadRoot, `${collisionName}.mp4`);
    await copyFile(SAMPLE_PATH, reservedPath);
    const created = await client.addDownloadTasks({
      startDownload: false,
      tasks: [
        { type: "direct", name: collisionName, url: `${origin}/complete.mp4` },
        {
          type: "direct",
          name: "review77-partial-library-output",
          url: `${origin}/partial.mp4`,
        },
        {
          type: "direct",
          name: "review77-missing-library-output",
          url: `${origin}/complete.mp4?missing`,
        },
      ],
    });
    expect(created.success).toBe(true);
    const fullId = created.data[0]?.id;
    const partialId = created.data[1]?.id;
    const missingId = created.data[2]?.id;
    if (!fullId || !partialId || !missingId)
      throw new Error("Fixture download tasks were not created");
    const started = await Promise.all(
      [fullId, partialId, missingId].map((id) =>
        client.startDownload(id, {
          localPath: downloadRoot,
          deleteSegments: false,
        }),
      ),
    );
    started.forEach((result) => expect(result.success).toBe(true));
    await expect
      .poll(async () => (await client.getDownloadTask(fullId)).data.status, {
        timeout: 60_000,
      })
      .toBe("success");
    await expect
      .poll(async () => (await client.getDownloadTask(missingId)).data.status, {
        timeout: 60_000,
      })
      .toBe("success");
    await expect
      .poll(async () => (await client.getDownloadTask(partialId)).data.status, {
        timeout: 60_000,
      })
      .toMatch(/failed|error|stopped/);
    const complete = (await client.getDownloadTask(fullId)).data;
    const partial = (await client.getDownloadTask(partialId)).data;
    const missing = (await client.getDownloadTask(missingId)).data;
    if (!complete.outputPath)
      throw new Error("Completed task has no output path");
    const outputPath = path.resolve(complete.outputPath);
    expect(path.dirname(outputPath)).toBe(path.resolve(downloadRoot));
    expect(path.basename(outputPath)).toBe(`${collisionName} (1).mp4`);
    expect(digest(await readFile(outputPath))).toBe(sampleHash);
    expect(partial.status).not.toBe("success");
    if (!missing.outputPath)
      throw new Error("Missing-file task lost its recorded path");
    const missingPath = path.resolve(missing.outputPath);
    await rm(missingPath, { force: true });
    expect(partialHits).toBeGreaterThan(0);

    const syncButton = running.page.getByRole("button", {
      name: "同步完整下载",
      exact: true,
    });
    await syncButton.click();
    const expectedTitle = path.basename(outputPath, path.extname(outputPath));
    const card = running.page.locator("article").filter({
      has: running.page.getByRole("heading", {
        name: expectedTitle,
        exact: true,
      }),
    });
    await expect(card).toBeVisible({ timeout: 15_000 });
    const libraryResult = unwrap<{
      items: Array<{ path: string; source: string }>;
    }>(
      await running.page.evaluate(async () => {
        const api = (window as Window & { electron?: { library?: LibraryApi } })
          .electron?.library;
        if (!api)
          throw new Error("Production preload library API is unavailable");
        return api.list();
      }),
    );
    expect(libraryResult.items).toHaveLength(1);
    expect(libraryResult.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: outputPath, source: "download" }),
      ]),
    );
    expect(libraryResult.items.some((item) => item.path === reservedPath)).toBe(
      false,
    );
    expect(
      libraryResult.items.some((item) => item.path === partial.outputPath),
    ).toBe(false);
    expect(libraryResult.items.some((item) => item.path === missingPath)).toBe(
      false,
    );

    // Removing a successfully downloaded runtime fixture must make its stale task path ineligible.
    expect(
      await stat(reservedPath).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
    await rm(outputPath, { force: true });
    await running.page
      .getByRole("button", { name: "同步完整下载", exact: true })
      .click();
    await expect(
      running.page.getByText("还没有可加入片库的本地完整下载。", {
        exact: true,
      }),
    ).toBeVisible();
    expect(successfulHits).toBeGreaterThan(0);
    await writeFile(
      path.join(EVIDENCE_DIRECTORY, `review77-library-sync-${Date.now()}.json`),
      JSON.stringify(
        {
          candidate: running.executablePath,
          mainPid: running.identity.pid,
          sampleSha256: sampleHash,
          successfulHits,
          partialHits,
          numberedOutput: outputPath,
          partialStatus: partial.status,
          missingPath,
          libraryPaths: libraryResult.items.map((item) => item.path),
          onlyExistingCompletedOutputImported: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeCandidate(running);
  }
});

test("current candidate filters all category and screening combinations and fails closed for missing or injected states", async () => {
  test.setTimeout(180_000);
  const running = await startCandidate();
  try {
    const mediaRoot = path.join(running.runtimeRoot, "library-fixtures");
    await mkdir(mediaRoot, { recursive: true });
    const combinations = [
      ["movie", true],
      ["movie", false],
      ["documentary", true],
      ["documentary", false],
      ["children", true],
      ["children", false],
      ["other", true],
      ["other", false],
    ] as const;
    const paths = await Promise.all(
      combinations.map(async ([category, screened], index) => {
        const fixturePath = path.join(
          mediaRoot,
          `review77-${category}-${screened ? "screened" : "unseen"}-${index}.mp4`,
        );
        await copyFile(SAMPLE_PATH, fixturePath);
        return fixturePath;
      }),
    );
    const imported = unwrap<{ items: Array<{ id: string; title: string }> }>(
      await running.page.evaluate(async (fixturePaths) => {
        const api = (window as Window & { electron?: { library?: LibraryApi } })
          .electron?.library;
        if (!api)
          throw new Error("Production preload library API is unavailable");
        return api.importFiles(fixturePaths, "import");
      }, paths),
    );
    expect(imported.items).toHaveLength(combinations.length);
    await Promise.all(
      imported.items.map(async (item, index) => {
        const combination = combinations[index];
        if (!combination)
          throw new Error("Filter fixture mapping is incomplete");
        unwrap(
          await running.page.evaluate(
            async ({ id, category, screened }) => {
              const api = (
                window as Window & { electron?: { library?: LibraryApi } }
              ).electron?.library;
              if (!api)
                throw new Error(
                  "Production preload library API is unavailable",
                );
              return api.update(id, { category, screened });
            },
            { id: item.id, category: combination[0], screened: combination[1] },
          ),
        );
      }),
    );
    await running.page
      .getByRole("button", { name: "刷新", exact: true })
      .click();
    const search = running.page.getByRole("textbox", {
      name: "搜索片名或标签",
    });
    await search.fill("review77-");
    const cards = running.page.locator("article");
    const categories = [
      ["全部分类", "all"],
      ["电影", "movie"],
      ["纪录片", "documentary"],
      ["儿童", "children"],
      ["其他", "other"],
    ] as const;
    const screenings = [
      ["全部状态", "all"],
      ["已放映", "true"],
      ["未放映", "false"],
    ] as const;
    const categoryFilter = running.page.getByRole("combobox", {
      name: "按分类筛选",
    });
    const screenedFilter = running.page.getByRole("combobox", {
      name: "按放映状态筛选",
    });
    // Native combobox choices are stateful and each selection must complete before the next.
    // oxlint-disable eslint/no-await-in-loop
    for (const [categoryLabel, categoryValue] of categories) {
      for (const [screeningLabel, screeningValue] of screenings) {
        await categoryFilter.click();
        await running.page
          .getByRole("option", { name: categoryLabel, exact: true })
          .click();
        await screenedFilter.click();
        await running.page
          .getByRole("option", { name: screeningLabel, exact: true })
          .click();
        const expected = combinations.filter(
          ([category, screened]) =>
            (categoryValue === "all" || category === categoryValue) &&
            (screeningValue === "all" || String(screened) === screeningValue),
        ).length;
        await expect(cards).toHaveCount(expected);
      }
    }
    // oxlint-enable eslint/no-await-in-loop
    await categoryFilter.click();
    await running.page
      .getByRole("option", { name: "全部分类", exact: true })
      .click();
    await screenedFilter.click();
    await running.page
      .getByRole("option", { name: "全部状态", exact: true })
      .click();
    await search.fill("no-such-review77-title");
    await expect(running.page.getByText("没有找到匹配的影片")).toBeVisible();
    await running.page.getByRole("button", { name: "清除筛选" }).click();
    await expect(cards).toHaveCount(combinations.length);

    const indexPath = path.join(running.userDataPath, "library-v1.json");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as {
      version: number;
      items: Array<{
        id: string;
        path: string;
        safety: {
          status: string;
          fingerprint?: string;
          checkedAt?: string;
          message?: string;
        };
      }>;
    };
    const stateFixturePath = paths[0];
    const item = imported.items[0];
    if (!stateFixturePath || !item) throw new Error("Safety fixture missing");
    const card = running.page.locator("article").filter({
      has: running.page.getByRole("heading", {
        name: item.title,
        exact: true,
      }),
    });
    await rm(stateFixturePath);
    await running.page
      .getByRole("button", { name: "刷新", exact: true })
      .click();
    await expect(card.getByText("文件已移走", { exact: true })).toBeVisible();
    await Promise.all(
      ["播放", "打开位置", "扫描"].map((label) =>
        expect(card.getByRole("button", { name: label })).toBeDisabled(),
      ),
    );
    await expect(
      card.getByRole("checkbox", { name: `选择${item.title}` }),
    ).toBeDisabled();
    await copyFile(SAMPLE_PATH, stateFixturePath);
    const stored = index.items.find((candidate) => candidate.id === item.id);
    if (!stored)
      throw new Error("Safety fixture row missing from isolated index");
    stored.safety = {
      status: "clean",
      checkedAt: "2000-01-01T00:00:00.000Z",
      fingerprint: digest(await readFile(stateFixturePath)),
    };
    await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n", "utf8");
    await writeFile(
      stateFixturePath,
      Buffer.concat([
        await readFile(stateFixturePath),
        Buffer.from(" changed after benign fixture fingerprint"),
      ]),
    );
    await running.page
      .getByRole("button", { name: "刷新", exact: true })
      .click();
    await expect(card.getByText("尚未扫描", { exact: true })).toBeVisible();
    const refreshedIndex = JSON.parse(
      await readFile(indexPath, "utf8"),
    ) as typeof index;
    const refreshedItem = refreshedIndex.items.find(
      (candidate) => candidate.id === item.id,
    );
    if (!refreshedItem)
      throw new Error("Safety fixture row vanished after refresh");
    refreshedItem.safety = {
      status: "blocked",
      checkedAt: "2000-01-01T00:00:00.000Z",
      message: "test-only injected blocked state",
    };
    await writeFile(
      indexPath,
      JSON.stringify(refreshedIndex, null, 2) + "\n",
      "utf8",
    );
    await running.page
      .getByRole("button", { name: "刷新", exact: true })
      .click();
    await expect(card.getByText("已阻止", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "播放" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "扫描" })).toBeDisabled();
    await expect(
      card.getByRole("checkbox", { name: `选择${item.title}` }),
    ).toBeDisabled();
    const playResult = await running.page.evaluate(async (id) => {
      const api = (window as Window & { electron?: { library?: LibraryApi } })
        .electron?.library;
      if (!api)
        throw new Error("Production preload library API is unavailable");
      try {
        return await api.play(id);
      } catch {
        return { rejected: true };
      }
    }, item.id);
    expect((playResult as { code?: number }).code).not.toBe(0);

    const layoutBefore = await running.app.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length !== 1)
        throw new Error("Candidate did not own exactly one window");
      const window = windows[0];
      if (!window) throw new Error("Candidate owner window was unavailable");
      window.setSize(1100, 680);
      return {
        id: window.id,
        bounds: window.getBounds(),
        minimum: window.getMinimumSize(),
      };
    });
    expect(layoutBefore.minimum[0]).toBe(1100);
    expect(layoutBefore.minimum[1]).toBe(680);
    expect(layoutBefore.bounds.width).toBeGreaterThanOrEqual(1100);
    expect(layoutBefore.bounds.height).toBeGreaterThanOrEqual(680);
    const layout = await running.page.evaluate(() => ({
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    await running.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Candidate owner window disappeared");
      window.minimize();
    });
    await expect
      .poll(() =>
        running.app.evaluate(({ BrowserWindow }) =>
          Boolean(BrowserWindow.getAllWindows()[0]?.isMinimized()),
        ),
      )
      .toBe(true);
    await running.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Candidate owner window disappeared");
      window.restore();
    });
    await expect
      .poll(() =>
        running.app.evaluate(({ BrowserWindow }) =>
          Boolean(BrowserWindow.getAllWindows()[0]?.isMinimized()),
        ),
      )
      .toBe(false);
    await expect(
      running.page.getByRole("heading", { name: "我的片库" }),
    ).toBeVisible();
    await writeFile(
      path.join(
        EVIDENCE_DIRECTORY,
        `review77-library-state-${Date.now()}.json`,
      ),
      JSON.stringify(
        {
          candidate: running.executablePath,
          mainPid: running.identity.pid,
          specificFilterMatrixCount: 4 * 2,
          allSelectorCombinationChecks: categories.length * screenings.length,
          missingActionsDisabled: true,
          changedFingerprintShownUnscanned: true,
          blockedPlayRejected: true,
          realDefenderInvoked: false,
          windowMinimumBounds: layoutBefore,
          minimizedAndRestoredOwnedWindow: true,
          horizontalOverflow: layout.documentWidth > layout.viewportWidth,
        },
        null,
        2,
      ),
    );
  } finally {
    await closeCandidate(running);
  }
});
