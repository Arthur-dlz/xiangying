import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
import type { PlatformApi } from "@mediago/common";
import { MediaGoClient } from "../../../packages/core-sdk/src/index.ts";
import { scrubElectronEnvironment } from "../support/electron-network.ts";
import { assertPortFree, waitForPortFree } from "../support/ports.ts";
import { trustedCoreClient } from "../support/xiangying-core-client.ts";
import {
  readWindowsProcessIdentity,
  waitForWindowsProcessExit,
  type WindowsProcessIdentity,
} from "../support/xiangying-windows-process.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const EVIDENCE = path.join(
  ROOT,
  ".task/remediation-20261006/interface/favorites",
);
const BINDING_PATH = path.resolve(
  process.env.MEDIAGO_REMEDIATION_BINDING ||
    path.join(ROOT, ".task/remediation-20261006/root/candidate-binding.json"),
);
const CORE_PORT = Number(process.env.MEDIAGO_CORE_PORT || 39_939);

declare global {
  interface Window {
    electron: PlatformApi;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function mainPage(application: ElectronApplication): Promise<Page> {
  await expect
    .poll(() =>
      application.windows().some((window) => {
        try {
          return new URL(window.url()).protocol === "xiangying:";
        } catch {
          return false;
        }
      }),
    )
    .toBe(true);
  const page = application.windows().find((window) => {
    try {
      return new URL(window.url()).protocol === "xiangying:";
    } catch {
      return false;
    }
  });
  if (!page) throw new Error("Candidate main window was not found");
  return page;
}

async function fixtureServer(): Promise<{
  origin: string;
  close(): Promise<void>;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><title>Owned Favorite Fixture</title><p>local favorite fixture</p>",
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Favorites fixture did not bind loopback");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test.skip(
  process.platform !== "win32",
  "candidate favorites acceptance is Windows-only",
);

test("favorites UI adds, opens, removes, and round-trips controlled fixture data", async () => {
  test.setTimeout(120_000);
  await mkdir(EVIDENCE, { recursive: true });
  await assertPortFree(
    "127.0.0.1",
    CORE_PORT,
    "interface favorites candidate Core",
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

  const runtimeRoot = await mkdtemp(path.join(EVIDENCE, "runtime-"));
  const tempDir = path.join(runtimeRoot, "temp");
  const fixture = await fixtureServer();
  await Promise.all([
    mkdir(path.join(runtimeRoot, "appdata"), { recursive: true }),
    mkdir(path.join(runtimeRoot, "localappdata"), { recursive: true }),
    mkdir(tempDir, { recursive: true }),
  ]);
  let application: ElectronApplication | undefined;
  let owner: WindowsProcessIdentity | undefined;
  let passed = false;
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
    const page = await mainPage(application);
    const envPathValue = await page.evaluate(() =>
      window.electron.app.getEnvPath(),
    );
    const envPath = (
      typeof envPathValue === "object" &&
      envPathValue !== null &&
      "data" in envPathValue
        ? envPathValue.data
        : envPathValue
    ) as { coreUrl: string };
    const client: MediaGoClient = trustedCoreClient(page, envPath.coreUrl);
    await client.setConfig({ language: "zh" });
    await page.reload();

    await page.getByRole("link", { name: /找视频/ }).click();
    await expect(page.getByRole("heading", { name: "我的收藏" })).toBeVisible();
    await page.getByRole("button", { name: "添加收藏", exact: true }).click();
    await page.getByLabel("网址").fill(`${fixture.origin}/owned`);
    await page.getByLabel("站点名称").fill("Owned favorite");
    await page.getByRole("button", { name: "确认", exact: true }).click();
    await expect(page.locator('[title="Owned favorite"]')).toBeVisible();
    await expect
      .poll(async () => (await client.getFavorites()).data.length)
      .toBe(1);

    const exported = (await client.exportFavorites()).data;
    expect(exported).toContain(`${fixture.origin}/owned`);
    await client.importFavorites([
      { url: `${fixture.origin}/imported`, title: "Imported fixture" },
    ]);
    await page.reload();
    await page.getByRole("link", { name: /找视频/ }).click();
    await expect(page.locator('[title="Imported fixture"]')).toBeVisible();

    await page.locator('[title="Owned favorite"]').click();
    await expect
      .poll(async () => {
        const result = await page.evaluate(() =>
          window.electron.browser.getTabs(),
        );
        const snapshot = (
          result as { data?: { tabs?: Array<{ url: string }> } }
        ).data;
        return (
          snapshot?.tabs?.some(
            (tab) => tab.url === `${fixture.origin}/owned`,
          ) ?? false
        );
      })
      .toBe(true);

    await page.getByRole("button", { name: "首页", exact: true }).click();
    await expect(page.getByRole("heading", { name: "我的收藏" })).toBeVisible();
    const ownedFavorite = page
      .locator('[title="Owned favorite"]')
      .locator("xpath=..");
    await ownedFavorite.hover();
    await ownedFavorite.locator("div.absolute").click();
    await expect(page.locator('[title="Owned favorite"]')).toHaveCount(0);
    const favorites = (await client.getFavorites()).data;
    expect(favorites).toEqual([
      expect.objectContaining({
        url: `${fixture.origin}/imported`,
        title: "Imported fixture",
      }),
    ]);
    passed = true;
  } finally {
    await fixture.close();
    if (application) await application.close().catch(() => undefined);
    if (owner)
      expect(await waitForWindowsProcessExit(owner, 10_000)).toBe(true);
    await waitForPortFree("127.0.0.1", CORE_PORT, 10_000);
    if (passed) await rm(runtimeRoot, { recursive: true, force: true });
  }
});
