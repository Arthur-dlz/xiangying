import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  _electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import type { PlatformApi, ResourceProvider } from "@mediago/common";
import {
  IPC,
  IpcEvent,
} from "../../../packages/common/src/constants/events.ts";
import { trustedCoreClient } from "../support/xiangying-core-client.ts";
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
  ".task/closure-20261007/security-search/evidence",
);
const requestedBindingPath = process.env.MEDIAGO_REMEDIATION_BINDING;
if (requestedBindingPath && !path.isAbsolute(requestedBindingPath)) {
  throw new Error("MEDIAGO_REMEDIATION_BINDING must be an absolute path");
}
const BINDING_PATH =
  requestedBindingPath ??
  path.join(ROOT, ".task/closure-20261007/root/candidate-binding.json");
const CORE_PORT = Number(process.env.MEDIAGO_CORE_PORT || 39_939);
const execFileAsync = promisify(execFile);

declare global {
  interface Window {
    electron: PlatformApi;
  }
}

interface CandidateBinding {
  candidate: string;
  exeSha256: string;
  asarSha256: string;
  coreSha256: string;
}

interface ProbeSnapshot {
  lookupHosts: string[];
  fetchURLs: string[];
  queryCalls: Record<string, number>;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function unwrap<T>(value: unknown): T {
  if (typeof value !== "object" || value === null)
    throw new Error("Candidate app API returned no result");
  const envelope = value as { code?: number; data?: T; message?: string };
  if (envelope.code !== 0)
    throw new Error(
      `Candidate app API failed: ${envelope.message ?? envelope.code}`,
    );
  return envelope.data as T;
}

function isMainPage(page: Page): boolean {
  if (page.isClosed()) return false;
  try {
    const url = new URL(page.url());
    return (
      url.protocol === "xiangying:" &&
      url.hostname === "index.html" &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
}

function isDownloadOverlayPage(page: Page): boolean {
  if (page.isClosed()) return false;
  try {
    const url = new URL(page.url());
    return (
      url.protocol === "xiangying:" &&
      url.hostname === "index.html" &&
      url.pathname === "/download-dialog"
    );
  } catch {
    return false;
  }
}

async function readCoreListener(): Promise<
  { pid: number; localAddress: string; localPort: number } | undefined
> {
  const script = `$ErrorActionPreference='Stop'; $items=@(Get-NetTCPConnection -State Listen -LocalPort ${CORE_PORT} -ErrorAction SilentlyContinue | Select-Object OwningProcess,LocalAddress,LocalPort); if ($items.Count -eq 0) { [Console]::Out.Write('[]') } else { [Console]::Out.Write(($items | ConvertTo-Json -Compress)) }`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 15_000, windowsHide: true, encoding: "utf8" },
  );
  const parsed: unknown = JSON.parse(stdout.trim());
  const rows = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (
      value,
    ): value is {
      OwningProcess: number;
      LocalAddress: string;
      LocalPort: number;
    } => typeof value === "object" && value !== null,
  );
  if (rows.length === 0) return undefined;
  const pids = [...new Set(rows.map((row) => Number(row.OwningProcess)))];
  const pid = pids.at(0);
  if (pids.length !== 1 || pid === undefined || !Number.isInteger(pid))
    throw new Error(`Core port ${CORE_PORT} has ambiguous listener owners`);
  return {
    pid,
    localAddress: String(rows[0]?.LocalAddress),
    localPort: Number(rows[0]?.LocalPort),
  };
}

async function mainPage(application: ElectronApplication): Promise<Page> {
  await expect.poll(() => application.windows().some(isMainPage)).toBe(true);
  const page = application.windows().find(isMainPage);
  if (!page) throw new Error("Candidate main page was not found");
  return page;
}

async function downloadOverlayPage(
  application: ElectronApplication,
): Promise<Page> {
  const pages = () =>
    [...application.context().pages(), ...application.windows()].filter(
      (page, index, all) => all.indexOf(page) === index,
    );
  await expect.poll(() => pages().some(isDownloadOverlayPage)).toBe(true);
  const overlay = pages().find(isDownloadOverlayPage);
  if (!overlay)
    throw new Error("Candidate download overlay Page was not found");
  return overlay;
}

