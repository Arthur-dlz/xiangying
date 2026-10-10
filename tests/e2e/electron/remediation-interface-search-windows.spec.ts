import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  _electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import type { PlatformApi } from "../../../packages/common/src/types/index.ts";
import { IPC } from "../../../packages/common/src/constants/events.ts";
import { trustedCoreClient } from "../support/xiangying-core-client.ts";
import { scrubElectronEnvironment } from "../support/electron-network.ts";
import { assertPortFree, waitForPortFree } from "../support/ports.ts";
import {
  readWindowsProcessIdentity,
  waitForWindowsProcessExit,
  type WindowsProcessIdentity,
} from "../support/xiangying-windows-process.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const EVIDENCE = path.join(ROOT, ".task/remediation-20261006/interface/search");
const BINDING_PATH = path.resolve(
  process.env.MEDIAGO_REMEDIATION_BINDING ||
    path.join(ROOT, ".task/remediation-20261006/root/candidate-binding.json"),
);
const CORE_PORT = Number(process.env.MEDIAGO_CORE_PORT || 39_939);
const SAMPLE_PATH = path.join(ROOT, "tests/media-service/public/v1/sample.mp4");

declare global {
  interface Window {
    electron: PlatformApi;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function unwrap<T>(value: unknown): T {
  if (typeof value !== "object" || value === null)
    throw new Error("Electron app API returned no result");
  const envelope = value as { code?: number; data?: T; message?: string };
  if (envelope.code !== 0)
    throw new Error(
      `Electron app API failed: ${envelope.message ?? envelope.code}`,
    );
  return envelope.data as T;
}

function isMainPage(window: Page): boolean {
  if (window.isClosed()) return false;
  try {
    const url = new URL(window.url());
    return (
      url.protocol === "xiangying:" &&
      url.hostname === "index.html" &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
}

async function mainPage(application: ElectronApplication): Promise<Page> {
  await expect.poll(() => application.windows().some(isMainPage)).toBe(true);
  const page = application.windows().find(isMainPage);
  if (!page) throw new Error("Candidate main window was not found");
  return page;
}

async function sampleServer(): Promise<{
  origin: string;
  hash: string;
  hits(): number;
  close(): Promise<void>;
}> {
  const sample = await readFile(SAMPLE_PATH);
  let hits = 0;
  const server = createServer((request, response) => {
    if (
      new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/sample.mp4"
    ) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "GET") hits += 1;
    response.writeHead(200, {
      "content-type": "video/mp4",
      "content-length": String(sample.length),
      "accept-ranges": "none",
    });
    response.end(request.method === "HEAD" ? undefined : sample);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Search media fixture did not bind loopback");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    hash: sha256(sample),
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test.skip(
  process.platform !== "win32",
  "candidate search acceptance is Windows-only",
);

test("search cancel creates no task and explicit confirmation submits one selected local fixture", async () => {
  test.setTimeout(120_000);
  await mkdir(EVIDENCE, { recursive: true });
  const testSourceSha256 = sha256(
    await readFile(fileURLToPath(import.meta.url)),
  );
  await assertPortFree(
    "127.0.0.1",
    CORE_PORT,
    "interface search candidate Core",
  );
  const binding = JSON.parse(await readFile(BINDING_PATH, "utf8")) as {
    candidate: string;
    asarSha256: string;
    coreSha256: string;
  };
  const candidate = path.resolve(binding.candidate);
  const executable = path.join(candidate, "乡映.exe");
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    executable,
  );
  expect(
    sha256(await readFile(path.join(candidate, "resources/app.asar"))),
  ).toBe(binding.asarSha256);
  expect(
    sha256(
      await readFile(path.join(candidate, "resources/bin/mediago-core.exe")),
    ),
  ).toBe(binding.coreSha256);

  const fixture = await sampleServer();
  const runtimeRoot = await mkdtemp(path.join(EVIDENCE, "runtime-"));
  const tempDir = path.join(runtimeRoot, "temp");
  await Promise.all([
    mkdir(path.join(runtimeRoot, "appdata"), { recursive: true }),
    mkdir(path.join(runtimeRoot, "localappdata"), { recursive: true }),
    mkdir(tempDir, { recursive: true }),
  ]);
  let application: ElectronApplication | undefined;
  let owner: WindowsProcessIdentity | undefined;
  let passed = false;
  let zeroRowsAfterDeselect = false;
  let zeroRowsAfterClosingSelectedPicker = false;
  let createdTaskId: number | undefined;
  let outputSha256: string | undefined;
  let duplicateFeedback: string | undefined;
  let processExited = false;
  let corePortFreed = false;
  let runtimeRootRemoved = false;
  let selectedMainPageUrl: string | undefined;
  let observedPageUrls: string[] = [];
  try {
    application = await _electron.launch({
      executablePath: executable,
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
        TEMP: tempDir,
        TMP: tempDir,
      },
    });
    owner = await readWindowsProcessIdentity(application.process().pid!);
    if (!owner)
      throw new Error("Candidate process identity could not be verified");
    const shellPage = await mainPage(application);
    const envPath = unwrap<{ coreUrl: string }>(
      await shellPage.evaluate(() => window.electron.app.getEnvPath()),
    );
    if (!envPath.coreUrl) throw new Error("Candidate Core URL was unavailable");
    const client = trustedCoreClient(shellPage, envPath.coreUrl);
    await client.setConfig({
      language: "zh",
    });
    const downloadsDirectory = path.join(runtimeRoot, "downloads");
    await mkdir(downloadsDirectory, { recursive: true });
    expect(
      (await client.setConfigKey("local", downloadsDirectory)).success,
    ).toBe(true);
    await shellPage.reload();

    const mediaURL = `${fixture.origin}/sample.mp4`;
    await application.evaluate(
      (
        { ipcMain },
        { listProviders, saveProviders, search, cancel, episodeURL },
      ) => {
        ipcMain.removeHandler(listProviders);
        ipcMain.handle(listProviders, async () => [
          {
            id: "remediation-local",
            name: "受控本地夹具",
            apiUrl: "https://fixture.invalid/api.php",
            enabled: true,
          },
        ]);
        ipcMain.removeHandler(saveProviders);
        ipcMain.handle(saveProviders, async (_event, providers) => providers);
        ipcMain.removeHandler(search);
        ipcMain.handle(search, async (_event, keyword, page) => {
          if (keyword === "取消中的搜索") {
            return new Promise((resolve) => {
              (
                globalThis as typeof globalThis & {
                  __releaseRemediationSearch?: (value: unknown) => void;
                }
              ).__releaseRemediationSearch = resolve;
            });
          }
          return {
            keyword,
            page: page ?? 1,
            items: [
              {
                id: "fixture-search-item",
                providerId: "remediation-local",
                providerName: "受控本地夹具",
                title: "受控影片",
                year: "2026",
                language: "中文",
                quality: "1080p",
                episodes: [
                  {
                    name: "测试直链",
                    url: episodeURL,
                    kind: "direct",
                  },
                ],
              },
            ],
            errors: [],
            hasMore: false,
          };
        });
        ipcMain.removeHandler(cancel);
        ipcMain.handle(cancel, async () => undefined);
      },
      {
        episodeURL: mediaURL,
        listProviders: IPC.resourceSearch.listProviders,
        saveProviders: IPC.resourceSearch.saveProviders,
        search: IPC.resourceSearch.search,
        cancel: IPC.resourceSearch.cancel,
      },
    );
    const page = await mainPage(application);
    selectedMainPageUrl = page.url();
    observedPageUrls = application.windows().map((window) => window.url());
    await page.getByRole("link", { name: /找视频/ }).click();
    expect(
      (await client.getDownloadTasks({ current: 1, pageSize: 100 })).data.total,
    ).toBe(0);

    const searchInput = page.getByRole("textbox", { name: "搜索影视名称" });
    await searchInput.fill("取消中的搜索");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await application.evaluate(() => {
      // Release the old search only after cancellation to exercise stale-result suppression.
      const release = (
        globalThis as typeof globalThis & {
          __releaseRemediationSearch?: (value: unknown) => void;
        }
      ).__releaseRemediationSearch;
      release?.({
        keyword: "取消中的搜索",
        page: 1,
        items: [],
        errors: [],
        hasMore: false,
      });
      delete (
        globalThis as typeof globalThis & {
          __releaseRemediationSearch?: (value: unknown) => void;
        }
      ).__releaseRemediationSearch;
    });
    await expect(page.getByText("取消中的搜索", { exact: false })).toHaveCount(
      0,
    );
    expect(
      (await client.getDownloadTasks({ current: 1, pageSize: 100 })).data.total,
    ).toBe(0);
    await searchInput.fill("受控影片");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.getByRole("heading", { name: "受控影片" })).toBeVisible();
    await page.getByRole("button", { name: "选择地址（1）" }).click();
    const episode = page.getByLabel("测试直链");
    await episode.check();
    await expect(page.getByText("已选择 1 个可下载地址")).toBeVisible();
    await episode.uncheck();
    await expect(page.getByText("已选择 1 个可下载地址")).toHaveCount(0);
    await page.getByRole("button", { name: "收起选集", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "选择地址（1）", exact: true }),
    ).toBeVisible();
    expect(
      (await client.getDownloadTasks({ current: 1, pageSize: 100 })).data.total,
    ).toBe(0);
    zeroRowsAfterDeselect = true;

    await page
      .getByRole("button", { name: "选择地址（1）", exact: true })
      .click();
    await episode.check();
    await expect(page.getByText("已选择 1 个可下载地址")).toBeVisible();
    await page.getByRole("button", { name: "收起选集", exact: true }).click();
    expect(
      (await client.getDownloadTasks({ current: 1, pageSize: 100 })).data.list,
    ).toHaveLength(0);
    zeroRowsAfterClosingSelectedPicker = true;
    await page
      .getByRole("button", { name: "选择地址（1）", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "加入下载任务" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "加入下载任务" }).click();
    await expect(page.getByRole("status")).toContainText("已加入下载任务");
    await expect
      .poll(
        async () =>
          (await client.getDownloadTasks({ current: 1, pageSize: 100 })).data
            .total,
      )
      .toBe(1);
    const tasks = (await client.getDownloadTasks({ current: 1, pageSize: 100 }))
      .data.list;
    const [created] = tasks;
    if (!created)
      throw new Error("Real Core did not persist the selected episode");
    createdTaskId = created.id;
    expect(created.url).toBe(mediaURL);
    await expect
      .poll(
        async () => (await client.getDownloadTask(created.id)).data.status,
        {
          timeout: 45_000,
        },
      )
      .toBe("success");
    const completed = (await client.getDownloadTask(created.id)).data;
    if (!completed.outputPath)
      throw new Error("Completed task has no output path");
    outputSha256 = sha256(await readFile(completed.outputPath));
    expect(outputSha256).toBe(fixture.hash);
    expect(fixture.hits()).toBeGreaterThan(0);

    await episode.check();
    await page.getByRole("button", { name: "加入下载任务" }).click();
    const duplicateAlert = page.getByRole("alert");
    await expect(duplicateAlert).toContainText(/URL 已存在|URL already exists/);
    duplicateFeedback = await duplicateAlert.innerText();
    const afterDuplicate = (
      await client.getDownloadTasks({ current: 1, pageSize: 100 })
    ).data;
    expect(afterDuplicate.total).toBe(1);
    const duplicateRows = afterDuplicate.list;
    expect(duplicateRows).toHaveLength(1);
    expect(duplicateRows[0]).toMatchObject({ id: created.id, url: mediaURL });
    passed = true;
  } finally {
    await fixture.close();
    if (application) await application.close().catch(() => undefined);
    if (owner) {
      processExited = await waitForWindowsProcessExit(owner, 10_000);
      expect(processExited).toBe(true);
    }
    await waitForPortFree("127.0.0.1", CORE_PORT, 10_000);
    corePortFreed = true;
    if (passed) {
      await rm(runtimeRoot, { recursive: true, force: true });
      runtimeRootRemoved = true;
    }
    await writeFile(
      path.join(EVIDENCE, "search-real-core-candidate-run.json"),
      JSON.stringify(
        {
          candidateBinding: BINDING_PATH,
          candidatePath: candidate,
          coreSha256: binding.coreSha256,
          asarSha256: binding.asarSha256,
          testSourceSha256,
          corePort: CORE_PORT,
          ownerProcessIdentity: owner,
          selectedMainPageUrl,
          observedPageUrls,
          processExited,
          corePortFreed,
          runtimeRootRemoved,
          zeroRowsAfterDeselect,
          zeroRowsAfterClosingSelectedPicker,
          selectedEpisodeUrl: `${fixture.origin}/sample.mp4`,
          sampleSha256: fixture.hash,
          createdTaskId,
          outputSha256,
          duplicateFeedback,
          passed,
        },
        null,
        2,
      ),
      "utf8",
    );
  }
});
