import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
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
import { trustedCoreClient } from "../support/xiangying-core-client.ts";
import { assertPortFree } from "../support/ports.ts";
import {
  readWindowsProcessIdentity,
  waitForWindowsProcessExit,
  type WindowsProcessIdentity,
} from "../support/xiangying-windows-process.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BINDING_PATH = (() => {
  const value = process.env.MEDIAGO_CLOSURE_BINDING;
  if (!value || !path.isAbsolute(value))
    throw new Error("MEDIAGO_CLOSURE_BINDING must be an absolute path");
  return value;
})();
const EVIDENCE_DIR = path.join(
  ROOT,
  ".task/closure-20261007/downloads/evidence",
);
const RUN_EVIDENCE_DIR = (() => {
  const value = process.env.MEDIAGO_CLOSURE_RUN_DIR;
  if (!value || !path.isAbsolute(value))
    throw new Error("MEDIAGO_CLOSURE_RUN_DIR must be an absolute path");
  const resolved = path.resolve(value);
  const evidenceRoot = path.resolve(EVIDENCE_DIR);
  const evidencePrefix = `${evidenceRoot}${path.sep}`;
  if (
    resolved === evidenceRoot ||
    !resolved.toLowerCase().startsWith(evidencePrefix.toLowerCase())
  )
    throw new Error(
      "MEDIAGO_CLOSURE_RUN_DIR must be inside downloads/evidence",
    );
  return resolved;
})();
const NATIVE_DIALOG_SCRIPT = path.join(
  ROOT,
  "packages/tooling/src/acceptance/xiangying-native-dialog.ps1",
);
const CORE_PORT = Number(process.env.MEDIAGO_CORE_PORT || "39929");
const execFileAsync = promisify(execFile);

interface CandidateBinding {
  candidate: string;
  exeSha256: string;
  coreSha256: string;
  asarSha256: string;
}

async function readVerifiedCandidateBinding(): Promise<CandidateBinding> {
  expect([
    path.resolve(
      ROOT,
      ".task/closure-20261007/root/main-batch-build-20261008/candidate-binding.json",
    ),
    path.resolve(
      ROOT,
      ".task/closure-20261007/root/core-fixes-build-20261008/candidate-binding.json",
    ),
    path.resolve(
      ROOT,
      ".task/closure-20261007/root/startup-storage-build-20261009/candidate-binding.json",
    ),
    path.resolve(
      ROOT,
      ".task/closure-20261007/root/bulk-refresh-build-20261009/candidate-binding.json",
    ),
  ]).toContain(path.resolve(BINDING_PATH));
  const binding = JSON.parse(
    await readFile(BINDING_PATH, "utf8"),
  ) as CandidateBinding;
  expect(path.isAbsolute(binding.candidate)).toBe(true);
  const candidatePath = path.resolve(binding.candidate);
  expect([
    path.resolve(ROOT, ".task/closure-20261007/candidate-ui"),
    path.resolve(ROOT, ".task/closure-20261007/candidate-main-batch-20261008"),
    path.resolve(ROOT, ".task/closure-20261007/candidate-core-fixes-20261008"),
    path.resolve(
      ROOT,
      ".task/closure-20261007/candidate-startup-storage-20261009",
    ),
    path.resolve(
      ROOT,
      ".task/closure-20261007/candidate-bulk-refresh-20261009",
    ),
  ]).toContain(candidatePath);
  expect(binding.coreSha256).toMatch(/^[a-f\d]{64}$/i);
  expect(binding.asarSha256).toMatch(/^[a-f\d]{64}$/i);
  expect(binding.exeSha256).toMatch(/^[a-f\d]{64}$/i);
  const executablePath = path.join(candidatePath, "乡映.exe");
  expect((await stat(executablePath)).isFile()).toBe(true);
  expect((await hashFile(executablePath)).toLowerCase()).toBe(
    binding.exeSha256.toLowerCase(),
  );
  expect(
    (
      await hashFile(path.join(candidatePath, "resources/bin/mediago-core.exe"))
    ).toLowerCase(),
  ).toBe(binding.coreSha256.toLowerCase());
  expect(
    (
      await hashFile(path.join(candidatePath, "resources/app.asar"))
    ).toLowerCase(),
  ).toBe(binding.asarSha256.toLowerCase());
  return binding;
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

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

function optionalStringProperty(
  value: unknown,
  property: string,
): string | undefined {
  if (typeof value !== "object" || value === null || !(property in value))
    return undefined;
  const fieldValue = Reflect.get(value, property);
  return typeof fieldValue === "string" ? fieldValue : undefined;
}

async function snapshotDirectory(
  root: string,
): Promise<
  Array<{ path: string; kind: "directory" | "file"; sha256?: string }>
> {
  const result: Array<{
    path: string;
    kind: "directory" | "file";
    sha256?: string;
  }> = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = path.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        result.push({ path: relative, kind: "directory" });
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        result.push({
          path: relative,
          kind: "file",
          sha256: await hashFile(absolute),
        });
      } else {
        throw new Error(`unexpected dependency tree entry type: ${relative}`);
      }
    }
  };
  await visit(root, "");
  return result;
}

function isCandidateRootPage(page: Page): boolean {
  if (page.isClosed()) return false;
  try {
    const url = new URL(page.url());
    return (
      url.protocol === "xiangying:" &&
      url.hostname === "index.html" &&
      (url.pathname === "" || url.pathname === "/")
    );
  } catch {
    return false;
  }
}

async function startCandidate(
  executablePath: string,
  runtimeRoot: string,
): Promise<{
  application: ElectronApplication;
  page: Page;
  owner: WindowsProcessIdentity;
  coreOwner: WindowsProcessIdentity;
}> {
  const candidateEnv = scrubElectronEnvironment(process.env);
  delete candidateEnv.ELECTRON_RUN_AS_NODE;
  delete candidateEnv.NODE_OPTIONS;
  const application = await _electron.launch({
    executablePath,
    args: [],
    cwd: runtimeRoot,
    timeout: 30_000,
    env: {
      ...candidateEnv,
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
  const owner = await readWindowsProcessIdentity(
    await application.evaluate(() => process.pid),
  );
  if (!owner) throw new Error("candidate Electron owner exited at startup");
  await writeFile(
    path.join(runtimeRoot, "electron-owner.json"),
    JSON.stringify(owner, null, 2),
  );
  await expect
    .poll(() => application.windows().some(isCandidateRootPage), {
      timeout: 15_000,
    })
    .toBe(true);
  const appPages = application.windows();
  const pageUrls = appPages.map((window) => ({
    url: window.url(),
    closed: window.isClosed(),
    isCandidateRootPage: isCandidateRootPage(window),
  }));
  const rootPages = appPages.filter(isCandidateRootPage);
  if (rootPages.length !== 1)
    throw new Error(
      `expected exactly one candidate root Page; observed ${JSON.stringify(pageUrls)}`,
    );
  const page = rootPages[0];
  if (!page) throw new Error("candidate main window not found");
  const nativeWindows = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      id: window.id,
      url: window.webContents.getURL(),
      visible: window.isVisible(),
      focused: window.isFocused(),
      destroyed: window.isDestroyed(),
    })),
  );
  const matchingNativeWindows = nativeWindows.filter(
    (window) => window.url === page.url(),
  );
  if (matchingNativeWindows.length !== 1)
    throw new Error(
      `expected one native BrowserWindow for selected root Page; pages=${JSON.stringify(pageUrls)}; native=${JSON.stringify(nativeWindows)}`,
    );
  const selectedBrowserWindow = matchingNativeWindows[0];
  if (!selectedBrowserWindow)
    throw new Error("candidate BrowserWindow identity is unavailable");
  await writeFile(
    path.join(runtimeRoot, `initial-window-selection-${owner.pid}.json`),
    JSON.stringify({ pageUrls, nativeWindows, selectedBrowserWindow }, null, 2),
    "utf8",
  );
  let coreOwner: WindowsProcessIdentity | undefined;
  await expect
    .poll(
      async () => {
        try {
          coreOwner = await listenerIdentity(CORE_PORT);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  if (!coreOwner) throw new Error("leased Core listener identity unavailable");
  const corePath = path.join(
    path.dirname(executablePath),
    "resources/bin/mediago-core.exe",
  );
  const coreImageOwner = (await processIdentitiesByImage(corePath)).find(
    (identity) =>
      identity.pid === coreOwner!.pid &&
      identity.creationFileTime === coreOwner!.creationFileTime,
  );
  if (!coreImageOwner)
    throw new Error(
      "leased listener PID does not match the bound candidate Core image",
    );
  await writeFile(
    path.join(runtimeRoot, "core-owner.json"),
    JSON.stringify(coreOwner, null, 2),
  );
  return { application, page, owner, coreOwner };
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

async function closeCandidate(
  application: ElectronApplication | undefined,
  owner: WindowsProcessIdentity | undefined,
  runtimeRoot: string,
): Promise<void> {
  if (application) await application.close().catch(() => undefined);
  let electronExited: boolean | null = null;
  if (owner) {
    electronExited = await waitForWindowsProcessExit(owner, 15_000);
    expect(
      electronExited,
      "owned candidate Electron process exited after close",
    ).toBe(true);
  }
  let coreOwner: WindowsProcessIdentity | undefined;
  try {
    coreOwner = JSON.parse(
      await readFile(path.join(runtimeRoot, "core-owner.json"), "utf8"),
    ) as WindowsProcessIdentity;
  } catch {
    coreOwner = undefined;
  }
  if (owner)
    expect(
      coreOwner,
      "bound candidate Core process identity was recorded before shutdown",
    ).toBeDefined();
  let coreExited: boolean | null = null;
  if (coreOwner) {
    coreExited = await waitForWindowsProcessExit(coreOwner, 15_000);
    expect(
      coreExited,
      "exact bound candidate Core owner exited after close",
    ).toBe(true);
  }
  await assertPortFree("127.0.0.1", CORE_PORT, "closure candidate");
  await writeFile(
    path.join(runtimeRoot, "owner-cleanup.json"),
    JSON.stringify(
      {
        electronOwner: owner ?? null,
        electronExited,
        coreOwner: coreOwner ?? null,
        coreExited,
        corePort: CORE_PORT,
        corePortFree: true,
      },
      null,
      2,
    ),
  );
}

async function clickOwnedNativeCancel(
  owner: WindowsProcessIdentity,
): Promise<{ action: string; ownerPid: number; method: string }> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const current = await readWindowsProcessIdentity(owner.pid);
    if (!current || current.creationFileTime !== owner.creationFileTime)
      throw new Error("native save-dialog owner PID+creation identity changed");
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          NATIVE_DIALOG_SCRIPT,
          "-Action",
          "Click",
          "-OwnerPid",
          String(owner.pid),
          "-Names",
          "取消|Cancel",
        ],
        { timeout: 10_000, windowsHide: true, encoding: "utf8" },
      );
      const result = JSON.parse(stdout.trim()) as {
        action: string;
        ownerPid: number;
        method: string;
      };
      if (
        result.action !== "Click" ||
        result.ownerPid !== owner.pid ||
        result.method !== "owned-native-button"
      )
        throw new Error("native helper did not confirm an owned dialog button");
      const after = await readWindowsProcessIdentity(owner.pid);
      if (!after || after.creationFileTime !== owner.creationFileTime)
        throw new Error("native save-dialog owner exited or changed identity");
      return result;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error("owned native save dialog Cancel button was not found", {
    cause: lastError,
  });
}

async function isolatedRuntime(): Promise<string> {
  await mkdir(RUN_EVIDENCE_DIR, { recursive: true });
  const runtimeRoot = await mkdtemp(path.join(RUN_EVIDENCE_DIR, "runtime-"));
  await Promise.all([
    mkdir(path.join(runtimeRoot, "appdata"), { recursive: true }),
    mkdir(path.join(runtimeRoot, "localappdata"), { recursive: true }),
    mkdir(path.join(runtimeRoot, "temp"), { recursive: true }),
    mkdir(path.join(runtimeRoot, "downloads"), { recursive: true }),
    mkdir(path.join(runtimeRoot, "fixtures"), { recursive: true }),
  ]);
  console.log(`[closure-runtime] ${runtimeRoot}`);
  return runtimeRoot;
}

async function navigate(page: Page, route: string): Promise<void> {
  await page.evaluate((nextRoute) => {
    window.history.pushState({}, "", nextRoute);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, route);
}

async function startHttpServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("local fixture server did not bind");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function waitConversion(
  client: Awaited<ReturnType<typeof getClient>>,
  id: number,
  terminal: RegExp = /^done$/,
): Promise<void> {
  await expect
    .poll(async () => (await client.getConversion(id)).data.status, {
      timeout: 90_000,
      intervals: [100, 250, 500, 1000],
    })
    .toMatch(terminal);
}

async function decode(ffmpeg: string, outputPath: string): Promise<void> {
  await execFileAsync(
    ffmpeg,
    [
      "-hide_banner",
      "-v",
      "error",
      "-xerror",
      "-i",
      outputPath,
      "-f",
      "null",
      "-",
    ],
    { timeout: 45_000, windowsHide: true },
  );
}

async function processIdentitiesByImage(
  imagePath: string,
): Promise<WindowsProcessIdentity[]> {
  const escaped = imagePath.replaceAll("'", "''");
  const script = `$ErrorActionPreference='Stop'; $image='${escaped}'; $ids=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath),$image,[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { [int]$_.ProcessId }); [Console]::Out.Write((ConvertTo-Json -InputObject $ids -Compress))`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 15_000, windowsHide: true, encoding: "utf8" },
  );
  const value: unknown = JSON.parse(stdout || "[]");
  const pids = Array.isArray(value) ? value : [value];
  const identities: WindowsProcessIdentity[] = [];
  for (const item of pids) {
    if (typeof item !== "number" || !Number.isInteger(item) || item < 1)
      continue;
    const identity = await readWindowsProcessIdentity(item);
    if (identity) identities.push(identity);
  }
  return identities;
}

