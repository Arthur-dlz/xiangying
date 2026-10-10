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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import {
  _electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { IPC } from "../../../packages/common/src/constants/events.ts";
import { DownloadType as CoreDownloadType } from "../../../packages/core-sdk/src/index.ts";
import { scrubElectronEnvironment } from "../support/regression-downloads-electron-network.ts";
import {
  captureProcessOutput,
  type ProcessOutput,
} from "../support/process.ts";
import { loadMediaFixture } from "../support/media.ts";
import { trustedCoreClient } from "../support/xiangying-core-client.ts";
import {
  readWindowsProcessIdentity,
  waitForWindowsProcessExit,
  type WindowsProcessIdentity,
} from "../support/xiangying-windows-process.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const EXECUTABLE = path.join(
  ROOT,
  "apps/electron/release-slim/win-unpacked/乡映.exe",
);

interface SniffedSource {
  id: number;
  name: string;
  type: string;
  url: string;
}

interface SniffedTab {
  id: string;
  sources: SniffedSource[];
}

interface BrowserTabsValue {
  activeTabId: string;
  tabs: SniffedTab[];
}

function unwrapIpcData(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const envelope = value as Record<string, unknown>;
  if (!("code" in envelope)) return value;
  if (envelope.code !== 0) {
    throw new Error(
      `Trusted IPC request failed: ${String(envelope.message ?? envelope.msg ?? envelope.code)}`,
    );
  }
  return envelope.data;
}

function readBrowserTabs(value: unknown): BrowserTabsValue {
  const data = unwrapIpcData(value);
  if (typeof data !== "object" || data === null)
    throw new Error("Browser tabs IPC returned no snapshot");
  const snapshot = data as Record<string, unknown>;
  if (
    typeof snapshot.activeTabId !== "string" ||
    !Array.isArray(snapshot.tabs)
  ) {
    throw new Error("Browser tabs IPC returned an invalid snapshot");
  }
  const tabs = snapshot.tabs.map((candidate): SniffedTab => {
    if (typeof candidate !== "object" || candidate === null)
      throw new Error("Browser tab entry is invalid");
    const tab = candidate as Record<string, unknown>;
    if (typeof tab.id !== "string" || !Array.isArray(tab.sources))
      throw new Error("Browser tab sources are invalid");
    const sources = tab.sources.map((candidateSource): SniffedSource => {
      if (typeof candidateSource !== "object" || candidateSource === null)
        throw new Error("Browser source entry is invalid");
      const source = candidateSource as Record<string, unknown>;
      if (
        typeof source.id !== "number" ||
        typeof source.name !== "string" ||
        typeof source.type !== "string" ||
        typeof source.url !== "string"
      ) {
        throw new Error("Browser source fields are invalid");
      }
      return {
        id: source.id,
        name: source.name,
        type: source.type,
        url: source.url,
      };
    });
    return { id: tab.id, sources };
  });
  return { activeTabId: snapshot.activeTabId, tabs };
}

function runtimeEnvironment(runtimeRoot: string): Record<string, string> {
  return {
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
  };
}

async function startFixtureServer(): Promise<{
  origin: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/page") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><title>Sniff fixture</title><video autoplay muted loop preload="auto" controls src="${url.searchParams.get("mp4") ?? ""}"></video><iframe src="/frame"></iframe><script>fetch(${JSON.stringify(url.searchParams.get("hls") ?? "")}).catch(() => {});</script>`,
      );
      return;
    }
    if (url.pathname === "/frame") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>fixture frame</title>");
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
    throw new Error("Fixture server did not bind");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function trustedBrowserPage(
  application: ElectronApplication,
): Promise<Page> {
  await expect
    .poll(
      () =>
        application.windows().some((window) => {
          try {
            return new URL(window.url()).pathname.endsWith("/browser");
          } catch {
            return false;
          }
        }),
      { timeout: 15_000 },
    )
    .toBe(true);
  const page = application.windows().find((window) => {
    try {
      return new URL(window.url()).pathname.endsWith("/browser");
    } catch {
      return false;
    }
  });
  if (!page) throw new Error("Trusted browser window was not opened");
  return page;
}

test.skip(
  process.platform !== "win32",
  "Packaged 乡映 runtime acceptance is Windows-only",
);

