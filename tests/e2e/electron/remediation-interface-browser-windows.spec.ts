import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PlatformApi } from "@mediago/common";
import { trustedCoreClient } from "../support/xiangying-core-client.ts";
import { createHash } from "node:crypto";
import {
  _electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { scrubElectronEnvironment } from "../support/electron-network.ts";
import { assertPortFree, waitForPortFree } from "../support/ports.ts";
import {
  readWindowsProcessIdentity,
  waitForWindowsProcessExit,
  type WindowsProcessIdentity,
} from "../support/xiangying-windows-process.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const EVIDENCE = path.join(
  ROOT,
  ".task/remediation-20261006/interface/browser",
);
const BINDING_PATH = path.resolve(
  process.env.MEDIAGO_REMEDIATION_BINDING ||
    path.join(ROOT, ".task/remediation-20261006/root/candidate-binding.json"),
);
const SAMPLE_PATH = path.join(ROOT, "tests/media-service/public/v1/sample.mp4");
const CORE_PORT = Number(process.env.MEDIAGO_CORE_PORT || 39_939);

declare global {
  interface Window {
    electron: PlatformApi;
  }
}

interface BrowserTab {
  id: string;
  mode: string;
  sources: Array<{ url: string }>;
  status: string;
  url: string;
}

interface BrowserTabs {
  activeTabId: string;
  tabs: BrowserTab[];
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function unwrap<T>(value: unknown): T {
  if (typeof value !== "object" || value === null)
    throw new Error("Electron browser API returned no result");
  const envelope = value as { code?: number; data?: T; message?: string };
  if (envelope.code !== 0) {
    throw new Error(
      `Electron browser API failed: ${envelope.message ?? envelope.code}`,
    );
  }
  return envelope.data as T;
}

async function browserTabs(page: Page): Promise<BrowserTabs> {
  return unwrap<BrowserTabs>(
    await page.evaluate(() => window.electron.browser.getTabs()),
  );
}

async function startFixture(): Promise<{
  origin: string;
  close(): Promise<void>;
}> {
  const media = await readFile(SAMPLE_PATH);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/page/")) {
      const id = url.pathname.slice("/page/".length);
      const withMedia = id !== "empty";
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><title>Remediation ${id}</title>${withMedia ? `<video autoplay muted preload="auto" src="/media/${id}.mp4"></video>` : ""}`,
      );
      return;
    }
    if (url.pathname.startsWith("/media/")) {
      response.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": String(media.length),
      });
      response.end(media);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Browser fixture did not bind a loopback port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
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

test.skip(
  process.platform !== "win32",
  "candidate browser acceptance is Windows-only",
);

test("candidate keeps three browser tabs isolated and clears stale sources on navigation", async () => {
  test.setTimeout(120_000);
  await mkdir(EVIDENCE, { recursive: true });
  await assertPortFree(
    "127.0.0.1",
    CORE_PORT,
    "interface browser candidate Core",
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
  const fixture = await startFixture();
  let application: ElectronApplication | undefined;
  let owner: WindowsProcessIdentity | undefined;
  let passed = false;
  try {
    const tempDir = path.join(runtimeRoot, "temp");
    await Promise.all([
      mkdir(path.join(runtimeRoot, "appdata"), { recursive: true }),
      mkdir(path.join(runtimeRoot, "localappdata"), { recursive: true }),
      mkdir(tempDir, { recursive: true }),
    ]);
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
    const envPath = unwrap<{ coreUrl: string }>(
      await page.evaluate(() => window.electron.app.getEnvPath()),
    );
    await trustedCoreClient(page, envPath.coreUrl).setConfig({
      language: "zh",
    });
    await page.reload();
    await page.getByRole("link", { name: /找视频/ }).click();
    const initial = await browserTabs(page);
    const firstId = initial.activeTabId;
    await page.evaluate(
      ({ tabId, url }) => window.electron.browser.loadURL(tabId, url),
      { tabId: firstId, url: `${fixture.origin}/page/a` },
    );
    const second = unwrap<{ id: string }>(
      await page.evaluate(() => window.electron.browser.createTab()),
    );
    await page.evaluate(
      ({ tabId, url }) => window.electron.browser.loadURL(tabId, url),
      { tabId: second.id, url: `${fixture.origin}/page/b` },
    );
    const third = unwrap<{ id: string }>(
      await page.evaluate(() => window.electron.browser.createTab()),
    );
    await page.evaluate(
      ({ tabId, url }) => window.electron.browser.loadURL(tabId, url),
      { tabId: third.id, url: `${fixture.origin}/page/c` },
    );

    await expect
      .poll(async () => {
        const tabs = await browserTabs(page);
        return [firstId, second.id, third.id].map(
          (id) => tabs.tabs.find((tab) => tab.id === id)?.sources[0]?.url ?? "",
        );
      })
      .toEqual([
        `${fixture.origin}/media/a.mp4`,
        `${fixture.origin}/media/b.mp4`,
        `${fixture.origin}/media/c.mp4`,
      ]);

    await page.evaluate(
      ({ tabId, url }) => window.electron.browser.loadURL(tabId, url),
      { tabId: firstId, url: `${fixture.origin}/page/empty` },
    );
    await expect
      .poll(async () => {
        const tabs = await browserTabs(page);
        return {
          first: tabs.tabs.find((tab) => tab.id === firstId)?.sources.length,
          second: tabs.tabs.find((tab) => tab.id === second.id)?.sources[0]
            ?.url,
          third: tabs.tabs.find((tab) => tab.id === third.id)?.sources[0]?.url,
        };
      })
      .toEqual({
        first: 0,
        second: `${fixture.origin}/media/b.mp4`,
        third: `${fixture.origin}/media/c.mp4`,
      });

    const beforeUnsafe = await browserTabs(page);
    for (const unsafeUrl of [
      pathToFileURL(path.join(runtimeRoot, "does-not-exist.txt")).href,
      "javascript:document.title='unexpected'",
      "data:text/html,<title>unexpected</title>",
    ]) {
      await page.evaluate(
        async ({ tabId, url }) => {
          try {
            await window.electron.browser.loadURL(tabId, url);
          } catch {
            // Rejection is an expected safe outcome.
          }
        },
        { tabId: firstId, url: unsafeUrl },
      );
      await expect
        .poll(async () => {
          const tab = (await browserTabs(page)).tabs.find(
            (candidate) => candidate.id === firstId,
          );
          return { status: tab?.status, url: tab?.url };
        })
        .toEqual({ status: "failed", url: unsafeUrl });
    }
    const afterUnsafe = await browserTabs(page);
    expect(afterUnsafe.tabs.map((tab) => tab.id)).toEqual(
      beforeUnsafe.tabs.map((tab) => tab.id),
    );

    await page.evaluate(
      (tabId) => window.electron.browser.closeTab(tabId),
      second.id,
    );
    await expect
      .poll(async () => (await browserTabs(page)).tabs.map((tab) => tab.id))
      .toEqual([firstId, third.id]);
    await page.evaluate(
      (tabId) => window.electron.browser.closeTab(tabId),
      third.id,
    );
    await page.evaluate(
      (tabId) => window.electron.browser.closeTab(tabId),
      firstId,
    );
    const finalTabs = await browserTabs(page);
    expect(finalTabs.tabs).toHaveLength(1);
    expect(finalTabs.tabs[0]).toMatchObject({ mode: "home", sources: [] });
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
