import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, expect, test } from "@playwright/test";
import { scrubElectronEnvironment } from "../support/electron-network.ts";
import { assertPortFree, waitForPortFree } from "../support/ports.ts";
import { trustedCoreClient } from "../support/xiangying-core-client.ts";
import {
  readWindowsProcessIdentity,
  terminateOwnedWindowsProcess,
  waitForWindowsProcessExit,
} from "../support/xiangying-windows-process.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const evidence = path.join(repository, ".task/repair-20261006");
const executable = path.join(evidence, "candidate-ui/乡映.exe");
const port = 39_809;

test("repaired number field preserves each invalid blur error in Electron", async () => {
  test.setTimeout(120_000);
  test.skip(process.platform !== "win32", "Windows candidate validation");
  await assertPortFree("127.0.0.1", port, "isolated repair Core");
  const binding = JSON.parse(
    await readFile(path.join(evidence, "candidate-ui-binding.json"), "utf8"),
  ) as { asarSha256: string; coreSha256: string; settingSourceSha256: string };
  const digest = async (file: string) =>
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  expect(
    await digest(path.join(evidence, "candidate-ui/resources/app.asar")),
  ).toBe(binding.asarSha256);
  expect(
    await digest(
      path.join(evidence, "candidate-ui/resources/bin/mediago-core.exe"),
    ),
  ).toBe(binding.coreSha256);
  expect(
    await digest(
      path.join(
        repository,
        "apps/ui/src/pages/setting-page/setting-fields.tsx",
      ),
    ),
  ).toBe(binding.settingSourceSha256);

  const runtime = await mkdtemp(path.join(evidence, "settings-runtime-"));
  await Promise.all(
    ["appdata", "localappdata", "temp"].map((name) =>
      mkdir(path.join(runtime, name), { recursive: true }),
    ),
  );
  const application = await _electron.launch({
    executablePath: executable,
    args: [],
    env: {
      ...scrubElectronEnvironment(process.env),
      APP_NAME: "xiangying",
      APP_TARGET: "electron",
      NODE_ENV: "production",
      ELECTRON_IS_DEV: "0",
      MEDIAGO_RUNTIME_ROOT: runtime,
      MEDIAGO_CORE_PORT: String(port),
      APPDATA: path.join(runtime, "appdata"),
      LOCALAPPDATA: path.join(runtime, "localappdata"),
      TEMP: path.join(runtime, "temp"),
      TMP: path.join(runtime, "temp"),
    },
  });
  const identity = await readWindowsProcessIdentity(application.process().pid!);
  try {
    const findMainWindow = () =>
      application.windows().find((window) => {
        try {
          const url = new URL(window.url());
          return (
            url.protocol === "xiangying:" &&
            url.hostname === "index.html" &&
            ["", "/", "/library", "/downloads", "/settings"].includes(
              url.pathname,
            )
          );
        } catch {
          return false;
        }
      });
    await expect.poll(() => Boolean(findMainWindow())).toBe(true);
    const page = findMainWindow()!;
    await expect(page.getByTitle("设置")).toBeVisible();
    await page.getByTitle("设置").click();
    const envResult: unknown = await page.evaluate(async () => {
      const electron = (
        window as Window & {
          electron?: { app?: { getEnvPath(): Promise<unknown> } };
        }
      ).electron;
      if (!electron?.app) throw new Error("trusted app API missing");
      return electron.app.getEnvPath();
    });
    const wrapped = envResult as {
      code: number;
      data: { coreUrl: string; workspace: string };
    };
    expect(wrapped.code).toBe(0);
    expect(path.resolve(wrapped.data.workspace)).toBe(
      path.resolve(runtime, "data"),
    );
    const client = trustedCoreClient(page, wrapped.data.coreUrl);
    await client.setConfig({ maxRunner: 1 });
    await page.reload();
    await page.getByTitle("设置").click();
    const input = page.locator("#setting-maxRunner");
    await expect(input).toHaveValue("1");
    const observations: Array<Record<string, unknown>> = [];
    for (const value of ["0", "51", "", "-1", "51"]) {
      await input.fill(value);
      await input.press("Tab");
      await expect(input).toHaveValue("1");
      await expect(input).toHaveAttribute("aria-invalid", "true");
      await expect(page.getByText("1–50", { exact: true })).toBeVisible();
      expect((await client.getConfig()).data.maxRunner).toBe(1);
      observations.push({ value, restored: "1", invalid: true, core: 1 });
    }
    await input.fill("10");
    await input.press("Tab");
    await expect(input).toHaveValue("10");
    await expect(input).toHaveAttribute("aria-invalid", "false");
    await expect(page.getByText("1–50", { exact: true })).toHaveCount(0);
    await expect
      .poll(async () => (await client.getConfig()).data.maxRunner)
      .toBe(10);
    await page.screenshot({ path: path.join(evidence, "settings-repair.png") });
    await writeFile(
      path.join(evidence, "settings-runtime-result.json"),
      JSON.stringify(
        { executable, binding, runtime, observations, legal: 10 },
        null,
        2,
      ),
    );
    if (process.env.MEDIAGO_REPAIR_CORE_VALIDATION === "1") {
      const media = await readFile(
        path.join(repository, "tests/media-service/public/v1/sample.mp4"),
      );
      const downloads = path.join(runtime, "downloads");
      await mkdir(downloads, { recursive: true });
      const sentinel = Buffer.from("repair-existing-file-must-remain");
      const sentinelPath = path.join(downloads, "repair-occupied.mp4");
      await writeFile(sentinelPath, sentinel);
      let rejectedSourceHits = 0;
      let rejectedTargetHits = 0;
      const target = createServer((_request, response) => {
        rejectedTargetHits++;
        response.writeHead(500).end();
      });
      const source = createServer((request, response) => {
        if (request.url === "/redirect.m3u8") {
          rejectedSourceHits++;
          response
            .writeHead(302, {
              Location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/target.m3u8`,
            })
            .end();
        } else {
          response
            .writeHead(200, {
              "Content-Type": "video/mp4",
              "Content-Length": media.length,
            })
            .end(media);
        }
      });
      await new Promise<void>((resolve) =>
        target.listen(0, "127.0.0.1", resolve),
      );
      await new Promise<void>((resolve) =>
        source.listen(0, "127.0.0.1", resolve),
      );
      try {
        const sourcePort = (source.address() as AddressInfo).port;
        const created = await client.addDownloadTasks({
          startDownload: true,
          tasks: ["a", "b"].map((name) => ({
            type: "direct",
            name: "repair-occupied",
            url: `http://127.0.0.1:${sourcePort}/${name}.mp4`,
          })),
        });
        expect(created.success).toBe(true);
        await expect
          .poll(
            async () => {
              const tasks = await Promise.all(
                created.data.map((task) => client.getDownloadTask(task.id)),
              );
              return tasks.every((task) => task.data.status === "success");
            },
            { timeout: 30_000 },
          )
          .toBe(true);
        const outputs = await Promise.all(
          created.data.map(async (task) => {
            const completed = (await client.getDownloadTask(task.id)).data;
            if (!completed.outputPath)
              throw new Error("Completed download has no output path");
            expect(path.dirname(completed.outputPath)).toBe(downloads);
            expect(await readFile(completed.outputPath)).toEqual(media);
            return {
              id: task.id,
              outputPath: completed.outputPath,
              sha256: await digest(completed.outputPath),
            };
          }),
        );
        expect(new Set(outputs.map((output) => output.outputPath)).size).toBe(
          2,
        );
        expect(await readFile(sentinelPath)).toEqual(sentinel);
        const secret = "repair-fake-auth-sentinel";
        const blocked = await client.addDownloadTasks({
          startDownload: true,
          tasks: [
            {
              type: "m3u8",
              name: "repair-blocked",
              url: `http://localhost:${sourcePort}/redirect.m3u8`,
              headers: `Cookie: session=${secret}\nAuthorization: Bearer ${secret}`,
            },
          ],
        });
        expect(blocked.success).toBe(true);
        const blockedTask = blocked.data[0];
        if (!blockedTask)
          throw new Error("Rejected fixture task was not created");
        await expect
          .poll(
            async () =>
              (await client.getDownloadTask(blockedTask.id)).data.status,
          )
          .toBe("failed");
        expect(rejectedSourceHits).toBe(0);
        expect(rejectedTargetHits).toBe(0);
        const rejectionLog = JSON.stringify(
          (await client.getTaskLogs(String(blockedTask.id))).data,
        );
        expect(rejectionLog).toContain("unsupported sensitive headers");
        expect(rejectionLog).not.toContain(secret);
        await writeFile(
          path.join(evidence, "core-runtime-result.json"),
          JSON.stringify(
            {
              executable,
              binding,
              runtime,
              outputs,
              sentinelPreserved: true,
              rejected: {
                taskId: blockedTask.id,
                status: "failed",
                sourceHits: rejectedSourceHits,
                targetHits: rejectedTargetHits,
                secretAbsentFromFailureLog: true,
              },
            },
            null,
            2,
          ),
        );
      } finally {
        await Promise.all(
          [source, target].map(
            (server) =>
              new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
                server.closeAllConnections();
              }),
          ),
        );
      }
    }
  } finally {
    await application.close().catch(async () => {
      if (!identity)
        throw new Error("Unable to verify owned process for cleanup");
      await terminateOwnedWindowsProcess(identity);
    });
    if (identity)
      expect(await waitForWindowsProcessExit(identity, 5_000)).toBe(true);
    await waitForPortFree("127.0.0.1", port, 10_000);
  }
});