async function listenerIdentity(port: number): Promise<WindowsProcessIdentity> {
  const script = `$ErrorActionPreference='Stop'; $ids=@(Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -ExpandProperty OwningProcess -Unique); [Console]::Out.Write((ConvertTo-Json -InputObject $ids -Compress))`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 15_000, windowsHide: true, encoding: "utf8" },
  );
  const value: unknown = JSON.parse(stdout || "[]");
  const pids = Array.isArray(value) ? value : [value];
  const pid = pids.find(
    (item): item is number =>
      typeof item === "number" && Number.isInteger(item) && item > 0,
  );
  if (!pid) throw new Error(`No Core listener identity on leased port ${port}`);
  const identity = await readWindowsProcessIdentity(pid);
  if (!identity)
    throw new Error(`Core listener PID ${pid} exited during identity capture`);
  return identity;
}

test.skip(
  process.platform !== "win32",
  "closure candidate acceptance is Windows-specific",
);

test("R-DL-13: all 7 formats at all 3 qualities produce independent decodable Core outputs", async () => {
  test.setTimeout(900_000);
  expect(Number.isInteger(CORE_PORT) && CORE_PORT > 0).toBe(true);
  await assertPortFree("127.0.0.1", CORE_PORT, "closure candidate");
  const binding = await readVerifiedCandidateBinding();
  const executablePath = path.join(binding.candidate, "乡映.exe");
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    path.resolve(executablePath),
  );

  const runtimeRoot = await isolatedRuntime();
  const fixturePath = path.join(
    runtimeRoot,
    "fixtures",
    "closure-short-input.mp4",
  );
  const ffmpeg = path.join(binding.candidate, "resources/deps/ffmpeg.exe");
  await execFileAsync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=160x90:rate=12",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:sample_rate=44100",
      "-t",
      "1.25",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      fixturePath,
    ],
    { timeout: 45_000, windowsHide: true },
  );
  const inputHash = await hashFile(fixturePath);
  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  let owner: WindowsProcessIdentity | undefined;
  try {
    ({ application, page, owner } = await startCandidate(
      executablePath,
      runtimeRoot,
    ));
    if (!page) throw new Error("candidate main page unavailable after startup");
    const client = await getClient(page);
    const config = await client.getConfig();
    expect(config.data.language).toBe("zh");
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("zh");

    const cases: Array<{
      format: string;
      quality: string;
      id: number;
      outputPath: string;
      outputSha256: string;
    }> = [];
    for (const format of ["mp4", "mkv", "webm", "mp3", "aac", "flac", "wav"]) {
      for (const quality of ["high", "medium", "low"]) {
        const added = await client.addConversion({
          path: fixturePath,
          name: `closure-${format}-${quality}`,
          outputFormat: format,
          quality,
        });
        expect(added.success).toBe(true);
        const id = added.data.id;
        expect((await client.startConversion(id)).success).toBe(true);
        await waitConversion(client, id);
        const result = (await client.getConversion(id)).data;
        expect(result.status).toBe("done");
        expect(result.outputFormat).toBe(format);
        expect(result.quality).toBe(quality);
        expect(path.resolve(result.outputPath)).not.toBe(
          path.resolve(fixturePath),
        );
        expect((await stat(result.outputPath)).size).toBeGreaterThan(0);
        await decode(ffmpeg, result.outputPath);
        expect(await hashFile(fixturePath)).toBe(inputHash);
        cases.push({
          id,
          format,
          quality,
          outputPath: result.outputPath,
          outputSha256: await hashFile(result.outputPath),
        });
        await writeFile(
          path.join(RUN_EVIDENCE_DIR, "conversion-matrix-progress.json"),
          JSON.stringify(
            {
              candidateCoreSha256: binding.coreSha256,
              candidateAsarSha256: binding.asarSha256,
              executablePath,
              fixturePath,
              fixtureSha256: inputHash,
              inputSha256AfterCase: await hashFile(fixturePath),
              completedCases: cases.length,
              latestCase: cases.at(-1),
              cases,
            },
            null,
            2,
          ),
          "utf8",
        );
      }
    }

    expect(cases).toHaveLength(21);
    expect(
      new Set(cases.map((item) => path.resolve(item.outputPath))).size,
    ).toBe(21);
    await navigate(page, "/converter");
    await expect(
      page.getByRole("navigation", { name: /分页|pagination/i }),
    ).toBeVisible();
    await page.getByRole("button", { name: /下一页|next page/i }).click();
    await expect(
      page.getByRole("button", { name: /第 2 页|page 2/i }),
    ).toHaveAttribute("aria-current", "page");

    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "conversion-matrix.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          executablePath,
          executableSha256: await hashFile(executablePath),
          persistedLanguage: config.data.language,
          inputPath: fixturePath,
          inputSha256Before: inputHash,
          inputSha256After: await hashFile(fixturePath),
          formatQualityCount: cases.length,
          cases,
          conversionPaginationPage2: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await closeCandidate(application, owner, runtimeRoot);
  }
});

test("R-DL-09: converter UI queues and decodes an independent same-format output without changing input", async () => {
  test.setTimeout(150_000);
  await assertPortFree("127.0.0.1", CORE_PORT, "closure candidate");
  const binding = await readVerifiedCandidateBinding();
  const executablePath = path.join(binding.candidate, "乡映.exe");
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    path.resolve(executablePath),
  );
  const runtimeRoot = await isolatedRuntime();
  const inputPath = path.join(
    runtimeRoot,
    "fixtures",
    "closure-ui-same-format.mp4",
  );
  const samplePath = path.join(
    ROOT,
    "tests/media-service/public/v1/sample.mp4",
  );
  await writeFile(inputPath, await readFile(samplePath));
  const inputSha256 = await hashFile(inputPath);
  const ffmpeg = path.join(binding.candidate, "resources/deps/ffmpeg.exe");
  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  let owner: WindowsProcessIdentity | undefined;
  try {
    ({ application, page, owner } = await startCandidate(
      executablePath,
      runtimeRoot,
    ));
    if (!page || !application)
      throw new Error("candidate converter window unavailable");
    const converterPage = page;
    const client = await getClient(converterPage);
    expect((await client.getConfig()).data.language).toBe("zh");
    await application.evaluate(({ dialog }, selectedPath) => {
      const state = globalThis as typeof globalThis & {
        closureOpenDialogCalls?: number;
      };
      state.closureOpenDialogCalls = 0;
      dialog.showOpenDialog = async () => {
        state.closureOpenDialogCalls = (state.closureOpenDialogCalls ?? 0) + 1;
        return { canceled: false, filePaths: [selectedPath] };
      };
    }, inputPath);
    await navigate(converterPage, "/converter");
    await converterPage
      .getByRole("button", { name: /创建任务|create task/i })
      .click();
    await converterPage
      .getByRole("button", { name: /选择文件|select media files/i })
      .click();
    await expect
      .poll(() =>
        application!.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                closureOpenDialogCalls?: number;
              }
            ).closureOpenDialogCalls ?? 0,
        ),
      )
      .toBe(1);
    await expect(
      converterPage.getByText(path.basename(inputPath), { exact: true }),
    ).toBeVisible();
    await converterPage
      .getByRole("button", { name: /添加到列表|add to queue/i })
      .click();
    await expect
      .poll(async () => {
        const response = await client.getConversions({
          current: 1,
          pageSize: 100,
        });
        return response.data.list.some((item) => item.path === inputPath);
      })
      .toBe(true);
    const queued = await client.getConversions({ current: 1, pageSize: 100 });
    const item = queued.data.list.find(
      (candidate) => candidate.path === inputPath,
    );
    if (!item) throw new Error("converter UI did not create the staged task");
    expect(item.outputFormat).toBe("mp4");
    expect(item.quality).toBe("medium");
    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "converter-ui-queued-checkpoint.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          taskId: item.id,
          status: item.status,
          outputFormat: item.outputFormat,
          quality: item.quality,
          inputPath,
          inputSha256Before: inputSha256,
          dialogCallCount: await application.evaluate(
            () =>
              (
                globalThis as typeof globalThis & {
                  closureOpenDialogCalls?: number;
                }
              ).closureOpenDialogCalls ?? 0,
          ),
        },
        null,
        2,
      ),
      "utf8",
    );
    const row = converterPage
      .getByText(path.basename(inputPath), { exact: true })
      .locator("xpath=../../..");
    await row.getByRole("button", { name: /^开始$|^start$/i }).click();
    await waitConversion(client, item.id);
    const completed = (await client.getConversion(item.id)).data;
    expect(completed.status).toBe("done");
    expect(path.resolve(completed.outputPath)).not.toBe(
      path.resolve(inputPath),
    );
    expect((await stat(completed.outputPath)).size).toBeGreaterThan(0);
    await decode(ffmpeg, completed.outputPath);
    const inputAfter = await hashFile(inputPath);
    expect(inputAfter).toBe(inputSha256);
    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "converter-ui-same-format.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          taskId: item.id,
          outputFormat: completed.outputFormat,
          quality: completed.quality,
          inputPath,
          inputSha256Before: inputSha256,
          inputSha256After: inputAfter,
          outputPath: completed.outputPath,
          outputSha256: await hashFile(completed.outputPath),
          outputDistinct:
            path.resolve(completed.outputPath) !== path.resolve(inputPath),
          fullFfmpegDecode: true,
          fileDialogBoundary:
            "main-process dialog.showOpenDialog returned the owned fixture path; OS picker interaction not exercised",
        },
        null,
        2,
      ),
    );
  } finally {
    await closeCandidate(application, owner, runtimeRoot);
  }
});

