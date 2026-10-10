import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  DownloadType,
  type PlatformApi,
} from "../../../packages/common/src/types/index.ts";
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
import { trustedCoreClient } from "../support/xiangying-core-client.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const EVIDENCE = path.join(
  ROOT,
  ".task/remediation-20261006/interface/security",
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

interface BrowserTabs {
  activeTabId: string;
  tabs: Array<{ id: string; kind: string; mode: string; url: string }>;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function unwrap<T>(value: unknown): T {
  if (typeof value !== "object" || value === null)
    throw new Error("Electron browser API returned no result");
  const envelope = value as { code?: number; data?: T; message?: string };
  if (envelope.code !== 0)
    throw new Error(
      `Electron browser API failed: ${envelope.message ?? envelope.code}`,
    );
  return envelope.data as T;
}

async function browserTabs(page: Page): Promise<BrowserTabs> {
  return unwrap<BrowserTabs>(
    await page.evaluate(() => window.electron.browser.getTabs()),
  );
}

async function mainPage(application: ElectronApplication): Promise<Page> {
  await expect
    .poll(() =>
      application.windows().some((window) => {
        try {
          const url = new URL(window.url());
          return url.protocol === "xiangying:" && url.pathname === "/";
        } catch {
          return false;
        }
      }),
    )
    .toBe(true);
  const page = application.windows().find((window) => {
    try {
      const url = new URL(window.url());
      return url.protocol === "xiangying:" && url.pathname === "/";
    } catch {
      return false;
    }
  });
  if (!page) throw new Error("Candidate main window was not found");
  return page;
}

async function overlayText(application: ElectronApplication): Promise<string> {
  return application.evaluate(async ({ webContents }) => {
    const overlay = webContents
      .getAllWebContents()
      .find(
        (contents) =>
          new URL(contents.getURL()).href ===
          "xiangying://index.html/download-dialog",
      );
    if (!overlay) throw new Error("Local download overlay was not found");
    return overlay.executeJavaScript("document.body.innerText");
  });
}

async function clickOverlayButton(
  application: ElectronApplication,
  name: string,
): Promise<boolean> {
  return application.evaluate(async ({ webContents }, buttonName) => {
    const overlay = webContents
      .getAllWebContents()
      .find(
        (contents) =>
          new URL(contents.getURL()).href ===
          "xiangying://index.html/download-dialog",
      );
    if (!overlay) throw new Error("Local download overlay was not found");
    return overlay.executeJavaScript(
      `(() => { const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(buttonName)}); if (!button) return false; button.click(); return true; })()`,
    );
  }, name);
}

async function hostileFixture(): Promise<{
  origin: string;
  getProbe(): Record<string, unknown> | undefined;
  sourceHits(): number;
  close(): Promise<void>;
}> {
  let probe: Record<string, unknown> | undefined;
  let sourceRequests = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/hostile") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Hostile local fixture</title>
        <script>
          (async () => {
            async function denied(operation) {
              try {
                const response = await operation();
                return typeof response === 'object' && response !== null &&
                  typeof response.code === 'number' && response.code !== 0;
              } catch {
                return true;
              }
            }
            const result = {
              electron: typeof window.electron,
              require: typeof window.require,
              process: typeof window.process,
              nodeProcess: typeof process,
              getEnvPathDenied: await denied(() => window.electron.app.getEnvPath()),
              getBrowserTabsDenied: await denied(() => window.electron.browser.getTabs()),
            };
            await fetch('/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(result) });
            window.open('/popup', '_blank');
          })();
        </script>`);
      return;
    }
    if (url.pathname === "/report" && request.method === "POST") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        try {
          probe = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >;
        } catch {
          probe = { invalidReport: true };
        }
        response.writeHead(204).end();
      });
      return;
    }
    if (url.pathname === "/protected.m3u8") sourceRequests += 1;
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Security fixture did not bind loopback");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    getProbe: () => probe,
    sourceHits: () => sourceRequests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test.skip(
  process.platform !== "win32",
  "candidate security acceptance is Windows-only",
);

test("remote browser content stays isolated and private-header rejection is visible", async () => {
  test.setTimeout(120_000);
  await mkdir(EVIDENCE, { recursive: true });
  await assertPortFree(
    "127.0.0.1",
    CORE_PORT,
    "interface security candidate Core",
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
  const fixture = await hostileFixture();
  const tempDir = path.join(runtimeRoot, "temp");
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
    const envPath = unwrap<{ coreUrl: string }>(
      await page.evaluate(() => window.electron.app.getEnvPath()),
    );
    await trustedCoreClient(page, envPath.coreUrl).setConfig({
      language: "zh",
    });
    await expect
      .poll(
        async () =>
          (await trustedCoreClient(page, envPath.coreUrl).getConfig()).data
            .language,
      )
      .toBe("zh");
    await page.reload();
    const sourceNavigation = page.locator('nav a[href="/source"]').first();
    await expect(sourceNavigation).toBeVisible();
    await sourceNavigation.click();
    const tab = await browserTabs(page);
    const tabId = tab.activeTabId;
    await page.evaluate(
      ({ id, url }) => window.electron.browser.loadURL(id, url),
      { id: tabId, url: `${fixture.origin}/hostile` },
    );
    await expect
      .poll(() => fixture.getProbe())
      .toMatchObject({
        electron: "object",
        require: "undefined",
        process: "undefined",
        nodeProcess: "undefined",
        getEnvPathDenied: true,
        getBrowserTabsDenied: true,
      });
    await expect
      .poll(async () => {
        const snapshot = await browserTabs(page);
        const popupTabs = snapshot.tabs.filter(
          (candidate) => !tab.tabs.some((before) => before.id === candidate.id),
        );
        return {
          originalIds: snapshot.tabs
            .filter((candidate) =>
              tab.tabs.some((before) => before.id === candidate.id),
            )
            .map(({ id }) => id),
          popupCount: popupTabs.length,
          popup: popupTabs[0],
          activeIsPopup: snapshot.activeTabId === popupTabs[0]?.id,
        };
      })
      .toMatchObject({
        originalIds: tab.tabs.map(({ id }) => id),
        popupCount: 1,
        popup: {
          kind: "user",
          mode: "browser",
          url: `${fixture.origin}/popup`,
        },
        activeIsPopup: true,
      });

    const secret = "remediation-private-header-sentinel";
    unwrap<void>(
      await page.evaluate(
        ({ id, url, header, type }) =>
          window.electron.browser.showDownloadDialog(id, [
            {
              name: "Private header rejection fixture",
              url,
              type,
              headers: `Cookie: session=${header}\nAuthorization: Bearer ${header}`,
              folder: "",
            },
          ]),
        {
          id: tabId,
          url: `${fixture.origin}/protected.m3u8`,
          header: secret,
          type: DownloadType.m3u8,
        },
      ),
    );
    await expect.poll(() => overlayText(application!)).toContain("立即下载");
    expect(await clickOverlayButton(application, "立即下载")).toBe(true);
    await expect
      .poll(() => overlayText(application!))
      .toContain("unsupported sensitive headers for downloads");
    expect(fixture.sourceHits()).toBe(0);
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
