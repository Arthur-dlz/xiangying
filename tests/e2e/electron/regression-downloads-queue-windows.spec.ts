import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
  waitForWindowsProcessExit,
  type WindowsProcessIdentity,
} from "../support/xiangying-windows-process.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const EXE = path.join(ROOT, "apps/electron/release-slim/win-unpacked/乡映.exe");

test.skip(
  process.platform !== "win32",
  "Windows packaged candidate acceptance",
);

// oxlint-disable-next-line no-empty-pattern -- Playwright requires the fixture parameter to be destructured.
test("乡映 queue concurrency, stop/restart, retry and interrupted restart recovery", async ({}, testInfo) => {
  test.setTimeout(200_000);
  if (
    path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "") !==
    path.resolve(EXE)
  ) {
    throw new Error(
      "XIANGYING_E2E_EXECUTABLE must be the frozen release-slim candidate",
    );
  }
  const runtimeRoot = await mkdtemp(
    path.join(
      ROOT,
      ".task/regression-20261006/downloads/runtime/xiangying-queue-e2e-",
    ),
  );
  const sample = await readFile(
    path.join(ROOT, "tests/media-service/public/v1/sample.mp4"),
  );
  const active = new Set<string>();
  const held = new Map<string, () => void>();
  let release = false;
  let fail = true;
  const source = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    if (url.pathname === "/retry.mp4" && fail) {
      response.writeHead(404).end();
      return;
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2]
      ? Math.min(Number(range[2]), sample.length - 1)
      : sample.length - 1;
    response.writeHead(range ? 206 : 200, {
      "Content-Type": "video/mp4",
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      ...(range
        ? { "Content-Range": `bytes ${start}-${end}/${sample.length}` }
        : {}),
    });
    active.add(url.pathname);
    response.once("close", () => {
      active.delete(url.pathname);
      held.delete(url.pathname);
    });
    if (release || url.pathname === "/retry.mp4")
      response.end(sample.subarray(start, end + 1));
    else {
      const initial = Math.min(start + 256, end + 1);
      response.write(sample.subarray(start, initial));
      held.set(url.pathname, () =>
        response.end(sample.subarray(initial, end + 1)),
      );
    }
  });
  await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
  const address = source.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture server did not bind");
  const origin = `http://127.0.0.1:${address.port}`;
  let application: ElectronApplication | undefined;
  let identity: WindowsProcessIdentity | undefined;
  let passed = false;
  const launch = async (): Promise<Page> => {
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
      .poll(() =>
        application
          ?.windows()
          .some((page) =>
            /^xiangying:\/\/index.html\/(?:library)?$/.test(page.url()),
          ),
      )
      .toBe(true);
    const page = application
      .windows()
      .find((entry) =>
        /^xiangying:\/\/index.html\/(?:library)?$/.test(entry.url()),
      );
    if (!page) throw new Error("App page not found");
    await expect(page.getByRole("heading", { name: "我的片库" })).toBeVisible();
    return page;
  };
  const close = async () => {
    if (!application) return;
    await application.evaluate(({ app }) => app.quit()).catch(() => undefined);
    await application.close().catch(() => undefined);
    if (identity)
      expect(await waitForWindowsProcessExit(identity, 5_000)).toBe(true);
    application = undefined;
    identity = undefined;
  };
  const clientFor = async (page: Page) => {
    const env = (await page.evaluate(async () => {
      const api = (
        window as Window & {
          electron?: {
            app?: { getEnvPath(): Promise<{ data?: { coreUrl?: string } }> };
          };
        }
      ).electron;
      return api?.app?.getEnvPath();
    })) as unknown as { data?: { coreUrl?: string } };
    if (!env?.data?.coreUrl) throw new Error("Core URL missing");
    return trustedCoreClient(page, env.data.coreUrl);
  };
  try {
    await mkdir(path.join(runtimeRoot, "appdata"), { recursive: true });
    await mkdir(path.join(runtimeRoot, "localappdata"), { recursive: true });
    await mkdir(path.join(runtimeRoot, "temp"), { recursive: true });
    let page = await launch();
    let client = await clientFor(page);
    const directory = path.join(runtimeRoot, "downloads");
    expect((await client.setConfigKey("local", directory)).success).toBe(true);
    expect((await client.setConfigKey("maxRunner", 2)).success).toBe(true);
    const created = await client.addDownloadTasks({
      startDownload: true,
      tasks: [1, 2, 3].map((id) => ({
        type: "direct",
        name: `队列验收${id}`,
        url: `${origin}/slow-${id}.mp4`,
      })),
    });
    expect(created.success).toBe(true);
    const ids = created.data.map((item) => item.id);
    const states = async () =>
      Promise.all(
        ids.map(async (id) => (await client.getDownloadTask(id)).data.status),
      );
    await expect
      .poll(states, { timeout: 20_000 })
      .toEqual(["downloading", "downloading", "pending"]);
    await expect.poll(() => active.size).toBe(2);
    expect((await client.stopDownload(ids[0]!)).success).toBe(true);
    await expect
      .poll(states)
      .toEqual(["stopped", "downloading", "downloading"]);
    for (const id of ids.slice(1))
      expect((await client.stopDownload(id)).success).toBe(true);
    await expect.poll(states).toEqual(["stopped", "stopped", "stopped"]);
    release = true;
    for (const finish of held.values()) finish();
    expect(
      (
        await client.startDownload(ids[0]!, {
          localPath: directory,
          deleteSegments: false,
        })
      ).success,
    ).toBe(true);
    await expect
      .poll(async () => (await client.getDownloadTask(ids[0]!)).data.status, {
        timeout: 25_000,
      })
      .toBe("success");
    const complete = (await client.getDownloadTask(ids[0]!)).data;
    expect(await readFile(complete.outputPath!)).toEqual(sample);

    const retry = await client.addDownloadTasks({
      startDownload: true,
      tasks: [
        { type: "direct", name: "失败重试验收", url: `${origin}/retry.mp4` },
      ],
    });
    const retryId = retry.data[0]!.id;
    await expect
      .poll(async () => (await client.getDownloadTask(retryId)).data.status, {
        timeout: 25_000,
      })
      .toBe("failed");
    fail = false;
    expect(
      (
        await client.startDownload(retryId, {
          localPath: directory,
          deleteSegments: false,
        })
      ).success,
    ).toBe(true);
    await expect
      .poll(async () => (await client.getDownloadTask(retryId)).data.status, {
        timeout: 25_000,
      })
      .toBe("success");
    expect(
      await readFile((await client.getDownloadTask(retryId)).data.outputPath!),
    ).toEqual(sample);

    release = false;
    const interrupted = await client.addDownloadTasks({
      startDownload: true,
      tasks: [
        { type: "direct", name: "重启恢复验收", url: `${origin}/restart.mp4` },
      ],
    });
    const restartId = interrupted.data[0]!.id;
    await expect
      .poll(() => active.has("/restart.mp4"), { timeout: 20_000 })
      .toBe(true);
    await close();
    page = await launch();
    client = await clientFor(page);
    expect((await client.getDownloadTask(restartId)).data.status).toBe(
      "stopped",
    );
    release = true;
    for (const finish of held.values()) finish();
    expect(
      (
        await client.startDownload(restartId, {
          localPath: directory,
          deleteSegments: false,
        })
      ).success,
    ).toBe(true);
    await expect
      .poll(async () => (await client.getDownloadTask(restartId)).data.status, {
        timeout: 25_000,
      })
      .toBe("success");
    expect(
      await readFile(
        (await client.getDownloadTask(restartId)).data.outputPath!,
      ),
    ).toEqual(sample);
    await page.getByRole("link", { name: "下载任务", exact: true }).click();
    await page.getByRole("link", { name: "已完成", exact: true }).click();
    await expect(page.getByText("重启恢复验收", { exact: true })).toBeVisible();
    await testInfo.attach("queue-recovery-window.png", {
      body: await page.screenshot({
        path: path.join(
          ROOT,
          ".task/regression-20261006/downloads/artifacts/queue-window.png",
        ),
      }),
      contentType: "image/png",
    });
    await testInfo.attach("queue-result.json", {
      body: JSON.stringify({
        ids,
        retryId,
        restartId,
        successfulFilesMatchFixture: true,
        recoveryPolicy: "stopped and manually restart; byte resume not claimed",
      }),
      contentType: "application/json",
    });
    passed = true;
  } finally {
    await close();
    source.closeAllConnections();
    await new Promise<void>((resolve) => source.close(() => resolve()));
    if (passed)
      await rm(runtimeRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    else
      await testInfo.attach("runtime-root.txt", {
        body: runtimeRoot,
        contentType: "text/plain",
      });
  }
});
