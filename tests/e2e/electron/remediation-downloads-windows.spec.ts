import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
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
import { scrubElectronEnvironment } from "../support/regression-downloads-electron-network.ts";
import { assertPortFree, reserveLoopbackPort } from "../support/ports.ts";
import { trustedCoreClient } from "../support/xiangying-core-client.ts";
import {
  readWindowsProcessIdentity,
  waitForWindowsProcessExit,
  type WindowsProcessIdentity,
} from "../support/xiangying-windows-process.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BINDING_PATH = (() => {
  const override = process.env.MEDIAGO_REMEDIATION_BINDING;
  if (!override)
    return path.join(
      ROOT,
      ".task/remediation-20261006/root/candidate-binding.json",
    );
  if (!path.isAbsolute(override))
    throw new Error("MEDIAGO_REMEDIATION_BINDING must be an absolute path");
  return override;
})();
const SAMPLE_PATH = path.join(ROOT, "tests/media-service/public/v1/sample.mp4");
const EVIDENCE_DIR = path.join(ROOT, ".task/remediation-20261006/downloads");

interface CandidateBinding {
  candidate: string;
  coreSha256: string;
  asarSha256: string;
}

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

async function startCandidate(
  executablePath: string,
  runtimeRoot: string,
  corePort: number,
): Promise<{
  application: ElectronApplication;
  page: Page;
  owner: WindowsProcessIdentity;
}> {
  const application = await _electron.launch({
    executablePath,
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
  const owner = await readWindowsProcessIdentity(
    await application.evaluate(() => process.pid),
  );
  if (!owner) throw new Error("candidate Electron owner exited at startup");
  await expect
    .poll(
      () =>
        application
          .windows()
          .some((window) => window.url().startsWith("xiangying://index.html")),
      { timeout: 15_000 },
    )
    .toBe(true);
  const page = application
    .windows()
    .find((window) => window.url().startsWith("xiangying://index.html"));
  if (!page) throw new Error("candidate main window not found");
  return { application, page, owner };
}

async function getClient(page: Page) {
  const appEnv = await page.evaluate(async () =>
    (
      window as Window & {
        electron?: { app?: { getEnvPath(): Promise<unknown> } };
      }
    ).electron?.app?.getEnvPath(),
  );
  const coreURL = coreURLFromIpc(appEnv);
  if (!coreURL) throw new Error("trusted candidate Core URL unavailable");
  return trustedCoreClient(page, coreURL);
}

async function listenLoopback(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("local download fixture did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function closeCandidate(
  application: ElectronApplication | undefined,
  owner: WindowsProcessIdentity | undefined,
) {
  if (application) await application.close().catch(() => undefined);
  if (owner)
    expect(
      await waitForWindowsProcessExit(owner, 10_000),
      "owned candidate Electron process exited after close",
    ).toBe(true);
}

test.skip(
  process.platform !== "win32",
  "candidate-bound Windows download remediation checks",
);

test("candidate queue retry/stop, library import, filters, pagination, and text export", async () => {
  test.setTimeout(180_000);
  const binding = JSON.parse(
    await readFile(BINDING_PATH, "utf8"),
  ) as CandidateBinding;
  expect(path.isAbsolute(BINDING_PATH)).toBe(true);
  const expectedExecutable = path.join(binding.candidate, "乡映.exe");
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    path.resolve(expectedExecutable),
  );

  const runtimeRoot = await mkdtemp(path.join(EVIDENCE_DIR, "runtime-queue-"));
  const downloads = path.join(runtimeRoot, "downloads");
  await Promise.all(
    ["appdata", "localappdata", "temp", "downloads"].map((name) =>
      mkdir(path.join(runtimeRoot, name), { recursive: true }),
    ),
  );
  const media = await readFile(SAMPLE_PATH);
  const sampleHash = createHash("sha256").update(media).digest("hex");
  const dummyQueryToken = "remediation-query-token-dummy";
  let retryReady = false;
  let retryHits = 0;
  let pendingHits = 0;
  let heldResponse: ServerResponse | undefined;
  let holdActive = true;
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const pathname = new URL(request.url || "/", "http://fixture").pathname;
      if (pathname === "/retry.mp4") {
        retryHits++;
        if (!retryReady) {
          response.writeHead(404).end();
          return;
        }
      } else if (pathname === "/active.mp4" && holdActive) {
        heldResponse = response;
        response.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": String(media.length),
          "Accept-Ranges": "bytes",
        });
        response.write(media.subarray(0, 1));
        return;
      } else if (pathname === "/pending.mp4") {
        pendingHits++;
      } else if (!pathname.startsWith("/page-")) {
        response.writeHead(404).end();
        return;
      }
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || "");
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
      response.end(media.subarray(start, end + 1));
    },
  );
  const origin = await listenLoopback(server);
  const retryURL = `${origin}/retry.mp4?token=${dummyQueryToken}`;
  const retryURLWithoutQuery = retryURL.slice(0, retryURL.indexOf("?"));
  const corePort = process.env.MEDIAGO_CORE_PORT
    ? Number(process.env.MEDIAGO_CORE_PORT)
    : await reserveLoopbackPort();
  let application: ElectronApplication | undefined;
  let owner: WindowsProcessIdentity | undefined;
  try {
    const started = await startCandidate(
      expectedExecutable,
      runtimeRoot,
      corePort,
    );
    application = started.application;
    owner = started.owner;
    const activeApplication = started.application;
    const page = started.page;
    const client = await getClient(page);
    expect((await client.setConfigKey("local", downloads)).success).toBe(true);
    expect((await client.setConfigKey("maxRunner", 1)).success).toBe(true);
    const persistedLanguage = (await client.getConfig()).data.language;
    expect(persistedLanguage).toBe("zh");
    const initialURL = new URL(page.url());
    expect(initialURL.protocol).toBe("xiangying:");
    expect(initialURL.hostname).toBe("index.html");
    expect(initialURL.pathname).toBe("/");
    const sidebarResizeHandle = page.getByRole("separator", {
      name: "调整侧边栏宽度",
    });
    const sidebarValue =
      await sidebarResizeHandle.getAttribute("aria-valuetext");
    expect(sidebarValue).not.toBe("侧边栏已收起");
    await expect(page.getByRole("link", { name: /下载任务/ })).toBeVisible();

    const retryCreated = await client.addDownloadTasks({
      startDownload: false,
      tasks: [
        {
          type: "direct",
          name: "remediation-retry",
          url: retryURL,
        },
      ],
    });
    expect(retryCreated.success).toBe(true);
    const retryTaskCreated = retryCreated.data[0];
    if (!retryTaskCreated) throw new Error("retry task was not created");
    const retryId = retryTaskCreated.id;
    expect(
      (
        await client.startDownload(retryId, {
          localPath: downloads,
          deleteSegments: false,
        })
      ).success,
    ).toBe(true);
    await expect
      .poll(async () => (await client.getDownloadTask(retryId)).data.status, {
        timeout: 20_000,
      })
      .toMatch(/failed|error/);
    const failedLogs = (await client.getDownloadLogs(retryId)).data.log;
    expect(failedLogs.length).toBeGreaterThan(0);
    expect(failedLogs).toContain(retryURLWithoutQuery);
    expect(failedLogs).not.toContain(dummyQueryToken);
    retryReady = true;
    expect(
      (
        await client.startDownload(retryId, {
          localPath: downloads,
          deleteSegments: false,
        })
      ).success,
    ).toBe(true);
    await expect
      .poll(async () => (await client.getDownloadTask(retryId)).data.status, {
        timeout: 45_000,
      })
      .toBe("success");
    const retryTask = (await client.getDownloadTask(retryId)).data;
    expect(retryTask.outputPath).toBeTruthy();
    if (!retryTask.outputPath)
      throw new Error("successful retry has no output path");
    const successfulLogs = (await client.getDownloadLogs(retryId)).data.log;
    expect(successfulLogs.length).toBeGreaterThan(0);
    expect(successfulLogs).not.toContain(dummyQueryToken);
    expect(
      createHash("sha256")
        .update(await readFile(retryTask.outputPath))
        .digest("hex"),
    ).toBe(sampleHash);
    expect(retryHits).toBeGreaterThanOrEqual(2);

    const activeAndPending = await client.addDownloadTasks({
      startDownload: false,
      tasks: [
        {
          type: "direct",
          name: "remediation-active",
          url: `${origin}/active.mp4`,
        },
        {
          type: "direct",
          name: "remediation-pending",
          url: `${origin}/pending.mp4`,
        },
      ],
    });
    expect(activeAndPending.success).toBe(true);
    const [activeId, pendingId] = activeAndPending.data.map((task) => task.id);
    if (!activeId || !pendingId)
      throw new Error("active and pending fixtures were not created");
    expect(
      (
        await client.startDownload(activeId, {
          localPath: downloads,
          deleteSegments: false,
        })
      ).success,
    ).toBe(true);
    await expect
      .poll(async () => (await client.getDownloadTask(activeId)).data.status, {
        timeout: 15_000,
      })
      .toBe("downloading");
    expect(
      (
        await client.startDownload(pendingId, {
          localPath: downloads,
          deleteSegments: false,
        })
      ).success,
    ).toBe(true);
    expect((await client.stopDownload(pendingId)).success).toBe(true);
    await expect
      .poll(async () => (await client.getDownloadTask(pendingId)).data.status, {
        timeout: 15_000,
      })
      .toMatch(/stopped|failed/);
    expect(pendingHits).toBe(0);
    expect((await client.stopDownload(activeId)).success).toBe(true);
    holdActive = false;
    heldResponse?.destroy();
    await expect
      .poll(async () => (await client.getDownloadTask(activeId)).data.status, {
        timeout: 15_000,
      })
      .toMatch(/stopped|failed/);
    await expect
      .poll(async () =>
        (await readdir(downloads)).some((name) =>
          name.startsWith(".mediago-stage-"),
        ),
      )
      .toBe(false);

    const pageTasks = await client.addDownloadTasks({
      startDownload: false,
      tasks: Array.from({ length: 21 }, (_, index) => ({
        type: "direct",
        name: `remediation-page-${String(index + 1).padStart(2, "0")}`,
        url: `${origin}/page-${index + 1}.mp4`,
      })),
    });
    expect(pageTasks.success).toBe(true);
    const pendingPage = await client.getDownloadTasks({
      current: 1,
      pageSize: 20,
      filter: "list",
      localPath: downloads,
    });
    expect(pendingPage.success).toBe(true);
    expect(pendingPage.data.total).toBeGreaterThanOrEqual(21);
    expect(pendingPage.data.list).toHaveLength(20);
    const completedPage = await client.getDownloadTasks({
      current: 1,
      pageSize: 5,
      filter: "done",
      localPath: downloads,
    });
    expect(completedPage.data.list.some((task) => task.id === retryId)).toBe(
      true,
    );

    await page.getByRole("link", { name: /下载任务/ }).click();
    await page.getByRole("link", { name: /已完成/ }).click();
    await expect(
      page.getByText("remediation-retry", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "播放视频" }).first().click();
    const imported = await page.evaluate(async (outputPath) => {
      const api = (
        window as unknown as {
          electron?: {
            library?: {
              list(): Promise<{
                code?: number;
                data?: { items?: Array<{ path: string }> };
              }>;
            };
          };
        }
      ).electron?.library;
      const result = await api?.list();
      if (!result || result.code !== 0) return 0;
      return (
        result.data?.items?.filter((item) => item.path === outputPath).length ??
        0
      );
    }, retryTask.outputPath);
    expect(imported).toBe(1);

    await page.getByRole("link", { name: /待完成/ }).click();
    await expect(page.getByRole("navigation", { name: "分页" })).toBeVisible();
    await page.getByRole("button", { name: "下一页" }).click();
    await expect(page.getByRole("button", { name: "第 2 页" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.getByRole("button", { name: "更多" }).click();
    const exportPath = path.join(runtimeRoot, "downloads-export.txt");
    await activeApplication.evaluate(({ dialog }, targetPath) => {
      const state = globalThis as typeof globalThis & {
        remediationExportDialogCalls?: number;
      };
      state.remediationExportDialogCalls = 0;
      dialog.showSaveDialog = async () => {
        state.remediationExportDialogCalls =
          (state.remediationExportDialogCalls ?? 0) + 1;
        return { canceled: false, filePath: targetPath };
      };
    }, exportPath);
    await page.getByRole("menuitem", { name: "导出下载列表" }).click();
    await expect
      .poll(() =>
        activeApplication.evaluate(() => {
          const state = globalThis as typeof globalThis & {
            remediationExportDialogCalls?: number;
          };
          return state.remediationExportDialogCalls ?? 0;
        }),
      )
      .toBe(1);
    await expect
      .poll(async () => {
        try {
          await access(exportPath);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(true);
    const exported = await readFile(exportPath, "utf8");
    expect(exported).toContain("remediation-retry");
    await writeFile(
      path.join(EVIDENCE_DIR, "remediation-queue-ui.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          persistedLanguage,
          initialRoute: initialURL.pathname,
          sidebarExpanded: true,
          directRetrySourceHits: retryHits,
          pendingStopSourceHits: pendingHits,
          retriedOutputSha256: sampleHash,
          dummyQueryTokenAbsentFromFailedLogs:
            !failedLogs.includes(dummyQueryToken),
          dummyQueryTokenAbsentFromSuccessfulLogs:
            !successfulLogs.includes(dummyQueryToken),
          libraryEntryCount: imported,
          pendingPageTotal: pendingPage.data.total,
          pendingPageSize: pendingPage.data.list.length,
          completedFilterContainsRetry: completedPage.data.list.some(
            (task) => task.id === retryId,
          ),
          exportedTextContainsRetry: exported.includes("remediation-retry"),
        },
        null,
        2,
      ),
    );
  } finally {
    const ownerAtShutdown = owner;
    await closeCandidate(application, owner);
    await assertPortFree(
      "127.0.0.1",
      corePort,
      "remediation downloads Core cleanup",
    );
    await writeFile(
      path.join(EVIDENCE_DIR, "remediation-queue-cleanup.json"),
      JSON.stringify(
        {
          runtimeOwnerPid: ownerAtShutdown?.pid,
          runtimeOwnerCreationFileTime: ownerAtShutdown?.creationFileTime,
          corePort,
          ownedProcessExited: true,
          corePortFree: true,
        },
        null,
        2,
      ),
    );
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("candidate interrupted download can be retried after process restart", async () => {
  test.setTimeout(150_000);
  const binding = JSON.parse(
    await readFile(BINDING_PATH, "utf8"),
  ) as CandidateBinding;
  expect(path.isAbsolute(BINDING_PATH)).toBe(true);
  const expectedExecutable = path.join(binding.candidate, "乡映.exe");
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    path.resolve(expectedExecutable),
  );
  const runtimeRoot = await mkdtemp(
    path.join(EVIDENCE_DIR, "runtime-restart-"),
  );
  const downloads = path.join(runtimeRoot, "downloads");
  await Promise.all(
    ["appdata", "localappdata", "temp", "downloads"].map((name) =>
      mkdir(path.join(runtimeRoot, name), { recursive: true }),
    ),
  );
  const media = await readFile(SAMPLE_PATH);
  const expectedHash = createHash("sha256").update(media).digest("hex");
  let release = false;
  let requestHits = 0;
  let heldResponse: ServerResponse | undefined;
  const server = createServer(
    (_request: IncomingMessage, response: ServerResponse) => {
      requestHits++;
      if (!release) {
        heldResponse = response;
        response.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": String(media.length),
        });
        response.write(media.subarray(0, Math.min(32_768, media.length)));
        return;
      }
      response.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": String(media.length),
      });
      response.end(media);
    },
  );
  const origin = await listenLoopback(server);
  const corePort = process.env.MEDIAGO_CORE_PORT
    ? Number(process.env.MEDIAGO_CORE_PORT)
    : await reserveLoopbackPort();
  let application: ElectronApplication | undefined;
  let owner: WindowsProcessIdentity | undefined;
  try {
    const first = await startCandidate(
      expectedExecutable,
      runtimeRoot,
      corePort,
    );
    application = first.application;
    owner = first.owner;
    let client = await getClient(first.page);
    expect((await client.setConfigKey("local", downloads)).success).toBe(true);
    const created = await client.addDownloadTasks({
      startDownload: false,
      tasks: [
        {
          type: "direct",
          name: "remediation-restart-retry",
          url: `${origin}/interrupted.mp4`,
        },
      ],
    });
    expect(created.success).toBe(true);
    const task = created.data[0];
    if (!task) throw new Error("restart task was not created");
    expect(
      (
        await client.startDownload(task.id, {
          localPath: downloads,
          deleteSegments: false,
        })
      ).success,
    ).toBe(true);
    await expect
      .poll(async () => (await client.getDownloadTask(task.id)).data.status, {
        timeout: 20_000,
      })
      .toBe("downloading");
    await expect
      .poll(() => requestHits, { timeout: 10_000 })
      .toBeGreaterThan(0);

    await closeCandidate(application, owner);
    application = undefined;
    owner = undefined;
    await assertPortFree(
      "127.0.0.1",
      corePort,
      "first remediation Core shutdown",
    );
    heldResponse?.destroy();
    release = true;

    const restarted = await startCandidate(
      expectedExecutable,
      runtimeRoot,
      corePort,
    );
    application = restarted.application;
    owner = restarted.owner;
    const restartOwner = restarted.owner;
    client = await getClient(restarted.page);
    expect(
      (
        await client.startDownload(task.id, {
          localPath: downloads,
          deleteSegments: false,
        })
      ).success,
    ).toBe(true);
    await expect
      .poll(async () => (await client.getDownloadTask(task.id)).data.status, {
        timeout: 60_000,
      })
      .toBe("success");
    const recovered = (await client.getDownloadTask(task.id)).data;
    if (!recovered.outputPath)
      throw new Error("recovered task has no published output path");
    const outputHash = createHash("sha256")
      .update(await readFile(recovered.outputPath))
      .digest("hex");
    expect(outputHash).toBe(expectedHash);
    const remainingStages = (await readdir(downloads)).filter((name) =>
      name.startsWith(".mediago-stage-"),
    );
    expect(remainingStages).toEqual([]);
    await writeFile(
      path.join(EVIDENCE_DIR, "remediation-restart-retry.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          runtimeOwnerPid: restartOwner.pid,
          runtimeOwnerCreationFileTime: restartOwner.creationFileTime,
          corePort,
          attempts: requestHits,
          taskId: task.id,
          status: recovered.status,
          outputHash,
          remainingStageDirectories: remainingStages,
        },
        null,
        2,
      ),
    );
  } finally {
    const ownerAtShutdown = owner;
    await closeCandidate(application, owner);
    await assertPortFree(
      "127.0.0.1",
      corePort,
      "remediation restart Core cleanup",
    );
    await writeFile(
      path.join(EVIDENCE_DIR, "remediation-restart-cleanup.json"),
      JSON.stringify(
        {
          runtimeOwnerPid: ownerAtShutdown?.pid,
          runtimeOwnerCreationFileTime: ownerAtShutdown?.creationFileTime,
          corePort,
          ownedProcessExited: true,
          corePortFree: true,
        },
        null,
        2,
      ),
    );
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