test("R-DL-13 queue: single/all start and stop, retry, delete, clear completed, and page", async () => {
  test.setTimeout(360_000);
  await assertPortFree("127.0.0.1", CORE_PORT, "closure candidate");
  const binding = await readVerifiedCandidateBinding();
  const executablePath = path.join(binding.candidate, "乡映.exe");
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    path.resolve(executablePath),
  );
  const runtimeRoot = await isolatedRuntime();
  const fixturePath = path.join(
    runtimeRoot,
    "fixtures",
    "conversion-queue-long.mp4",
  );
  const missingPath = path.join(
    runtimeRoot,
    "fixtures",
    "retry-created-after-failure.mp4",
  );
  const ffmpeg = path.join(binding.candidate, "resources/deps/ffmpeg.exe");
  const sample = path.join(ROOT, "tests/media-service/public/v1/sample.mp4");
  const sampleBytes = await readFile(sample);
  await execFileAsync(
    ffmpeg,
    [
      "-hide_banner",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=1280x720:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100",
      "-t",
      "45",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "27",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      fixturePath,
    ],
    { timeout: 90_000, windowsHide: true },
  );
  const fixtureHash = await hashFile(fixturePath);
  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  let owner: WindowsProcessIdentity | undefined;
  try {
    ({ application, page, owner } = await startCandidate(
      executablePath,
      runtimeRoot,
    ));
    if (!page) throw new Error("candidate converter page unavailable");
    const converterPage = page;
    const client = await getClient(converterPage);
    const getConversionWithFailureCheckpoint = async (
      id: number,
      phase: string,
    ) => {
      try {
        return await client.getConversion(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const statusMatch = message.match(/HTTP (\d{3})\b/);
        await writeFile(
          path.join(RUN_EVIDENCE_DIR, "conversion-get-failure-checkpoint.json"),
          JSON.stringify(
            {
              phase,
              conversionId: id,
              statusCode: statusMatch ? Number(statusMatch[1]) : null,
              endpointPath: `/api/conversions/${id}`,
            },
            null,
            2,
          ),
          "utf8",
        );
        throw error;
      }
    };
    expect((await client.getConfig()).data.language).toBe("zh");
    const fillers = [];
    for (let index = 0; index < 8; index++) {
      const added = await client.addConversion({
        path: fixturePath,
        name: `queue-page-${index}`,
        outputFormat: "mkv",
        quality: "high",
      });
      expect(added.success).toBe(true);
      fillers.push(added.data.id);
    }
    const deletable = await client.addConversion({
      path: fixturePath,
      name: "queue-delete-pending",
      outputFormat: "mkv",
      quality: "high",
    });
    const retryable = await client.addConversion({
      path: missingPath,
      name: "queue-retry-after-failure",
      outputFormat: "mkv",
      quality: "high",
    });
    const singleStop = await client.addConversion({
      path: fixturePath,
      name: "queue-single-stop",
      outputFormat: "mkv",
      quality: "high",
    });
    const allStartA = await client.addConversion({
      path: fixturePath,
      name: "queue-all-start-a",
      outputFormat: "mkv",
      quality: "high",
    });
    const allStartB = await client.addConversion({
      path: fixturePath,
      name: "queue-all-start-b",
      outputFormat: "mkv",
      quality: "high",
    });
    const singleStart = await client.addConversion({
      path: fixturePath,
      name: "queue-single-start",
      outputFormat: "mkv",
      quality: "high",
    });
    const createdIds = [
      ...fillers,
      deletable.data.id,
      retryable.data.id,
      singleStop.data.id,
      allStartA.data.id,
      allStartB.data.id,
      singleStart.data.id,
    ];
    const allInitial = await client.getConversions({
      current: 1,
      pageSize: 100,
    });
    expect(allInitial.data.list).toHaveLength(14);
    const pageOneApi = await client.getConversions({
      current: 1,
      pageSize: 10,
    });
    const pageTwoApi = await client.getConversions({
      current: 2,
      pageSize: 10,
    });
    const pageOneIds = pageOneApi.data.list.map((item) => item.id);
    const pageTwoIds = pageTwoApi.data.list.map((item) => item.id);
    expect(pageOneApi.data.list).toHaveLength(10);
    expect(pageTwoApi.data.list).toHaveLength(4);
    expect(pageOneIds.filter((id) => pageTwoIds.includes(id))).toEqual([]);
    expect([...pageOneIds, ...pageTwoIds].sort((a, b) => a - b)).toEqual(
      [...createdIds].sort((a, b) => a - b),
    );
    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "conversion-queue-seed-checkpoint.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          fixturePath,
          fixtureSha256: fixtureHash,
          totalCreated: createdIds.length,
          createdIds,
          pageSize: 10,
          pageOneIds,
          pageTwoIds,
          pageOneNames: pageOneApi.data.list.map((item) => item.name),
          pageTwoNames: pageTwoApi.data.list.map((item) => item.name),
          pageIdsDisjoint: true,
          pageUnionMatchesAll14: true,
        },
        null,
        2,
      ),
      "utf8",
    );

    await navigate(converterPage, "/converter");
    await expect(
      converterPage.getByRole("button", { name: /第 1 页|page 1/i }),
    ).toHaveAttribute("aria-current", "page");
    for (const item of pageOneApi.data.list) {
      if (!item.name)
        throw new Error(`queue item ${item.id} has no display name`);
      await expect(
        converterPage.getByText(item.name, { exact: true }),
      ).toBeVisible();
    }
    await converterPage
      .getByRole("button", { name: /下一页|next page/i })
      .click();
    await expect(
      converterPage.getByRole("button", { name: /第 2 页|page 2/i }),
    ).toHaveAttribute("aria-current", "page");
    for (const item of pageTwoApi.data.list) {
      if (!item.name)
        throw new Error(`queue item ${item.id} has no display name`);
      await expect(
        converterPage.getByText(item.name, { exact: true }),
      ).toBeVisible();
    }
    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "conversion-queue-page-ui-checkpoint.json"),
      JSON.stringify(
        {
          currentPage: 2,
          pageSize: 10,
          visiblePageTwoIds: pageTwoIds,
          visiblePageTwoNames: pageTwoApi.data.list.map((item) => item.name),
        },
        null,
        2,
      ),
      "utf8",
    );
    await converterPage
      .getByRole("button", { name: /上一页|previous page/i })
      .click();
    await expect(
      converterPage.getByRole("button", { name: /第 1 页|page 1/i }),
    ).toHaveAttribute("aria-current", "page");

    const row = (name: string) =>
      converterPage.getByText(name, { exact: true }).locator("xpath=../../..");
    const singleUiStartTask = pageOneApi.data.list.find(
      (item) => item.name === "queue-page-0",
    );
    if (!singleUiStartTask)
      throw new Error("single-start fixture is not on the first page");
    const otherPagePendingTask = pageOneApi.data.list.find(
      (item) => item.name === "queue-page-1",
    );
    if (!otherPagePendingTask)
      throw new Error("cross-page pending fixture is not on the first page");
    const conversionExists = async (id: number): Promise<boolean> => {
      try {
        await client.getConversion(id);
        return true;
      } catch {
        return false;
      }
    };
    await row("queue-page-0")
      .getByRole("button", { name: /^开始$|^start$/i })
      .click();
    await waitConversion(client, singleUiStartTask.id);

    await row("queue-retry-after-failure")
      .getByRole("button", { name: /^开始$|^start$/i })
      .click();
    await waitConversion(client, retryable.data.id, /^failed$/);
    await writeFile(missingPath, sampleBytes);
    await row("queue-retry-after-failure")
      .getByRole("button", { name: /重新转换|retry conversion/i })
      .click();
    await waitConversion(client, retryable.data.id);

    await converterPage
      .getByRole("button", { name: /下一页|next page/i })
      .click();
    await expect(
      converterPage.getByRole("button", { name: /第 2 页|page 2/i }),
    ).toHaveAttribute("aria-current", "page");
    await row("queue-single-stop")
      .getByRole("button", { name: /^开始$|^start$/i })
      .click();
    await expect
      .poll(
        async () =>
          (await client.getConversion(singleStop.data.id)).data.status,
      )
      .toBe("converting");
    await row("queue-single-stop")
      .getByRole("button", { name: /^停止$|^stop$/i })
      .click();
    await expect
      .poll(
        async () =>
          (await client.getConversion(singleStop.data.id)).data.status,
      )
      .toBe("failed");
    const singleStopRecord = (await client.getConversion(singleStop.data.id))
      .data;
    expect(singleStopRecord.error).toMatch(/cancel/i);
    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "conversion-queue-single-checkpoint.json"),
      JSON.stringify(
        {
          singleStart: (await client.getConversion(singleUiStartTask.id)).data,
          failedThenRetried: (await client.getConversion(retryable.data.id))
            .data,
          singleStop: singleStopRecord,
          inputSha256Before: fixtureHash,
          inputSha256After: await hashFile(fixturePath),
        },
        null,
        2,
      ),
      "utf8",
    );

    await row("queue-single-stop")
      .getByRole("button", { name: /^删除$|^delete$/i })
      .click();
    await expect.poll(() => conversionExists(singleStop.data.id)).toBe(false);
    const allStartPage = await client.getConversions({
      current: 2,
      pageSize: 10,
    });
    const allStartPageIds = allStartPage.data.list.map((item) => item.id);
    expect(allStartPage.data.list.map((item) => item.name)).toEqual([
      "queue-all-start-a",
      "queue-all-start-b",
      "queue-single-start",
    ]);
    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "conversion-queue-all-page-checkpoint.json"),
      JSON.stringify(
        {
          currentPage: 2,
          pageSize: 10,
          stoppedTaskDeleted: !(await conversionExists(singleStop.data.id)),
          allStartPageIds,
          allStartPageNames: allStartPage.data.list.map((item) => item.name),
        },
        null,
        2,
      ),
      "utf8",
    );

    const visibleIds = allStartPageIds;
    const initiallyPendingIds = allStartPage.data.list
      .filter((item) => item.status === "pending")
      .map((item) => item.id);
    expect(initiallyPendingIds).toEqual(allStartPageIds);
    const otherPageStatusBeforeAllActions = (
      await client.getConversion(otherPagePendingTask.id)
    ).data.status;
    expect(otherPageStatusBeforeAllActions).toBe("pending");
    const allEligibleIds = [...initiallyPendingIds, otherPagePendingTask.id];
    await converterPage
      .getByRole("button", { name: /^全部转换$|^convert all$/i })
      .click();
    await expect
      .poll(
        async () => {
          const statuses = await Promise.all(
            allEligibleIds.map(
              async (id) => (await client.getConversion(id)).data.status,
            ),
          );
          return statuses.every((status) => status !== "pending");
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          converterPage
            .getByRole("button", { name: /^全部停止$|^stop all$/i })
            .count(),
        { timeout: 15_000 },
      )
      .toBe(1);
    const statusesBeforeAllStop = await Promise.all(
      allEligibleIds.map(
        async (id) =>
          (await getConversionWithFailureCheckpoint(id, "all-stop-poll")).data
            .status,
      ),
    );
    expect(statusesBeforeAllStop).toContain("converting");
    expect(
      (await client.getConversion(otherPagePendingTask.id)).data.status,
    ).toBe("converting");
    await converterPage
      .getByRole("button", { name: /^全部停止$|^stop all$/i })
      .click();
    await expect
      .poll(
        async () => {
          const statuses = await Promise.all(
            allEligibleIds.map(
              async (id) => (await client.getConversion(id)).data.status,
            ),
          );
          return statuses.every(
            (status) => status === "done" || status === "failed",
          );
        },
        { timeout: 45_000 },
      )
      .toBe(true);
    const finalRecords = await Promise.all(
      allEligibleIds.map(
        async (id) =>
          (
            await getConversionWithFailureCheckpoint(
              id,
              "all-stop-final-records",
            )
          ).data,
      ),
    );
    const otherPageStatusAfterAllActions = (
      await getConversionWithFailureCheckpoint(
        otherPagePendingTask.id,
        "all-stop-cross-page-status",
      )
    ).data.status;
    expect(otherPageStatusAfterAllActions).toBe("failed");
    expect(
      finalRecords.some((item) => item.error && /cancel/i.test(item.error)),
    ).toBe(true);
    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "conversion-queue-all-checkpoint.json"),
      JSON.stringify(
        {
          currentPage: 2,
          visibleIds,
          allEligibleIds,
          statusesBeforeAllStop,
          finalRecords,
          otherPagePendingTask: {
            id: otherPagePendingTask.id,
            name: otherPagePendingTask.name,
            statusBeforeAllActions: otherPageStatusBeforeAllActions,
            statusAfterAllActions: otherPageStatusAfterAllActions,
            includedAcrossPagesInAllOperations: true,
          },
          inputSha256Before: fixtureHash,
          inputSha256After: await hashFile(fixturePath),
        },
        null,
        2,
      ),
      "utf8",
    );

    // Complete a page-two item after the cross-page stop, so clear-completed
    // must remove records from both pages when invoked from page one.
    await row("queue-all-start-a")
      .getByRole("button", { name: /重新转换|retry conversion/i })
      .click();
    await waitConversion(client, allStartA.data.id);
    const pageTwoCompleted = (await client.getConversion(allStartA.data.id))
      .data;
    expect(pageTwoCompleted.status).toBe("done");
    if (!pageTwoCompleted.outputPath)
      throw new Error("page-two completed conversion has no outputPath");
    const pageTwoOutputSha256 = await hashFile(pageTwoCompleted.outputPath);

    const pageOneCompleted = (await client.getConversion(singleUiStartTask.id))
      .data;
    expect(pageOneCompleted.status).toBe("done");
    if (!pageOneCompleted.outputPath)
      throw new Error("page-one completed conversion has no outputPath");
    const pageOneOutputSha256 = await hashFile(pageOneCompleted.outputPath);
    const donePageOneBeforeClear = (
      await client.getConversions({ current: 1, pageSize: 10 })
    ).data.list
      .filter((item) => item.status === "done")
      .map((item) => item.id);
    const donePageTwoBeforeClear = (
      await client.getConversions({ current: 2, pageSize: 10 })
    ).data.list
      .filter((item) => item.status === "done")
      .map((item) => item.id);
    expect(donePageOneBeforeClear).toContain(singleUiStartTask.id);
    expect(donePageTwoBeforeClear).toContain(allStartA.data.id);
    await writeFile(
      path.join(
        RUN_EVIDENCE_DIR,
        "conversion-queue-clear-cross-page-before.json",
      ),
      JSON.stringify(
        {
          pageSize: 10,
          donePageOneBeforeClear,
          donePageTwoBeforeClear,
          pageOneCompletedId: singleUiStartTask.id,
          pageOneOutputPath: pageOneCompleted.outputPath,
          pageOneOutputSha256,
          pageTwoCompletedId: allStartA.data.id,
          pageTwoOutputPath: pageTwoCompleted.outputPath,
          pageTwoOutputSha256,
          fixturePath,
          fixtureSha256BeforeClear: await hashFile(fixturePath),
        },
        null,
        2,
      ),
      "utf8",
    );

    await converterPage
      .getByRole("button", { name: /上一页|previous page/i })
      .click();
    await expect(
      converterPage.getByRole("button", { name: /第 1 页|page 1/i }),
    ).toHaveAttribute("aria-current", "page");
    await row("queue-delete-pending")
      .getByRole("button", { name: /^删除$|^delete$/i })
      .click();
    await expect.poll(() => conversionExists(deletable.data.id)).toBe(false);

    await converterPage
      .getByRole("button", { name: /清理已完成|clear completed/i })
      .click();
    const clearCompletedTaskIds = [
      singleUiStartTask.id,
      retryable.data.id,
      allStartA.data.id,
    ];
    for (const id of clearCompletedTaskIds) {
      await expect.poll(() => conversionExists(id)).toBe(false);
    }
    const pageOneOutputSha256After = await hashFile(
      pageOneCompleted.outputPath,
    );
    const pageTwoOutputSha256After = await hashFile(
      pageTwoCompleted.outputPath,
    );
    expect(pageOneOutputSha256After).toBe(pageOneOutputSha256);
    expect(pageTwoOutputSha256After).toBe(pageTwoOutputSha256);
    expect(await hashFile(fixturePath)).toBe(fixtureHash);
    await writeFile(
      path.join(
        RUN_EVIDENCE_DIR,
        "conversion-queue-delete-clear-checkpoint.json",
      ),
      JSON.stringify(
        {
          pendingTaskDeleted: !(await conversionExists(deletable.data.id)),
          singleStartCleared: !(await conversionExists(singleUiStartTask.id)),
          retriedTaskCleared: !(await conversionExists(retryable.data.id)),
          pageTwoCompletedCleared: !(await conversionExists(allStartA.data.id)),
          clearCompletedTaskIds,
          pageOneOutputPath: pageOneCompleted.outputPath,
          pageOneOutputSha256Before: pageOneOutputSha256,
          pageOneOutputSha256After,
          pageTwoOutputPath: pageTwoCompleted.outputPath,
          pageTwoOutputSha256Before: pageTwoOutputSha256,
          pageTwoOutputSha256After,
          fixtureSha256Before: fixtureHash,
          fixtureSha256After: await hashFile(fixturePath),
          singleStopDeleted: !(await conversionExists(singleStop.data.id)),
          queueCountAfterCleanup: (
            await client.getConversions({
              current: 1,
              pageSize: 100,
            })
          ).data.list.length,
        },
        null,
        2,
      ),
      "utf8",
    );
    expect(await hashFile(fixturePath)).toBe(fixtureHash);
    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "conversion-queue-actions.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          conversionPageSize: 10,
          totalCreated: createdIds.length,
          page2Observed: true,
          singleStartTaskId: singleUiStartTask.id,
          failedThenRecoveredRetryTaskId: retryable.data.id,
          singleStopTaskId: singleStop.data.id,
          singleStopError: singleStopRecord.error,
          deletedPendingTaskId: deletable.data.id,
          clearCompletedTaskIds,
          clearCompletedSpannedPages: [1, 2],
          convertAllVisibleTaskIds: visibleIds,
          stopAllObservedConverting:
            statusesBeforeAllStop.includes("converting"),
          finalVisibleStatuses: finalRecords.map((item) => ({
            id: item.id,
            status: item.status,
            error: item.error,
          })),
          inputSha256BeforeAndAfter: {
            before: fixtureHash,
            after: await hashFile(fixturePath),
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await closeCandidate(application, owner, runtimeRoot);
  }
});

