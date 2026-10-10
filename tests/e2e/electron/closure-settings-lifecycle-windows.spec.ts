import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  _electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { scrubElectronEnvironment } from "../support/electron-network.ts";
import { assertPortFree, waitForPortFree } from "../support/ports.ts";
import { trustedCoreClient } from "../support/xiangying-core-client.ts";
import {
  readWindowsProcessIdentity,
  waitForWindowsProcessExit,
  type WindowsProcessIdentity,
} from "../support/xiangying-windows-process.ts";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEFAULT_BINDING_PATH = path.join(
  ROOT,
  ".task/remediation-20261006/root/candidate-binding.json",
);
const EVIDENCE_ROOT = path.join(
  ROOT,
  ".task/closure-20261007/settings-lifecycle/evidence/guarded",
);
const CORE_PORT = Number(process.env.MEDIAGO_CORE_PORT || 39_939);

interface CandidateBinding {
  candidate: string;
  asarSha256: string;
  coreSha256: string;
}

interface CandidateSession {
  app: ElectronApplication;
  page: Page;
  runtimeRoot: string;
  ownerIdentity: WindowsProcessIdentity;
  coreIdentity?: WindowsProcessIdentity;
  coreExecutable?: string;
  coreUrl: string;
}

interface EvidenceSession {
  label: string;
  runtimeRoot: string;
  owner?: WindowsProcessIdentity;
  core?: WindowsProcessIdentity;
  coreExecutable?: string;
  ownerExited?: boolean;
  coreExited?: boolean;
  corePortFree?: boolean;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function unwrap<T>(value: unknown): T {
  if (typeof value !== "object" || value === null || !("code" in value))
    return value as T;
  const result = value as { code?: number; data?: unknown; message?: unknown };
  if (result.code !== 0)
    throw new Error(`Candidate Core API failed (${String(result.code)})`);
  return result.data as T;
}

async function candidatePage(application: ElectronApplication): Promise<Page> {
  await expect
    .poll(
      () =>
        application.windows().some((window) => {
          try {
            const url = new URL(window.url());
            return (
              url.protocol === "xiangying:" && url.hostname === "index.html"
            );
          } catch {
            return false;
          }
        }),
      { timeout: 20_000 },
    )
    .toBe(true);
  const page = application.windows().find((window) => {
    try {
      const url = new URL(window.url());
      return url.protocol === "xiangying:" && url.hostname === "index.html";
    } catch {
      return false;
    }
  });
  if (!page) throw new Error("Current candidate main window was not found");
  return page;
}

async function readCoreOwner(port: number): Promise<
  | {
      pid: number;
      executablePath: string;
    }
  | undefined
> {
  const script = `$c=Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1; if ($null -eq $c) { exit 3 }; $p=Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $c.OwningProcess); [pscustomobject]@{ProcessId=$p.ProcessId;ExecutablePath=$p.ExecutablePath} | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    const result = JSON.parse(stdout.trim()) as {
      ProcessId: number;
      ExecutablePath: string;
    };
    return {
      pid: Number(result.ProcessId),
      executablePath: path.resolve(result.ExecutablePath),
    };
  } catch (error) {
    const failure = error as { code?: string | number };
    if (failure.code === 3 || failure.code === "3") return undefined;
    throw error;
  }
}

async function prepareRuntime(
  label: string,
  existingRuntimeRoot?: string,
): Promise<{
  runtimeRoot: string;
  environment: Record<string, string>;
}> {
  const runtimeRoot =
    existingRuntimeRoot ??
    (await mkdtemp(path.join(EVIDENCE_ROOT, `${label}-`)));
  const temp = path.join(runtimeRoot, "temp");
  const data = path.join(runtimeRoot, "data");
  await Promise.all(
    [
      "data",
      "downloads",
      "downloads-A",
      "downloads-B",
      "logs",
      "appdata",
      "localappdata",
      "temp",
    ].map((directory) =>
      mkdir(path.join(runtimeRoot, directory), { recursive: true }),
    ),
  );
  if (!existingRuntimeRoot) {
    await writeFile(
      path.join(data, "config.json"),
      JSON.stringify(
        {
          language: "zh",
          local: path.join(runtimeRoot, "downloads"),
          autoUpgrade: false,
          allowBeta: false,
          closeMainWindow: false,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await writeFile(
      path.join(data, "library-v1.json"),
      JSON.stringify({ version: 1, items: [] }, null, 2) + "\n",
      "utf8",
    );
  }

  const inherited = scrubElectronEnvironment(process.env);
  for (const key of [
    "DB_PATH",
    "MEDIAGO_DEPS_DIR",
    "MEDIAGO_CORE_BIN",
    "MEDIAGO_RUNTIME_ROOT",
    "MEDIAGO_CORE_PORT",
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
  ])
    delete inherited[key];
  const environment = {
    ...inherited,
    APP_NAME: "xiangying",
    APP_TARGET: "electron",
    NODE_ENV: "production",
    ELECTRON_IS_DEV: "0",
    MEDIAGO_RUNTIME_ROOT: runtimeRoot,
    MEDIAGO_CORE_PORT: String(CORE_PORT),
    APPDATA: path.join(runtimeRoot, "appdata"),
    LOCALAPPDATA: path.join(runtimeRoot, "localappdata"),
    TEMP: temp,
    TMP: temp,
  };
  return { runtimeRoot, environment };
}

async function startCandidate(
  executablePath: string,
  label: string,
  sessions: EvidenceSession[],
  existingRuntimeRoot?: string,
): Promise<CandidateSession> {
  await assertPortFree("127.0.0.1", CORE_PORT, `closure ${label} Core`);
  const runtime = await prepareRuntime(label, existingRuntimeRoot);
  const evidence: EvidenceSession = {
    label,
    runtimeRoot: runtime.runtimeRoot,
  };
  sessions.push(evidence);
  let application: ElectronApplication | undefined;
  let ownerIdentity: WindowsProcessIdentity | undefined;
  try {
    application = await _electron.launch({
      executablePath,
      args: [],
      cwd: runtime.runtimeRoot,
      timeout: 30_000,
      env: runtime.environment,
    });
    const main = await application.evaluate(({ app }) => ({
      pid: process.pid,
      executablePath: process.execPath,
      userDataPath: app.getPath("userData"),
    }));
    ownerIdentity = await readWindowsProcessIdentity(main.pid);
    if (!ownerIdentity)
      throw new Error("Candidate Electron owner PID is unverifiable");
    evidence.owner = ownerIdentity;
    if (
      path.resolve(main.executablePath).toLowerCase() !==
      executablePath.toLowerCase()
    )
      throw new Error("Electron process executable does not match the binding");
    if (
      path.resolve(main.userDataPath).toLowerCase() !==
      path.join(runtime.runtimeRoot, "data").toLowerCase()
    )
      throw new Error(
        "Candidate userData path escaped the isolated runtime root",
      );

    const page = await candidatePage(application);
    const envResult = unwrap<{ coreUrl: string; workspace: string }>(
      await page.evaluate(() => {
        const app = (
          window as Window & {
            electron?: { app?: { getEnvPath(): Promise<unknown> } };
          }
        ).electron?.app;
        return app?.getEnvPath();
      }),
    );
    if (!envResult.coreUrl)
      throw new Error("Candidate Core URL is unavailable");
    if (
      path.resolve(envResult.workspace).toLowerCase() !==
      path.join(runtime.runtimeRoot, "data").toLowerCase()
    )
      throw new Error(
        "Candidate Core workspace escaped the isolated runtime root",
      );
    const coreOwner = await readCoreOwner(CORE_PORT);
    if (
      !coreOwner ||
      coreOwner.executablePath.toLowerCase() !==
        path
          .join(path.dirname(executablePath), "resources/bin/mediago-core.exe")
          .toLowerCase()
    )
      throw new Error(
        "Core listener owner did not match the bound candidate Core executable",
      );
    const coreIdentity = await readWindowsProcessIdentity(coreOwner.pid);
    if (!coreIdentity) throw new Error("Candidate Core PID is unverifiable");
    evidence.core = coreIdentity;
    evidence.coreExecutable = coreOwner.executablePath;
    return {
      app: application,
      page,
      runtimeRoot: runtime.runtimeRoot,
      ownerIdentity,
      coreIdentity,
      coreExecutable: coreOwner.executablePath,
      coreUrl: envResult.coreUrl,
    };
  } catch (error) {
    if (application) {
      await application
        .evaluate(({ app }) => app.quit())
        .catch(() => undefined);
      evidence.ownerExited = ownerIdentity
        ? await waitForWindowsProcessExit(ownerIdentity, 15_000).catch(
            () => false,
          )
        : false;
      await application.close().catch(() => undefined);
      await waitForPortFree("127.0.0.1", CORE_PORT, 15_000).then(
        () => (evidence.corePortFree = true),
        () => (evidence.corePortFree = false),
      );
    }
    throw error;
  }
}

async function stopCandidate(
  session: CandidateSession | undefined,
  evidence: EvidenceSession | undefined,
): Promise<void> {
  if (!session) return;
  await session.app.evaluate(({ app }) => app.quit()).catch(() => undefined);
  const ownerExited = await waitForWindowsProcessExit(
    session.ownerIdentity,
    15_000,
  );
  await session.app.close().catch(() => undefined);
  if (evidence) evidence.ownerExited = ownerExited;
  if (!ownerExited)
    throw new Error(
      `Candidate owner ${session.ownerIdentity.pid} did not exit normally`,
    );
  const coreExited = session.coreIdentity
    ? await waitForWindowsProcessExit(session.coreIdentity, 15_000)
    : false;
  if (evidence) evidence.coreExited = coreExited;
  if (!coreExited)
    throw new Error(
      "Candidate Core process did not exit after Electron owner quit",
    );
  await waitForPortFree("127.0.0.1", CORE_PORT, 15_000);
  if (evidence) evidence.corePortFree = true;
}

test.skip(
  process.platform !== "win32",
  "current-candidate settings/lifecycle closure requires Windows",
);

test("closes SET02/19 and LIFE05 guarded UI plus LIFE07 corrupt-index classification", async () => {
  test.setTimeout(180_000);
  await mkdir(EVIDENCE_ROOT, { recursive: true });
  if (!Number.isInteger(CORE_PORT) || CORE_PORT < 1024 || CORE_PORT > 65535)
    throw new Error("MEDIAGO_CORE_PORT must be the root-assigned test port");

  const configuredBinding = process.env.MEDIAGO_REMEDIATION_BINDING?.trim();
  if (configuredBinding && !path.isAbsolute(configuredBinding))
    throw new Error("MEDIAGO_REMEDIATION_BINDING must be an absolute path");
  const bindingPath = configuredBinding
    ? path.resolve(configuredBinding)
    : DEFAULT_BINDING_PATH;
  const binding = JSON.parse(
    await readFile(bindingPath, "utf8"),
  ) as CandidateBinding;
  const candidateRoot = path.resolve(binding.candidate);
  const executablePath = path.join(candidateRoot, "乡映.exe");
  const observedAsar = sha256(
    await readFile(path.join(candidateRoot, "resources/app.asar")),
  );
  const observedCore = sha256(
    await readFile(path.join(candidateRoot, "resources/bin/mediago-core.exe")),
  );
  expect(observedAsar).toBe(binding.asarSha256.toLowerCase());
  expect(observedCore).toBe(binding.coreSha256.toLowerCase());
  const configuredExecutable = process.env.XIANGYING_E2E_EXECUTABLE?.trim();
  if (
    configuredExecutable &&
    path.resolve(configuredExecutable).toLowerCase() !==
      executablePath.toLowerCase()
  )
    throw new Error(
      "XIANGYING_E2E_EXECUTABLE does not match the bound candidate",
    );

  const evidenceDirectory = await mkdtemp(path.join(EVIDENCE_ROOT, "run-"));
  const evidencePath = path.join(evidenceDirectory, "results.json");
  const evidence: Record<string, unknown> = {
    bindingPath,
    candidateRoot,
    executablePath,
    coreSha256: observedCore,
    asarSha256: observedAsar,
    specSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    corePort: CORE_PORT,
    scope: [
      "R-SET-02 guarded UI layer",
      "R-SET-19 package entry/version",
      "R-LIFE-05 disabled updater state",
      "R-LIFE-07 corrupt isolated index",
    ],
    sessions: [] as EvidenceSession[],
    settings: {},
    updater: {},
    life07: {},
    pageErrors: [] as string[],
    updateActionsInvoked: false,
    cleanupComplete: false,
  };
  let active: CandidateSession | undefined;
  let activeEvidence: EvidenceSession | undefined;
  const sessions = evidence.sessions as EvidenceSession[];
  try {
    active = await startCandidate(executablePath, "settings", sessions);
    activeEvidence = sessions.at(-1);
    active.page.on("pageerror", (error) =>
      (evidence.pageErrors as string[]).push(error.message),
    );
    const client = trustedCoreClient(active.page, active.coreUrl);
    const emptyIndexPath = path.join(
      active.runtimeRoot,
      "data",
      "library-v1.json",
    );
    const validEmptyIndexHash = sha256(await readFile(emptyIndexPath));
    await expect(
      active.page.getByRole("button", { name: "刷新", exact: true }),
    ).toBeVisible();
    (evidence.life07 as Record<string, unknown>).emptyAndPersistedIndex = {
      initialValidEmptyIndex: true,
      indexSha256: validEmptyIndexHash,
    };

    await active.page.getByRole("link", { name: "设置", exact: true }).click();
    const localInput = active.page.locator("#setting-local");
    await expect(localInput).toBeVisible();
    const pathA = path.join(active.runtimeRoot, "downloads-A");
    await active.app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selectedPath],
      });
    }, pathA);
    await active.page
      .getByRole("button", { name: "选择文件夹", exact: true })
      .click();
    await expect(localInput).toHaveValue(pathA);
    await expect
      .poll(async () => (await client.getConfig()).data.local)
      .toBe(pathA);

    await active.app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await active.page
      .getByRole("button", { name: "选择文件夹", exact: true })
      .click();
    await expect(localInput).toHaveValue(pathA);
    await expect
      .poll(async () => (await client.getConfig()).data.local)
      .toBe(pathA);
    (evidence.settings as Record<string, unknown>).selectionAndCancel = {
      selectedA: pathA,
      cancelPreservedA: true,
    };

    const currentVersion = await active.app.evaluate(({ app }) =>
      app.getVersion(),
    );
    await expect(
      active.page.getByText("当前版本", { exact: true }),
    ).toBeVisible();
    await expect(
      active.page.getByText(currentVersion, { exact: true }),
    ).toBeVisible();
    const updateState = unwrap<{ status: string; autoDownload: boolean }>(
      await active.page.evaluate(async () => {
        const update = (
          window as Window & {
            electron?: { update?: { getState(): Promise<unknown> } };
          }
        ).electron?.update;
        if (!update) throw new Error("update bridge unavailable");
        return update.getState();
      }),
    );
    expect(updateState).toMatchObject({
      status: "not-available",
      autoDownload: false,
    });
    (evidence.settings as Record<string, unknown>).entryAndVersion = {
      settingsReachable: true,
      currentVersion,
      currentVersionDisplayed: true,
    };
    (evidence.updater as Record<string, unknown>).initialState = updateState;

    const autoUpgrade = active.page.locator("#setting-autoUpgrade");
    const allowBeta = active.page.locator("#setting-allowBeta");
    await expect(autoUpgrade).toHaveAttribute("aria-checked", "false");
    await expect(allowBeta).toHaveAttribute("aria-checked", "false");
    await autoUpgrade.click();
    await allowBeta.click();
    await expect(autoUpgrade).toHaveAttribute("aria-checked", "true");
    await expect(allowBeta).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(async () => (await client.getConfig()).data.autoUpgrade)
      .toBe(true);
    await expect
      .poll(async () => (await client.getConfig()).data.allowBeta)
      .toBe(true);
    (
      evidence.updater as Record<string, unknown>
    ).togglesPersistedBeforeRestart = true;

    const sameRuntimeRoot = active.runtimeRoot;
    await stopCandidate(active, activeEvidence);
    active = undefined;
    activeEvidence = undefined;
    active = await startCandidate(
      executablePath,
      "settings-restart",
      sessions,
      sameRuntimeRoot,
    );
    activeEvidence = sessions.at(-1);
    const restartedClient = trustedCoreClient(active.page, active.coreUrl);
    await active.page.getByRole("link", { name: "设置", exact: true }).click();
    await expect(active.page.locator("#setting-autoUpgrade")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(active.page.locator("#setting-allowBeta")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const restartedLocal = (await restartedClient.getConfig()).data.local;
    const expectedGuardedLocal = path.join(active.runtimeRoot, "downloads");
    expect(path.resolve(restartedLocal).toLowerCase()).toBe(
      path.resolve(expectedGuardedLocal).toLowerCase(),
    );
    const restartedState = unwrap<{ status: string; autoDownload: boolean }>(
      await active.page.evaluate(async () => {
        const update = (
          window as Window & {
            electron?: { update?: { getState(): Promise<unknown> } };
          }
        ).electron?.update;
        if (!update) throw new Error("update bridge unavailable");
        return update.getState();
      }),
    );
    expect(restartedState).toMatchObject({
      status: "not-available",
      autoDownload: false,
    });
    expect(await readFile(emptyIndexPath).then(sha256)).toBe(
      validEmptyIndexHash,
    );
    (evidence.life07 as Record<string, unknown>).emptyAndPersistedIndex = {
      initialValidEmptyIndex: true,
      sameIndexAfterRestart: true,
      indexSha256: validEmptyIndexHash,
    };
    (evidence.settings as Record<string, unknown>).guardedRestart = {
      selectedAResetByRuntimeOverride:
        path.resolve(restartedLocal) !== path.resolve(pathA),
      actualLocal: restartedLocal,
      expectedRuntimeDownloadRoot: expectedGuardedLocal,
      classification:
        "test override behavior; not a normal-profile persistence result",
    };
    (evidence.updater as Record<string, unknown>).restartState = restartedState;
    (evidence.updater as Record<string, unknown>).actionsInvoked = false;

    const pathB = path.join(active.runtimeRoot, "downloads-B");
    await active.app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selectedPath],
      });
    }, pathB);
    await active.page
      .getByRole("button", { name: "选择文件夹", exact: true })
      .click();
    await expect(active.page.locator("#setting-local")).toHaveValue(pathB);
    await expect
      .poll(async () => (await restartedClient.getConfig()).data.local)
      .toBe(pathB);
    (evidence.settings as Record<string, unknown>).selectionBAfterRestart = {
      selectedB: pathB,
      immediateCoreReadback: true,
    };
    await stopCandidate(active, activeEvidence);
    active = undefined;
    activeEvidence = undefined;

    active = await startCandidate(executablePath, "corrupt-index", sessions);
    activeEvidence = sessions.at(-1);
    const indexPath = path.join(active.runtimeRoot, "data", "library-v1.json");
    const corruptIndex = "{ deliberately invalid closure fixture";
    await writeFile(indexPath, corruptIndex, "utf8");
    const corruptHash = sha256(Buffer.from(corruptIndex, "utf8"));
    await active.page
      .getByRole("button", { name: "刷新", exact: true })
      .click();
    await expect(active.page.getByText(/片库索引损坏/)).toBeVisible();
    const afterIndex = await readFile(indexPath);
    expect(afterIndex.toString("utf8")).toBe(corruptIndex);
    expect(sha256(afterIndex)).toBe(corruptHash);
    (evidence.life07 as Record<string, unknown>).corruptIndex = {
      errorVisible: true,
      fixtureSha256Before: corruptHash,
      fixtureSha256After: sha256(afterIndex),
      originalBytesPreserved: true,
    };
    await stopCandidate(active, activeEvidence);
    active = undefined;
    activeEvidence = undefined;
    evidence.result = "PASS_FOR_EXERCISED_LAYERS";
  } finally {
    if (active) {
      await stopCandidate(active, activeEvidence).catch((error: unknown) => {
        evidence.cleanupError =
          error instanceof Error ? error.message : String(error);
      });
    }
    evidence.cleanupComplete = sessions.every(
      (session) =>
        session.ownerExited === true &&
        session.coreExited === true &&
        session.corePortFree === true,
    );
    await writeFile(
      evidencePath,
      JSON.stringify(evidence, null, 2) + "\n",
      "utf8",
    );
  }
});