test("packaged 乡映 isolates remote browser APIs and preserves trusted sniff submission", async () => {
  test.setTimeout(
    process.env.XIANGYING_PUBLIC_PROBE === "1" ? 210_000 : 150_000,
  );
  if (
    path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "") !==
    path.resolve(EXECUTABLE)
  ) {
    throw new Error(
      "XIANGYING_E2E_EXECUTABLE must be the frozen release-slim candidate",
    );
  }
  const runtimeRoot = await mkdtemp(
    path.join(
      ROOT,
      ".task/regression-20261006/downloads/runtime/xiangying-sniff-e2e-",
    ),
  );
  const fixture = await startFixtureServer();
  const media = await loadMediaFixture();
  let application: ElectronApplication | undefined;
  let processOutput: ProcessOutput | undefined;
  let mainIdentity: WindowsProcessIdentity | undefined;
  let failed = false;
  try {
    await mkdir(path.join(runtimeRoot, "appdata"), { recursive: true });
    await mkdir(path.join(runtimeRoot, "localappdata"), { recursive: true });
    await mkdir(path.join(runtimeRoot, "temp"), { recursive: true });
    application = await _electron.launch({
      executablePath: process.env.XIANGYING_E2E_EXECUTABLE || EXECUTABLE,
      args:
        process.env.XIANGYING_GPU_PROBE === "1"
          ? ["--use-angle=d3d11", "--disable-features=WebGPUService"]
          : [],
      env: runtimeEnvironment(runtimeRoot),
      timeout: 60_000,
    });
    processOutput = captureProcessOutput(application.process());
    mainIdentity = await readWindowsProcessIdentity(
      await application.evaluate(() => process.pid),
    );
    await expect
      .poll(() =>
        application!
          .windows()
          .some(
            (candidate) =>
              candidate.url() === "xiangying://index.html/" ||
              candidate.url() === "xiangying://index.html/library",
          ),
      )
      .toBe(true);
    const home = application
      .windows()
      .find(
        (candidate) =>
          candidate.url() === "xiangying://index.html/" ||
          candidate.url() === "xiangying://index.html/library",
      );
    if (!home) throw new Error("Packaged main library page not found");
    await expect(home.getByRole("heading", { name: "我的片库" })).toBeVisible({
      timeout: 30_000,
    });
    const trustedApi = await home.evaluate(async () => {
      const api = (
        window as Window & {
          electron?: { library?: { list(): Promise<unknown> } };
        }
      ).electron;
      if (!api?.library) throw new Error("Trusted library API missing");
      return api.library.list();
    });
    expect(trustedApi).toMatchObject({ code: 0 });

    await expect
      .poll(
        async () =>
          home.evaluate(async () => {
            const api = (
              window as Window & {
                electron?: { app?: { getEnvPath(): Promise<unknown> } };
              }
            ).electron;
            if (!api?.app) return false;
            const value = await api.app.getEnvPath();
            if (!value || typeof value !== "object") return false;
            const result = value as {
              code?: unknown;
              data?: unknown;
              coreUrl?: unknown;
            };
            if (typeof result.code === "number") {
              if (
                result.code !== 0 ||
                !result.data ||
                typeof result.data !== "object"
              )
                return false;
              return (
                typeof (result.data as { coreUrl?: unknown }).coreUrl ===
                "string"
              );
            }
            return typeof result.coreUrl === "string";
          }),
        { timeout: 45_000, intervals: [500, 1_000] },
      )
      .toBe(true);
    const browserOpenResult = await home.evaluate(async () => {
      const api = (
        window as Window & {
          electron?: {
            app?: { showBrowserWindow(): Promise<void> };
            browser?: { getTabs(): Promise<{ activeTabId: string }> };
          };
        }
      ).electron;
      if (!api?.app) throw new Error("Trusted browser window action missing");
      return api.app.showBrowserWindow();
    });
    unwrapIpcData(browserOpenResult);
    const browser = await trustedBrowserPage(application);
    await expect(
      browser.getByRole("heading", { name: "资源聚合搜索" }),
    ).toBeVisible();
    await expect(
      browser.getByRole("heading", { name: "影视网站入口" }),
    ).toBeVisible();
    const navigation = browser.locator(
      '[aria-labelledby="resource-navigation-title"]',
    );
    await expect(navigation.getByRole("button", { name: /^打开/ })).toHaveCount(
      10,
    );
    await navigation
      .getByRole("button", { name: "少儿与动画", exact: true })
      .click();
    await expect(
      navigation.getByRole("button", { name: "打开央视少儿", exact: true }),
    ).toBeVisible();
    await navigation.getByRole("button", { name: "全部", exact: true }).click();
    await expect(navigation.getByRole("button", { name: /^打开/ })).toHaveCount(
      10,
    );
    const configuredProviders = await browser.evaluate(async () => {
      const api = (
        window as Window & {
          electron?: { resourceSearch?: { listProviders(): Promise<unknown> } };
        }
      ).electron;
      if (!api?.resourceSearch)
        throw new Error("Trusted resource search API missing");
      return api.resourceSearch.listProviders();
    });
    expect(unwrapIpcData(configuredProviders)).toEqual([
      expect.objectContaining({ id: "bfzy", enabled: true }),
      expect.objectContaining({ id: "ffzy", enabled: true }),
    ]);
    if (process.env.XIANGYING_PUBLIC_PROBE === "1") {
      await browser
        .getByRole("textbox", { name: "搜索影视名称" })
        .fill("熊出没");
      await browser.getByRole("button", { name: "搜索", exact: true }).click();
      await expect(
        browser.getByRole("button", { name: "搜索", exact: true }),
      ).toBeVisible({ timeout: 25_000 });
      const searchProbe = await browser.evaluate(() => ({
        resultCount: document.querySelectorAll(
          '[aria-labelledby="resource-search-title"] article',
        ).length,
        partialFailure: document.body.innerText.includes("部分资源源搜索失败"),
        noResults: document.body.innerText.includes("未找到匹配结果"),
        alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(
          (element) => element.textContent,
        ),
      }));
      await writeFile(
        path.join(
          ROOT,
          ".task/regression-20261006/downloads/artifacts/public-search-probe.json",
        ),
        JSON.stringify(searchProbe, null, 2),
      );
      await browser.screenshot({
        path: path.join(
          ROOT,
          ".task/regression-20261006/downloads/artifacts/resource-search-window.png",
        ),
      });
    }
    const tabState = readBrowserTabs(
      await browser.evaluate(async () => {
        const api = (
          window as Window & {
            electron?: {
              browser?: { getTabs(): Promise<{ activeTabId: string }> };
            };
          }
        ).electron;
        if (!api?.browser)
          throw new Error("Trusted browser window API missing");
        return api.browser.getTabs();
      }),
    );
    const tabId = tabState.activeTabId;
    const mp4 = media.sampleURL;
    const pageUrl = `${fixture.origin}/page?mp4=${encodeURIComponent(mp4)}&hls=${encodeURIComponent(`${media.baseURL}/hls/index.m3u8`)}`;
    await browser.evaluate(
      async ({ selectedTabId, targetPageUrl }) => {
        const api = (
          window as Window & {
            electron?: {
              browser?: { loadURL(tabId: string, url: string): Promise<void> };
            };
          }
        ).electron;
        if (!api?.browser) throw new Error("Trusted browser API missing");
        await api.browser.loadURL(selectedTabId, targetPageUrl);
      },
      { selectedTabId: tabId, targetPageUrl: pageUrl },
    );

    await expect
      .poll(async () => {
        const response = await browser.evaluate(async () => {
          const api = (
            window as Window & {
              electron?: {
                browser?: {
                  getTabs(): Promise<{
                    tabs: Array<{ sources: Array<{ url: string }> }>;
                  }>;
                };
              };
            }
          ).electron;
          if (!api?.browser) throw new Error("Trusted browser API missing");
          return api.browser.getTabs();
        });
        return readBrowserTabs(response).tabs.flatMap((tab) =>
          tab.sources.map((source) => source.url),
        );
      })
      .toEqual(
        expect.arrayContaining([mp4, `${media.baseURL}/hls/index.m3u8`]),
      );
    const detected = readBrowserTabs(
      await browser.evaluate(async () => {
        const api = (
          window as Window & {
            electron?: { browser?: { getTabs(): Promise<unknown> } };
          }
        ).electron;
        if (!api?.browser) throw new Error("Trusted browser API missing");
        return api.browser.getTabs();
      }),
    );
    const detectedTab = detected.tabs.find((tab) => tab.id === tabId);
    if (!detectedTab)
      throw new Error("Sniffed browser tab missing from trusted snapshot");

    if (process.env.XIANGYING_GPU_PROBE === "1") {
      const graphics = await application.evaluate(
        async ({ app, webContents }, target) => {
          const content = webContents
            .getAllWebContents()
            .find((entry) => entry.getURL() === target);
          if (!content) throw new Error("Controlled video page missing");
          const sample = await content.executeJavaScript(`(async () => {
            const video = document.querySelector('video');
            if (!video) throw new Error('Controlled video missing');
            await Promise.race([video.play(), new Promise((_, reject) => setTimeout(() => reject(new Error('Controlled playback timed out')), 5000))]);
            const before = video.getVideoPlaybackQuality().totalVideoFrames;
            await new Promise(resolve => setTimeout(resolve, 1000));
            const after = video.getVideoPlaybackQuality().totalVideoFrames;
            const gl = document.createElement('canvas').getContext('webgl');
            if (!gl) throw new Error('WebGL unavailable');
            gl.clearColor(0.25, 0.5, 0.75, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            const pixel = new Uint8Array(4);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            const info = gl.getExtension('WEBGL_debug_renderer_info');
            const adapter = navigator.gpu ? await Promise.race([navigator.gpu.requestAdapter().then(value => Boolean(value), () => false), new Promise(resolve => setTimeout(() => resolve('timeout'), 3000))]) : false;
            return { before, after, readyState: video.readyState, paused: video.paused, width: video.videoWidth, webgpuAdapter: adapter, renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), pixel: Array.from(pixel) };
          })()`);
          return { featureStatus: app.getGPUFeatureStatus(), sample };
        },
        pageUrl,
      );
      await writeFile(
        path.join(
          ROOT,
          ".task/regression-20261006/downloads/artifacts/gpu-runtime.json",
        ),
        JSON.stringify(graphics, null, 2),
      );
      expect(graphics.sample.after).toBeGreaterThan(graphics.sample.before);
      expect(graphics.sample.width).toBeGreaterThan(0);
      expect(graphics.sample.paused).toBe(false);
      expect(graphics.sample.webgpuAdapter).toBe(false);
      expect(
        (graphics.featureStatus as unknown as Record<string, string>).webgpu,
      ).toMatch(/^disabled/);
      expect(graphics.sample.pixel[3]).toBe(255);
      expect(graphics.sample.pixel[0]).toBeGreaterThanOrEqual(63);
      expect(graphics.sample.pixel[0]).toBeLessThanOrEqual(65);
    }

    await expect
      .poll(async () =>
        application?.evaluate(({ webContents }, target) => {
          const contents = webContents
            .getAllWebContents()
            .find((entry) => entry.getURL() === target);
          if (!contents) return null;
          return contents.executeJavaScript(
            `(() => ({ keys: Object.keys(window.electron || {}), browser: Object.keys(window.electron?.browser || {}), frameHasBridge: Boolean(window.frames[0]?.electron) }))()`,
          );
        }, pageUrl),
      )
      .toMatchObject({
        keys: ["browser"],
        browser: ["showDownloadDialog"],
        frameHasBridge: false,
      });

    // A separate, unregistered BrowserWindow exercises real IPC rejection from a remote origin.
    const hostilePreload = path.join(runtimeRoot, "hostile-preload.cjs");
    await writeFile(
      hostilePreload,
      `const { contextBridge, ipcRenderer } = require('electron'); contextBridge.exposeInMainWorld('hostileProbe', { invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args) });`,
    );
    const hostileUrl = `${fixture.origin}/frame`;
    await application.evaluate(
      ({ BrowserWindow }, options) => {
        const window = new BrowserWindow({
          show: false,
          webPreferences: {
            preload: options.preload,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
          },
        });
        void window.loadURL(options.url);
      },
      { preload: hostilePreload, url: hostileUrl },
    );
    await expect
      .poll(() =>
        application
          ?.windows()
          .some((candidate) => candidate.url() === hostileUrl),
      )
      .toBe(true);
    const hostile = application
      .windows()
      .find((candidate) => candidate.url() === hostileUrl);
    if (!hostile)
      throw new Error("Hostile unregistered BrowserWindow did not load");
    const rejected = await Promise.all(
      [
        IPC.library.list,
        IPC.shell.open,
        IPC.dialog.open,
        IPC.update.check,
        IPC.resourceSearch.listProviders,
        IPC.resourceSearch.search,
      ].map((name) =>
        hostile.evaluate(async (channel) => {
          const bridge = (
            window as Window & {
              hostileProbe?: {
                invoke(channel: string): Promise<{ code: number }>;
              };
            }
          ).hostileProbe;
          if (!bridge) throw new Error("Hostile IPC probe preload missing");
          return bridge.invoke(channel);
        }, name),
      ),
    );
    for (const result of rejected) expect(result).toMatchObject({ code: -1 });

    // Keep the user-owned sniff bridge exercised; it may submit only tab-bound HTTP(S) candidates.
    await application.evaluate(
      ({ webContents }, { target, mediaUrl }) => {
        const contents = webContents
          .getAllWebContents()
          .find((entry) => entry.getURL() === target);
        if (!contents)
          throw new Error("Registered remote WebContents disappeared");
        return contents.executeJavaScript(
          `window.electron.browser.showDownloadDialog([{ name: 'fixture.mp4', url: ${JSON.stringify(mediaUrl)}, type: 'direct' }])`,
        );
      },
      { target: pageUrl, mediaUrl: mp4 },
    );
    await expect
      .poll(() =>
        application!.evaluate(({ webContents }) => {
          const overlay = webContents
            .getAllWebContents()
            .find((entry) => entry.getURL().endsWith("/download-dialog"));
          if (!overlay) throw new Error("Local download overlay missing");
          return overlay.executeJavaScript(
            "document.body.innerText + Array.from(document.querySelectorAll('input')).map(input => input.value).join(' ')",
          );
        }),
      )
      .toContain("fixture.mp4");
    const overlayEnvironment = await application.evaluate(({ webContents }) => {
      const overlay = webContents
        .getAllWebContents()
        .find((entry) => entry.getURL().endsWith("/download-dialog"));
      if (!overlay) throw new Error("Local download overlay missing");
      return overlay.executeJavaScript("window.electron.app.getEnvPath()");
    });
    expect(overlayEnvironment).toMatchObject({ code: 0 });

    const envPath = (await home.evaluate(async () => {
      const api = (
        window as Window & {
          electron?: { app?: { getEnvPath(): Promise<unknown> } };
        }
      ).electron;
      return api?.app?.getEnvPath();
    })) as { data?: { coreUrl?: string } };
    const coreUrl = envPath.data?.coreUrl;
    if (!coreUrl)
      throw new Error("Trusted app did not expose its local Core URL");
    const netstat = await promisify(execFile)(
      path.join(process.env.SystemRoot || "C:/Windows", "System32/netstat.exe"),
      ["-ano", "-p", "TCP"],
      { timeout: 15_000, windowsHide: true },
    );
    const corePort = new URL(coreUrl).port;
    const listeners = netstat.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter(
        (fields) =>
          fields.length === 5 &&
          fields[0] === "TCP" &&
          fields[1]?.endsWith(`:${corePort}`) &&
          fields[3] === "LISTENING" &&
          /^\d+$/.test(fields[4] || ""),
      )
      .map((fields) => ({ address: fields[1], pid: Number(fields[4]) }));
    expect(listeners.length).toBeGreaterThan(0);
    for (const listener of listeners)
      expect([`127.0.0.1:${corePort}`, `[::1]:${corePort}`]).toContain(
        listener.address,
      );
    await mkdir(
      path.join(ROOT, ".task/regression-20261006/downloads/artifacts"),
      {
        recursive: true,
      },
    );
    await writeFile(
      path.join(
        ROOT,
        ".task/regression-20261006/downloads/artifacts/core-listener.json",
      ),
      JSON.stringify({ coreUrl, listeners }, null, 2),
    );
    const unauthorizedStatus = await application.evaluate(
      ({ webContents }, { target, url }) => {
        const remote = webContents
          .getAllWebContents()
          .find((entry) => entry.getURL() === target);
        if (!remote) throw new Error("Remote test page disappeared");
        return remote.executeJavaScript(
          `fetch(${JSON.stringify(url)}, { credentials: 'omit' }).then(response => response.status)`,
        );
      },
      { target: pageUrl, url: `${coreUrl}/api/config` },
    );
    await test.info().attach("desktop-api-unauthorized-status.json", {
      body: JSON.stringify({ remoteHTTPStatus: unauthorizedStatus }),
      contentType: "application/json",
    });
    expect(unauthorizedStatus).toBe(401);
    expect((await fetch(`${coreUrl}/api/config`)).status).toBe(401);
    await home.evaluate((url) => {
      const frame = document.createElement("iframe");
      frame.id = "desktop-auth-negative-frame";
      frame.src = url;
      frame.style.display = "none";
      document.body.append(frame);
    }, `${fixture.origin}/frame?desktop-auth-negative`);
    await expect
      .poll(() =>
        home
          .frames()
          .some((frame) => frame.url().includes("desktop-auth-negative")),
      )
      .toBe(true);
    const remoteFrame = home
      .frames()
      .find((frame) => frame.url().includes("desktop-auth-negative"));
    if (!remoteFrame)
      throw new Error("Cross-origin security test iframe missing");
    expect(
      await remoteFrame.evaluate(
        async (url) => (await fetch(url, { credentials: "omit" })).status,
        `${coreUrl}/api/config`,
      ),
    ).toBe(401);
    await home.evaluate(() =>
      document.getElementById("desktop-auth-negative-frame")?.remove(),
    );
    const client = trustedCoreClient(home, coreUrl);
    const downloadsDirectory = path.join(runtimeRoot, "downloads");
    await mkdir(downloadsDirectory, { recursive: true });
    const localConfiguration = await client.setConfigKey(
      "local",
      downloadsDirectory,
    );
    expect(localConfiguration.success).toBe(true);
    const selectedSources = detectedTab.sources.filter(
      (source) =>
        source.url === mp4 || source.url === `${media.baseURL}/hls/index.m3u8`,
    );
    expect(selectedSources).toHaveLength(2);
    const directButtons = browser.getByRole("button", {
      name: "立即下载",
      exact: true,
    });
    await expect(directButtons).toHaveCount(2);
    for (let index = 0; index < 2; index++) {
      await expect(directButtons.nth(index)).toBeEnabled({ timeout: 30_000 });
      await directButtons.nth(index).click();
      await expect(
        browser.getByText("已加入下载任务", { exact: true }).last(),
      ).toBeVisible();
    }
    const listing = await client.getDownloadTasks({
      current: 1,
      pageSize: 100,
    });
    expect(listing.success).toBe(true);
    const created = { success: listing.success, data: listing.data.list };
    expect(created.data).toHaveLength(2);
    const taskIds = created.data.map((task) => task.id);
    await expect
      .poll(
        async () =>
          Promise.all(
            taskIds.map(async (id) => {
              const response = await client.getDownloadTask(id);
              return response.data.status;
            }),
          ),
        { timeout: 90_000, intervals: [1_000, 2_000, 3_000] },
      )
      .toEqual(["success", "success"]);
    const tasks = await Promise.all(
      taskIds.map(async (id) => (await client.getDownloadTask(id)).data),
    );
    const outputPaths = tasks.map((task) => {
      if (!task.outputPath)
        throw new Error(`Completed task ${task.id} has no merged output path`);
      return task.outputPath;
    });
    const outputs = await Promise.all(
      outputPaths.map((outputPath) => stat(outputPath)),
    );
    expect(outputs.every((output) => output.size > 0)).toBe(true);
    const signatures = await Promise.all(
      outputPaths.map(async (outputPath) =>
        (await readFile(outputPath)).toString("ascii", 4, 8),
      ),
    );
    expect(signatures).toEqual(["ftyp", "ftyp"]);
    const bundledFFmpeg = path.join(
      path.dirname(process.env.XIANGYING_E2E_EXECUTABLE || EXECUTABLE),
      "resources/deps/ffmpeg.exe",
    );
    const decodeResults = await Promise.all(
      outputPaths.map(async (outputPath) => {
        const result = await promisify(execFile)(
          bundledFFmpeg,
          [
            "-v",
            "error",
            "-i",
            outputPath,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0",
            "-f",
            "null",
            "-",
          ],
          { timeout: 30_000, windowsHide: true },
        );
        expect(result.stderr.trim()).toBe("");
        return { name: path.basename(outputPath), audioVideoDecoded: true };
      }),
    );
    const evidenceDirectory = path.join(
      ROOT,
      ".task/regression-20261006/downloads/artifacts/media",
    );
    await mkdir(evidenceDirectory, { recursive: true });
    const hlsOutput = tasks.find(
      (task) => task.type === CoreDownloadType.M3U8,
    )?.outputPath;
    if (!hlsOutput) throw new Error("Merged HLS fixture missing");
    await copyFile(hlsOutput, path.join(evidenceDirectory, "merged-hls.mp4"));
    await writeFile(
      path.join(evidenceDirectory, "audio-video-decode.json"),
      JSON.stringify(decodeResults, null, 2),
    );
    const imported = (await home.evaluate(async (paths) => {
      const api = (
        window as Window & {
          electron?: {
            library?: {
              importFiles(
                paths: string[],
                source?: "download",
              ): Promise<unknown>;
            };
          };
        }
      ).electron;
      if (!api?.library) throw new Error("Trusted library API missing");
      return api.library.importFiles(paths, "download");
    }, outputPaths)) as { code?: number; data?: { added?: number } };
    expect(imported.code).toBe(0);
    expect(imported.data?.added).toBe(2);
    const library = (await home.evaluate(async () => {
      const api = (
        window as Window & {
          electron?: { library?: { list(): Promise<unknown> } };
        }
      ).electron;
      return api?.library?.list();
    })) as { data?: { items?: Array<{ path: string; source: string }> } };
    expect(
      library.data?.items?.filter((item) =>
        tasks.some(
          (task) => task.outputPath === item.path && item.source === "download",
        ),
      ),
    ).toHaveLength(2);
    if (process.env.XIANGYING_PUBLIC_PROBE === "1") {
      const sourceProbe: Record<string, unknown> = {};
      try {
        unwrapIpcData(
          await browser.evaluate(async (id) => {
            const api = (
              window as Window & {
                electron?: {
                  browser?: { home(tabId: string): Promise<unknown> };
                };
              }
            ).electron;
            return api?.browser?.home(id);
          }, tabId),
        );
        await browser
          .getByRole("textbox", { name: "搜索影视名称" })
          .fill("熊出没");
        await browser
          .getByRole("button", { name: "搜索", exact: true })
          .click();
        const firstResult = browser
          .locator('[aria-labelledby="resource-search-title"] article')
          .first();
        await expect(firstResult).toBeVisible({ timeout: 25_000 });
        sourceProbe.provider = (
          await firstResult.locator("p").first().innerText()
        ).split(" · ")[0];
        await firstResult.getByRole("button").click();
        await firstResult.getByRole("checkbox").first().check();
        await browser
          .getByRole("button", { name: "加入下载任务", exact: true })
          .click();
        await expect(
          browser.getByText("已加入下载任务", { exact: true }).last(),
        ).toBeVisible();
        const selected = (
          await client.getDownloadTasks({ current: 1, pageSize: 100 })
        ).data.list.filter((task) => !taskIds.includes(task.id));
        sourceProbe.enqueued = selected.length;
        if (selected.length !== 1)
          throw new Error("Expected one explicitly selected resource task");
        const sourceId = selected[0]!.id;
        taskIds.push(sourceId);
        const inspectMedia = async (
          directory: string,
          depth = 0,
        ): Promise<{ files: number; bytes: number }> => {
          let files = 0;
          let bytes = 0;
          for (const entry of await readdir(directory, {
            withFileTypes: true,
          }).catch(() => [])) {
            if (entry.isSymbolicLink()) continue;
            const target = path.join(directory, entry.name);
            if (entry.isDirectory() && depth < 6) {
              const nested = await inspectMedia(target, depth + 1);
              files += nested.files;
              bytes += nested.bytes;
            } else if (
              entry.isFile() &&
              !outputPaths.includes(target) &&
              /\.(?:ts|mp4|m4s)$/i.test(entry.name)
            ) {
              const size = await stat(target).then(
                (file) => file.size,
                () => 0,
              );
              if (size > 1024) {
                files++;
                bytes += size;
              }
            }
          }
          return { files, bytes };
        };
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const task = (await client.getDownloadTask(sourceId)).data;
          const progress = await inspectMedia(downloadsDirectory);
          sourceProbe.status = task.status;
          sourceProbe.mediaFiles = progress.files;
          sourceProbe.mediaBytes = progress.bytes;
          if (
            progress.bytes > 0 ||
            task.status === "success" ||
            task.status === "error"
          )
            break;
          await browser.waitForTimeout(1_000);
        }
        await client.stopDownload(sourceId);
        sourceProbe.stoppedAfterProbe = true;
      } catch (error) {
        sourceProbe.error =
          error instanceof Error ? error.message : String(error);
      }
      await writeFile(
        path.join(
          ROOT,
          ".task/regression-20261006/downloads/artifacts/public-source-download-probe.json",
        ),
        JSON.stringify(sourceProbe, null, 2),
      );
      const targetUrl = "https://www.1905.com/vod/play/388459.shtml";
      const pageProbe: Record<string, unknown> = { targetUrl };
      try {
        unwrapIpcData(
          await browser.evaluate(async (id) => {
            const api = (
              window as Window & {
                electron?: {
                  browser?: { home(tabId: string): Promise<unknown> };
                };
              }
            ).electron;
            return api?.browser?.home(id);
          }, tabId),
        );
        await browser
          .getByRole("button", { name: "打开1905电影网", exact: true })
          .click();
        await expect
          .poll(async () =>
            browser.evaluate(async (id) => {
              const api = (
                window as Window & {
                  electron?: {
                    browser?: {
                      getTabs(): Promise<unknown>;
                    };
                  };
                }
              ).electron;
              const value = await api?.browser?.getTabs();
              if (!value || typeof value !== "object") return undefined;
              const result = value as {
                code?: unknown;
                data?: unknown;
                tabs?: unknown;
              };
              const payload =
                typeof result.code === "number" ? result.data : result;
              if (!payload || typeof payload !== "object") return undefined;
              const tabs = (payload as { tabs?: unknown }).tabs;
              const match = Array.isArray(tabs)
                ? tabs.find((tab: unknown) =>
                    Boolean(
                      tab &&
                      typeof tab === "object" &&
                      (tab as { id?: unknown }).id === id,
                    ),
                  )
                : undefined;
              return match &&
                typeof match === "object" &&
                typeof (match as { url?: unknown }).url === "string"
                ? (match as { url: string }).url
                : undefined;
            }, tabId),
          )
          .toBe("https://www.1905.com/vod/");
        pageProbe.websiteEntryClicked = true;
        const loaded = await browser.evaluate(
          async ({ id, url }) => {
            const api = (
              window as Window & {
                electron?: {
                  browser?: {
                    loadURL(tabId: string, url: string): Promise<unknown>;
                  };
                };
              }
            ).electron;
            if (!api?.browser) throw new Error("Browser API missing");
            return api.browser.loadURL(id, url);
          },
          { id: tabId, url: targetUrl },
        );
        unwrapIpcData(loaded);
        const playing = await application.evaluate(
          async ({ webContents }, url) => {
            const page = webContents
              .getAllWebContents()
              .find((candidate) => candidate.getURL().startsWith(url));
            if (!page) return { loaded: false };
            return page.executeJavaScript(
              `(async () => { const video = document.querySelector('video'); if (!video) return { loaded: true, video: false, title: document.title }; let playResult; try { playResult = await Promise.race([video.play().then(() => 'started', () => 'rejected'), new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))]); } catch { playResult = 'rejected'; } return { loaded: true, video: true, paused: video.paused, playResult, title: document.title }; })()`,
            );
          },
          targetUrl,
        );
        pageProbe.page = playing;
        await browser.waitForTimeout(5_000);
        const state = readBrowserTabs(
          await browser.evaluate(async () => {
            const api = (
              window as Window & {
                electron?: { browser?: { getTabs(): Promise<unknown> } };
              }
            ).electron;
            return api?.browser?.getTabs();
          }),
        );
        const candidates =
          state.tabs.find((tab) => tab.id === tabId)?.sources ?? [];
        pageProbe.detected = candidates.map((source) => ({
          type: source.type,
        }));
        pageProbe.detectedCount = candidates.length;
        pageProbe.downloadButtonCount = await browser
          .getByRole("button", { name: "立即下载", exact: true })
          .count();
        if (candidates.length > 0) {
          await browser
            .getByRole("button", { name: "立即下载", exact: true })
            .first()
            .click();
          await expect(
            browser.getByText("已加入下载任务", { exact: true }).last(),
          ).toBeVisible();
          const newTasks = (
            await client.getDownloadTasks({ current: 1, pageSize: 100 })
          ).data.list.filter((task) => !taskIds.includes(task.id));
          pageProbe.newTaskCount = newTasks.length;
          for (const task of newTasks) await client.stopDownload(task.id);
        }
        await browser.screenshot({
          path: path.join(
            ROOT,
            ".task/regression-20261006/downloads/artifacts/1905-window.png",
          ),
        });
      } catch (error) {
        pageProbe.error =
          error instanceof Error ? error.message : String(error);
      }
      await writeFile(
        path.join(
          ROOT,
          ".task/regression-20261006/downloads/artifacts/1905-public-probe.json",
        ),
        JSON.stringify(pageProbe, null, 2),
      );
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (application) {
      await application
        .evaluate(({ app }) => app.quit())
        .catch(() => undefined);
      await application.close().catch(() => undefined);
      if (mainIdentity)
        expect(await waitForWindowsProcessExit(mainIdentity, 5_000)).toBe(true);
    }
    if (processOutput) {
      const evidenceDirectory = path.join(
        ROOT,
        ".task/regression-20261006/downloads/artifacts",
      );
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(
        path.join(evidenceDirectory, "packaged-main-process-output.json"),
        JSON.stringify(
          {
            launchMode:
              process.env.XIANGYING_E2E_LAUNCH_MODE || "default-sandbox",
            executable: process.env.XIANGYING_E2E_EXECUTABLE || EXECUTABLE,
            runtimeRoot,
            corePort: process.env.MEDIAGO_CORE_PORT || "39719",
            gpuProbe: process.env.XIANGYING_GPU_PROBE === "1",
            publicProbe: process.env.XIANGYING_PUBLIC_PROBE === "1",
            outputTail: processOutput.logTail(),
          },
          null,
          2,
        ),
        "utf8",
      );
      processOutput.dispose();
    }
    await media.close();
    await fixture.close();
    if (!failed)
      await rm(runtimeRoot, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 500,
      });
  }
});