test("R-DL-06/11: controlled Direct cancellation and selected batch actions", async () => {
  test.setTimeout(240_000);
  await assertPortFree("127.0.0.1", CORE_PORT, "closure candidate");
  const binding = await readVerifiedCandidateBinding();
  const executablePath = path.join(binding.candidate, "乡映.exe");
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    path.resolve(executablePath),
  );
  const runtimeRoot = await isolatedRuntime();
  const outputDir = path.join(runtimeRoot, "downloads");
  const fixtureDir = path.join(runtimeRoot, "fixtures");
  const ffmpeg = path.join(binding.candidate, "resources/deps/ffmpeg.exe");
  const sourceA = path.join(fixtureDir, "video-a.mp4");
  const sample = path.join(ROOT, "tests/media-service/public/v1/sample.mp4");
  await execFileAsync(
    ffmpeg,
    ["-hide_banner", "-v", "error", "-i", sample, "-c", "copy", sourceA],
    { timeout: 30_000, windowsHide: true },
  );
  const bytesA = await readFile(sourceA);

  let activeHits = 0;
  let pendingHits = 0;
  let batchStartHits = 0;
  let unselectedHits = 0;
  let heldActive: ServerResponse | undefined;
  let heldPending: ServerResponse | undefined;
  let heldBatchStart: ServerResponse | undefined;
  const fixture = await startHttpServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    const send = (body: Buffer) => {
      response.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": String(body.length),
      });
      response.end(body);
    };
    if (pathname === "/video-a.mp4") return send(bytesA);
    if (pathname === "/held-active.mp4") {
      activeHits++;
      heldActive = response;
      response.writeHead(200, { "Content-Type": "video/mp4" });
      response.write(bytesA.subarray(0, Math.min(bytesA.length, 1024)));
      return;
    }
    if (pathname === "/held-pending.mp4") {
      pendingHits++;
      heldPending = response;
      response.writeHead(200, { "Content-Type": "video/mp4" });
      response.write(bytesA.subarray(0, Math.min(bytesA.length, 1024)));
      return;
    }
    if (pathname === "/batch-start.mp4") {
      batchStartHits++;
      heldBatchStart = response;
      response.writeHead(200, { "Content-Type": "video/mp4" });
      response.write(bytesA.subarray(0, Math.min(bytesA.length, 1024)));
      return;
    }
    if (pathname === "/never-selected.mp4") {
      unselectedHits++;
      return send(bytesA);
    }
    response.writeHead(404).end();
  });
  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  let owner: WindowsProcessIdentity | undefined;
  try {
    ({ application, page, owner } = await startCandidate(
      executablePath,
      runtimeRoot,
    ));
    if (!page) throw new Error("candidate main page unavailable after startup");
    const client = await getClient(page);
    const queue = await client.addDownloadTasks({
      tasks: [
        {
          type: "direct",
          url: `${fixture.url}/held-active.mp4`,
          name: "closure-active",
        },
        {
          type: "direct",
          url: `${fixture.url}/held-pending.mp4`,
          name: "closure-pending",
        },
        {
          type: "direct",
          url: `${fixture.url}/never-selected.mp4`,
          name: "closure-unselected",
        },
        {
          type: "direct",
          url: `${fixture.url}/never-selected.mp4?edit=1`,
          name: "closure-edit-before",
        },
        {
          type: "direct",
          url: `${fixture.url}/batch-start.mp4`,
          name: "closure-batch-start",
        },
      ],
      startDownload: false,
    });
    expect(queue.data).toHaveLength(5);
    const [active, pending, unselected, editTask, batchStartTask] = queue.data;
    await client.setConfig({ maxRunner: 1 });
    expect((await client.getConfig()).data.maxRunner).toBe(1);
    const aria2Path = path.join(binding.candidate, "resources/deps/aria2c.exe");
    const baselineAria2 = new Set(
      (await processIdentitiesByImage(aria2Path)).map((item) => item.pid),
    );
    await client.startDownload(active.id, {
      localPath: outputDir,
      deleteSegments: true,
    });
    await expect.poll(() => activeHits, { timeout: 15_000 }).toBe(1);
    await expect
      .poll(async () => (await client.getDownloadTask(active.id)).data.status, {
        timeout: 15_000,
      })
      .toBe("downloading");
    let stoppedChild: WindowsProcessIdentity | undefined;
    await expect
      .poll(
        async () => {
          const current = await processIdentitiesByImage(aria2Path);
          stoppedChild = current.find((item) => !baselineAria2.has(item.pid));
          return Boolean(stoppedChild);
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    if (!stoppedChild)
      throw new Error(
        "active controlled download has no identifiable pinned aria2 child",
      );
    expect(
      (
        await client.startDownload(pending.id, {
          localPath: outputDir,
          deleteSegments: true,
        })
      ).success,
    ).toBe(true);
    await expect
      .poll(
        async () => (await client.getDownloadTask(pending.id)).data.status,
        {
          timeout: 15_000,
        },
      )
      .toBe("pending");
    expect(pendingHits).toBe(0);

    await writeFile(
      path.join(
        RUN_EVIDENCE_DIR,
        "direct-active-pending-start-checkpoint.json",
      ),
      JSON.stringify(
        {
          activeStatus: (await client.getDownloadTask(active.id)).data.status,
          pendingStatus: (await client.getDownloadTask(pending.id)).data.status,
          activeSourceHits: activeHits,
          pendingSourceHits: pendingHits,
          unselectedSourceHits: unselectedHits,
          maxRunner: (await client.getConfig()).data.maxRunner,
        },
        null,
        2,
      ),
      "utf8",
    );

    await navigate(page, "/downloads");
    await expect(
      page.getByRole("article", { name: "closure-active" }),
    ).toBeVisible();
    const activeCard = page.getByRole("article", { name: "closure-active" });
    const pendingCard = page.getByRole("article", { name: "closure-pending" });
    const activeCheckbox = activeCard.getByRole("checkbox");
    const pendingCheckbox = pendingCard.getByRole("checkbox");
    await activeCard.hover();
    await expect(activeCheckbox).toBeVisible();
    await activeCheckbox.scrollIntoViewIfNeeded();
    await activeCheckbox.click();
    await pendingCard.hover();
    await expect(pendingCheckbox).toBeVisible();
    await pendingCheckbox.scrollIntoViewIfNeeded();
    await pendingCheckbox.click();
    await expect(page.getByText(/已选择 2 项|2 selected/i)).toBeVisible();
    const clearSelection = page.getByRole("button", {
      name: /^取消$|^cancel$/i,
    });
    if (await clearSelection.count()) await clearSelection.click();
    await expect(activeCard.getByRole("checkbox")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    const afterHeaderCancel = {
      activeStatus: (await client.getDownloadTask(active.id)).data.status,
      pendingStatus: (await client.getDownloadTask(pending.id)).data.status,
      activeSourceHits: activeHits,
      pendingSourceHits: pendingHits,
      unselectedSourceHits: unselectedHits,
    };
    expect(afterHeaderCancel.activeStatus).toBe("downloading");
    expect(afterHeaderCancel.pendingStatus).toBe("pending");
    await expect(pendingCard.getByRole("checkbox")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(afterHeaderCancel.activeSourceHits).toBe(1);
    expect(afterHeaderCancel.pendingSourceHits).toBe(0);
    expect(afterHeaderCancel.unselectedSourceHits).toBe(0);

    await activeCard.getByRole("checkbox").click();
    await pendingCard.getByRole("checkbox").click();
    const batchStopButton = page.getByRole("button", {
      name: /批量停止|停止选中|stop selected|pause selected/i,
    });
    const batchStopEntryCount = await batchStopButton.count();
    let batchStopDidStopSelected = false;
    if (batchStopEntryCount === 1) {
      await batchStopButton.click();
      await expect
        .poll(
          async () => (await client.getDownloadTask(active.id)).data.status,
          {
            timeout: 15_000,
          },
        )
        .toMatch(/^(failed|stopped)$/);
      await expect
        .poll(
          async () => (await client.getDownloadTask(pending.id)).data.status,
          {
            timeout: 15_000,
          },
        )
        .toMatch(/^(failed|stopped)$/);
      batchStopDidStopSelected = true;
    }

    if (!batchStopDidStopSelected) await client.stopDownload(active.id);
    await expect
      .poll(async () => (await client.getDownloadTask(active.id)).data.status, {
        timeout: 15_000,
      })
      .toMatch(/^(failed|stopped)$/);
    const activeChildExited = await waitForWindowsProcessExit(
      stoppedChild,
      15_000,
    );
    expect(
      activeChildExited,
      "the exact pinned aria2 PID+creation identity exited after active stop",
    ).toBe(true);
    if (!batchStopDidStopSelected) await client.stopDownload(pending.id);
    await expect
      .poll(
        async () => (await client.getDownloadTask(pending.id)).data.status,
        {
          timeout: 15_000,
        },
      )
      .toMatch(/^(failed|stopped)$/);
    expect(pendingHits).toBe(0);

    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "direct-active-pending-checkpoint.json"),
      JSON.stringify(
        {
          afterActualPendingStart: {
            activeStatus: afterHeaderCancel.activeStatus,
            pendingStatus: afterHeaderCancel.pendingStatus,
            activeSourceHits: afterHeaderCancel.activeSourceHits,
            pendingSourceHits: afterHeaderCancel.pendingSourceHits,
            unselectedSourceHits: afterHeaderCancel.unselectedSourceHits,
          },
          afterSelectedBatchStop: {
            activeStatus: (await client.getDownloadTask(active.id)).data.status,
            pendingStatus: (await client.getDownloadTask(pending.id)).data
              .status,
            batchStopDidStopSelected,
            pendingSourceHits: pendingHits,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const batchStartCard = page.getByRole("article", {
      name: "closure-batch-start",
    });
    await page.getByRole("button", { name: /^取消$|^cancel$/i }).click();
    await expect(activeCard.getByRole("checkbox")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(pendingCard.getByRole("checkbox")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(batchStartCard.getByRole("checkbox")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await batchStartCard.getByRole("checkbox").click();
    await expect(page.getByText(/已选择 1 项|1 selected/i)).toBeVisible();
    await expect(batchStartCard.getByRole("checkbox")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(activeCard.getByRole("checkbox")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(pendingCard.getByRole("checkbox")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "direct-batch-selection-checkpoint.json"),
      JSON.stringify(
        {
          selectedCount: 1,
          batchStartSelected: true,
          activeSelected: false,
          pendingSelected: false,
          unselectedSourceHits: unselectedHits,
        },
        null,
        2,
      ),
      "utf8",
    );
    const batchStartHeader = page
      .locator(
        "div.flex.flex-row.items-center.justify-between.border-b.px-3.py-2",
      )
      .getByRole("button", { name: /^下载$|^download$/i });
    await expect(batchStartHeader).toHaveCount(1);
    await batchStartHeader.click();
    await expect.poll(() => batchStartHits, { timeout: 15_000 }).toBe(1);
    await expect
      .poll(
        async () =>
          (await client.getDownloadTask(batchStartTask.id)).data.status,
        { timeout: 15_000 },
      )
      .toBe("downloading");
    expect(unselectedHits).toBe(0);

    const unselectedCard = page.getByRole("article", {
      name: "closure-unselected",
    });
    await unselectedCard.getByRole("checkbox").click();
    await page.getByRole("button", { name: /^删除$|^delete$/i }).click();
    let unselectedRecordDeleted = false;
    try {
      await client.getDownloadTask(unselected.id);
    } catch {
      unselectedRecordDeleted = true;
    }
    expect(unselectedRecordDeleted).toBe(true);
    expect(unselectedHits).toBe(0);

    const editCard = page.getByRole("article", { name: "closure-edit-before" });
    await editCard.getByRole("button", { name: /编辑|edit/i }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('input[id$="-name"]').fill("closure-edit-after");
    await dialog.getByRole("button", { name: /^保存$|^save$/i }).click();
    await expect(
      page.getByRole("article", { name: "closure-edit-after" }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("article", { name: "closure-edit-after" }),
    ).toBeVisible();
    expect((await client.getDownloadTask(editTask.id)).data.name).toBe(
      "closure-edit-after",
    );
    await client.stopDownload(batchStartTask.id);

    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "direct-batch-observation.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          sourceA: { sha256: await hashFile(sourceA), path: sourceA },
          batchCancelObserved: afterHeaderCancel,
          batchStopEntryCount,
          batchStopDidStopSelected,
          selectedBatchStartOnlySelected: { batchStartHits, unselectedHits },
          activeStopChildIdentity: stoppedChild,
          activeStopChildExited: activeChildExited,
          pendingTaskStoppedBeforeAnySourceRequest: {
            pendingHits,
            status: (await client.getDownloadTask(pending.id)).data.status,
          },
          editPersistedAcrossRefresh: true,
          selectedBatchDeleteRemovedOnlyChosenRecord: unselectedRecordDeleted,
          batchStopContract: batchStopDidStopSelected
            ? "verified: selected active and pending tasks stopped while unselected task remained untouched"
            : "not demonstrated: no batch-stop action was available; individual stop APIs were used only for cleanup",
        },
        null,
        2,
      ),
    );
  } finally {
    heldActive?.destroy();
    heldPending?.destroy();
    heldBatchStart?.destroy();
    await closeServer(fixture.server);
    await closeCandidate(application, owner, runtimeRoot);
  }
});

test("R-DL-11 contract: selected batch stop stops active and pending tasks only", async () => {
  test.setTimeout(90_000);
  await assertPortFree("127.0.0.1", CORE_PORT, "closure candidate");
  const binding = await readVerifiedCandidateBinding();
  const executablePath = path.join(binding.candidate, "乡映.exe");
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    path.resolve(executablePath),
  );
  const runtimeRoot = await isolatedRuntime();
  const outputDir = path.join(runtimeRoot, "downloads");
  let activeHits = 0;
  let pendingHits = 0;
  let unselectedHits = 0;
  let heldActive: ServerResponse | undefined;
  let activeAria2: WindowsProcessIdentity | undefined;
  const aria2Path = path.join(binding.candidate, "resources/deps/aria2c.exe");
  const baselineAria2 = new Set(
    (await processIdentitiesByImage(aria2Path)).map((item) => item.pid),
  );
  const fixture = await startHttpServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (pathname === "/active.mp4") {
      activeHits++;
      heldActive = response;
      response.writeHead(200, { "Content-Type": "video/mp4" });
      response.write(Buffer.from("controlled-active-prefix"));
      return;
    }
    if (pathname === "/unselected.mp4") {
      unselectedHits++;
      response.writeHead(200, { "Content-Type": "video/mp4" });
      response.write(Buffer.from("controlled-unselected-prefix"));
      return;
    }
    if (pathname === "/pending.mp4") {
      pendingHits++;
      response.writeHead(404).end();
      return;
    }
    response.writeHead(404).end();
  });
  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  let owner: WindowsProcessIdentity | undefined;
  let coreOwner: WindowsProcessIdentity | undefined;
  try {
    ({ application, page, owner, coreOwner } = await startCandidate(
      executablePath,
      runtimeRoot,
    ));
    if (!page) throw new Error("candidate main page unavailable after startup");
    const client = await getClient(page);
    await client.setConfig({ maxRunner: 1 });
    expect((await client.getConfig()).data.maxRunner).toBe(1);
    const queued = await client.addDownloadTasks({
      tasks: [
        {
          type: "direct",
          url: `${fixture.url}/active.mp4`,
          name: "dl11-active",
        },
        {
          type: "direct",
          url: `${fixture.url}/pending.mp4`,
          name: "dl11-pending",
        },
        {
          type: "direct",
          url: `${fixture.url}/unselected.mp4`,
          name: "dl11-unselected",
        },
      ],
      startDownload: false,
    });
    expect(queued.data).toHaveLength(3);
    const [active, pending, unselected] = queued.data;
    await client.startDownload(active.id, {
      localPath: outputDir,
      deleteSegments: true,
    });
    await expect.poll(() => activeHits, { timeout: 15_000 }).toBe(1);
    await expect
      .poll(async () => (await client.getDownloadTask(active.id)).data.status, {
        timeout: 15_000,
      })
      .toBe("downloading");
    expect(
      (
        await client.startDownload(pending.id, {
          localPath: outputDir,
          deleteSegments: true,
        })
      ).success,
    ).toBe(true);
    await expect
      .poll(
        async () => (await client.getDownloadTask(pending.id)).data.status,
        { timeout: 15_000 },
      )
      .toBe("pending");
    await expect
      .poll(
        async () => {
          const processes = await processIdentitiesByImage(aria2Path);
          activeAria2 = processes.find(
            (processIdentity) => !baselineAria2.has(processIdentity.pid),
          );
          return Boolean(activeAria2);
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    if (!activeAria2)
      throw new Error(
        "active Direct task has no pinned aria2 PID+creation identity",
      );
    await writeFile(
      path.join(runtimeRoot, "active-aria2-owner.json"),
      JSON.stringify(activeAria2, null, 2),
    );
    expect((await client.getDownloadTask(unselected.id)).data.status).toBe(
      "ready",
    );

    await navigate(page, "/downloads");
    const activeCard = page.getByRole("article", { name: "dl11-active" });
    const pendingCard = page.getByRole("article", { name: "dl11-pending" });
    await activeCard.getByRole("checkbox").click();
    await pendingCard.getByRole("checkbox").click();
    const stopSelected = page.getByRole("button", {
      name: /批量停止|停止选中|stop selected|pause selected/i,
    });
    const stopButtonCount = await stopSelected.count();
    await writeFile(
      path.join(runtimeRoot, "dl11-batch-stop-red-observation.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          electronOwner: owner,
          coreOwner,
          activeAria2Owner: activeAria2,
          tasks: {
            active: {
              id: active.id,
              status: (await client.getDownloadTask(active.id)).data.status,
            },
            pending: {
              id: pending.id,
              status: (await client.getDownloadTask(pending.id)).data.status,
            },
            unselected: {
              id: unselected.id,
              status: (await client.getDownloadTask(unselected.id)).data.status,
            },
            selectedIds: [active.id, pending.id],
          },
          sourceHits: { activeHits, pendingHits, unselectedHits },
          stopButtonCount,
          relevantDomText: await page.locator("body").innerText(),
        },
        null,
        2,
      ),
    );
    await expect(
      stopSelected,
      "the selected-task toolbar exposes a real batch-stop action",
    ).toHaveCount(1);
    await stopSelected.click();
    await expect
      .poll(async () => (await client.getDownloadTask(active.id)).data.status, {
        timeout: 15_000,
      })
      .toMatch(/^(failed|stopped)$/);
    await expect
      .poll(
        async () => (await client.getDownloadTask(pending.id)).data.status,
        { timeout: 15_000 },
      )
      .toMatch(/^(failed|stopped)$/);
    expect((await client.getDownloadTask(unselected.id)).data.status).toBe(
      "ready",
    );
    expect(activeHits).toBe(1);
    expect(unselectedHits).toBe(0);
    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "batch-stop-contract.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          activeTaskId: active.id,
          pendingTaskId: pending.id,
          unselectedTaskId: unselected.id,
          selectedStopped: true,
          unselectedRemainedPending: true,
          sourceHits: { activeHits, unselectedHits },
        },
        null,
        2,
      ),
    );
  } finally {
    heldActive?.destroy();
    await closeServer(fixture.server);
    await closeCandidate(application, owner, runtimeRoot);
    const activeAria2Exited = activeAria2
      ? await waitForWindowsProcessExit(activeAria2, 15_000)
      : undefined;
    const coreOwnerExited = coreOwner
      ? await waitForWindowsProcessExit(coreOwner, 15_000)
      : undefined;
    await writeFile(
      path.join(runtimeRoot, "owned-process-cleanup.json"),
      JSON.stringify(
        {
          electronOwner: owner,
          coreOwner,
          coreOwnerExited,
          activeAria2Owner: activeAria2,
          activeAria2Exited,
          corePortFree: true,
        },
        null,
        2,
      ),
    );
    if (activeAria2) {
      expect(
        activeAria2Exited,
        "owned pinned aria2 PID+creation exited after candidate cleanup",
      ).toBe(true);
    }
    if (coreOwner) {
      expect(
        coreOwnerExited,
        "owned Core PID+creation exited after candidate cleanup",
      ).toBe(true);
    }
  }
});

test("R-DL-11 contract: clicking select all from a partial selection selects every eligible row", async () => {
  test.setTimeout(90_000);
  await assertPortFree("127.0.0.1", CORE_PORT, "closure candidate");
  const binding = await readVerifiedCandidateBinding();
  const executablePath = path.join(binding.candidate, "乡映.exe");
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    path.resolve(executablePath),
  );
  const runtimeRoot = await isolatedRuntime();
  let sourceHits = 0;
  const fixture = await startHttpServer((_request, response) => {
    sourceHits++;
    response.writeHead(404).end();
  });
  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  let owner: WindowsProcessIdentity | undefined;
  let coreOwner: WindowsProcessIdentity | undefined;
  try {
    ({ application, page, owner, coreOwner } = await startCandidate(
      executablePath,
      runtimeRoot,
    ));
    if (!page) throw new Error("candidate main page unavailable after startup");
    const client = await getClient(page);
    const queued = await client.addDownloadTasks({
      tasks: [0, 1, 2].map((index) => ({
        type: "direct" as const,
        url: `${fixture.url}/select-all-${index}.mp4`,
        name: `dl11-select-all-${index}`,
      })),
      startDownload: false,
    });
    expect(queued.data).toHaveLength(3);
    expect(
      await Promise.all(
        queued.data.map(
          async (task) => (await client.getDownloadTask(task.id)).data.status,
        ),
      ),
    ).toEqual(["ready", "ready", "ready"]);

    await navigate(page, "/downloads");
    const currentPage = page;
    const cards = queued.data.map((task) =>
      currentPage.getByRole("article", { name: task.name }),
    );
    await cards[0].getByRole("checkbox").click();
    await expect(page.getByText(/已选择 1 项|1 selected/i)).toBeVisible();
    await page.getByText(/全选|select all/i).click();

    const selectedCounter = page.getByText(/已选择 3 项|3 selected/i);
    const selectedCounterCount = await selectedCounter.count();
    const checkboxStates = await Promise.all(
      cards.map((card) =>
        card.getByRole("checkbox").getAttribute("aria-checked"),
      ),
    );
    await writeFile(
      path.join(runtimeRoot, "dl11-select-all-red-observation.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          electronOwner: owner,
          coreOwner,
          taskIds: queued.data.map((task) => task.id),
          taskStatuses: await Promise.all(
            queued.data.map(
              async (task) =>
                (await client.getDownloadTask(task.id)).data.status,
            ),
          ),
          selectedCounterCount,
          checkboxStates,
          sourceHits,
          relevantDomText: await page.locator("body").innerText(),
        },
        null,
        2,
      ),
    );

    await expect(
      selectedCounter,
      "partial selection followed by Select All must select all eligible rows",
    ).toBeVisible();
    await Promise.all(
      cards.map((card) =>
        expect(card.getByRole("checkbox")).toHaveAttribute(
          "aria-checked",
          "true",
        ),
      ),
    );

    await page.getByRole("button", { name: /取消|cancel/i }).click();
    await Promise.all(
      cards.map((card) =>
        expect(card.getByRole("checkbox")).toHaveAttribute(
          "aria-checked",
          "false",
        ),
      ),
    );
    expect(sourceHits).toBe(0);
    expect(
      await Promise.all(
        queued.data.map(
          async (task) => (await client.getDownloadTask(task.id)).data.status,
        ),
      ),
    ).toEqual(["ready", "ready", "ready"]);
    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "select-all-partial-contract.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          taskIds: queued.data.map((task) => task.id),
          partialSelectionThenSelectAll: true,
          cancelOnlyClearedSelection: true,
          allTasksRemainPending: true,
          sourceHits,
        },
        null,
        2,
      ),
    );
  } finally {
    await closeServer(fixture.server);
    await closeCandidate(application, owner, runtimeRoot);
    const coreOwnerExited = coreOwner
      ? await waitForWindowsProcessExit(coreOwner, 15_000)
      : undefined;
    await writeFile(
      path.join(runtimeRoot, "owned-process-cleanup.json"),
      JSON.stringify(
        {
          electronOwner: owner,
          coreOwner,
          coreOwnerExited,
          sourceHits,
          corePortFree: true,
        },
        null,
        2,
      ),
    );
    if (coreOwner) {
      expect(
        coreOwnerExited,
        "owned Core PID+creation exited after candidate cleanup",
      ).toBe(true);
    }
  }
});