async function installControlledResourceSearchIO(
  application: ElectronApplication,
): Promise<void> {
  await application.evaluate(({ net }) => {
    const runtime = process as NodeJS.Process & {
      getBuiltinModule?: (name: string) => Record<string, unknown>;
    };
    const moduleAPI = runtime.getBuiltinModule?.("node:module") as
      | {
          createRequire(filename: string): (id: string) => unknown;
          syncBuiltinESMExports(): void;
        }
      | undefined;
    if (!moduleAPI || typeof net.fetch !== "function")
      throw new Error("Candidate controlled-I/O seam is unavailable");
    const requireBuiltin = moduleAPI.createRequire(process.execPath);
    const dns = requireBuiltin("node:dns/promises") as {
      lookup: (...args: unknown[]) => Promise<unknown>;
    };
    const state = {
      lookupHosts: [] as string[],
      fetchURLs: [] as string[],
      queryCalls: {} as Record<string, number>,
      oldLookup: dns.lookup,
      oldFetch: net.fetch,
    };
    dns.lookup = async (hostname: unknown) => {
      const host = String(hostname);
      state.lookupHosts.push(host);
      if (host === "127.0.0.1") return [{ address: "127.0.0.1", family: 4 }];
      if (host === "dns-timeout.fixture.invalid")
        return new Promise(() => undefined);
      return [{ address: "93.184.216.34", family: 4 }];
    };
    moduleAPI.syncBuiltinESMExports();
    net.fetch = async (input, init) => {
      const url = new URL(String(input));
      const query = url.searchParams.get("wd") || "";
      state.fetchURLs.push(url.href);
      state.queryCalls[query] = (state.queryCalls[query] || 0) + 1;

      if (url.hostname === "redirect.fixture.invalid")
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        });
      if (url.hostname === "timeout.fixture.invalid")
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      if (query === "超大响应")
        return new Response('{"list":[]}', {
          status: 200,
          headers: { "content-length": String(4 * 1024 * 1024 + 1) },
        });

      const respond = () => {
        let list =
          query === "无结果"
            ? []
            : query === "两页元数据"
              ? url.searchParams.get("pg") === "2"
                ? [
                    {
                      vod_id: "unknown-metadata-page-2",
                      vod_name: "第二页缺失元数据项",
                      vod_play_url:
                        "正片$https://media.fixture.invalid/page-two.mp4#备用播放页$https://page.fixture.invalid/episode",
                    },
                  ]
                : Array.from({ length: 20 }, (_, index) => ({
                    vod_id: `page-one-${index + 1}`,
                    vod_name:
                      index === 0
                        ? "第一页详情与集数项"
                        : `第一页受控结果 ${index + 1}`,
                    vod_year: index === 0 ? "2026" : undefined,
                    vod_lang: index === 0 ? "中文" : undefined,
                    vod_remarks: index === 0 ? "1080p" : undefined,
                    type_name: index === 0 ? "受控分类" : undefined,
                    vod_play_url:
                      index === 0
                        ? "正片$https://media.fixture.invalid/page-one.mp4#备用播放页$https://page.fixture.invalid/episode"
                        : undefined,
                  }))
              : [
                  {
                    vod_id: `fixture-${query}`,
                    vod_name:
                      query === "旧查询迟到结果"
                        ? "STALE_CLOSURE_RESULT"
                        : "受控服务结果",
                    vod_year: "2026",
                    vod_lang: "中文",
                    vod_remarks: "1080p",
                    type_name: "受控分类",
                    vod_play_url:
                      "网页播放页$https://page.fixture.invalid/watch?marker=page-dummy#媒体直链$https://media.fixture.invalid/sample.mp4?marker=media-dummy",
                  },
                ];
        return new Response(JSON.stringify({ list }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      if (query === "旧查询迟到结果")
        return new Promise((resolve) =>
          setTimeout(() => resolve(respond()), 900),
        );
      return Promise.resolve(respond());
    };
    Object.assign(globalThis, {
      closureResourceSearchIO: state,
    });
  });
}

async function restoreControlledResourceSearchIO(
  application: ElectronApplication,
): Promise<void> {
  await application.evaluate(({ net }) => {
    const state = (
      globalThis as typeof globalThis & {
        closureResourceSearchIO?: {
          oldLookup: (...args: unknown[]) => Promise<unknown>;
          oldFetch: typeof net.fetch;
        };
      }
    ).closureResourceSearchIO;
    if (!state) return;
    const moduleAPI = process.getBuiltinModule?.("node:module") as
      | {
          createRequire(filename: string): (id: string) => unknown;
          syncBuiltinESMExports(): void;
        }
      | undefined;
    if (!moduleAPI)
      throw new Error("Node module API disappeared before restore");
    const dns = moduleAPI.createRequire(process.execPath)(
      "node:dns/promises",
    ) as { lookup: (...args: unknown[]) => Promise<unknown> };
    dns.lookup = state.oldLookup;
    moduleAPI.syncBuiltinESMExports();
    net.fetch = state.oldFetch;
    delete (
      globalThis as typeof globalThis & {
        closureResourceSearchIO?: unknown;
      }
    ).closureResourceSearchIO;
  });
}

async function resourceSearchIOSnapshot(
  application: ElectronApplication,
): Promise<ProbeSnapshot> {
  return application.evaluate(() => {
    const state = (
      globalThis as typeof globalThis & {
        closureResourceSearchIO?: ProbeSnapshot;
      }
    ).closureResourceSearchIO;
    if (!state) throw new Error("Controlled I/O counters were not installed");
    return {
      lookupHosts: [...state.lookupHosts],
      fetchURLs: [...state.fetchURLs],
      queryCalls: { ...state.queryCalls },
    };
  });
}

async function installNativeNoopObserver(
  application: ElectronApplication,
): Promise<void> {
  await application.evaluate(({ shell, dialog }) => {
    const shellAPI = shell as unknown as {
      openPath: (path: string) => Promise<string>;
      openExternal: (url: string) => Promise<void>;
    };
    const dialogAPI = dialog as unknown as {
      showOpenDialog: (...args: unknown[]) => Promise<{
        canceled: boolean;
        filePaths: string[];
      }>;
      showSaveDialog: (...args: unknown[]) => Promise<{
        canceled: boolean;
        filePath?: string;
      }>;
    };
    const state = {
      calls: { openPath: 0, openExternal: 0, openDialog: 0, saveDialog: 0 },
      original: {
        openPath: shellAPI.openPath,
        openExternal: shellAPI.openExternal,
        showOpenDialog: dialogAPI.showOpenDialog,
        showSaveDialog: dialogAPI.showSaveDialog,
      },
    };
    shellAPI.openPath = async () => {
      state.calls.openPath += 1;
      return "";
    };
    shellAPI.openExternal = async () => {
      state.calls.openExternal += 1;
    };
    dialogAPI.showOpenDialog = async () => {
      state.calls.openDialog += 1;
      return { canceled: true, filePaths: [] };
    };
    dialogAPI.showSaveDialog = async () => {
      state.calls.saveDialog += 1;
      return { canceled: true };
    };
    Object.assign(globalThis, { closureNativeEffects: state });
  });
}

async function nativeNoopObserverSnapshot(
  application: ElectronApplication,
): Promise<Record<string, number>> {
  return application.evaluate(() => {
    const state = (
      globalThis as typeof globalThis & {
        closureNativeEffects?: { calls: Record<string, number> };
      }
    ).closureNativeEffects;
    if (!state)
      throw new Error("Native side-effect observer was not installed");
    return { ...state.calls };
  });
}

async function restoreNativeNoopObserver(
  application: ElectronApplication,
): Promise<void> {
  await application.evaluate(({ shell, dialog }) => {
    const state = (
      globalThis as typeof globalThis & {
        closureNativeEffects?: {
          original: {
            openPath: (path: string) => Promise<string>;
            openExternal: (url: string) => Promise<void>;
            showOpenDialog: (...args: unknown[]) => Promise<{
              canceled: boolean;
              filePaths: string[];
            }>;
            showSaveDialog: (...args: unknown[]) => Promise<{
              canceled: boolean;
              filePath?: string;
            }>;
          };
        };
      }
    ).closureNativeEffects;
    if (!state) return;
    Object.assign(shell, {
      openPath: state.original.openPath,
      openExternal: state.original.openExternal,
    });
    Object.assign(dialog, {
      showOpenDialog: state.original.showOpenDialog,
      showSaveDialog: state.original.showSaveDialog,
    });
    delete (
      globalThis as typeof globalThis & { closureNativeEffects?: unknown }
    ).closureNativeEffects;
  });
}

async function startSniffFixture(): Promise<{
  origin: string;
  sampleSha256: string;
  sampleHits(): number;
  sampleHeadHits(): number;
  privateSampleCookieRequestCount(): number;
  privateSampleRequestHadDummyCookie(): boolean;
  pathHits(pathname: string): number;
  hlsRequests(): Array<{
    method: string;
    pathAndQuery: string;
    hasDummyCookie: boolean;
    hasSecFetchMetadata: boolean;
    hasBrowserUserAgent: boolean;
  }>;
  close(): Promise<void>;
}> {
  const sample = await readFile(
    path.join(ROOT, "tests/media-service/public/v1/sample.mp4"),
  );
  let sampleHits = 0;
  let sampleHeadHits = 0;
  let privateSampleCookieRequestCount = 0;
  let privateSampleRequestHadDummyCookie = false;
  let fixtureOrigin = "";
  const requestHits: Record<string, number> = {};
  const hlsRequestObservations: Array<{
    method: string;
    pathAndQuery: string;
    hasDummyCookie: boolean;
    hasSecFetchMetadata: boolean;
    hasBrowserUserAgent: boolean;
  }> = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requestHits[url.pathname] = (requestHits[url.pathname] || 0) + 1;
    if (url.pathname === "/hls/master.m3u8") {
      const userAgent = request.headers["user-agent"] ?? "";
      hlsRequestObservations.push({
        method: request.method ?? "",
        pathAndQuery: `${url.pathname}${url.search}`,
        hasDummyCookie: (request.headers.cookie ?? "").includes(
          "closure_hls_cookie_marker",
        ),
        hasSecFetchMetadata: Boolean(
          request.headers["sec-fetch-site"] ||
          request.headers["sec-fetch-mode"] ||
          request.headers["sec-fetch-dest"],
        ),
        hasBrowserUserAgent: /Mozilla\//i.test(userAgent),
      });
      response.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl",
        "cache-control": "no-store",
      });
      response.end(
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n",
      );
      return;
    }
    if (url.pathname === "/hostile") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Untrusted local page</title>");
      return;
    }
    if (url.pathname === "/watch") {
      const mediaURL = `${fixtureOrigin}/private/sample.mp4?mediaToken=closure_url_dummy`;
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie":
          "closure_cookie_dummy=closure_header_dummy; HttpOnly; SameSite=Lax; Path=/private",
      });
      response.end(
        `<!doctype html><title>Controlled watch page</title><video autoplay muted preload="auto" src=${JSON.stringify(mediaURL)}></video>`,
      );
      return;
    }
    if (url.pathname === "/watch-public") {
      const mediaURL = `${fixtureOrigin}/public/sample.mp4?mediaToken=closure_url_dummy`;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><title>Controlled public watch page</title><video autoplay muted preload="auto" src=${JSON.stringify(mediaURL)}></video>`,
      );
      return;
    }
    if (url.pathname === "/watch-hls") {
      const run = url.searchParams.get("run") ?? "missing-run-id";
      const playlistURL = `${fixtureOrigin}/hls/master.m3u8?run=${encodeURIComponent(run)}`;
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie":
          "closure_hls_cookie_marker=closure_hls_value_dummy; HttpOnly; SameSite=Lax; Path=/hls",
        "cache-control": "no-store",
      });
      response.end(
        `<!doctype html><title>Controlled HLS watch page</title><script>fetch(${JSON.stringify(playlistURL)}, { credentials: "same-origin", cache: "no-store" }).then((response) => response.text()).catch(() => undefined);</script>`,
      );
      return;
    }
    if (url.pathname === "/login" || url.pathname === "/drm-indicated") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><title>${url.pathname === "/login" ? "Login required" : "DRM indicated"}</title><main>${url.pathname === "/login" ? "Login required" : "Protected DRM content"}</main>`,
      );
      return;
    }
    if (
      url.pathname === "/sample.mp4" ||
      url.pathname === "/private/sample.mp4" ||
      url.pathname === "/public/sample.mp4"
    ) {
      if (url.pathname === "/private/sample.mp4") {
        const hasCookieMarker = (request.headers.cookie ?? "").includes(
          "closure_header_dummy",
        );
        if (hasCookieMarker) privateSampleCookieRequestCount += 1;
        privateSampleRequestHadDummyCookie ||= hasCookieMarker;
      }
      if (request.method === "GET") sampleHits += 1;
      if (request.method === "HEAD") sampleHeadHits += 1;
      response.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": String(sample.length),
        "accept-ranges": "none",
      });
      response.end(request.method === "HEAD" ? undefined : sample);
      return;
    }
    if (
      url.pathname === "/edit-old.mp4" ||
      url.pathname === "/edit-new.mp4" ||
      url.pathname === "/edit-sensitive.mp4"
    ) {
      response.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": String(sample.length),
        "accept-ranges": "none",
      });
      response.end(request.method === "HEAD" ? undefined : sample);
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
    throw new Error("Sniff fixture did not bind loopback");
  fixtureOrigin = `http://127.0.0.1:${address.port}`;
  return {
    origin: fixtureOrigin,
    sampleSha256: sha256(sample),
    sampleHits: () => sampleHits,
    sampleHeadHits: () => sampleHeadHits,
    privateSampleCookieRequestCount: () => privateSampleCookieRequestCount,
    privateSampleRequestHadDummyCookie: () =>
      privateSampleRequestHadDummyCookie,
    pathHits: (pathname) => requestHits[pathname] || 0,
    hlsRequests: () =>
      hlsRequestObservations.map((item) => Object.assign({}, item)),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test.skip(
  process.platform !== "win32",
  "closure candidate acceptance is Windows-only",
);

test("candidate search UI uses the real service with controlled I/O and preserves negative states", async () => {
  test.setTimeout(180_000);
  await mkdir(EVIDENCE, { recursive: true });
  const testSourceSha256 = sha256(readFileSync(fileURLToPath(import.meta.url)));
  await assertPortFree(
    "127.0.0.1",
    CORE_PORT,
    "security-search candidate Core",
  );
  const bindingBytes = await readFile(BINDING_PATH);
  const binding = JSON.parse(bindingBytes.toString("utf8")) as CandidateBinding;
  const bindingSha256 = sha256(bindingBytes);
  const candidate = path.resolve(binding.candidate);
  const executable = path.join(candidate, "乡映.exe");
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    executable,
  );
  const asarSha256 = sha256(
    await readFile(path.join(candidate, "resources/app.asar")),
  );
  const coreSha256 = sha256(
    await readFile(path.join(candidate, "resources/bin/mediago-core.exe")),
  );
  expect(asarSha256).toBe(binding.asarSha256);
  expect(coreSha256).toBe(binding.coreSha256);

  const sniffFixture = await startSniffFixture();
  const runtimeRoot = path.join(EVIDENCE, `runtime-${Date.now()}`);
  const tempDir = path.join(runtimeRoot, "temp");
  await Promise.all([
    mkdir(path.join(runtimeRoot, "appdata"), { recursive: true }),
    mkdir(path.join(runtimeRoot, "localappdata"), { recursive: true }),
    mkdir(path.join(runtimeRoot, "data"), { recursive: true }),
    mkdir(path.join(runtimeRoot, "downloads"), { recursive: true }),
    mkdir(tempDir, { recursive: true }),
  ]);
  let application: ElectronApplication | undefined;
  let owner: WindowsProcessIdentity | undefined;
  let coreListener: Awaited<ReturnType<typeof readCoreListener>>;
  let coreOwner: WindowsProcessIdentity | undefined;
  let processExited = false;
  let coreProcessExited = false;
  let corePortFreed = false;
  let runtimeRootRemoved = false;
  let shimRestored = false;
  let passed = false;
  const phaseCheckpoints: string[] = [];
  let selectedMainPageUrl: string | undefined;
  let probe: ProbeSnapshot | undefined;
  let observedWatchUrl: string | undefined;
  let observedMediaUrl: string | undefined;
  let observedWatchSources: Array<{
    url: string;
    documentURL: string;
    type: string;
    mediaInfo?: {
      playlistType?: string;
      maxQuality?: string;
      variants?: unknown[];
    };
  }> = [];
  let observedWatchSourcesContainDummyHeaderMarker = false;
  let privateSourceEventSummary:
    | {
        sourceKeys: string[];
        hasHeadersField: boolean;
        headerNames: string[];
        hasCookieHeader: boolean;
        hasAuthorizationHeader: boolean;
        hasProxyAuthorizationHeader: boolean;
        hasDummyCookieMarker: boolean;
        hasDummyAuthorizationMarker: boolean;
      }
    | undefined;
  let defaultSnapshotHeaderRedactionSummary:
    | {
        sourceKeys: string[];
        hasHeadersField: boolean;
        hasDummyMarker: boolean;
      }
    | undefined;
  let observedSniffOutputSha256: string | undefined;
  let observedPublicSniffSources: Array<{
    url: string;
    documentURL: string;
    type: string;
  }> = [];
  let downloadOverlayURL: string | undefined;
  let downloadOverlayHasExpectedMediaURL = false;
  let downloadOverlayHasDummyHeader = false;
  let sniffTaskId: number | undefined;
  let urlEditTaskId: number | undefined;
  let oldAddressRequests = 0;
  let newAddressRequests = 0;
  let sensitiveAddressRequests = 0;
  let sensitiveHeaderAttemptRejected = false;
  let sensitiveHeaderUiRejectionSummary:
    | {
        overlayURL: string;
        hlsType: string;
        headersFieldCount: number;
        postStatus: number;
        requestHadDummyCookie: boolean;
        requestHadDummyAuthorization: boolean;
        responseHadDummyMarker: boolean;
        toastVisible: boolean;
        toastHadDummyMarker: boolean;
        toastMessageVisible: boolean;
        taskCountBefore: number;
        taskCountAfter: number;
        hlsRequestDelta: number;
        sampleMediaRequestDelta: number;
      }
    | undefined;
  let editedOutputSha256: string | undefined;
  let editedTaskAndLogsRedacted = false;
  let defaultSnapshotAndPanelRedaction = false;
  let hlsInspectionProbe:
    | {
        watchURL: string;
        masterPathAndQuery: string;
        browserRequestCount: number;
        browserRequestHadDummyCookie: boolean;
        inspectorRequestCount: number;
        inspectorRequestHadDummyCookie: boolean;
        sourceObserved: boolean;
        playlistType?: string;
        sourceEventHasHeadersField: boolean;
        sourceEventHasDummyCookie: boolean;
        sourceEventHeaderNames: string[];
        sourceEventHasCookieHeader: boolean;
        sourceEventHasAuthorizationHeader: boolean;
        sourceEventHasProxyAuthorizationHeader: boolean;
      }
    | undefined;
  let publicDownloadSubmitSummary:
    | {
        overlayURL: string;
        formHasExpectedURL: boolean;
        formHasName: boolean;
        formHasType: boolean;
        formHasNoSensitiveHeaders: boolean;
        headersFieldCount: number;
        publicHeaderNames: string[];
        formValidBeforeSubmit: boolean;
        submitButtonCount: number;
        postPaths: string[];
        postResponseStatuses: number[];
        pageErrorCount: number;
        submissionSignalObserved: boolean;
        formErrorCountAfterSubmit: number;
        formAlertCountAfterSubmit: number;
        toastVisibleAfterSubmit: boolean;
        taskCountBefore: number;
        taskCountAfter: number;
      }
    | undefined;
  let loginPageHadNoMedia = false;
  let drmIndicatedPageHadNoMedia = false;
  let hostileDenials: Array<{ code?: number; message?: string }> = [];
  let nativeSideEffectCounts: Record<string, number> | undefined;
  let sentinelSha256Before: string | undefined;
  let sentinelSha256After: string | undefined;
  let providerConfigSha256Before: string | undefined;
  let providerConfigSha256After: string | undefined;
  let nativeObserverRestored = false;
  const failure = { message: "" };
  try {
    const childEnvironment = scrubElectronEnvironment(process.env);
    delete childEnvironment.ELECTRON_RUN_AS_NODE;
    delete childEnvironment.NODE_OPTIONS;
    const launched = await _electron.launch({
      executablePath: executable,
      timeout: 30_000,
      env: {
        ...childEnvironment,
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
    application = launched;
    const processId = launched.process().pid;
    if (!processId) throw new Error("Candidate process has no PID");
    owner = await readWindowsProcessIdentity(processId);
    if (!owner) throw new Error("Candidate process identity is unavailable");
    await expect
      .poll(async () => await readCoreListener(), { timeout: 20_000 })
      .toBeTruthy();
    coreListener = await readCoreListener();
    if (!coreListener || coreListener.localPort !== CORE_PORT)
      throw new Error("Candidate Core listener identity was not captured");
    coreOwner = await readWindowsProcessIdentity(coreListener.pid);
    if (!coreOwner)
      throw new Error("Candidate Core process identity is unavailable");
    const page = await mainPage(launched);
    selectedMainPageUrl = page.url();
    const envPath = unwrap<{ coreUrl: string }>(
      await page.evaluate(() => window.electron.app.getEnvPath()),
    );
    if (!envPath.coreUrl) throw new Error("Candidate Core URL is unavailable");
    const client = trustedCoreClient(page, envPath.coreUrl);
    await client.setConfig({ language: "zh" });
    expect(
      (await client.setConfigKey("local", path.join(runtimeRoot, "downloads")))
        .success,
    ).toBe(true);
    await page.reload();
    await installControlledResourceSearchIO(launched);

    const saveProviders = async (providers: ResourceProvider[]) =>
      page.evaluate(async (value) => {
        try {
          const response = (await window.electron.resourceSearch.saveProviders(
            value,
          )) as { code?: number; data?: unknown; message?: string };
          return response.code === 0
            ? { ok: true, providers: response.data }
            : { ok: false, message: response.message ?? response.code };
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }, providers);

    const privateProvider: ResourceProvider = {
      id: "closure-private",
      name: "受控私网源",
      apiUrl: "https://127.0.0.1/api.php",
      enabled: true,
    };
    expect(await saveProviders([privateProvider])).toMatchObject({ ok: true });
    await page.locator('nav a[href="/source"]').first().click();
    const search = page.getByRole("textbox", { name: "搜索影视名称" });
    await search.fill("DNS shim preflight");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "非公网 IP" }),
    ).toContainText("非公网 IP");
    const privatePreflight = await resourceSearchIOSnapshot(launched);
    expect(privatePreflight.lookupHosts).toContain("127.0.0.1");
    expect(privatePreflight.fetchURLs).toHaveLength(0);

    const good: ResourceProvider = {
      id: "closure-good",
      name: "受控成功源",
      apiUrl: "https://good.fixture.invalid/api.php",
      enabled: true,
    };
    const redirect: ResourceProvider = {
      id: "closure-redirect",
      name: "受控跳转源",
      apiUrl: "https://redirect.fixture.invalid/api.php",
      enabled: true,
    };
    expect(await saveProviders([good, redirect])).toMatchObject({ ok: true });

    const sourceLink = page.locator('nav a[href="/source"]').first();
    await expect(sourceLink).toBeVisible();
    await sourceLink.click();
    await search.fill("受控混合结果");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "受控服务结果" }),
    ).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "部分资源源搜索失败" }),
    ).toContainText("部分资源源搜索失败");
    await expect(page.getByText("受控成功源", { exact: false })).toBeVisible();
    const mixedSnapshot = await resourceSearchIOSnapshot(launched);
    expect(mixedSnapshot.lookupHosts).toEqual(
      expect.arrayContaining([
        "good.fixture.invalid",
        "redirect.fixture.invalid",
      ]),
    );
    expect(
      mixedSnapshot.fetchURLs.some((url) =>
        url.includes("good.fixture.invalid"),
      ),
    ).toBe(true);
    expect(
      mixedSnapshot.fetchURLs.some((url) =>
        url.includes("redirect.fixture.invalid"),
      ),
    ).toBe(true);

    const invalidCredential = await saveProviders([
      { ...good, apiUrl: "https://dummy:dummy@good.fixture.invalid/api.php" },
    ]);
    expect(invalidCredential).toMatchObject({ ok: false });
    const invalidPort = await saveProviders([
      { ...good, apiUrl: "https://good.fixture.invalid:8443/api.php" },
    ]);
    expect(invalidPort).toMatchObject({ ok: false });

    expect(
      await saveProviders([
        {
          id: "closure-private",
          name: "受控私网源",
          apiUrl: "https://127.0.0.1/api.php",
          enabled: true,
        },
      ]),
    ).toMatchObject({ ok: true });
    const beforePrivate = await resourceSearchIOSnapshot(launched);
    await search.fill("私网应拒绝");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "非公网 IP" }),
    ).toContainText("非公网 IP");
    const afterPrivate = await resourceSearchIOSnapshot(launched);
    expect(afterPrivate.lookupHosts.at(-1)).toBe("127.0.0.1");
    expect(afterPrivate.fetchURLs).toHaveLength(beforePrivate.fetchURLs.length);

    expect(await saveProviders([good])).toMatchObject({ ok: true });
    await search.fill("两页元数据");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    const firstPageItem = page
      .locator("article")
      .filter({ hasText: "第一页详情与集数项" });
    await expect(firstPageItem).toBeVisible();
    await firstPageItem.getByRole("button", { name: "选择地址（2）" }).click();
    await expect(
      firstPageItem.getByText("正片", { exact: true }),
    ).toBeVisible();
    await expect(
      firstPageItem.getByText("备用播放页", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "加载更多", exact: true }).click();
    const secondPageItem = page
      .locator("article")
      .filter({ hasText: "第二页缺失元数据项" });
    await expect(secondPageItem).toBeVisible();
    await expect(secondPageItem).toContainText("未知 · 未知 · 未知");
    await expect(
      secondPageItem.getByRole("button", { name: "选择地址（2）" }),
    ).toBeVisible();

    await search.fill("无结果");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(
      page.getByText("未找到匹配结果。", { exact: true }),
    ).toBeVisible();

    await search.fill("超大响应");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("4 MiB");

    expect(
      await saveProviders([
        {
          id: "closure-timeout",
          name: "受控超时源",
          apiUrl: "https://timeout.fixture.invalid/api.php",
          enabled: true,
        },
      ]),
    ).toMatchObject({ ok: true });
    await search.fill("超时");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("超时", {
      timeout: 20_000,
    });

    expect(await saveProviders([good])).toMatchObject({ ok: true });
    await search.fill("旧查询迟到结果");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await resourceSearchIOSnapshot(launched)).queryCalls[
            "旧查询迟到结果"
          ],
      )
      .toBe(1);
    await search.fill("新查询");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "受控服务结果" }),
    ).toBeVisible();
    await expect(
      page.getByText("STALE_CLOSURE_RESULT", { exact: true }),
    ).toHaveCount(0);
    await page.waitForTimeout(1_100);
    await expect(
      page.getByText("STALE_CLOSURE_RESULT", { exact: true }),
    ).toHaveCount(0);

    const sentinelPath = path.join(runtimeRoot, "hostile-file-sentinel.txt");
    const providerConfigPath = path.join(
      runtimeRoot,
      "data/resource-search-providers.json",
    );
    await writeFile(sentinelPath, "closure-file-sentinel-dummy\n", "utf8");
    sentinelSha256Before = sha256(await readFile(sentinelPath));
    providerConfigSha256Before = sha256(await readFile(providerConfigPath));
    await installNativeNoopObserver(launched);
    const hostilePreload = path.join(runtimeRoot, "hostile-preload.cjs");
    await writeFile(
      hostilePreload,
      "const { contextBridge, ipcRenderer } = require('electron'); contextBridge.exposeInMainWorld('closureProbe', { invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args) });",
      "utf8",
    );
    const hostileURL = `${sniffFixture.origin}/hostile`;
    await launched.evaluate(
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
      { preload: hostilePreload, url: hostileURL },
    );
    await expect
      .poll(() =>
        launched.windows().some((window) => window.url() === hostileURL),
      )
      .toBe(true);
    const hostilePage = launched
      .windows()
      .find((window) => window.url() === hostileURL);
    if (!hostilePage) throw new Error("Hostile fixture page did not load");
    const hostilePageGlobals = await hostilePage.evaluate(() => ({
      requireType: typeof window.require,
      processType: typeof window.process,
      nodeProcessType: typeof process,
    }));
    expect(hostilePageGlobals).toEqual({
      requireType: "undefined",
      processType: "undefined",
      nodeProcessType: "undefined",
    });
    const hostileResults = await hostilePage.evaluate(
      async ({ operations }) => {
        const bridge = (
          window as Window & {
            closureProbe?: {
              invoke(channel: string, ...args: unknown[]): Promise<unknown>;
            };
          }
        ).closureProbe;
        if (!bridge) throw new Error("Hostile test preload is missing");
        return Promise.all(
          operations.map(async ({ channel, args }) =>
            bridge.invoke(channel, ...args),
          ),
        );
      },
      {
        operations: [
          { channel: IPC.shell.open, args: ["https://example.invalid/noop"] },
          { channel: IPC.shell.open, args: [sentinelPath] },
          {
            channel: IPC.dialog.open,
            args: [{ type: "file", multiple: false, readContent: true }],
          },
          {
            channel: IPC.dialog.save,
            args: [{ defaultPath: sentinelPath, content: "overwrite-dummy" }],
          },
          {
            channel: IPC.app.setSharedState,
            args: [{ activeTabId: "hostile-dummy", tabs: [] }],
          },
          {
            channel: IPC.resourceSearch.saveProviders,
            args: [[good]],
          },
        ],
      },
    );
    hostileDenials = hostileResults.map((value) => {
      if (!value || typeof value !== "object")
        throw new Error("Hostile IPC result is malformed");
      return value as { code?: number; message?: string };
    });
    expect(hostileDenials).toHaveLength(6);
    expect(hostileDenials.every((result) => result.code !== 0)).toBe(true);
    const sentinelFileURL = pathToFileURL(sentinelPath).href;
    expect(
      await hostilePage.evaluate(
        (url) =>
          fetch(url).then(
            () => true,
            () => false,
          ),
        sentinelFileURL,
      ),
    ).toBe(false);
    sentinelSha256After = sha256(await readFile(sentinelPath));
    providerConfigSha256After = sha256(await readFile(providerConfigPath));
    expect(sentinelSha256After).toBe(sentinelSha256Before);
    expect(providerConfigSha256After).toBe(providerConfigSha256Before);
    nativeSideEffectCounts = await nativeNoopObserverSnapshot(launched);
    expect(nativeSideEffectCounts).toEqual({
      openPath: 0,
      openExternal: 0,
      openDialog: 0,
      saveDialog: 0,
    });
    await hostilePage.close();
    await restoreNativeNoopObserver(launched);
    nativeObserverRestored = true;

    await page.getByRole("link", { name: /找视频/ }).click();
    const browser = page;
    type BrowserSnapshot = {
      activeTabId: string;
      tabs: Array<{
        id: string;
        url: string;
        sources: Array<{
          url: string;
          documentURL: string;
          name: string;
          type: string;
          mediaInfo?: {
            playlistType?: string;
            maxQuality?: string;
            variants?: unknown[];
          };
        }>;
      }>;
    };
    const readBrowserSnapshot = async () =>
      unwrap<BrowserSnapshot>(
        await browser.evaluate(() => window.electron.browser.getTabs()),
      );
    const initialBrowserSnapshot = await readBrowserSnapshot();
    const controlledTab = unwrap<{ id: string }>(
      await browser.evaluate(() => window.electron.browser.createTab()),
    );
    const loginURL = `${sniffFixture.origin}/login`;
    unwrap<void>(
      await browser.evaluate(
        ({ tabId, url }) => window.electron.browser.loadURL(tabId, url),
        { tabId: controlledTab.id, url: loginURL },
      ),
    );
    await expect
      .poll(async () => {
        const snapshot = await readBrowserSnapshot();
        return snapshot.tabs.find((tab) => tab.id === controlledTab.id);
      })
      .toMatchObject({ url: loginURL, sources: [] });
    loginPageHadNoMedia = true;

    const drmURL = `${sniffFixture.origin}/drm-indicated`;
    unwrap<void>(
      await browser.evaluate(
        ({ tabId, url }) => window.electron.browser.loadURL(tabId, url),
        { tabId: controlledTab.id, url: drmURL },
      ),
    );
    await expect
      .poll(async () => {
        const snapshot = await readBrowserSnapshot();
        return snapshot.tabs.find((tab) => tab.id === controlledTab.id);
      })
      .toMatchObject({ url: drmURL, sources: [] });
    drmIndicatedPageHadNoMedia = true;

    const hlsRunId = `closure-hls-${process.pid}-${Date.now()}`;
    const hlsWatchURL = `${sniffFixture.origin}/watch-hls?run=${encodeURIComponent(hlsRunId)}`;
    const hlsMasterPathAndQuery = `/hls/master.m3u8?run=${encodeURIComponent(hlsRunId)}`;
    hlsInspectionProbe = {
      watchURL: hlsWatchURL,
      masterPathAndQuery: hlsMasterPathAndQuery,
      browserRequestCount: 0,
      browserRequestHadDummyCookie: false,
      inspectorRequestCount: 0,
      inspectorRequestHadDummyCookie: false,
      sourceObserved: false,
      sourceEventHasHeadersField: false,
      sourceEventHasDummyCookie: false,
      sourceEventHeaderNames: [],
      sourceEventHasCookieHeader: false,
      sourceEventHasAuthorizationHeader: false,
      sourceEventHasProxyAuthorizationHeader: false,
    };
    await browser.evaluate(
      ({ channel, masterPathAndQuery }) => {
        const state = {
          sourceKeys: [] as string[],
          headerNames: [] as string[],
          hasHeadersField: false,
          hasDummyCookie: false,
        };
        window.electron.on(channel, (...args) => {
          const payload = args[1];
          if (!payload || typeof payload !== "object") return;
          const source = (payload as { source?: unknown }).source;
          if (!source || typeof source !== "object") return;
          const record = source as Record<string, unknown>;
          if (
            typeof record.url !== "string" ||
            !record.url.includes(masterPathAndQuery)
          )
            return;
          const headers =
            typeof record.headers === "string" ? record.headers : "";
          state.headerNames = headers
            .split(/\r?\n/)
            .map((line) => line.slice(0, line.indexOf(":")))
            .filter((name) => name.length > 0)
            .map((name) => name.trim().toLowerCase())
            .toSorted();
          state.sourceKeys = Object.keys(record).toSorted();
          state.hasHeadersField = Object.hasOwn(record, "headers");
          state.hasDummyCookie = headers.includes("closure_hls_value_dummy");
        });
        Object.assign(globalThis, { closureHlsSourceEvent: state });
      },
      {
        channel: IpcEvent.browser.sourceDetected,
        masterPathAndQuery: hlsMasterPathAndQuery,
      },
    );
    unwrap<void>(
      await browser.evaluate(
        ({ tabId, url }) => window.electron.browser.loadURL(tabId, url),
        { tabId: controlledTab.id, url: hlsWatchURL },
      ),
    );
    const hlsRows = () =>
      sniffFixture
        .hlsRequests()
        .filter((request) => request.pathAndQuery === hlsMasterPathAndQuery);
    await expect
      .poll(() =>
        hlsRows().some(
          (request) => request.hasSecFetchMetadata && request.hasDummyCookie,
        ),
      )
      .toBe(true);
    const browserHlsRequests = hlsRows().filter(
      (request) => request.hasSecFetchMetadata,
    );
    hlsInspectionProbe.browserRequestCount = browserHlsRequests.length;
    hlsInspectionProbe.browserRequestHadDummyCookie = browserHlsRequests.some(
      (request) => request.hasDummyCookie,
    );
    expect(hlsInspectionProbe.browserRequestHadDummyCookie).toBe(true);

    await expect
      .poll(() => hlsRows().some((request) => !request.hasSecFetchMetadata))
      .toBe(true);
    const inspectorHlsRequests = hlsRows().filter(
      (request) => !request.hasSecFetchMetadata,
    );
    hlsInspectionProbe.inspectorRequestCount = inspectorHlsRequests.length;
    hlsInspectionProbe.inspectorRequestHadDummyCookie =
      inspectorHlsRequests.some((request) => request.hasDummyCookie);
    expect(hlsInspectionProbe.inspectorRequestCount).toBeGreaterThan(0);
    expect(hlsInspectionProbe.inspectorRequestHadDummyCookie).toBe(false);

    let hlsSourceSnapshot:
      | BrowserSnapshot["tabs"][number]["sources"][number]
      | undefined;
    await expect
      .poll(async () => {
        const snapshot = await readBrowserSnapshot();
        const tab = snapshot.tabs.find((item) => item.id === controlledTab.id);
        hlsSourceSnapshot = tab?.sources.find((source) => {
          try {
            const url = new URL(source.url);
            return (
              url.origin === sniffFixture.origin &&
              url.pathname === "/hls/master.m3u8" &&
              url.searchParams.get("run") === hlsRunId
            );
          } catch {
            return false;
          }
        });
        return hlsSourceSnapshot?.mediaInfo?.playlistType;
      })
      .toBe("media");
    hlsInspectionProbe.sourceObserved = true;
    hlsInspectionProbe.playlistType =
      hlsSourceSnapshot?.mediaInfo?.playlistType;
    const hlsEventSummary = await browser.evaluate(() => {
      const state = (
        globalThis as typeof globalThis & {
          closureHlsSourceEvent?: {
            sourceKeys: string[];
            headerNames: string[];
            hasHeadersField: boolean;
            hasDummyCookie: boolean;
          };
        }
      ).closureHlsSourceEvent;
      if (!state) throw new Error("HLS source event summary was not recorded");
      return { ...state, sourceKeys: [...state.sourceKeys] };
    });
    hlsInspectionProbe.sourceEventHasHeadersField =
      hlsEventSummary.hasHeadersField;
    hlsInspectionProbe.sourceEventHasDummyCookie =
      hlsEventSummary.hasDummyCookie;
    hlsInspectionProbe.sourceEventHeaderNames = hlsEventSummary.headerNames;
    hlsInspectionProbe.sourceEventHasCookieHeader =
      hlsEventSummary.headerNames.includes("cookie");
    hlsInspectionProbe.sourceEventHasAuthorizationHeader =
      hlsEventSummary.headerNames.includes("authorization");
    hlsInspectionProbe.sourceEventHasProxyAuthorizationHeader =
      hlsEventSummary.headerNames.includes("proxy-authorization");
    expect(hlsEventSummary.hasDummyCookie).toBe(false);
    expect(hlsInspectionProbe.sourceEventHasCookieHeader).toBe(false);
    expect(hlsInspectionProbe.sourceEventHasAuthorizationHeader).toBe(false);
    expect(hlsInspectionProbe.sourceEventHasProxyAuthorizationHeader).toBe(
      false,
    );
    const safeHeaderNames = new Set([
      "accept",
      "accept-encoding",
      "accept-language",
      "origin",
      "range",
      "referer",
      "user-agent",
    ]);
    expect(
      hlsEventSummary.headerNames.every((name) => safeHeaderNames.has(name)),
    ).toBe(true);
    expect(
      (await client.getDownloadTasks({ current: 1, pageSize: 100 })).data.total,
    ).toBe(0);
    phaseCheckpoints.push("hls-default-cookie-inspection-redaction");

    const hlsTitle = page.locator('span[title="Controlled HLS watch page"]');
    await expect(hlsTitle).toHaveCount(1);
    await expect(hlsTitle).toBeVisible();
    const hlsCard = hlsTitle.locator("xpath=..");
    const hlsEditButton = hlsCard.getByRole("button", {
      name: "编辑",
      exact: true,
    });
    await expect(hlsEditButton).toHaveCount(1);
    await hlsEditButton.click();
    const rejectionOverlay = await downloadOverlayPage(launched);
    const rejectionForm = rejectionOverlay.locator('[role="dialog"] form');
    await expect(rejectionForm).toBeVisible();
    const hlsType = await rejectionForm
      .locator('[role="combobox"]')
      .innerText();
    const headersInput = rejectionForm.locator('textarea[id$="-headers"]');
    if (!(await headersInput.isVisible())) {
      await rejectionForm.locator("details summary").click();
    }
    await expect(headersInput).toBeVisible();
    const headersFieldCount = await rejectionForm
      .locator('textarea[name="headers"]')
      .count();
    expect(headersFieldCount).toBe(1);
    await headersInput.fill(
      "Cookie: closure_ui_cookie_dummy\nAuthorization: Bearer closure_ui_auth_dummy",
    );
    const taskCountBeforeHeaderReject = (
      await client.getDownloadTasks({ current: 1, pageSize: 100 })
    ).data.total;
    expect(taskCountBeforeHeaderReject).toBe(0);
    const hlsRequestCountBeforeReject = hlsRows().length;
    const sampleMediaRequestCountBeforeReject = sniffFixture.sampleHits();
    const rejectRequestPromise = rejectionOverlay.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === "POST" && url.pathname === "/api/downloads";
    });
    const rejectResponsePromise = rejectionOverlay.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "POST" &&
          url.pathname === "/api/downloads"
        );
      },
    );
    await rejectionOverlay
      .getByRole("button", { name: "立即下载", exact: true })
      .click();
    const rejectRequest = await rejectRequestPromise;
    const rejectResponse = await rejectResponsePromise;
    const requestBody = rejectRequest.postData() ?? "";
    const responseBody = await rejectResponse.text();
    const rejectToast = rejectionOverlay.locator("[data-sonner-toast]");
    await expect.poll(() => rejectToast.count()).toBeGreaterThan(0);
    const rejectToastText = await rejectToast.first().innerText();
    const taskCountAfterHeaderReject = (
      await client.getDownloadTasks({ current: 1, pageSize: 100 })
    ).data.total;
    const hlsRequestCountAfterReject = hlsRows().length;
    const sampleMediaRequestCountAfterReject = sniffFixture.sampleHits();
    sensitiveHeaderUiRejectionSummary = {
      overlayURL: rejectionOverlay.url(),
      hlsType,
      headersFieldCount,
      postStatus: rejectResponse.status(),
      requestHadDummyCookie: requestBody.includes("closure_ui_cookie_dummy"),
      requestHadDummyAuthorization: requestBody.includes(
        "closure_ui_auth_dummy",
      ),
      responseHadDummyMarker: /closure_ui_(?:cookie|auth)_dummy/.test(
        responseBody,
      ),
      toastVisible: (await rejectToast.count()) > 0,
      toastHadDummyMarker: /closure_ui_(?:cookie|auth)_dummy/.test(
        rejectToastText,
      ),
      toastMessageVisible: rejectToastText.trim().length > 0,
      taskCountBefore: taskCountBeforeHeaderReject,
      taskCountAfter: taskCountAfterHeaderReject,
      hlsRequestDelta: hlsRequestCountAfterReject - hlsRequestCountBeforeReject,
      sampleMediaRequestDelta:
        sampleMediaRequestCountAfterReject -
        sampleMediaRequestCountBeforeReject,
    };
    expect(sensitiveHeaderUiRejectionSummary.postStatus).toBe(400);
    expect(sensitiveHeaderUiRejectionSummary.requestHadDummyCookie).toBe(true);
    expect(sensitiveHeaderUiRejectionSummary.requestHadDummyAuthorization).toBe(
      true,
    );
    expect(sensitiveHeaderUiRejectionSummary.responseHadDummyMarker).toBe(
      false,
    );
    expect(sensitiveHeaderUiRejectionSummary.toastVisible).toBe(true);
    expect(sensitiveHeaderUiRejectionSummary.toastMessageVisible).toBe(true);
    expect(sensitiveHeaderUiRejectionSummary.toastHadDummyMarker).toBe(false);
    expect(sensitiveHeaderUiRejectionSummary.taskCountAfter).toBe(0);
    expect(sensitiveHeaderUiRejectionSummary.hlsRequestDelta).toBe(0);
    expect(sensitiveHeaderUiRejectionSummary.sampleMediaRequestDelta).toBe(0);
    phaseCheckpoints.push(
      "explicit-sensitive-header-ui-rejected-no-persist-or-media-request",
    );
    await rejectionOverlay
      .getByRole("button", { name: "取消", exact: true })
      .click();

    const watchURL = `${sniffFixture.origin}/watch`;
    await browser.evaluate((channel) => {
      const state = {
        sourceKeys: [] as string[],
        headerNames: [] as string[],
        hasHeadersField: false,
        hasCookieHeader: false,
        hasAuthorizationHeader: false,
        hasProxyAuthorizationHeader: false,
        hasDummyCookieMarker: false,
        hasDummyAuthorizationMarker: false,
      };
      window.electron.on(channel, (...args) => {
        const payload = args[1];
        if (!payload || typeof payload !== "object") return;
        const source = (payload as { source?: unknown }).source;
        if (!source || typeof source !== "object") return;
        const record = source as Record<string, unknown>;
        if (
          typeof record.url !== "string" ||
          !record.url.includes("/private/sample.mp4")
        )
          return;
        const header = typeof record.headers === "string" ? record.headers : "";
        state.headerNames = header
          .split(/\r?\n/)
          .map((line) => line.slice(0, line.indexOf(":")))
          .filter((name) => name.length > 0)
          .map((name) => name.trim().toLowerCase())
          .toSorted();
        state.sourceKeys = Object.keys(record).toSorted();
        state.hasHeadersField = Object.hasOwn(record, "headers");
        state.hasCookieHeader = /^cookie\s*:/im.test(header);
        state.hasAuthorizationHeader =
          state.headerNames.includes("authorization");
        state.hasProxyAuthorizationHeader = state.headerNames.includes(
          "proxy-authorization",
        );
        state.hasDummyCookieMarker = header.includes("closure_header_dummy");
        state.hasDummyAuthorizationMarker =
          header.includes("closure_auth_dummy");
      });
      Object.assign(globalThis, { closureSniffSourceEvent: state });
    }, IpcEvent.browser.sourceDetected);
    unwrap<void>(
      await browser.evaluate(
        ({ tabId, url }) => window.electron.browser.loadURL(tabId, url),
        { tabId: controlledTab.id, url: watchURL },
      ),
    );
    await expect
      .poll(async () => {
        const snapshot = await readBrowserSnapshot();
        const tab = snapshot.tabs.find((item) => item.id === controlledTab.id);
        observedWatchSources =
          tab?.sources.map(({ url, documentURL, type }) => ({
            url,
            documentURL,
            type,
          })) ?? [];
        observedWatchSourcesContainDummyHeaderMarker = JSON.stringify(
          observedWatchSources,
        ).includes("closure_header_dummy");
        return {
          pageURL: tab?.url,
          sources: observedWatchSources,
        };
      })
      .toMatchObject({
        pageURL: watchURL,
        sources: expect.arrayContaining([
          expect.objectContaining({
            url: expect.stringContaining("/sample.mp4"),
            documentURL: watchURL,
            type: "direct",
          }),
        ]),
      });
    observedWatchUrl = watchURL;
    expect(sniffFixture.privateSampleCookieRequestCount()).toBeGreaterThan(0);
    expect(sniffFixture.privateSampleRequestHadDummyCookie()).toBe(true);
    const sniffedSnapshot = await readBrowserSnapshot();
    const sniffedTab = sniffedSnapshot.tabs.find(
      (tab) => tab.id === controlledTab.id,
    );
    if (!sniffedTab) throw new Error("Sniffed browser tab disappeared");
    const mediaSource = sniffedTab.sources.find((source) => {
      try {
        const url = new URL(source.url);
        return (
          url.origin === sniffFixture.origin &&
          url.pathname === "/private/sample.mp4"
        );
      } catch {
        return false;
      }
    });
    if (!mediaSource)
      throw new Error("Sniffed sample media URL is unavailable");
    const mediaURL = mediaSource.url;
    expect(mediaURL).not.toBe(watchURL);
    expect(new URL(mediaURL).origin).toBe(sniffFixture.origin);
    expect(new URL(mediaURL).pathname).toBe("/private/sample.mp4");
    observedMediaUrl = mediaURL;
    privateSourceEventSummary = await browser.evaluate(() => {
      const state = (
        globalThis as typeof globalThis & {
          closureSniffSourceEvent?: {
            sourceKeys: string[];
            headerNames: string[];
            hasHeadersField: boolean;
            hasCookieHeader: boolean;
            hasAuthorizationHeader: boolean;
            hasProxyAuthorizationHeader: boolean;
            hasDummyCookieMarker: boolean;
            hasDummyAuthorizationMarker: boolean;
          };
        }
      ).closureSniffSourceEvent;
      if (!state) throw new Error("Source event summary was not recorded");
      return { ...state, sourceKeys: [...state.sourceKeys] };
    });
    expect(privateSourceEventSummary).toMatchObject({
      hasCookieHeader: false,
      hasAuthorizationHeader: false,
      hasProxyAuthorizationHeader: false,
      hasDummyCookieMarker: false,
      hasDummyAuthorizationMarker: false,
    });
    expect(
      privateSourceEventSummary.headerNames.every((name) =>
        safeHeaderNames.has(name),
      ),
    ).toBe(true);
    const safeTabSnapshot = unwrap<{
      tabs: Array<{ id: string; sources: Array<Record<string, unknown>> }>;
    }>(await browser.evaluate(() => window.electron.browser.getTabs()));
    const safeTab = safeTabSnapshot.tabs.find(
      (tab) => tab.id === controlledTab.id,
    );
    if (!safeTab) throw new Error("Safe tab snapshot disappeared");
    const safeSource = safeTab.sources.find(
      (source) => source.url === mediaURL,
    );
    if (!safeSource) throw new Error("Safe source snapshot disappeared");
    defaultSnapshotHeaderRedactionSummary = {
      sourceKeys: Object.keys(safeSource).toSorted(),
      hasHeadersField: Object.hasOwn(safeSource, "headers"),
      hasDummyMarker: JSON.stringify(safeSource).includes(
        "closure_header_dummy",
      ),
    };
    expect(defaultSnapshotHeaderRedactionSummary).toMatchObject({
      hasHeadersField: false,
      hasDummyMarker: false,
    });
    const sniffedSurface = `${JSON.stringify(sniffedSnapshot)}\n${await browser.locator("body").innerText()}`;
    expect(sniffedSurface).not.toContain("closure_header_dummy");
    defaultSnapshotAndPanelRedaction = true;
    phaseCheckpoints.push("default-direct-sniff-event-and-snapshot-redaction");
    const taskCountBeforePublicSubmit = (
      await client.getDownloadTasks({ current: 1, pageSize: 100 })
    ).data.total;
    expect(taskCountBeforePublicSubmit).toBe(0);

    const publicWatchURL = `${sniffFixture.origin}/watch-public`;
    unwrap<void>(
      await browser.evaluate(
        ({ tabId, url }) => window.electron.browser.loadURL(tabId, url),
        { tabId: controlledTab.id, url: publicWatchURL },
      ),
    );
    await expect
      .poll(async () => {
        const snapshot = await readBrowserSnapshot();
        const tab = snapshot.tabs.find((item) => item.id === controlledTab.id);
        observedPublicSniffSources =
          tab?.sources.map(({ url, documentURL, type }) => ({
            url,
            documentURL,
            type,
          })) ?? [];
        return { pageURL: tab?.url, sources: observedPublicSniffSources };
      })
      .toMatchObject({
        pageURL: publicWatchURL,
        sources: expect.arrayContaining([
          expect.objectContaining({
            url: expect.stringContaining("/public/sample.mp4"),
            documentURL: publicWatchURL,
            type: "direct",
          }),
        ]),
      });
    const publicSource = observedPublicSniffSources.find((source) => {
      try {
        const url = new URL(source.url);
        return (
          url.origin === sniffFixture.origin &&
          url.pathname === "/public/sample.mp4"
        );
      } catch {
        return false;
      }
    });
    if (!publicSource) throw new Error("Public-shaped sniff source is missing");
    expect(publicSource.documentURL).toBe(publicWatchURL);
    expect(publicSource.url).not.toBe(publicWatchURL);
    const publicMediaURL = publicSource.url;
    expect(
      (await client.getDownloadTasks({ current: 1, pageSize: 100 })).data.total,
    ).toBe(0);
    const publicCardTitle = browser.locator(
      'span[title="Controlled public watch page"]',
    );
    await expect(publicCardTitle).toHaveCount(1);
    await expect(publicCardTitle).toBeVisible();
    const publicCard = publicCardTitle.locator("xpath=..");
    const publicEditButton = publicCard.getByRole("button", {
      name: "编辑",
      exact: true,
    });
    await expect(publicEditButton).toHaveCount(1);
    await publicEditButton.click();
    const overlayPage = await downloadOverlayPage(launched);
    downloadOverlayURL = overlayPage.url();
    const overlayForm = overlayPage.locator('[role="dialog"] form');
    await expect(overlayForm).toBeVisible();
    const formSnapshot = (expectedDownloadUrl: string) =>
      overlayForm.evaluate((form, expectedURL) => {
        const formElement = form as HTMLFormElement;
        const urlInput =
          form.querySelector<HTMLInputElement>('input[id$="-url"]');
        const nameInput =
          form.querySelector<HTMLInputElement>('input[id$="-name"]');
        const typeControl =
          form.querySelector<HTMLElement>('[role="combobox"]');
        const headerFields = [
          ...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
            'input[name="headers"], textarea[name="headers"]',
          ),
        ];
        const downloadButtons = [
          ...(form.closest('[role="dialog"]')?.querySelectorAll("button") ??
            []),
        ].filter((button) => button.textContent?.trim() === "立即下载");
        return {
          urlMatchesExpected: urlInput?.value === expectedURL,
          namePresent: Boolean(nameInput?.value.trim()),
          typePresent: Boolean(typeControl?.textContent?.trim()),
          headerFieldCount: headerFields.length,
          publicHeaderNames: headerFields
            .flatMap((field) => field.value.split(/\r?\n/))
            .map((line) => line.slice(0, line.indexOf(":")))
            .filter((name) => name.length > 0)
            .map((name) => name.trim().toLowerCase())
            .toSorted(),
          headersNoSensitiveNames: (() => {
            const publicNames = new Set([
              "accept",
              "accept-encoding",
              "accept-language",
              "origin",
              "range",
              "referer",
              "user-agent",
            ]);
            const names = headerFields
              .flatMap((field) => field.value.split(/\r?\n/))
              .map((line) => line.slice(0, line.indexOf(":")))
              .filter((name) => name.length > 0)
              .map((name) => name.trim().toLowerCase());
            return (
              headerFields.every(
                (field) =>
                  !/closure_(?:header|auth|hls)_/i.test(field.value) &&
                  !/^(?:cookie|authorization|proxy-authorization|x-api-key)\s*:/im.test(
                    field.value,
                  ),
              ) && names.every((name) => publicNames.has(name))
            );
          })(),
          validByDomBeforeSubmit: formElement.checkValidity(),
          invalidControlCount: form.querySelectorAll('[aria-invalid="true"]')
            .length,
          submitButtonCount: downloadButtons.length,
          submitButtonDisabled: downloadButtons[0]?.disabled ?? true,
        };
      }, expectedDownloadUrl);
    const publicOverlayState = await formSnapshot(publicMediaURL);
    downloadOverlayHasExpectedMediaURL = publicOverlayState.urlMatchesExpected;
    downloadOverlayHasDummyHeader = !publicOverlayState.headersNoSensitiveNames;
    expect(publicOverlayState).toMatchObject({
      urlMatchesExpected: true,
      namePresent: true,
      typePresent: true,
      headersNoSensitiveNames: true,
      submitButtonCount: 1,
      submitButtonDisabled: false,
    });
    expect(
      (await client.getDownloadTasks({ current: 1, pageSize: 100 })).data.total,
    ).toBe(0);
    const observedSubmitRequests: string[] = [];
    const observedSubmitResponses: number[] = [];
    let overlayPageErrorCount = 0;
    let submissionSignalObserved = false;
    const observeSubmitRequest = (
      request: import("@playwright/test").Request,
    ) => {
      const url = new URL(request.url());
      if (
        request.method() === "POST" &&
        (url.pathname === "/api/downloads" || url.pathname === "/api/tasks")
      ) {
        const body = request.postData() ?? "";
        observedSubmitRequests.push(
          `${url.pathname};dummyHeader=${/closure_(?:header|auth|hls)_/i.test(body)}`,
        );
      }
    };
    const observeSubmitResponse = (
      response: import("@playwright/test").Response,
    ) => {
      const url = new URL(response.url());
      if (
        response.request().method() === "POST" &&
        (url.pathname === "/api/downloads" || url.pathname === "/api/tasks")
      ) {
        observedSubmitResponses.push(response.status());
      }
    };
    const observeOverlayPageError = () => {
      overlayPageErrorCount += 1;
    };
    overlayPage.on("request", observeSubmitRequest);
    overlayPage.on("response", observeSubmitResponse);
    overlayPage.on("pageerror", observeOverlayPageError);
    await overlayPage
      .getByRole("button", { name: "立即下载", exact: true })
      .click();
    const taskCountBefore = taskCountBeforePublicSubmit;
    try {
      await expect
        .poll(
          async () => {
            const taskCount = (
              await client.getDownloadTasks({ current: 1, pageSize: 100 })
            ).data.total;
            return (
              observedSubmitResponses.length > 0 ||
              taskCount > taskCountBefore ||
              (await overlayForm.locator('[role="alert"]').count()) > 0 ||
              (await overlayPage.locator("[data-sonner-toast]").count()) > 0
            );
          },
          { timeout: 5_000 },
        )
        .toBe(true);
      submissionSignalObserved = true;
    } catch {
      submissionSignalObserved = false;
    }
    const postSubmitFormState =
      (await overlayForm.count()) > 0
        ? await formSnapshot(publicMediaURL)
        : undefined;
    const postSubmitTaskCount = (
      await client.getDownloadTasks({ current: 1, pageSize: 100 })
    ).data.total;
    const toastVisibleAfterSubmit =
      (await overlayPage.locator("[data-sonner-toast]").count()) > 0;
    publicDownloadSubmitSummary = {
      overlayURL: overlayPage.url(),
      formHasExpectedURL: publicOverlayState.urlMatchesExpected,
      formHasName: publicOverlayState.namePresent,
      formHasType: publicOverlayState.typePresent,
      formHasNoSensitiveHeaders: publicOverlayState.headersNoSensitiveNames,
      headersFieldCount: publicOverlayState.headerFieldCount,
      publicHeaderNames: publicOverlayState.publicHeaderNames,
      formValidBeforeSubmit: publicOverlayState.validByDomBeforeSubmit,
      submitButtonCount: publicOverlayState.submitButtonCount,
      postPaths: [...observedSubmitRequests],
      postResponseStatuses: [...observedSubmitResponses],
      pageErrorCount: overlayPageErrorCount,
      submissionSignalObserved,
      formErrorCountAfterSubmit: postSubmitFormState?.invalidControlCount ?? 0,
      formAlertCountAfterSubmit: postSubmitFormState
        ? await overlayForm.locator('[role="alert"]').count()
        : 0,
      toastVisibleAfterSubmit,
      taskCountBefore,
      taskCountAfter: postSubmitTaskCount,
    };
    overlayPage.off("request", observeSubmitRequest);
    overlayPage.off("response", observeSubmitResponse);
    overlayPage.off("pageerror", observeOverlayPageError);
    await expect
      .poll(
        async () =>
          (await client.getDownloadTasks({ current: 1, pageSize: 100 })).data
            .total,
      )
      .toBe(1);
    const [sniffTask] = (
      await client.getDownloadTasks({ current: 1, pageSize: 100 })
    ).data.list;
    if (!sniffTask) throw new Error("Manual sniff click did not create a task");
    sniffTaskId = sniffTask.id;
    expect(sniffTask.url).toBe(publicMediaURL);
    await expect
      .poll(
        async () => (await client.getDownloadTask(sniffTask.id)).data.status,
        {
          timeout: 45_000,
        },
      )
      .toBe("success");
    const completedSniffTask = (await client.getDownloadTask(sniffTask.id))
      .data;
    if (!completedSniffTask.outputPath)
      throw new Error("Sniffed media task has no output path");
    observedSniffOutputSha256 = sha256(
      await readFile(completedSniffTask.outputPath),
    );
    expect(observedSniffOutputSha256).toBe(sniffFixture.sampleSha256);
    expect(sniffFixture.sampleHits()).toBeGreaterThan(0);
    phaseCheckpoints.push("public-manual-enqueue-output-sha");
    expect(
      initialBrowserSnapshot.tabs.some((tab) => tab.id === controlledTab.id),
    ).toBe(false);

    const oldAddress = `${sniffFixture.origin}/edit-old.mp4?token=closure_old_query_dummy`;
    const newAddress = `${sniffFixture.origin}/edit-new.mp4?token=closure_new_query_dummy`;
    const sensitiveAddress = `${sniffFixture.origin}/edit-sensitive.mp4?token=closure_sensitive_query_dummy`;
    const pausedTask = await client.addDownloadTasks({
      startDownload: false,
      tasks: [
        {
          type: "direct",
          name: "closure-url-edit-boundary",
          url: oldAddress,
        },
      ],
    });
    expect(pausedTask.success).toBe(true);
    urlEditTaskId = pausedTask.data[0]?.id;
    if (!urlEditTaskId) throw new Error("Paused URL-edit task was not created");
    const editedTaskId = urlEditTaskId;
    expect((await client.getDownloadTask(editedTaskId)).data.url).toBe(
      oldAddress,
    );
    expect(
      (
        await client.editDownloadTask(editedTaskId, {
          url: newAddress,
        })
      ).success,
    ).toBe(true);
    expect((await client.getDownloadTask(editedTaskId)).data.url).toBe(
      newAddress,
    );
    expect(
      (
        await client.startDownload(editedTaskId, {
          localPath: path.join(runtimeRoot, "downloads"),
          deleteSegments: false,
        })
      ).success,
    ).toBe(true);
    await expect
      .poll(
        async () => (await client.getDownloadTask(editedTaskId)).data.status,
        {
          timeout: 45_000,
        },
      )
      .toBe("success");
    const completedEditedTask = (await client.getDownloadTask(editedTaskId))
      .data;
    if (!completedEditedTask.outputPath)
      throw new Error("Edited URL task has no output path");
    editedOutputSha256 = sha256(await readFile(completedEditedTask.outputPath));
    expect(editedOutputSha256).toBe(sniffFixture.sampleSha256);
    oldAddressRequests = sniffFixture.pathHits("/edit-old.mp4");
    newAddressRequests = sniffFixture.pathHits("/edit-new.mp4");
    expect(oldAddressRequests).toBe(0);
    expect(newAddressRequests).toBeGreaterThan(0);

    const dummySensitiveHeader =
      "Cookie: closure_header_edit_dummy\nAuthorization: Bearer closure_auth_edit_dummy";
    const tasksBeforeSensitiveAttempt = (
      await client.getDownloadTasks({ current: 1, pageSize: 100 })
    ).data.total;
    try {
      await client.addDownloadTasks({
        startDownload: true,
        tasks: [
          {
            type: "direct",
            name: "closure-rejected-sensitive-header",
            url: sensitiveAddress,
            headers: dummySensitiveHeader,
          },
        ],
      });
    } catch {
      sensitiveHeaderAttemptRejected = true;
    }
    expect(sensitiveHeaderAttemptRejected).toBe(true);
    expect(
      (await client.getDownloadTasks({ current: 1, pageSize: 100 })).data.total,
    ).toBe(tasksBeforeSensitiveAttempt);
    expect((await client.getDownloadTask(editedTaskId)).data.url).toBe(
      newAddress,
    );
    sensitiveAddressRequests = sniffFixture.pathHits("/edit-sensitive.mp4");
    expect(sensitiveAddressRequests).toBe(0);
    const editedTaskLogs = (await client.getDownloadLogs(editedTaskId)).data
      .log;
    editedTaskAndLogsRedacted = ![
      JSON.stringify(completedEditedTask),
      editedTaskLogs,
    ].some((value) =>
      ["closure_header_edit_dummy", "closure_auth_edit_dummy"].some((marker) =>
        value.includes(marker),
      ),
    );
    expect(editedTaskAndLogsRedacted).toBe(true);
    phaseCheckpoints.push(
      "url-edit-secret-invalidation-and-api-private-header-rejection",
    );

    probe = await resourceSearchIOSnapshot(launched);
    expect(probe.lookupHosts.length).toBeGreaterThan(0);
    expect(
      probe.fetchURLs.every((url) =>
        new URL(url).hostname.endsWith(".fixture.invalid"),
      ),
    ).toBe(true);
    phaseCheckpoints.push("resource-search-controlled-network-boundary");
    passed = true;
  } catch (error) {
    failure.message =
      error instanceof Error ? error.stack || error.message : String(error);
    throw error;
  } finally {
    if (application) {
      await restoreControlledResourceSearchIO(application).then(
        () => (shimRestored = true),
        () => undefined,
      );
      await restoreNativeNoopObserver(application).then(
        () => (nativeObserverRestored = true),
        () => undefined,
      );
      await application.close().catch(() => undefined);
    }
    await sniffFixture.close();
    if (owner) {
      processExited = await waitForWindowsProcessExit(owner, 10_000);
      expect(processExited).toBe(true);
    }
    if (coreOwner) {
      coreProcessExited = await waitForWindowsProcessExit(coreOwner, 10_000);
      expect(coreProcessExited).toBe(true);
    }
    await waitForPortFree("127.0.0.1", CORE_PORT, 10_000);
    corePortFreed = true;
    if (passed) {
      await rm(runtimeRoot, { recursive: true, force: true });
      runtimeRootRemoved = true;
    }
    await writeFile(
      path.join(
        EVIDENCE,
        `candidate-search-controlled-io-${path.basename(runtimeRoot)}.json`,
      ),
      JSON.stringify(
        {
          candidateBinding: BINDING_PATH,
          candidateBindingSha256: bindingSha256,
          candidate,
          asarSha256,
          coreSha256,
          testSourceSha256,
          corePort: CORE_PORT,
          ownerProcessIdentity: owner,
          coreListener,
          coreProcessIdentity: coreOwner,
          selectedMainPageUrl,
          observedWatchUrl,
          observedMediaUrl,
          observedWatchSources,
          privateSourceEventSummary,
          defaultSnapshotHeaderRedactionSummary,
          observedSniffOutputSha256,
          observedPublicSniffSources,
          downloadOverlayURL,
          downloadOverlayHasExpectedMediaURL,
          downloadOverlayHasDummyHeader,
          sniffTaskId,
          urlEditTaskId,
          oldAddressRequests,
          newAddressRequests,
          sensitiveAddressRequests,
          sensitiveHeaderAttemptRejected,
          sensitiveHeaderUiRejectionSummary,
          phaseCheckpoints,
          editedOutputSha256,
          editedTaskAndLogsRedacted,
          defaultSnapshotAndPanelRedaction,
          hlsInspectionProbe,
          hlsRequestObservations: sniffFixture.hlsRequests(),
          publicDownloadSubmitSummary,
          loginPageHadNoMedia,
          drmIndicatedPageHadNoMedia,
          hostileDenials,
          hostilePageGlobalBoundary: "require/process unavailable",
          nativeSideEffectCounts,
          nativeObserverRestored,
          sentinelSha256Before,
          sentinelSha256After,
          providerConfigSha256Before,
          providerConfigSha256After,
          sniffFixtureSampleSha256: sniffFixture.sampleSha256,
          sniffFixtureRequests: sniffFixture.sampleHits(),
          sniffFixtureHeadRequests: sniffFixture.sampleHeadHits(),
          privateSampleCookieRequestCount:
            sniffFixture.privateSampleCookieRequestCount(),
          privateSampleRequestHadDummyCookie:
            sniffFixture.privateSampleRequestHadDummyCookie(),
          observedWatchSourcesContainDummyHeaderMarker,
          ioLayer:
            "candidate-real-ipc-controller-service-controlled-dns-and-fetch",
          externalNetworkUsed: false,
          probe,
          passed,
          failure: failure.message,
          shimRestored,
          processExited,
          coreProcessExited,
          corePortFreed,
          runtimeRootRemoved,
          runtimeRoot,
        },
        null,
        2,
      ),
      "utf8",
    );
  }
});