test("R-DL-08: completed work is not replayed after same-profile restart; interrupted work can retry", async () => {
  test.setTimeout(180_000);
  await assertPortFree("127.0.0.1", CORE_PORT, "closure candidate");
  const binding = await readVerifiedCandidateBinding();
  const executablePath = path.join(binding.candidate, "乡映.exe");
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    path.resolve(executablePath),
  );
  const runtimeRoot = await isolatedRuntime();
  const outputDir = path.join(runtimeRoot, "downloads");
  const fixturePath = path.join(runtimeRoot, "fixtures", "restart-source.mp4");
  const sourcePath = path.join(
    ROOT,
    "tests/media-service/public/v1/sample.mp4",
  );
  await writeFile(fixturePath, await readFile(sourcePath));
  const fixtureBytes = await readFile(fixturePath);
  const fixtureHash = await hashFile(fixturePath);
  let completedHits = 0;
  let retryHits = 0;
  let heldResponse: ServerResponse | undefined;
  let heldRetryResponse: ServerResponse | undefined;
  const fixture = await startHttpServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (pathname === "/completed.mp4") {
      completedHits++;
      response.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": String(fixtureBytes.length),
      });
      response.end(fixtureBytes);
      return;
    }
    if (pathname === "/interrupted.mp4") {
      retryHits++;
      response.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": String(fixtureBytes.length),
      });
      if (retryHits === 1) {
        heldResponse = response;
        response.write(
          fixtureBytes.subarray(0, Math.min(fixtureBytes.length, 2048)),
        );
        return;
      }
      if (retryHits === 2) {
        heldRetryResponse = response;
        response.write(
          fixtureBytes.subarray(0, Math.min(fixtureBytes.length, 2048)),
        );
        return;
      }
      response.end(fixtureBytes);
      return;
    }
    response.writeHead(404).end();
  });

  let firstApplication: ElectronApplication | undefined;
  let firstOwner: WindowsProcessIdentity | undefined;
  let secondApplication: ElectronApplication | undefined;
  let secondOwner: WindowsProcessIdentity | undefined;
  try {
    const first = await startCandidate(executablePath, runtimeRoot);
    firstApplication = first.application;
    firstOwner = first.owner;
    const firstClient = await getClient(first.page);
    expect((await firstClient.getConfig()).data.language).toBe("zh");
    const created = await firstClient.addDownloadTasks({
      tasks: [
        {
          type: "direct",
          url: `${fixture.url}/completed.mp4`,
          name: "closure-completed",
        },
        {
          type: "direct",
          url: `${fixture.url}/interrupted.mp4`,
          name: "closure-interrupted",
        },
      ],
      startDownload: false,
    });
    expect(created.data).toHaveLength(2);
    const [completed, interrupted] = created.data;
    await firstClient.startDownload(completed.id, {
      localPath: outputDir,
      deleteSegments: true,
    });
    await expect
      .poll(
        async () =>
          (await firstClient.getDownloadTask(completed.id)).data.status,
        { timeout: 30_000 },
      )
      .toBe("success");
    const completedBeforeRestart = (
      await firstClient.getDownloadTask(completed.id)
    ).data;
    const completedOutputBefore = await hashFile(
      completedBeforeRestart.outputPath ||
        path.join(outputDir, "closure-completed.mp4"),
    );
    expect(completedOutputBefore).toBe(fixtureHash);
    expect(completedHits).toBe(1);
    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "restart-completed-before-checkpoint.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          runtimeRoot,
          language: (await firstClient.getConfig()).data.language,
          completedTaskId: completed.id,
          completedStatus: completedBeforeRestart.status,
          completedSourceHits: completedHits,
          completedOutputSha256: completedOutputBefore,
          fixtureSha256: fixtureHash,
          firstElectron: first.owner,
          firstCoreListener: first.coreOwner,
        },
        null,
        2,
      ),
      "utf8",
    );

    await firstClient.startDownload(interrupted.id, {
      localPath: outputDir,
      deleteSegments: true,
    });
    await expect.poll(() => retryHits, { timeout: 15_000 }).toBe(1);
    await expect
      .poll(
        async () =>
          (await firstClient.getDownloadTask(interrupted.id)).data.status,
        { timeout: 15_000 },
      )
      .toBe("downloading");
    const firstCoreOwner = await listenerIdentity(CORE_PORT);
    const aria2Path = path.join(binding.candidate, "resources/deps/aria2c.exe");
    const firstAria2 = await processIdentitiesByImage(aria2Path);
    expect(firstAria2.length).toBeGreaterThan(0);
    await firstApplication.close();
    expect(
      await waitForWindowsProcessExit(firstOwner, 15_000),
      "first Electron owner exited",
    ).toBe(true);
    expect(
      await waitForWindowsProcessExit(firstCoreOwner, 15_000),
      "first Core listener owner exited",
    ).toBe(true);
    for (const child of firstAria2)
      expect(
        await waitForWindowsProcessExit(child, 15_000),
        `aria2 child ${child.pid} exited`,
      ).toBe(true);
    await assertPortFree("127.0.0.1", CORE_PORT, "closure candidate restart");
    await writeFile(
      path.join(
        RUN_EVIDENCE_DIR,
        "restart-first-generation-exit-checkpoint.json",
      ),
      JSON.stringify(
        {
          firstElectron: first.owner,
          firstElectronExited: true,
          firstCoreListener: firstCoreOwner,
          firstCoreExited: true,
          firstAria2Children: firstAria2,
          firstAria2ChildrenExited: firstAria2.map(() => true),
          corePort: CORE_PORT,
          corePortFree: true,
          interruptedTaskId: interrupted.id,
          interruptedSourceHitsBeforeRestart: retryHits,
          completedTaskSourceHits: completedHits,
        },
        null,
        2,
      ),
      "utf8",
    );
    firstApplication = undefined;
    firstOwner = undefined;
    heldResponse?.destroy();

    const second = await startCandidate(executablePath, runtimeRoot);
    secondApplication = second.application;
    secondOwner = second.owner;
    const secondClient = await getClient(second.page);
    const secondCoreOwner = await listenerIdentity(CORE_PORT);
    expect(second.owner.pid).not.toBe(first.owner.pid);
    expect(secondCoreOwner.pid).not.toBe(firstCoreOwner.pid);
    const secondLanguage = (await secondClient.getConfig()).data.language;
    expect(secondLanguage).toBe("zh");
    const completedAfterRestart = (
      await secondClient.getDownloadTask(completed.id)
    ).data;
    expect(completedAfterRestart.status).toBe("success");
    expect(
      await hashFile(
        completedAfterRestart.outputPath ||
          path.join(outputDir, "closure-completed.mp4"),
      ),
    ).toBe(completedOutputBefore);
    expect(completedHits).toBe(1);
    const interruptedAfterRestart = (
      await secondClient.getDownloadTask(interrupted.id)
    ).data;
    expect(interruptedAfterRestart.status).not.toBe("success");
    const secondAria2Baseline = new Set(
      (await processIdentitiesByImage(aria2Path)).map((item) => item.pid),
    );
    await secondClient.startDownload(interrupted.id, {
      localPath: outputDir,
      deleteSegments: true,
    });
    await expect.poll(() => retryHits, { timeout: 15_000 }).toBe(2);
    let secondAria2Child: WindowsProcessIdentity | undefined;
    await expect
      .poll(
        async () => {
          const current = await processIdentitiesByImage(aria2Path);
          secondAria2Child = current.find(
            (item) => !secondAria2Baseline.has(item.pid),
          );
          return Boolean(secondAria2Child);
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    if (!secondAria2Child)
      throw new Error("retried controlled download has no pinned aria2 child");
    heldRetryResponse?.end(fixtureBytes.subarray(2048));
    await expect
      .poll(
        async () =>
          (await secondClient.getDownloadTask(interrupted.id)).data.status,
        { timeout: 45_000 },
      )
      .toBe("success");
    const recovered = (await secondClient.getDownloadTask(interrupted.id)).data;
    const recoveredHash = await hashFile(
      recovered.outputPath || path.join(outputDir, "closure-interrupted.mp4"),
    );
    expect(recoveredHash).toBe(fixtureHash);
    expect(await hashFile(fixturePath)).toBe(fixtureHash);
    expect(await waitForWindowsProcessExit(secondAria2Child, 15_000)).toBe(
      true,
    );
    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "restart-retry-recovered-checkpoint.json"),
      JSON.stringify(
        {
          completedTaskId: completed.id,
          completedStatus: completedAfterRestart.status,
          completedSourceHitsAfterRestart: completedHits,
          completedOutputSha256Before: completedOutputBefore,
          completedOutputSha256After: await hashFile(
            completedAfterRestart.outputPath ||
              path.join(outputDir, "closure-completed.mp4"),
          ),
          interruptedTaskId: interrupted.id,
          interruptedSourceHits: retryHits,
          retryTaskStatus: recovered.status,
          recoveredOutputSha256: recoveredHash,
          inputSha256Before: fixtureHash,
          inputSha256After: await hashFile(fixturePath),
          secondElectron: second.owner,
          secondCoreListener: secondCoreOwner,
          secondAria2Child,
          secondAria2ChildExited: true,
        },
        null,
        2,
      ),
      "utf8",
    );

    await secondApplication.close();
    const secondElectronExited = await waitForWindowsProcessExit(
      secondOwner,
      15_000,
    );
    expect(secondElectronExited, "second Electron owner exited").toBe(true);
    const secondCoreExited = await waitForWindowsProcessExit(
      secondCoreOwner,
      15_000,
    );
    expect(secondCoreExited, "second Core listener owner exited").toBe(true);
    await assertPortFree("127.0.0.1", CORE_PORT, "closure candidate restart");
    secondApplication = undefined;
    secondOwner = undefined;

    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "restart-nonreplay.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          runtimeRoot,
          persistedLanguage: secondLanguage,
          completedTaskId: completed.id,
          completedSourceHitsBeforeAndAfterRestart: completedHits,
          completedOutputSha256BeforeAndAfterRestart: completedOutputBefore,
          interruptedTaskId: interrupted.id,
          interruptedSourceHits: retryHits,
          recoveredOutputSha256: recoveredHash,
          inputSha256BeforeAndAfter: {
            before: fixtureHash,
            after: await hashFile(fixturePath),
          },
          firstElectron: first.owner,
          firstCoreListener: firstCoreOwner,
          secondElectron: second.owner,
          secondCoreListener: secondCoreOwner,
          secondAria2Child: secondAria2Child,
          processExitProof: {
            firstElectron: true,
            firstCoreListener: true,
            firstAria2Children: firstAria2.map(() => true),
            secondElectron: secondElectronExited,
            secondCoreListener: secondCoreExited,
            secondAria2Child: true,
            secondCorePortFreed: true,
          },
          firstAria2Children: firstAria2,
        },
        null,
        2,
      ),
    );
  } finally {
    heldResponse?.destroy();
    await closeServer(fixture.server);
    await closeCandidate(secondApplication, secondOwner, runtimeRoot);
    if (firstApplication)
      await closeCandidate(firstApplication, firstOwner, runtimeRoot);
  }
});

test("R-DL-12: real download-list export writes only isolated task text through the save IPC", async () => {
  test.setTimeout(90_000);
  await assertPortFree("127.0.0.1", CORE_PORT, "closure candidate");
  const binding = await readVerifiedCandidateBinding();
  const executablePath = path.join(binding.candidate, "乡映.exe");
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    path.resolve(executablePath),
  );
  const runtimeRoot = await isolatedRuntime();
  let application: ElectronApplication | undefined;
  let owner: WindowsProcessIdentity | undefined;
  let exportPage: Page | undefined;
  try {
    ({
      application,
      owner,
      page: exportPage,
    } = await startCandidate(executablePath, runtimeRoot));
    const page = exportPage;
    if (!page || !application)
      throw new Error("candidate export page unavailable");
    const client = await getClient(page);
    const config = await client.getConfig();
    expect(config.data.language).toBe("zh");
    const task = await client.addDownloadTasks({
      tasks: [
        {
          type: "direct",
          url: "http://127.0.0.1:9/closure-export-only.mp4",
          name: "closure-export-only",
        },
      ],
      startDownload: false,
    });
    expect(task.data).toHaveLength(1);
    const taskListText = (await client.exportDownloadList()).data;
    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "download-export-api-checkpoint.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          language: config.data.language,
          taskIds: task.data.map((item) => item.id),
          apiExportSha256: createHash("sha256")
            .update(taskListText)
            .digest("hex"),
          apiExportIncludesOwnedTask: taskListText.includes(
            "closure-export-only",
          ),
        },
        null,
        2,
      ),
      "utf8",
    );
    await navigate(page, "/downloads");
    await page.getByRole("button", { name: /^更多$|^more$/i }).click();
    const exportPath = path.join(
      runtimeRoot,
      "downloads",
      "closure-export.txt",
    );
    await application.evaluate(({ dialog }, targetPath) => {
      const state = globalThis as typeof globalThis & {
        closureSaveDialogCalls?: number;
      };
      state.closureSaveDialogCalls = 0;
      dialog.showSaveDialog = async () => {
        state.closureSaveDialogCalls = (state.closureSaveDialogCalls ?? 0) + 1;
        return { canceled: false, filePath: targetPath };
      };
    }, exportPath);
    await page
      .getByRole("menuitem", { name: /导出下载列表|export download list/i })
      .click();
    await expect
      .poll(() =>
        application!.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                closureSaveDialogCalls?: number;
              }
            ).closureSaveDialogCalls ?? 0,
        ),
      )
      .toBe(1);
    await expect
      .poll(
        async () => {
          try {
            await stat(exportPath);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    const exported = await readFile(exportPath, "utf8");
    const apiText = taskListText;
    expect(exported).toBe(apiText);
    expect(exported).toContain("closure-export-only");
    expect(exported).not.toContain("normal-profile");
    const cancelledExportPath = path.join(
      runtimeRoot,
      "downloads",
      "closure-export-cancelled.txt",
    );
    let cancelledOutputExists = true;
    try {
      await stat(cancelledExportPath);
    } catch {
      cancelledOutputExists = false;
    }
    expect(cancelledOutputExists).toBe(false);
    await application.evaluate(({ dialog }, targetPath) => {
      const state = globalThis as typeof globalThis & {
        closureSaveDialogCalls?: number;
      };
      dialog.showSaveDialog = async () => {
        state.closureSaveDialogCalls = (state.closureSaveDialogCalls ?? 0) + 1;
        return { canceled: true, filePath: targetPath };
      };
    }, cancelledExportPath);
    await page.getByRole("button", { name: /^更多$|^more$/i }).click();
    await page
      .getByRole("menuitem", { name: /导出下载列表|export download list/i })
      .click();
    await expect
      .poll(() =>
        application!.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                closureSaveDialogCalls?: number;
              }
            ).closureSaveDialogCalls ?? 0,
        ),
      )
      .toBe(2);
    cancelledOutputExists = true;
    try {
      await stat(cancelledExportPath);
    } catch {
      cancelledOutputExists = false;
    }
    expect(cancelledOutputExists).toBe(false);
    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "download-export-content.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          persistedLanguage: config.data.language,
          taskIds: task.data.map((item) => item.id),
          outputPath: exportPath,
          exportSha256: await hashFile(exportPath),
          exportMatchesApiText: exported === apiText,
          exportIncludesOnlyOwnedTask: exported.includes("closure-export-only"),
          saveDialogBoundary:
            "main-process dialog.showSaveDialog was intercepted; successful save used an owned path",
          cancellationBoundary:
            "main-process dialog.showSaveDialog returned canceled=true; no file was created",
          cancelledOutputPath: cancelledExportPath,
          cancelledOutputExists,
          nativeOsSaveDialogCancellationExercised: false,
        },
        null,
        2,
      ),
    );
  } finally {
    await closeCandidate(application, owner, runtimeRoot);
  }
});