test("candidate default Cookie source is redacted through HLS inspection and public manual confirmation", async () => {
  test.setTimeout(120_000);
  await mkdir(EVIDENCE, { recursive: true });
  const testSourceSha256 = sha256(readFileSync(fileURLToPath(import.meta.url)));
  await assertPortFree(
    "127.0.0.1",
    CORE_PORT,
    "default Cookie/HLS candidate Core",
  );
  const bindingBytes = await readFile(BINDING_PATH);
  const binding = JSON.parse(bindingBytes.toString("utf8")) as CandidateBinding;
  const bindingSha256 = sha256(bindingBytes);
  const candidate = path.resolve(binding.candidate);
  const executable = path.join(candidate, "乡映.exe");
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    executable,
  );
  const exeSha256 = sha256(await readFile(executable));
  const asarSha256 = sha256(
    await readFile(path.join(candidate, "resources/app.asar")),
  );
  const coreSha256 = sha256(
    await readFile(path.join(candidate, "resources/bin/mediago-core.exe")),
  );
  expect(exeSha256).toBe(binding.exeSha256);
  expect(asarSha256).toBe(binding.asarSha256);
  expect(coreSha256).toBe(binding.coreSha256);

  const sniffFixture = await startSniffFixture();
  const runtimeRoot = path.join(EVIDENCE, `runtime-cookie-hls-${Date.now()}`);
  const tempDir = path.join(runtimeRoot, "temp");
  await Promise.all(
    ["appdata", "localappdata", "data", "downloads", "temp"].map((name) =>
      mkdir(path.join(runtimeRoot, name), { recursive: true }),
    ),
  );
  let application: ElectronApplication | undefined;
  let owner: WindowsProcessIdentity | undefined;
  let coreListener: Awaited<ReturnType<typeof readCoreListener>>;
  let coreOwner: WindowsProcessIdentity | undefined;
  let processExited = false;
  let coreProcessExited = false;
  let corePortFreed = false;
  let runtimeRootRemoved = false;
  let passed = false;
  let selectedMainPageUrl: string | undefined;
  let hlsEvidence:
    | {
        masterPathAndQuery: string;
        browserRequestCount: number;
        browserRequestHadDummyCookie: boolean;
        inspectorRequestCount: number;
        inspectorRequestHadDummyCookie: boolean;
        playlistType?: string;
        snapshotHasHeaders: boolean;
        sourceEventHeaderNames: string[];
        sourceEventHasDummyCookie: boolean;
        sourceEventHasCookieHeader: boolean;
        sourceEventHasAuthorizationHeader: boolean;
        sourceEventHasProxyAuthorizationHeader: boolean;
      }
    | undefined;
  let directCookieEvidence:
    | {
        requestCount: number;
        browserRequestHadDummyCookie: boolean;
        sourceEventHasHeadersField: boolean;
        sourceEventHasDummyCookie: boolean;
        sourceEventHeaderNames: string[];
        sourceEventHasCookieHeader: boolean;
        sourceEventHasAuthorizationHeader: boolean;
        sourceEventHasProxyAuthorizationHeader: boolean;
        safeSnapshotHasHeadersField: boolean;
        safeSnapshotHasDummyCookie: boolean;
      }
    | undefined;
  let manualEvidence:
    | {
        overlayURL: string;
        formHasExpectedURL: boolean;
        formHasName: boolean;
        formHasType: boolean;
        formHasNoSensitiveHeaders: boolean;
        headersFieldCount: number;
        publicHeaderNames: string[];
        postPaths: string[];
        responseStatuses: number[];
        taskCountBefore: number;
        taskCountAfter: number;
        taskId?: number;
        outputSha256?: string;
      }
    | undefined;
  const failure = { message: "" };
  try {
    const childEnvironment = scrubElectronEnvironment(process.env);
    delete childEnvironment.ELECTRON_RUN_AS_NODE;
    delete childEnvironment.NODE_OPTIONS;
    const launched = await _electron.launch({
      executablePath: executable,
      timeout: 30_000,
      env: {
        ...childEnvironment,
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
    application = launched;
    const processId = launched.process().pid;
    if (!processId) throw new Error("Candidate process has no PID");
    owner = await readWindowsProcessIdentity(processId);
    if (!owner) throw new Error("Candidate process identity is unavailable");
    await expect
      .poll(async () => await readCoreListener(), { timeout: 20_000 })
      .toBeTruthy();
    coreListener = await readCoreListener();
    if (!coreListener || coreListener.localPort !== CORE_PORT)
      throw new Error("Candidate Core listener identity was not captured");
    coreOwner = await readWindowsProcessIdentity(coreListener.pid);
    if (!coreOwner)
      throw new Error("Candidate Core process identity is unavailable");

    const page = await mainPage(launched);
    selectedMainPageUrl = page.url();
    const envPath = unwrap<{ coreUrl: string }>(
      await page.evaluate(() => window.electron.app.getEnvPath()),
    );
    if (!envPath.coreUrl) throw new Error("Candidate Core URL is unavailable");
    const client = trustedCoreClient(page, envPath.coreUrl);
    await client.setConfig({ language: "zh" });
    expect(
      (await client.setConfigKey("local", path.join(runtimeRoot, "downloads")))
        .success,
    ).toBe(true);
    await page.reload();
    await page.getByRole("link", { name: /找视频/ }).click();
    const browser = page;
    type SmokeBrowserSnapshot = {
      tabs: Array<{
        id: string;
        url: string;
        sources: Array<{
          url: string;
          documentURL: string;
          name: string;
          type: string;
          mediaInfo?: { playlistType?: string };
        }>;
      }>;
    };
    const readBrowserSnapshot = async () =>
      unwrap<SmokeBrowserSnapshot>(
        await browser.evaluate(() => window.electron.browser.getTabs()),
      );
    const controlledTab = unwrap<{ id: string }>(
      await browser.evaluate(() => window.electron.browser.createTab()),
    );
    const hlsRunId = `closure-hls-smoke-${process.pid}-${Date.now()}`;
    const hlsWatchURL = `${sniffFixture.origin}/watch-hls?run=${encodeURIComponent(hlsRunId)}`;
    const hlsMasterPathAndQuery = `/hls/master.m3u8?run=${encodeURIComponent(hlsRunId)}`;
    const sourceEventState = await browser.evaluate(
      ({ channel, hlsPath }) => {
        const state = {
          hls: {
            keys: [] as string[],
            headerNames: [] as string[],
            hasHeaders: false,
            hasCookie: false,
            hasCookieName: false,
            hasAuthorizationName: false,
            hasProxyAuthorizationName: false,
          },
          direct: {
            keys: [] as string[],
            headerNames: [] as string[],
            hasHeaders: false,
            hasCookie: false,
            hasCookieName: false,
            hasAuthorizationName: false,
            hasProxyAuthorizationName: false,
          },
        };
        window.electron.on(channel, (...args) => {
          const payload = args[1];
          if (!payload || typeof payload !== "object") return;
          const source = (payload as { source?: unknown }).source;
          if (!source || typeof source !== "object") return;
          const record = source as Record<string, unknown>;
          if (typeof record.url !== "string") return;
          const header =
            typeof record.headers === "string" ? record.headers : "";
          const headerNames = header
            .split(/\r?\n/)
            .map((line) => line.slice(0, line.indexOf(":")))
            .filter((name) => name.length > 0)
            .map((name) => name.trim().toLowerCase())
            .toSorted();
          if (record.url.includes(hlsPath)) {
            state.hls = {
              keys: Object.keys(record).toSorted(),
              headerNames,
              hasHeaders: Object.hasOwn(record, "headers"),
              hasCookie: header.includes("closure_hls_value_dummy"),
              hasCookieName: headerNames.includes("cookie"),
              hasAuthorizationName: headerNames.includes("authorization"),
              hasProxyAuthorizationName: headerNames.includes(
                "proxy-authorization",
              ),
            };
          }
          if (record.url.includes("/private/sample.mp4")) {
            state.direct = {
              keys: Object.keys(record).toSorted(),
              headerNames,
              hasHeaders: Object.hasOwn(record, "headers"),
              hasCookie: header.includes("closure_header_dummy"),
              hasCookieName: headerNames.includes("cookie"),
              hasAuthorizationName: headerNames.includes("authorization"),
              hasProxyAuthorizationName: headerNames.includes(
                "proxy-authorization",
              ),
            };
          }
        });
        Object.assign(globalThis, { closureCookieHlsSourceEvents: state });
        return { listenerInstalled: true };
      },
      {
        channel: IpcEvent.browser.sourceDetected,
        hlsPath: hlsMasterPathAndQuery,
      },
    );
    expect(sourceEventState.listenerInstalled).toBe(true);

    unwrap<void>(
      await browser.evaluate(
        ({ tabId, url }) => window.electron.browser.loadURL(tabId, url),
        { tabId: controlledTab.id, url: hlsWatchURL },
      ),
    );
    const hlsRows = () =>
      sniffFixture
        .hlsRequests()
        .filter((request) => request.pathAndQuery === hlsMasterPathAndQuery);
    await expect
      .poll(() =>
        hlsRows().some(
          (request) => request.hasSecFetchMetadata && request.hasDummyCookie,
        ),
      )
      .toBe(true);
    const browserHlsRequests = hlsRows().filter(
      (request) => request.hasSecFetchMetadata,
    );
    await expect
      .poll(() =>
        hlsRows().some(
          (request) => request.method === "GET" && !request.hasSecFetchMetadata,
        ),
      )
      .toBe(true);
    const inspectorHlsRequests = hlsRows().filter(
      (request) => request.method === "GET" && !request.hasSecFetchMetadata,
    );
    let hlsSource:
      | SmokeBrowserSnapshot["tabs"][number]["sources"][number]
      | undefined;
    await expect
      .poll(async () => {
        const snapshot = await readBrowserSnapshot();
        const tab = snapshot.tabs.find((item) => item.id === controlledTab.id);
        hlsSource = tab?.sources.find((source) => {
          try {
            const url = new URL(source.url);
            return (
              url.origin === sniffFixture.origin &&
              url.pathname === "/hls/master.m3u8" &&
              url.searchParams.get("run") === hlsRunId
            );
          } catch {
            return false;
          }
        });
        return hlsSource?.mediaInfo?.playlistType;
      })
      .toBe("media");
    const hlsEvents = await browser.evaluate(() => {
      const state = (
        globalThis as typeof globalThis & {
          closureCookieHlsSourceEvents?: {
            hls: {
              keys: string[];
              headerNames: string[];
              hasHeaders: boolean;
              hasCookie: boolean;
              hasCookieName: boolean;
              hasAuthorizationName: boolean;
              hasProxyAuthorizationName: boolean;
            };
          };
        }
      ).closureCookieHlsSourceEvents;
      if (!state) throw new Error("HLS source event was not captured");
      return state.hls;
    });
    hlsEvidence = {
      masterPathAndQuery: hlsMasterPathAndQuery,
      browserRequestCount: browserHlsRequests.length,
      browserRequestHadDummyCookie: browserHlsRequests.some(
        (request) => request.hasDummyCookie,
      ),
      inspectorRequestCount: inspectorHlsRequests.length,
      inspectorRequestHadDummyCookie: inspectorHlsRequests.some(
        (request) => request.hasDummyCookie,
      ),
      playlistType: hlsSource?.mediaInfo?.playlistType,
      snapshotHasHeaders: Boolean(
        hlsSource && Object.hasOwn(hlsSource, "headers"),
      ),
      sourceEventHeaderNames: hlsEvents.headerNames,
      sourceEventHasDummyCookie: hlsEvents.hasCookie,
      sourceEventHasCookieHeader: hlsEvents.hasCookieName,
      sourceEventHasAuthorizationHeader: hlsEvents.hasAuthorizationName,
      sourceEventHasProxyAuthorizationHeader:
        hlsEvents.hasProxyAuthorizationName,
    };
    expect(hlsEvidence.browserRequestHadDummyCookie).toBe(true);
    expect(hlsEvidence.inspectorRequestCount).toBeGreaterThan(0);
    expect(hlsEvidence.inspectorRequestHadDummyCookie).toBe(false);
    expect(hlsEvents.hasCookie).toBe(false);
    expect(hlsEvents.hasCookieName).toBe(false);
    expect(hlsEvents.hasAuthorizationName).toBe(false);
    expect(hlsEvents.hasProxyAuthorizationName).toBe(false);
    const safeHeaderNames = new Set([
      "accept",
      "accept-encoding",
      "accept-language",
      "origin",
      "range",
      "referer",
      "user-agent",
    ]);
    expect(
      hlsEvents.headerNames.every((name) => safeHeaderNames.has(name)),
    ).toBe(true);
    expect(hlsEvidence.snapshotHasHeaders).toBe(false);
    expect(
      (await client.getDownloadTasks({ current: 1, pageSize: 100 })).data.total,
    ).toBe(0);

    const privateWatchURL = `${sniffFixture.origin}/watch`;
    unwrap<void>(
      await browser.evaluate(
        ({ tabId, url }) => window.electron.browser.loadURL(tabId, url),
        { tabId: controlledTab.id, url: privateWatchURL },
      ),
    );
    await expect
      .poll(async () => {
        const snapshot = await readBrowserSnapshot();
        const tab = snapshot.tabs.find((item) => item.id === controlledTab.id);
        return tab?.sources.some((source) => {
          try {
            const url = new URL(source.url);
            return (
              url.origin === sniffFixture.origin &&
              url.pathname === "/private/sample.mp4"
            );
          } catch {
            return false;
          }
        });
      })
      .toBe(true);
    expect(sniffFixture.privateSampleCookieRequestCount()).toBeGreaterThan(0);
    expect(sniffFixture.privateSampleRequestHadDummyCookie()).toBe(true);
    const directEvents = await browser.evaluate(() => {
      const state = (
        globalThis as typeof globalThis & {
          closureCookieHlsSourceEvents?: {
            direct: {
              keys: string[];
              headerNames: string[];
              hasHeaders: boolean;
              hasCookie: boolean;
              hasCookieName: boolean;
              hasAuthorizationName: boolean;
              hasProxyAuthorizationName: boolean;
            };
          };
        }
      ).closureCookieHlsSourceEvents;
      if (!state) throw new Error("Direct source event was not captured");
      return state.direct;
    });
    const directSnapshot = await readBrowserSnapshot();
    const privateSource = directSnapshot.tabs
      .find((item) => item.id === controlledTab.id)
      ?.sources.find((source) => source.url.includes("/private/sample.mp4"));
    directCookieEvidence = {
      requestCount: sniffFixture.privateSampleCookieRequestCount(),
      browserRequestHadDummyCookie:
        sniffFixture.privateSampleRequestHadDummyCookie(),
      sourceEventHasHeadersField: directEvents.hasHeaders,
      sourceEventHasDummyCookie: directEvents.hasCookie,
      sourceEventHeaderNames: directEvents.headerNames,
      sourceEventHasCookieHeader: directEvents.hasCookieName,
      sourceEventHasAuthorizationHeader: directEvents.hasAuthorizationName,
      sourceEventHasProxyAuthorizationHeader:
        directEvents.hasProxyAuthorizationName,
      safeSnapshotHasHeadersField: Boolean(
        privateSource && Object.hasOwn(privateSource, "headers"),
      ),
      safeSnapshotHasDummyCookie: Boolean(
        privateSource &&
        JSON.stringify(privateSource).includes("closure_header_dummy"),
      ),
    };
    expect(directCookieEvidence.browserRequestHadDummyCookie).toBe(true);
    expect(directCookieEvidence.sourceEventHasDummyCookie).toBe(false);
    expect(directEvents.hasCookieName).toBe(false);
    expect(directEvents.hasAuthorizationName).toBe(false);
    expect(directEvents.hasProxyAuthorizationName).toBe(false);
    expect(
      directEvents.headerNames.every((name) => safeHeaderNames.has(name)),
    ).toBe(true);
    expect(directCookieEvidence.safeSnapshotHasHeadersField).toBe(false);
    expect(directCookieEvidence.safeSnapshotHasDummyCookie).toBe(false);
    expect(
      (await client.getDownloadTasks({ current: 1, pageSize: 100 })).data.total,
    ).toBe(0);

    const publicWatchURL = `${sniffFixture.origin}/watch-public`;
    unwrap<void>(
      await browser.evaluate(
        ({ tabId, url }) => window.electron.browser.loadURL(tabId, url),
        { tabId: controlledTab.id, url: publicWatchURL },
      ),
    );
    let publicMediaURL = "";
    await expect
      .poll(async () => {
        const snapshot = await readBrowserSnapshot();
        const tab = snapshot.tabs.find((item) => item.id === controlledTab.id);
        const source = tab?.sources.find((item) => {
          try {
            const url = new URL(item.url);
            return (
              url.origin === sniffFixture.origin &&
              url.pathname === "/public/sample.mp4" &&
              item.documentURL === publicWatchURL
            );
          } catch {
            return false;
          }
        });
        publicMediaURL = source?.url ?? "";
        return Boolean(publicMediaURL);
      })
      .toBe(true);
    const publicCardTitle = page.locator(
      'span[title="Controlled public watch page"]',
    );
    await expect(publicCardTitle).toHaveCount(1);
    const publicCard = publicCardTitle.locator("xpath=..");
    const editButton = publicCard.getByRole("button", {
      name: "编辑",
      exact: true,
    });
    await expect(editButton).toHaveCount(1);
    await editButton.click();
    const overlay = await downloadOverlayPage(launched);
    const form = overlay.locator('[role="dialog"] form');
    await expect(form).toBeVisible();
    const formState = await form.evaluate((element, expectedURL) => {
      const url = element.querySelector<HTMLInputElement>('input[id$="-url"]');
      const name =
        element.querySelector<HTMLInputElement>('input[id$="-name"]');
      const type = element.querySelector<HTMLElement>('[role="combobox"]');
      const headers = [
        ...element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
          'input[name="headers"], textarea[name="headers"]',
        ),
      ];
      const publicHeaderNames = headers
        .flatMap((field) => field.value.split(/\r?\n/))
        .map((line) => line.slice(0, line.indexOf(":")))
        .filter((headerName) => headerName.length > 0)
        .map((headerName) => headerName.trim().toLowerCase())
        .toSorted();
      const safeFormHeaderNames = new Set([
        "accept",
        "accept-encoding",
        "accept-language",
        "origin",
        "range",
        "referer",
        "user-agent",
      ]);
      return {
        hasExpectedURL: url?.value === expectedURL,
        hasName: Boolean(name?.value.trim()),
        hasType: Boolean(type?.textContent?.trim()),
        headersFieldCount: headers.length,
        publicHeaderNames,
        hasNoSensitiveHeaders:
          headers.every(
            (field) =>
              !/closure_(?:header|auth|hls)_/i.test(field.value) &&
              !/^(?:cookie|authorization|proxy-authorization|x-api-key)\s*:/im.test(
                field.value,
              ),
          ) &&
          publicHeaderNames.every((headerName) =>
            safeFormHeaderNames.has(headerName),
          ),
      };
    }, publicMediaURL);
    expect(formState).toEqual({
      hasExpectedURL: true,
      hasName: true,
      hasType: true,
      hasNoSensitiveHeaders: true,
      headersFieldCount: formState.headersFieldCount,
      publicHeaderNames: formState.publicHeaderNames,
    });
    const taskCountBefore = (
      await client.getDownloadTasks({ current: 1, pageSize: 100 })
    ).data.total;
    expect(taskCountBefore).toBe(0);
    const postPaths: string[] = [];
    const responseStatuses: number[] = [];
    const onRequest = (request: import("@playwright/test").Request) => {
      const url = new URL(request.url());
      if (
        request.method() === "POST" &&
        (url.pathname === "/api/downloads" || url.pathname === "/api/tasks")
      ) {
        postPaths.push(
          `${url.pathname};dummyHeader=${/closure_(?:header|auth|hls)_/i.test(request.postData() ?? "")}`,
        );
      }
    };
    const onResponse = (response: import("@playwright/test").Response) => {
      const url = new URL(response.url());
      if (
        response.request().method() === "POST" &&
        (url.pathname === "/api/downloads" || url.pathname === "/api/tasks")
      ) {
        responseStatuses.push(response.status());
      }
    };
    overlay.on("request", onRequest);
    overlay.on("response", onResponse);
    await overlay
      .getByRole("button", { name: "立即下载", exact: true })
      .click();
    await expect
      .poll(() => responseStatuses.length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(
        async () =>
          (await client.getDownloadTasks({ current: 1, pageSize: 100 })).data
            .total,
      )
      .toBe(1);
    const [task] = (
      await client.getDownloadTasks({ current: 1, pageSize: 100 })
    ).data.list;
    if (!task) throw new Error("Manual public confirmation created no task");
    await expect
      .poll(async () => (await client.getDownloadTask(task.id)).data.status, {
        timeout: 45_000,
      })
      .toBe("success");
    const completed = (await client.getDownloadTask(task.id)).data;
    if (!completed.outputPath)
      throw new Error("Manual public task has no output path");
    const outputSha256 = sha256(await readFile(completed.outputPath));
    expect(outputSha256).toBe(sniffFixture.sampleSha256);
    manualEvidence = {
      overlayURL: overlay.url(),
      formHasExpectedURL: formState.hasExpectedURL,
      formHasName: formState.hasName,
      formHasType: formState.hasType,
      formHasNoSensitiveHeaders: formState.hasNoSensitiveHeaders,
      headersFieldCount: formState.headersFieldCount,
      publicHeaderNames: formState.publicHeaderNames,
      postPaths,
      responseStatuses,
      taskCountBefore,
      taskCountAfter: (
        await client.getDownloadTasks({ current: 1, pageSize: 100 })
      ).data.total,
      taskId: task.id,
      outputSha256,
    };
    overlay.off("request", onRequest);
    overlay.off("response", onResponse);
    expect(manualEvidence.taskCountAfter).toBe(1);
    expect(manualEvidence.postPaths).toEqual(
      expect.arrayContaining(["/api/downloads;dummyHeader=false"]),
    );
    expect(manualEvidence.responseStatuses).toContain(200);
    expect(sniffFixture.sampleHits()).toBeGreaterThan(0);
    passed = true;
  } catch (error) {
    failure.message =
      error instanceof Error ? error.stack || error.message : String(error);
    throw error;
  } finally {
    if (application) await application.close().catch(() => undefined);
    await sniffFixture.close();
    if (owner) {
      processExited = await waitForWindowsProcessExit(owner, 10_000);
      expect(processExited).toBe(true);
    }
    if (coreOwner) {
      coreProcessExited = await waitForWindowsProcessExit(coreOwner, 10_000);
      expect(coreProcessExited).toBe(true);
    }
    await waitForPortFree("127.0.0.1", CORE_PORT, 10_000);
    corePortFreed = true;
    if (passed) {
      await rm(runtimeRoot, { recursive: true, force: true });
      runtimeRootRemoved = true;
    }
    await writeFile(
      path.join(
        EVIDENCE,
        `default-cookie-hls-smoke-${path.basename(runtimeRoot)}.json`,
      ),
      JSON.stringify(
        {
          candidateBinding: BINDING_PATH,
          candidateBindingSha256: bindingSha256,
          candidate,
          exeSha256,
          asarSha256,
          coreSha256,
          testSourceSha256,
          corePort: CORE_PORT,
          ownerProcessIdentity: owner,
          coreListener,
          coreProcessIdentity: coreOwner,
          selectedMainPageUrl,
          hlsEvidence,
          hlsRequestObservations: sniffFixture.hlsRequests(),
          directCookieEvidence,
          manualEvidence,
          sampleSha256: sniffFixture.sampleSha256,
          sampleRequestCount: sniffFixture.sampleHits(),
          passed,
          failure: failure.message,
          processExited,
          coreProcessExited,
          corePortFreed,
          runtimeRootRemoved,
          runtimeRoot,
          evidenceLayer:
            "candidate UI + trusted Core renderer API + actual Core HLS inspector; owned loopback fixture, no external network",
        },
        null,
        2,
      ),
      "utf8",
    );
  }
});