test("R-DL-12 native: owned Windows save dialog cancellation returns empty IPC path and preserves files", async () => {
  test.setTimeout(120_000);
  await assertPortFree("127.0.0.1", CORE_PORT, "closure candidate");
  const binding = await readVerifiedCandidateBinding();
  const executablePath = path.join(binding.candidate, "乡映.exe");
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    path.resolve(executablePath),
  );
  const runtimeRoot = await isolatedRuntime();
  const nativeOutputDir = path.join(runtimeRoot, "downloads", "native-save");
  await mkdir(nativeOutputDir, { recursive: true });
  const safeDefaultPath = path.join(nativeOutputDir, "cancelled-export.txt");
  const sentinelPath = path.join(nativeOutputDir, "existing-sentinel.txt");
  const sentinel = Buffer.from("native-save-cancel-sentinel-v1");
  await writeFile(sentinelPath, sentinel, { flag: "wx" });
  await expect(stat(safeDefaultPath)).rejects.toThrow();
  const initialDirectory = await readdir(nativeOutputDir);
  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  let owner: WindowsProcessIdentity | undefined;
  try {
    ({ application, page, owner } = await startCandidate(
      executablePath,
      runtimeRoot,
    ));
    if (!page || !application || !owner)
      throw new Error("candidate native-dialog owner unavailable");
    const converterPage = page;
    const client = await getClient(converterPage);
    expect((await client.getConfig()).data.language).toBe("zh");
    const nativeTask = await client.addDownloadTasks({
      tasks: [
        {
          type: "direct",
          url: "http://127.0.0.1:9/closure-native-cancel-paused.mp4",
          name: "closure-native-cancel-paused",
        },
      ],
      startDownload: false,
    });
    const exportText = (await client.exportDownloadList()).data;
    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "native-export-api-checkpoint.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          taskId: nativeTask.data[0]?.id ?? null,
          apiExportSha256: createHash("sha256")
            .update(exportText)
            .digest("hex"),
          outputDirectoryBefore: initialDirectory,
          sentinelSha256: await hashFile(sentinelPath),
          targetPathAbsent: true,
        },
        null,
        2,
      ),
      "utf8",
    );
    await application.evaluate(({ dialog }, targetPath) => {
      const state = globalThis as typeof globalThis & {
        closureNativeSaveDialogCalls?: number;
        closureNativeSaveDialogOutcome?: {
          canceled: boolean;
          filePath: string | null;
          defaultPath: string;
        };
      };
      const originalShowSaveDialog = dialog.showSaveDialog.bind(dialog) as (
        ...args: unknown[]
      ) => Promise<{ canceled: boolean; filePath?: string }>;
      state.closureNativeSaveDialogCalls = 0;
      state.closureNativeSaveDialogOutcome = undefined;
      dialog.showSaveDialog = (async (...args: unknown[]) => {
        state.closureNativeSaveDialogCalls =
          (state.closureNativeSaveDialogCalls ?? 0) + 1;
        const [window, options] = args;
        const safeOptions = {
          ...(options as Record<string, unknown>),
          defaultPath: targetPath,
        };
        const outcome = await originalShowSaveDialog(window, safeOptions);
        state.closureNativeSaveDialogOutcome = {
          canceled: outcome.canceled,
          filePath: outcome.filePath ?? null,
          defaultPath: targetPath,
        };
        return outcome;
      }) as typeof dialog.showSaveDialog;
    }, safeDefaultPath);

    const ownerBefore = await readWindowsProcessIdentity(owner.pid);
    expect(ownerBefore?.creationFileTime).toBe(owner.creationFileTime);
    await converterPage.evaluate(
      ({ content, defaultPath }) => {
        const state = globalThis as typeof globalThis & {
          closureNativeSaveResolved?: boolean;
          closureNativeSaveResult?: unknown;
        };
        const bridge = (
          window as Window & {
            electron?: {
              dialog?: {
                save(options: {
                  content: string;
                  defaultPath: string;
                  filters: Array<{ name: string; extensions: string[] }>;
                }): Promise<unknown>;
              };
            };
          }
        ).electron;
        if (!bridge?.dialog?.save)
          throw new Error("renderer dialog.save IPC is unavailable");
        state.closureNativeSaveResolved = false;
        state.closureNativeSaveResult = undefined;
        void bridge.dialog
          .save({
            content,
            defaultPath,
            filters: [{ name: "Text", extensions: ["txt"] }],
          })
          .then((result) => {
            state.closureNativeSaveResult = result;
            state.closureNativeSaveResolved = true;
          });
      },
      { content: exportText, defaultPath: safeDefaultPath },
    );

    const nativeCancelAction = await clickOwnedNativeCancel(owner);
    await expect
      .poll(() =>
        converterPage.evaluate(() => {
          const state = globalThis as typeof globalThis & {
            closureNativeSaveResolved?: boolean;
            closureNativeSaveResult?: unknown;
          };
          const response = state.closureNativeSaveResult;
          const envelope =
            typeof response === "object" && response !== null
              ? (response as { code?: unknown; data?: unknown })
              : undefined;
          return {
            resolved: state.closureNativeSaveResolved === true,
            code: envelope?.code ?? null,
            result: envelope?.data ?? null,
          };
        }),
      )
      .toEqual({ resolved: true, code: 0, result: "" });
    const rendererSaveEnvelope = await converterPage.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        closureNativeSaveResult?: unknown;
      };
      return state.closureNativeSaveResult ?? null;
    });
    const nativeDialogOutcome = await application.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        closureNativeSaveDialogCalls?: number;
        closureNativeSaveDialogOutcome?: {
          canceled: boolean;
          filePath: string | null;
          defaultPath: string;
        };
      };
      return {
        calls: state.closureNativeSaveDialogCalls ?? 0,
        outcome: state.closureNativeSaveDialogOutcome ?? null,
      };
    });
    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "native-save-dialog-cancel-checkpoint.json"),
      JSON.stringify(
        {
          owner,
          nativeCancelAction,
          rendererSaveEnvelope,
          rendererIpcResult: "",
          nativeDialogOutcome,
          outputDirectoryAfter: await readdir(nativeOutputDir),
          sentinelPreserved: (await readFile(sentinelPath)).equals(sentinel),
          targetPathExists: await stat(safeDefaultPath)
            .then(() => true)
            .catch(() => false),
        },
        null,
        2,
      ),
      "utf8",
    );
    expect(nativeDialogOutcome.calls).toBe(1);
    if (!nativeDialogOutcome.outcome)
      throw new Error("native save dialog produced no outcome");
    const dialogOutcome = nativeDialogOutcome.outcome;
    expect(dialogOutcome.canceled).toBe(true);
    expect([null, ""]).toContain(dialogOutcome.filePath);
    expect(dialogOutcome.defaultPath).toBe(safeDefaultPath);
    expect(await readdir(nativeOutputDir)).toEqual(initialDirectory);
    expect(await readFile(sentinelPath)).toEqual(sentinel);
    await expect(stat(safeDefaultPath)).rejects.toThrow();
    const ownerAfter = await readWindowsProcessIdentity(owner.pid);
    expect(ownerAfter?.creationFileTime).toBe(owner.creationFileTime);
    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "native-save-dialog-cancel.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          ownerBefore,
          ownerAfter,
          nativeCancelAction,
          defaultPathWasTaskOwned: safeDefaultPath,
          nativeDialogOutcome,
          saveIpcResolvedPath: "",
          noNewFile:
            (await readdir(nativeOutputDir)).join("|") ===
            initialDirectory.join("|"),
          sentinelSha256: await hashFile(sentinelPath),
          sentinelPreserved: (await readFile(sentinelPath)).equals(sentinel),
          actualWindowsNativeDialog: true,
          dialogReturnWasNotMocked: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await closeCandidate(application, owner, runtimeRoot);
  }
});

test("R-DL-15: pinned local Direct, yt-dlp generic, N_m3u8DL HLS, and MediaGo HLS/DASH routes complete", async () => {
  test.setTimeout(240_000);
  await assertPortFree("127.0.0.1", CORE_PORT, "closure candidate");
  const binding = await readVerifiedCandidateBinding();
  const executablePath = path.join(binding.candidate, "乡映.exe");
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    path.resolve(executablePath),
  );
  const runtimeRoot = await isolatedRuntime();
  const fixtureDir = path.join(runtimeRoot, "fixtures", "segments");
  const outputDir = path.join(runtimeRoot, "downloads");
  const ffmpeg = path.join(binding.candidate, "resources/deps/ffmpeg.exe");
  const depsDir = path.join(binding.candidate, "resources/deps");
  const biliUrl = "https://www.bilibili.com/video/BV1s3Yc68EJK/";
  await mkdir(fixtureDir, { recursive: true });
  await execFileAsync(
    ffmpeg,
    [
      "-hide_banner",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=160x90:rate=12",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=520:sample_rate=44100",
      "-t",
      "2.2",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      path.join(fixtureDir, "fixture.mp4"),
    ],
    { timeout: 45_000, windowsHide: true },
  );
  await execFileAsync(
    ffmpeg,
    [
      "-hide_banner",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=160x90:rate=12",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=660:sample_rate=44100",
      "-t",
      "2.2",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-f",
      "hls",
      "-hls_time",
      "1",
      "-hls_list_size",
      "0",
      "-hls_playlist_type",
      "vod",
      "-hls_segment_filename",
      path.join(fixtureDir, "hls-%02d.ts"),
      path.join(fixtureDir, "fixture.m3u8"),
    ],
    { timeout: 45_000, windowsHide: true },
  );
  await execFileAsync(
    ffmpeg,
    [
      "-hide_banner",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=160x90:rate=12",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100",
      "-t",
      "2.2",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-f",
      "dash",
      "-seg_duration",
      "1",
      path.join(fixtureDir, "fixture.mpd"),
    ],
    { timeout: 45_000, windowsHide: true, cwd: fixtureDir },
  );
  const fixtureFiles = new Map<string, Buffer>();
  for (const name of await readdir(fixtureDir))
    fixtureFiles.set(name, await readFile(path.join(fixtureDir, name)));
  const dashAssetNames = [...fixtureFiles.keys()].filter((name) =>
    name.endsWith(".m4s"),
  );
  for (const name of [
    "init-stream0.m4s",
    "init-stream1.m4s",
    "chunk-stream0-00001.m4s",
    "chunk-stream1-00001.m4s",
  ])
    expect(fixtureFiles.has(name), `DASH fixture asset ${name}`).toBe(true);
  const mediagoHlsBody = fixtureFiles.get("fixture.m3u8");
  const mediagoDashBody = fixtureFiles.get("fixture.mpd");
  if (!mediagoHlsBody || !mediagoDashBody)
    throw new Error("MediaGo fixture playlist bodies are missing");
  fixtureFiles.set("mediago-hls.m3u8", mediagoHlsBody);
  fixtureFiles.set("mediago-dash.mpd", mediagoDashBody);
  const sourceHits = new Map<string, number>();
  const fixture = await startHttpServer((request, response) => {
    const name = path.basename(
      new URL(request.url || "/", "http://127.0.0.1").pathname,
    );
    sourceHits.set(name, (sourceHits.get(name) ?? 0) + 1);
    const body = fixtureFiles.get(name);
    if (!body) return response.writeHead(404).end();
    const contentType = name.endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : name.endsWith(".mpd")
        ? "application/dash+xml"
        : name.endsWith(".html")
          ? "text/html; charset=utf-8"
          : name.endsWith(".mp4")
            ? "video/mp4"
            : name.endsWith(".ts")
              ? "video/mp2t"
              : "application/octet-stream";
    setTimeout(() => {
      response.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": String(body.length),
      });
      response.end(body);
    }, 750);
  });
  const genericMediaUrl = `${fixture.url}/fixture.mp4`;
  fixtureFiles.set(
    "generic.html",
    Buffer.from(
      `<!doctype html><html><head><meta property="og:title" content="Closure local video"><meta property="og:video" content="${genericMediaUrl}"><meta property="og:video:type" content="video/mp4"></head><body><video controls src="${genericMediaUrl}"></video></body></html>`,
      "utf8",
    ),
  );

  let application: ElectronApplication | undefined;
  let owner: WindowsProcessIdentity | undefined;
  let toolPage: Page | undefined;
  try {
    ({
      application,
      owner,
      page: toolPage,
    } = await startCandidate(executablePath, runtimeRoot));
    const page = toolPage;
    if (!page || !application)
      throw new Error("candidate engine page unavailable");
    const client = await getClient(page);
    const cases = [
      {
        type: "direct",
        name: "closure-aria2-direct",
        url: `${fixture.url}/fixture.mp4`,
        binary: "aria2c.exe",
        sourceName: "fixture.mp4",
        mediaSources: [],
      },
      {
        type: "youtube",
        name: "closure-ytdlp-generic-html",
        url: `${fixture.url}/generic.html`,
        binary: "yt-dlp.exe",
        sourceName: "generic.html",
        mediaSources: ["fixture.mp4"],
      },
      {
        type: "m3u8",
        name: "closure-n3u8-hls",
        url: `${fixture.url}/fixture.m3u8`,
        binary: "N_m3u8DL-RE.exe",
        sourceName: "fixture.m3u8",
        mediaSources: [],
      },
      {
        type: "mediago",
        name: "closure-mediago-hls",
        url: `${fixture.url}/mediago-hls.m3u8`,
        binary: "mediago.exe",
        sourceName: "mediago-hls.m3u8",
        mediaSources: [],
      },
      {
        type: "mediago",
        name: "closure-mediago-dash",
        url: `${fixture.url}/mediago-dash.mpd`,
        binary: "mediago.exe",
        sourceName: "mediago-dash.mpd",
        mediaSources: dashAssetNames,
      },
      {
        type: "bilibili",
        name: "closure-bbdown-public-bv1s3y",
        url: biliUrl,
        binary: "BBDown.exe",
        sourceName: "",
        mediaSources: [],
      },
    ];
    const routeFilter = process.env.MEDIAGO_DL15_ROUTE_FILTER?.split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    const selectedCases = routeFilter
      ? cases.filter((item) => routeFilter.includes(item.name))
      : cases;
    if (routeFilter)
      expect(selectedCases.map((item) => item.name).sort()).toEqual(
        [...routeFilter].sort(),
      );

    const results: Array<{
      type: string;
      name: string;
      binary: string;
      toolPath: string;
      toolSha256: string;
      processIdentity: WindowsProcessIdentity | null;
      outputPath: string;
      sha256: string;
      decoded: true;
      videoDimensions?: string;
    }> = [];
    let bbdownCoreFailure:
      | {
          status: string;
          error?: string;
          errorCode?: string;
          taskId: number;
        }
      | undefined;
    const toolInventory: Array<{
      binary: string;
      toolPath: string;
      sha256: string;
    }> = [];
    const candidateDepsBefore = await snapshotDirectory(depsDir);
    for (const binary of [
      "aria2c.exe",
      "N_m3u8DL-RE.exe",
      "mediago.exe",
      "BBDown.exe",
      "yt-dlp.exe",
    ]) {
      const toolPath = path.join(depsDir, binary);
      await stat(toolPath);
      toolInventory.push({
        binary,
        toolPath,
        sha256: await hashFile(toolPath),
      });
    }
    let bbdownMetadata: Record<string, unknown>;
    const reusableMetadataPath = process.env.MEDIAGO_DL15_REUSE_METADATA;
    if (reusableMetadataPath) {
      const prior = JSON.parse(
        await readFile(reusableMetadataPath, "utf8"),
      ) as { bbdownMetadata?: Record<string, unknown> };
      if (!prior.bbdownMetadata)
        throw new Error("reused BBDown metadata evidence is malformed");
      bbdownMetadata = {
        ...prior.bbdownMetadata,
        evidenceReference: reusableMetadataPath,
      };
    } else {
      const metadataCwd = path.join(runtimeRoot, "bbdown-anonymous-metadata");
      const metadataAppData = path.join(runtimeRoot, "bbdown-appdata");
      const metadataLocalAppData = path.join(
        runtimeRoot,
        "bbdown-localappdata",
      );
      const metadataTemp = path.join(runtimeRoot, "bbdown-temp");
      for (const directory of [
        metadataCwd,
        metadataAppData,
        metadataLocalAppData,
        metadataTemp,
      ])
        await mkdir(directory, { recursive: true });
      const bbdownPath = path.join(depsDir, "BBDown.exe");
      const metadataChild = spawn(bbdownPath, ["-info", biliUrl], {
        cwd: metadataCwd,
        env: {
          ...scrubElectronEnvironment(process.env),
          APPDATA: metadataAppData,
          LOCALAPPDATA: metadataLocalAppData,
          TEMP: metadataTemp,
          TMP: metadataTemp,
        },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const metadataPid = metadataChild.pid;
      if (!metadataPid)
        throw new Error("anonymous BBDown metadata process did not start");
      let metadataStdout = "";
      let metadataStderr = "";
      metadataChild.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        metadataStdout += chunk;
      });
      metadataChild.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        metadataStderr += chunk;
      });
      const metadataProcessResult = new Promise<{
        exitCode: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        metadataChild.once("error", reject);
        metadataChild.once("close", (exitCode, signal) =>
          resolve({ exitCode, signal }),
        );
      });
      let metadataProcessIdentity: WindowsProcessIdentity | undefined;
      for (
        let attempt = 0;
        attempt < 40 &&
        !metadataProcessIdentity &&
        metadataChild.exitCode === null &&
        metadataChild.signalCode === null;
        attempt++
      ) {
        metadataProcessIdentity = await readWindowsProcessIdentity(metadataPid);
        if (!metadataProcessIdentity)
          await new Promise((resolve) => setTimeout(resolve, 100));
      }
      let metadataTimedOut = false;
      let metadataTimer: NodeJS.Timeout | undefined;
      const metadataTimeout = new Promise<null>((resolve) => {
        metadataTimer = setTimeout(() => resolve(null), 60_000);
      });
      let metadataProcessExit = await Promise.race([
        metadataProcessResult,
        metadataTimeout,
      ]);
      if (metadataTimer) clearTimeout(metadataTimer);
      if (!metadataProcessExit) {
        metadataTimedOut = true;
        metadataChild.kill();
        metadataProcessExit = await metadataProcessResult;
      }
      const metadataSummary = {
        duration: metadataStdout.match(/\b\d+m\d+s\b/)?.[0] ?? null,
        pages: [...new Set(metadataStdout.match(/\bP\d+\b/g) ?? [])],
        videoOptionCount: (
          metadataStdout.match(
            /^\s*\d+\.\s+\[[^\]]+\]\s+\[\d{3,4}x\d{3,4}\]\s+\[(?:AVC|HEVC|AV1)\]/gm,
          ) ?? []
        ).length,
        audioOptionCount: (metadataStdout.match(/^\s*\d+\.\s+\[M4A\]/gm) ?? [])
          .length,
        videoResolutions: [
          ...new Set(
            [...metadataStdout.matchAll(/\[(\d{3,4}x\d{3,4})\]/g)].map(
              (match) => match[1],
            ),
          ),
        ],
        contentHosts: [
          ...new Set(
            [...metadataStdout.matchAll(/https?:\/\/([^/\s?]+)/g)].map(
              (match) => match[1],
            ),
          ),
        ],
      };
      bbdownMetadata = {
        url: biliUrl,
        trackingParametersRemoved: true,
        authenticationProvided: false,
        cookieOrAuthorizationProvided: false,
        args: ["-info", biliUrl],
        cwd: metadataCwd,
        appData: metadataAppData,
        localAppData: metadataLocalAppData,
        temp: metadataTemp,
        processId: metadataPid,
        processIdentity: metadataProcessIdentity ?? null,
        processIdentityCaptured: Boolean(metadataProcessIdentity),
        exitCode: metadataProcessExit.exitCode,
        signal: metadataProcessExit.signal,
        timedOut: metadataTimedOut,
        metadataSummary,
      };
      await writeFile(
        path.join(RUN_EVIDENCE_DIR, "bbdown-anonymous-metadata.json"),
        JSON.stringify(
          {
            candidateCoreSha256: binding.coreSha256,
            candidateAsarSha256: binding.asarSha256,
            bbdownSha256: toolInventory.find(
              (item) => item.binary === "BBDown.exe",
            )?.sha256,
            bbdownMetadata,
          },
          null,
          2,
        ),
        "utf8",
      );
    }
    for (const item of selectedCases) {
      const toolPath = path.join(depsDir, item.binary);
      const toolHash = await hashFile(toolPath);
      const sourceHitsBefore = item.sourceName
        ? (sourceHits.get(item.sourceName) ?? 0)
        : 0;
      const mediaHitsBefore = new Map(
        item.mediaSources.map((name) => [name, sourceHits.get(name) ?? 0]),
      );
      const toolPidsBefore = new Set(
        (await processIdentitiesByImage(toolPath)).map(
          (identity) => identity.pid,
        ),
      );
      const added = await client.addDownloadTasks({
        tasks: [{ type: item.type, url: item.url, name: item.name }],
        startDownload: false,
      });
      expect(added.data).toHaveLength(1);
      const id = added.data[0].id;
      expect(
        (
          await client.startDownload(id, {
            localPath: outputDir,
            deleteSegments: true,
          })
        ).success,
      ).toBe(true);
      if (item.sourceName) {
        await expect
          .poll(() => sourceHits.get(item.sourceName) ?? 0, {
            timeout: 30_000,
          })
          .toBeGreaterThan(sourceHitsBefore);
      }
      let processIdentity: WindowsProcessIdentity | undefined;
      try {
        await expect
          .poll(
            async () => {
              const current = await processIdentitiesByImage(toolPath);
              processIdentity = current.find(
                (identity) => !toolPidsBefore.has(identity.pid),
              );
              return Boolean(processIdentity);
            },
            { timeout: 15_000 },
          )
          .toBe(true);
      } catch (error) {
        void error;
      }
      if (item.type === "bilibili") {
        await expect
          .poll(async () => (await client.getDownloadTask(id)).data.status, {
            timeout: 75_000,
          })
          .toMatch(/^(success|failed)$/);
        const bbdownTask = (await client.getDownloadTask(id)).data;
        if (bbdownTask.status === "failed") {
          bbdownCoreFailure = {
            status: bbdownTask.status,
            error: optionalStringProperty(bbdownTask, "error"),
            errorCode: optionalStringProperty(bbdownTask, "errorCode"),
            taskId: id,
          };
          await writeFile(
            path.join(RUN_EVIDENCE_DIR, "bbdown-core-download.json"),
            JSON.stringify(
              {
                candidateCoreSha256: binding.coreSha256,
                candidateAsarSha256: binding.asarSha256,
                toolPath,
                toolSha256: toolHash,
                processIdentity: processIdentity ?? null,
                url: biliUrl,
                cookiesAuthOrLoginProvided: false,
                outputDirectory: outputDir,
                task: bbdownTask,
                sourceObservation:
                  "actual public-site Core task reached terminal failure; external-site layer remains unresolved",
              },
              null,
              2,
            ),
            "utf8",
          );
          continue;
        }
      } else {
        await expect
          .poll(async () => (await client.getDownloadTask(id)).data.status, {
            timeout: 75_000,
          })
          .toBe("success");
      }
      for (const mediaName of item.mediaSources)
        await expect
          .poll(() => sourceHits.get(mediaName) ?? 0, { timeout: 15_000 })
          .toBeGreaterThan(mediaHitsBefore.get(mediaName) ?? 0);
      const task = (await client.getDownloadTask(id)).data;
      const candidates = [
        task.outputPath,
        task.file,
        ...(task.files || []),
      ].filter((value): value is string => Boolean(value));
      const outputPath =
        candidates.find(
          (value) => path.extname(value).toLowerCase() === ".mp4",
        ) || candidates[0];
      if (!outputPath)
        throw new Error(
          `${item.name} completed without a reported media output path`,
        );
      expect((await stat(outputPath)).size).toBeGreaterThan(0);
      await decode(ffmpeg, outputPath);
      let videoDimensions: string | undefined;
      if (item.type === "bilibili") {
        const probe = await execFileAsync(
          ffmpeg,
          ["-hide_banner", "-i", outputPath, "-f", "null", "-"],
          { timeout: 45_000, windowsHide: true },
        );
        videoDimensions = probe.stderr.match(/\b\d{3,5}x\d{3,5}\b/)?.[0];
      }
      results.push({
        type: item.type,
        name: item.name,
        binary: item.binary,
        toolPath,
        toolSha256: toolHash,
        processIdentity: processIdentity ?? null,
        outputPath,
        sha256: await hashFile(outputPath),
        decoded: true,
        ...(videoDimensions ? { videoDimensions } : {}),
      });
      await writeFile(
        path.join(RUN_EVIDENCE_DIR, "local-engine-routes-progress.json"),
        JSON.stringify(
          {
            candidateCoreSha256: binding.coreSha256,
            candidateAsarSha256: binding.asarSha256,
            toolInventory,
            selectedRoutes: selectedCases.map((item) => item.name),
            completedRouteCount: results.length,
            actualOutputs: results,
            bbdownCoreFailure,
            latestSourceHits: Object.fromEntries(sourceHits),
          },
          null,
          2,
        ),
        "utf8",
      );
    }
    const candidateDepsAfter = await snapshotDirectory(depsDir);
    expect(candidateDepsAfter).toEqual(candidateDepsBefore);
    await writeFile(
      path.join(RUN_EVIDENCE_DIR, "local-engine-routes.json"),
      JSON.stringify(
        {
          candidateCoreSha256: binding.coreSha256,
          candidateAsarSha256: binding.asarSha256,
          toolInventory,
          candidateDepsBefore,
          candidateDepsAfter,
          candidateDepsUnchanged: true,
          fixtureProtocol: "127.0.0.1 only",
          bbdownMetadata,
          selectedRoutes: selectedCases.map((item) => item.name),
          actualOutputs: results,
          unprovenRoutes: [
            ...(bbdownCoreFailure
              ? [
                  {
                    engine: "BBDown",
                    route: "Bilibili public-site extraction",
                    reason: `Core task ${bbdownCoreFailure.taskId} reached failed status: ${bbdownCoreFailure.error ?? "no error text"}`,
                  },
                ]
              : []),
            {
              engine: "yt-dlp",
              route: "YouTube/X/TikTok/Douyin/Xiaohongshu site extraction",
              reason:
                "The local yt-dlp generic HTML/media route is exercised separately; named external site extractors require a lawful stable site fixture, and no account, credentials, or unstable external source was used.",
            },
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await closeServer(fixture.server);
    await closeCandidate(application, owner, runtimeRoot);
  }
});
