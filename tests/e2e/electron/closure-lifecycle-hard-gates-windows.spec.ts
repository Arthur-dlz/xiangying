import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
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
import {
  readWindowsProcessIdentity,
  waitForWindowsProcessExit,
  type WindowsProcessIdentity,
} from "../support/xiangying-windows-process.ts";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEFAULT_BINDING_PATH = path.join(
  ROOT,
  ".task/closure-20261007/root/startup-storage-build-20261009/candidate-binding.json",
);
const EVIDENCE_ROOT = path.join(
  ROOT,
  ".task/closure-20261007/settings-lifecycle/evidence/followup",
);
const OBSERVER_SOURCE = path.join(
  ROOT,
  "tests/e2e/electron/closure-update-egress-observer.cjs",
);
const CORE_PORT = Number(process.env.MEDIAGO_CORE_PORT || 39_939);

interface CandidateBinding {
  candidate: string;
  exeSha256: string;
  asarSha256: string;
  coreSha256: string;
  sourceManifest: string;
  coreSourceManifest: string;
}

interface BoundSourceManifest {
  path: string;
  sha256: string;
  entryCount: number;
}

interface CoreOwner {
  pid: number;
  executablePath: string;
}

interface CandidateSession {
  app: ElectronApplication;
  page: Page;
  pageSelection: CandidatePageSelection;
  runtimeRoot: string;
  owner: WindowsProcessIdentity;
  core?: WindowsProcessIdentity;
  coreExecutable?: string;
}

interface CandidatePageSelection {
  pageUrls: string[];
  selectedPageIndex: number;
  selectedUrl: string;
  nativeWindows: Array<{
    id: number;
    url: string;
    visible: boolean;
    destroyed: boolean;
  }>;
  nativeWindowInspectionError?: string;
  selectedNativeWindowIds: number[];
}

interface UpdateEgressState {
  version: number;
  armed: boolean;
  networkArmed: boolean;
  updaterSinkArmed: boolean;
  setupError: string | null;
  ownerPid: number;
  counters: Record<string, number>;
  attempts: string[];
}

interface UpdateState {
  status: string;
  autoDownload: boolean;
  error?: { phase?: string; message?: string };
}

interface NativeMenuProbeResult {
  action: "inspect" | "invoke-exit";
  hwnd: string;
  ownerPid: number;
  ownerCreationFileTime: string;
  windowClass: string;
  showMainWindowItemCount: number;
  showMainWindowControlTypes: string[];
  showMainWindowControlType: string;
  exitApplicationItemCount: number;
  exitApplicationControlTypes: string[];
  exitApplicationControlType: string;
  exitInvoked: boolean;
}

interface NativeMenuObservation {
  action: "observe";
  ownerPid: number;
  ownerCreationFileTime: string;
  foregroundHwnd: string;
  foregroundPid: number;
  expectedMainHwnd?: string;
  windows: Array<{
    hwnd: string;
    windowClass: string;
    title: string;
    rectangle: string;
    menuItems: Array<{ name: string; controlType: string }>;
  }>;
}

interface NativeMenuPreflightResult {
  action: "focus-main";
  ownerPid: number;
  ownerCreationFileTime: string;
  mainHwnd: string;
  mainWindowClass: string;
  foregroundBefore: { hwnd: string; pid: number };
  foregroundAfter: { hwnd: string; pid: number };
  setFocusAttempted: boolean;
  foregroundGatePassed: boolean;
  focusError: string | null;
  notifyIconHostWindows: Array<{
    hwnd: string;
    windowClass: string;
    visible: boolean;
  }>;
}

const OWNED_NATIVE_MENU_SCRIPT = path.join(
  ROOT,
  ".task/closure-20261007/settings-lifecycle/ownedNativeMenu.ps1",
);

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function unwrap<T>(value: unknown): T {
  if (typeof value !== "object" || value === null || !("code" in value))
    return value as T;
  const result = value as {
    code?: number;
    data?: unknown;
    message?: unknown;
  };
  if (result.code !== 0)
    throw new Error(`Candidate IPC failed (${String(result.code)})`);
  return result.data as T;
}

async function loadBinding(): Promise<{
  binding: CandidateBinding;
  bindingPath: string;
  executablePath: string;
  executableSha256: string;
  asarSha256: string;
  coreSha256: string;
  bindingSha256: string;
  sourceManifest?: BoundSourceManifest;
  coreSourceManifest?: BoundSourceManifest;
  specSha256: string;
}> {
  const configured = process.env.MEDIAGO_REMEDIATION_BINDING?.trim();
  if (configured && !path.isAbsolute(configured))
    throw new Error("MEDIAGO_REMEDIATION_BINDING must be absolute");
  const bindingPath = configured
    ? path.resolve(configured)
    : DEFAULT_BINDING_PATH;
  const bindingBytes = await readFile(bindingPath);
  const binding = JSON.parse(bindingBytes.toString("utf8")) as CandidateBinding;
  const candidateRoot = path.resolve(binding.candidate);
  const executablePath = path.join(candidateRoot, "乡映.exe");
  const executableSha256 = sha256(await readFile(executablePath));
  const asarHash = sha256(
    await readFile(path.join(candidateRoot, "resources/app.asar")),
  );
  const coreHash = sha256(
    await readFile(path.join(candidateRoot, "resources/bin/mediago-core.exe")),
  );
  for (const [name, value] of [
    ["exeSha256", binding.exeSha256],
    ["asarSha256", binding.asarSha256],
    ["coreSha256", binding.coreSha256],
  ] as const) {
    if (!/^[a-f0-9]{64}$/i.test(value)) {
      throw new Error(
        `Candidate binding ${name} must be a 64-character SHA-256`,
      );
    }
  }
  expect(executableSha256).toBe(binding.exeSha256.toLowerCase());
  expect(asarHash).toBe(binding.asarSha256.toLowerCase());
  expect(coreHash).toBe(binding.coreSha256.toLowerCase());
  const readManifest = async (
    relativeOrAbsolutePath: string | undefined,
  ): Promise<BoundSourceManifest | undefined> => {
    if (!relativeOrAbsolutePath) return undefined;
    const manifestPath = path.isAbsolute(relativeOrAbsolutePath)
      ? relativeOrAbsolutePath
      : path.resolve(ROOT, relativeOrAbsolutePath);
    const bytes = await readFile(manifestPath);
    const entries = JSON.parse(bytes.toString("utf8")) as Array<{
      path?: unknown;
      sha256?: unknown;
    }>;
    if (
      !Array.isArray(entries) ||
      entries.some(
        (entry) =>
          typeof entry.path !== "string" ||
          typeof entry.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/i.test(entry.sha256),
      )
    )
      throw new Error(`Bound source manifest is malformed: ${manifestPath}`);
    return {
      path: manifestPath,
      sha256: sha256(bytes),
      entryCount: entries.length,
    };
  };
  const sourceManifest = await readManifest(binding.sourceManifest);
  const coreSourceManifest = await readManifest(binding.coreSourceManifest);
  if (!sourceManifest || !coreSourceManifest)
    throw new Error("Candidate binding must include both source manifests");
  const expectedExecutable = process.env.XIANGYING_E2E_EXECUTABLE?.trim();
  if (
    expectedExecutable &&
    path.resolve(expectedExecutable).toLowerCase() !==
      executablePath.toLowerCase()
  )
    throw new Error(
      "XIANGYING_E2E_EXECUTABLE does not match candidate binding",
    );
  return {
    binding,
    bindingPath,
    executablePath,
    executableSha256,
    asarSha256: asarHash,
    coreSha256: coreHash,
    bindingSha256: sha256(bindingBytes),
    sourceManifest,
    coreSourceManifest,
    specSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
  };
}

async function readCoreOwner(port: number): Promise<CoreOwner | undefined> {
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
    const code = (error as { code?: string | number }).code;
    if (code === 3 || code === "3") return undefined;
    throw error;
  }
}

async function candidatePage(
  app: ElectronApplication,
): Promise<{ page: Page; selection: CandidatePageSelection }> {
  await expect
    .poll(
      () =>
        app.windows().some((window) => {
          try {
            const url = new URL(window.url());
            return (
              url.protocol === "xiangying:" &&
              url.hostname === "index.html" &&
              !url.port &&
              !url.username &&
              !url.password &&
              (url.pathname === "" || url.pathname === "/") &&
              !url.search &&
              !url.hash
            );
          } catch {
            return false;
          }
        }),
      { timeout: 20_000 },
    )
    .toBe(true);
  const windows = app.windows();
  const pageUrls = windows.map((window) => window.url());
  const candidates = windows.flatMap((window, index) => {
    try {
      const url = new URL(window.url());
      return url.protocol === "xiangying:" &&
        url.hostname === "index.html" &&
        !url.port &&
        !url.username &&
        !url.password &&
        (url.pathname === "" || url.pathname === "/") &&
        !url.search &&
        !url.hash
        ? [{ page: window, index, url: window.url() }]
        : [];
    } catch {
      return [];
    }
  });
  if (candidates.length !== 1)
    throw new Error(
      `Expected one candidate main page, found ${candidates.length}; URLs=${JSON.stringify(pageUrls)}`,
    );
  const selected = candidates[0];
  if (!selected) throw new Error("Candidate main window was not found");
  let nativeWindows: CandidatePageSelection["nativeWindows"] = [];
  let nativeWindowInspectionError: string | undefined;
  try {
    nativeWindows = await app.evaluate((_ctx, requireAnchor) => {
      const moduleApi = process.getBuiltinModule("node:module") as {
        createRequire(anchor: string): (id: string) => unknown;
      };
      const electron = moduleApi.createRequire(requireAnchor)("electron") as {
        BrowserWindow: {
          getAllWindows(): Array<{
            id: number;
            webContents: { getURL(): string };
            isVisible(): boolean;
            isDestroyed(): boolean;
          }>;
        };
      };
      return electron.BrowserWindow.getAllWindows().map((window) => ({
        id: window.id,
        url: window.webContents.getURL(),
        visible: window.isVisible(),
        destroyed: window.isDestroyed(),
      }));
    }, OBSERVER_SOURCE);
  } catch (error) {
    nativeWindowInspectionError =
      error instanceof Error ? error.message : String(error);
  }
  const selection: CandidatePageSelection = {
    pageUrls,
    selectedPageIndex: selected.index,
    selectedUrl: selected.url,
    nativeWindows,
    selectedNativeWindowIds: nativeWindows
      .filter((window) => window.url === selected.url)
      .map((window) => window.id),
    ...(nativeWindowInspectionError ? { nativeWindowInspectionError } : {}),
  };
  return { page: selected.page, selection };
}

async function startCandidate(
  label: string,
  options: {
    coreBinaryOverride?: string;
    updateObserver?: boolean;
  } = {},
): Promise<CandidateSession> {
  const { executablePath } = await loadBinding();
  await mkdir(EVIDENCE_ROOT, { recursive: true });
  const runtimeRoot = await mkdtemp(path.join(EVIDENCE_ROOT, `${label}-`));
  const temp = path.join(runtimeRoot, "temp");
  const data = path.join(runtimeRoot, "data");
  await Promise.all(
    ["data", "downloads", "logs", "appdata", "localappdata", "temp"].map(
      (directory) =>
        mkdir(path.join(runtimeRoot, directory), { recursive: true }),
    ),
  );
  await writeFileSafe(
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
  );

  const env = scrubElectronEnvironment(process.env);
  for (const key of [
    "DB_PATH",
    "MEDIAGO_CORE_BIN",
    "MEDIAGO_CORE_PORT",
    "MEDIAGO_DEPS_DIR",
    "MEDIAGO_RUNTIME_ROOT",
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
    "XIANGYING_UPDATE_EGRESS_OBSERVER_FILE",
  ])
    delete env[key];
  Object.assign(env, {
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
  });
  if (options.coreBinaryOverride) {
    env.MEDIAGO_CORE_BIN = options.coreBinaryOverride;
  }
  const observerFile = path.join(runtimeRoot, "update-egress-observer.json");
  if (options.updateObserver) {
    env.XIANGYING_UPDATE_EGRESS_OBSERVER_FILE = observerFile;
    env.NODE_OPTIONS = `--require=${OBSERVER_SOURCE}`;
  }

  await assertPortFree("127.0.0.1", CORE_PORT, `${label} Core`);
  let app: ElectronApplication | undefined;
  let owner: WindowsProcessIdentity | undefined;
  try {
    app = await _electron.launch({
      executablePath,
      args: [],
      cwd: runtimeRoot,
      timeout: 30_000,
      env,
    });
    const main = await app.evaluate(({ app: electronApp }) => ({
      pid: process.pid,
      executablePath: process.execPath,
      userDataPath: electronApp.getPath("userData"),
    }));
    owner = await readWindowsProcessIdentity(main.pid);
    if (!owner) throw new Error("Candidate owner PID is unverifiable");
    if (
      path.resolve(main.executablePath).toLowerCase() !==
      executablePath.toLowerCase()
    )
      throw new Error(
        "Electron owner executable differs from candidate binding",
      );
    if (
      path.resolve(main.userDataPath).toLowerCase() !==
      path.join(runtimeRoot, "data").toLowerCase()
    )
      throw new Error("Candidate userData escaped the test runtime root");

    const { page, selection: pageSelection } = await candidatePage(app);
    const coreOwner = await readCoreOwner(CORE_PORT);
    if (options.coreBinaryOverride) {
      if (coreOwner)
        throw new Error("Missing-Core fixture unexpectedly has a listener");
      return { app, page, pageSelection, runtimeRoot, owner };
    }
    const expectedCore = path.join(
      path.dirname(executablePath),
      "resources/bin/mediago-core.exe",
    );
    if (
      !coreOwner ||
      coreOwner.executablePath.toLowerCase() !== expectedCore.toLowerCase()
    )
      throw new Error("Core listener is not the bound candidate Core binary");
    const core = await readWindowsProcessIdentity(coreOwner.pid);
    if (!core) throw new Error("Candidate Core PID is unverifiable");
    return {
      app,
      page,
      pageSelection,
      runtimeRoot,
      owner,
      core,
      coreExecutable: coreOwner.executablePath,
    };
  } catch (error) {
    if (app) {
      await app
        .evaluate(({ app: electronApp }) => electronApp.quit())
        .catch(() => undefined);
      if (owner)
        await waitForWindowsProcessExit(owner, 15_000).catch(() => false);
      await app.close().catch(() => undefined);
      await waitForPortFree("127.0.0.1", CORE_PORT, 15_000).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

async function stopCandidate(session: CandidateSession): Promise<{
  ownerExited: boolean;
  coreExited: boolean;
  corePortFree: boolean;
}> {
  await session.app.evaluate(({ app }) => app.quit()).catch(() => undefined);
  const ownerExited = await waitForWindowsProcessExit(
    session.owner,
    15_000,
  ).catch(() => false);
  await session.app.close().catch(() => undefined);
  let coreExited = true;
  if (session.core) {
    coreExited = await waitForWindowsProcessExit(session.core, 15_000).catch(
      () => false,
    );
  }
  const corePortFree = await waitForPortFree("127.0.0.1", CORE_PORT, 15_000)
    .then(() => true)
    .catch(() => false);
  return { ownerExited, coreExited, corePortFree };
}

async function writeFileSafe(
  filePath: string,
  contents: string,
): Promise<void> {
  await writeFile(filePath, contents, "utf8");
}

async function readUpdateObserver(
  filePath: string,
): Promise<UpdateEgressState> {
  return JSON.parse(await readFile(filePath, "utf8")) as UpdateEgressState;
}

async function readCandidateLogs(runtimeRoot: string): Promise<string> {
  const logsDirectory = path.join(runtimeRoot, "data", "logs");
  let names: string[];
  try {
    names = await readdir(logsDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  const logContents = await Promise.all(
    names
      .filter((name) => name.endsWith("-xiangying.log"))
      .map((name) => readFile(path.join(logsDirectory, name), "utf8")),
  );
  return logContents.join("\n");
}

async function armActualUpdaterSinks(
  app: ElectronApplication,
): Promise<{ appTrayMethods: string[]; updaterMethods: string[] }> {
  return app.evaluate(async ({ app: electronApp }) => {
    type RemoteObject = {
      type?: string;
      objectId?: string;
      value?: unknown;
    };
    type Property = {
      name: string;
      value?: RemoteObject;
      get?: RemoteObject;
    };
    type PropertiesReply = {
      result?: Property[];
      internalProperties?: Property[];
    };
    type EvaluateReply = { result?: RemoteObject; exceptionDetails?: unknown };
    type CallReply = { result?: RemoteObject; exceptionDetails?: unknown };
    type InspectorPost = (
      method: string,
      params: Record<string, unknown>,
      callback: (error: Error | null, result: unknown) => void,
    ) => void;

    const inspector = process.getBuiltinModule(
      "node:inspector",
    ) as typeof import("node:inspector");
    const session = new inspector.Session();
    const marker = "__xiangyingLifecycleListenerForInspection";
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const listener = electronApp.listeners("second-instance")[0];
    if (typeof listener !== "function") {
      throw new Error("Candidate second-instance listener is unavailable");
    }
    globals[marker] = listener;

    const rawPost = session.post.bind(session) as unknown as InspectorPost;
    const post = <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> =>
      new Promise((resolve, reject) => {
        rawPost(method, params, (error, result) => {
          if (error) reject(error);
          else resolve(result as T);
        });
      });
    const getProperties = async (
      objectId: string,
      ownProperties = false,
      stage = "unknown object",
    ) => {
      try {
        return await post<PropertiesReply>("Runtime.getProperties", {
          objectId,
          ownProperties,
          accessorPropertiesOnly: false,
          generatePreview: false,
        });
      } catch (error) {
        throw new Error(
          `Inspector could not inspect ${stage}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    const inspectableObjectId = (remote?: RemoteObject) =>
      remote?.type === "object" || remote?.type === "function"
        ? remote.objectId
        : undefined;
    const valueObject = (properties: Property[], name: string) =>
      inspectableObjectId(
        properties.find((property) => property.name === name)?.value,
      );
    const namesOf = (properties: Property[]) =>
      new Set(properties.map((property) => property.name));
    const scopeObjects = async (functionObjectId: string) => {
      const functionProperties = await getProperties(
        functionObjectId,
        false,
        "second-instance listener function",
      );
      const scopesId = valueObject(
        functionProperties.internalProperties ?? [],
        "[[Scopes]]",
      );
      if (!scopesId) throw new Error("Function closure scopes are unavailable");
      const scopes = await getProperties(
        scopesId,
        false,
        "listener function scope list",
      );
      const result: Array<{ name: string; objectId: string }> = [];
      for (const scope of scopes.result ?? []) {
        const objectId = inspectableObjectId(scope.value);
        if (objectId) result.push({ name: scope.name, objectId });
      }
      return result;
    };

    try {
      session.connect();
      const listenerReply = await post<EvaluateReply>("Runtime.evaluate", {
        expression: `globalThis.${marker}`,
        objectGroup: "xiangying-lifecycle-owned",
        generatePreview: false,
      });
      const listenerObjectId = listenerReply.result?.objectId;
      if (
        listenerReply.result?.type !== "function" ||
        !listenerObjectId ||
        listenerReply.exceptionDetails
      ) {
        throw new Error("Inspector could not resolve the candidate listener");
      }

      const appMatches: Array<{ objectId: string; properties: Property[] }> =
        [];
      for (const scope of await scopeObjects(listenerObjectId)) {
        const properties = await getProperties(scope.objectId, true);
        const direct = properties.result?.find(
          (property) =>
            property.name === "mediagoApp" &&
            inspectableObjectId(property.value),
        );
        const candidates = direct
          ? [inspectableObjectId(direct.value)!]
          : (properties.result ?? [])
              .map((property) => inspectableObjectId(property.value))
              .filter((objectId): objectId is string => Boolean(objectId));
        for (const objectId of candidates) {
          const appProperties = await getProperties(objectId, true);
          const names = namesOf(appProperties.result ?? []);
          if (
            names.has("tray") &&
            names.has("updater") &&
            names.has("mainWindow") &&
            names.has("downloaderServer")
          ) {
            appMatches.push({
              objectId,
              properties: appProperties.result ?? [],
            });
          }
        }
      }
      if (appMatches.length !== 1) {
        throw new Error(
          "Candidate app closure did not resolve to one app instance",
        );
      }

      const appProperties = appMatches[0]!.properties;
      const trayId = valueObject(appProperties, "tray");
      const updaterId = valueObject(appProperties, "updater");
      if (!trayId || !updaterId) {
        throw new Error("Candidate app tray or updater object is unavailable");
      }
      const trayProperties = await getProperties(trayId);
      const trayNames = namesOf(trayProperties.result ?? []);
      const requiredTrayMethods = [
        "getBounds",
        "isDestroyed",
        "popUpContextMenu",
        "setContextMenu",
      ];
      if (!requiredTrayMethods.every((name) => trayNames.has(name))) {
        throw new Error("Candidate tray is missing native menu methods");
      }

      const updaterProperties = await getProperties(updaterId);
      const updaterPrototypeId = valueObject(
        updaterProperties.internalProperties ?? [],
        "[[Prototype]]",
      );
      const updaterPrototype = updaterPrototypeId
        ? await getProperties(updaterPrototypeId, true)
        : undefined;
      const registerListenersId =
        valueObject(updaterProperties.result ?? [], "registerListeners") ??
        valueObject(updaterPrototype?.result ?? [], "registerListeners");
      if (!registerListenersId) {
        throw new Error(
          "Candidate updater registerListeners closure is unavailable",
        );
      }

      const electronUpdaterNamespaces = new Map<
        string,
        { objectId: string; getterId: string }
      >();
      for (const scope of await scopeObjects(registerListenersId)) {
        const properties = await getProperties(scope.objectId, true);
        const namespaces = (properties.result ?? []).flatMap((property) =>
          property.value?.type === "object" && property.value.objectId
            ? [property.value.objectId]
            : [],
        );
        for (const namespaceId of namespaces) {
          const namespaceProperties = await getProperties(namespaceId, true);
          const namespaceEntries = namespaceProperties.result ?? [];
          const namespaceNames = namesOf(namespaceEntries);
          const updaterExport = namespaceEntries.find(
            (property) =>
              property.name === "autoUpdater" &&
              property.get?.type === "function" &&
              property.get.objectId,
          );
          if (
            !updaterExport?.get?.objectId ||
            !["AppUpdater", "NsisUpdater", "MacUpdater", "Provider"].every(
              (name) => namespaceNames.has(name),
            )
          ) {
            continue;
          }
          electronUpdaterNamespaces.set(namespaceId, {
            objectId: namespaceId,
            getterId: updaterExport.get.objectId,
          });
        }
      }
      if (electronUpdaterNamespaces.size !== 1) {
        throw new Error(
          "Actual electron-updater namespace could not be uniquely identified",
        );
      }

      const updaterNamespace = [...electronUpdaterNamespaces.values()][0]!;
      // The package exposes one lazy autoUpdater accessor. Resolve only that
      // known dependency namespace after the caller verified networkArmed;
      // never invoke a getter discovered by a broad closure scan.
      const singletonReply = await post<CallReply>("Runtime.callFunctionOn", {
        objectId: updaterNamespace.objectId,
        functionDeclaration:
          "function(expectedGetter){ const descriptor=Object.getOwnPropertyDescriptor(this,'autoUpdater'); if(!descriptor || descriptor.get!==expectedGetter) throw new Error('autoUpdater export getter identity changed'); return descriptor.get.call(this); }",
        arguments: [{ objectId: updaterNamespace.getterId }],
        returnByValue: false,
        objectGroup: "xiangying-lifecycle-owned",
      });
      const updaterSingletonId = singletonReply.result?.objectId;
      if (singletonReply.exceptionDetails || !updaterSingletonId) {
        throw new Error(
          "electron-updater autoUpdater singleton is unavailable",
        );
      }
      const singletonProperties = await getProperties(updaterSingletonId);
      const sinkNames = namesOf(singletonProperties.result ?? []);
      if (
        ![
          "checkForUpdates",
          "checkForUpdatesAndNotify",
          "downloadUpdate",
          "quitAndInstall",
        ].every((name) => sinkNames.has(name))
      ) {
        throw new Error(
          "Actual updater singleton is missing required sink methods",
        );
      }

      const armReply = await post<CallReply>("Runtime.callFunctionOn", {
        objectId: updaterSingletonId,
        functionDeclaration:
          "function(){ return globalThis.xiangyingUpdateEgressObserver?.armUpdater(this) === true; }",
        returnByValue: true,
        objectGroup: "xiangying-lifecycle-owned",
      });
      if (armReply.exceptionDetails || armReply.result?.value !== true) {
        throw new Error("Actual updater sink guards did not arm");
      }

      return {
        appTrayMethods: requiredTrayMethods,
        updaterMethods: [
          "checkForUpdates",
          "checkForUpdatesAndNotify",
          "downloadUpdate",
          "quitAndInstall",
        ],
      };
    } finally {
      delete globals[marker];
      try {
        session.disconnect();
      } catch {
        // The inspection session may already be disconnected after a protocol error.
      }
    }
  });
}

async function openActualCandidateTrayMenu(app: ElectronApplication): Promise<{
  bounds: { x: number; y: number; width: number; height: number };
}> {
  return app.evaluate(async ({ app: electronApp }) => {
    type RemoteObject = {
      type?: string;
      subtype?: string;
      className?: string;
      objectId?: string;
      value?: unknown;
    };
    type Property = { name: string; value?: RemoteObject };
    type PropertiesReply = {
      result?: Property[];
      internalProperties?: Property[];
    };
    type EvaluateReply = {
      result?: RemoteObject;
      exceptionDetails?: unknown;
    };
    type CallReply = {
      result?: RemoteObject;
      exceptionDetails?: unknown;
    };
    type InspectorPost = (
      method: string,
      params: Record<string, unknown>,
      callback: (error: Error | null, result: unknown) => void,
    ) => void;

    const inspector = process.getBuiltinModule(
      "node:inspector",
    ) as typeof import("node:inspector");
    const session = new inspector.Session();
    const marker = "__xiangyingLifecycleTrayListenerForInspection";
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const listener = electronApp.listeners("second-instance")[0];
    if (typeof listener !== "function") {
      throw new Error("Candidate second-instance listener is unavailable");
    }
    globals[marker] = listener;

    const rawPost = session.post.bind(session) as unknown as InspectorPost;
    const post = <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> =>
      new Promise((resolve, reject) => {
        rawPost(method, params, (error, result) => {
          if (error) reject(error);
          else resolve(result as T);
        });
      });
    const isInspectable = (
      remote: RemoteObject | undefined,
    ): remote is RemoteObject & { objectId: string } =>
      Boolean(
        remote?.objectId &&
        (remote.type === "object" || remote.type === "function"),
      );
    const contextOf = (remote: RemoteObject | undefined) =>
      `type=${remote?.type ?? "unknown"}, subtype=${remote?.subtype ?? "none"}, className=${remote?.className ?? "none"}`;
    const getProperties = async (
      remote: RemoteObject,
      ownProperties = false,
      stage = "unknown object",
    ) => {
      if (!isInspectable(remote)) {
        throw new Error(
          `Inspector refused non-object at ${stage} (${contextOf(remote)})`,
        );
      }
      try {
        return await post<PropertiesReply>("Runtime.getProperties", {
          objectId: remote.objectId,
          ownProperties,
          accessorPropertiesOnly: false,
          generatePreview: false,
        });
      } catch (error) {
        throw new Error(
          `Inspector could not inspect ${stage} (${contextOf(remote)}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    const objectFor = (properties: Property[], name: string) =>
      properties.find(
        (property) => property.name === name && isInspectable(property.value),
      )?.value;
    const namesOf = (properties: Property[]) =>
      new Set(properties.map((property) => property.name));
    const scopesOf = async (listenerFunction: RemoteObject) => {
      const functionProperties = await getProperties(
        listenerFunction,
        false,
        "second-instance listener function",
      );
      const scopesRemote = objectFor(
        functionProperties.internalProperties ?? [],
        "[[Scopes]]",
      );
      if (!scopesRemote) {
        throw new Error(
          "Candidate listener scope list is not an inspectable object",
        );
      }
      const scopes = await getProperties(
        scopesRemote,
        false,
        "listener function scope list",
      );
      return (scopes.result ?? []).map((scope) => {
        if (!isInspectable(scope.value)) {
          throw new Error(
            `Listener scope ${scope.name} is not inspectable (${contextOf(scope.value)})`,
          );
        }
        return { name: scope.name, value: scope.value };
      });
    };

    try {
      session.connect();
      const listenerReply = await post<EvaluateReply>("Runtime.evaluate", {
        expression: `globalThis.${marker}`,
        objectGroup: "xiangying-native-tray-inspection",
        generatePreview: false,
      });
      const listenerRemote = listenerReply.result;
      if (!isInspectable(listenerRemote) || listenerReply.exceptionDetails) {
        throw new Error("Inspector could not resolve the app listener");
      }

      const appObjects = new Set<string>();
      for (const scope of await scopesOf(listenerRemote)) {
        const scopeProperties = await getProperties(
          scope.value,
          true,
          `listener ${scope.name} scope`,
        );
        const directApp = objectFor(scopeProperties.result ?? [], "mediagoApp");
        const candidates: RemoteObject[] = directApp
          ? [directApp]
          : (scopeProperties.result ?? []).flatMap((property) =>
              isInspectable(property.value) ? [property.value] : [],
            );
        for (const candidate of candidates) {
          const properties = await getProperties(
            candidate,
            true,
            `listener ${scope.name} scope candidate (${contextOf(candidate)})`,
          );
          const names = namesOf(properties.result ?? []);
          if (
            names.has("tray") &&
            names.has("mainWindow") &&
            names.has("updater") &&
            names.has("downloaderServer")
          ) {
            appObjects.add(candidate.objectId!);
          }
        }
      }
      if (appObjects.size !== 1) {
        throw new Error(
          "App listener did not resolve to one candidate app instance",
        );
      }

      const appRemote: RemoteObject = {
        type: "object",
        objectId: [...appObjects][0]!,
      };
      const appProperties = await getProperties(
        appRemote,
        true,
        "candidate application instance",
      );
      const trayRemote = objectFor(appProperties.result ?? [], "tray");
      if (!trayRemote)
        throw new Error(
          "Candidate app has no attached inspectable tray object",
        );
      const trayProperties = await getProperties(
        trayRemote,
        false,
        "candidate tray instance",
      );
      const trayNames = namesOf(trayProperties.result ?? []);
      if (
        ![
          "getBounds",
          "isDestroyed",
          "popUpContextMenu",
          "setContextMenu",
        ].every((name) => trayNames.has(name))
      ) {
        throw new Error(
          "Candidate tray does not expose its native attached-menu API",
        );
      }

      const popup = await post<CallReply>("Runtime.callFunctionOn", {
        objectId: trayRemote.objectId!,
        functionDeclaration:
          "function(){ if(this.isDestroyed()) throw new Error('attached tray is destroyed'); const b=this.getBounds(); if(!b) throw new Error('tray bounds unavailable'); this.popUpContextMenu(); return {bounds:{x:b.x,y:b.y,width:b.width,height:b.height}}; }",
        returnByValue: true,
        objectGroup: "xiangying-native-tray-inspection",
      });
      if (popup.exceptionDetails || popup.result?.value == null) {
        throw new Error("Candidate tray did not open its attached native menu");
      }
      return popup.result.value as {
        bounds: { x: number; y: number; width: number; height: number };
      };
    } finally {
      delete globals[marker];
      try {
        session.disconnect();
      } catch {
        // The inspector may already be disconnected after an app shutdown.
      }
    }
  });
}

async function runOwnedNativeMenuProbe(
  owner: WindowsProcessIdentity,
  action: "observe",
  expectedHwnd: string,
  timeoutMs?: number,
): Promise<NativeMenuObservation>;
async function runOwnedNativeMenuProbe(
  owner: WindowsProcessIdentity,
  action: "focus-main",
  expectedHwnd: string,
  timeoutMs?: number,
): Promise<NativeMenuPreflightResult>;
async function runOwnedNativeMenuProbe(
  owner: WindowsProcessIdentity,
  action: NativeMenuProbeResult["action"],
  expectedHwnd?: string,
  timeoutMs?: number,
): Promise<NativeMenuProbeResult>;
async function runOwnedNativeMenuProbe(
  owner: WindowsProcessIdentity,
  action: "observe" | "focus-main" | NativeMenuProbeResult["action"],
  expectedHwnd?: string,
  timeoutMs = 20_000,
): Promise<
  NativeMenuObservation | NativeMenuProbeResult | NativeMenuPreflightResult
> {
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    OWNED_NATIVE_MENU_SCRIPT,
    "-OwnerPid",
    String(owner.pid),
    "-OwnerCreationFileTime",
    owner.creationFileTime,
    "-Action",
    action,
  ];
  if (expectedHwnd) args.push("-ExpectedHwnd", expectedHwnd);
  const { stdout } = await execFileAsync("powershell.exe", args, {
    windowsHide: true,
    timeout: timeoutMs,
    encoding: "utf8",
  });
  return JSON.parse(stdout.trim()) as NativeMenuProbeResult;
}

test.skip(
  process.platform !== "win32",
  "candidate lifecycle follow-up requires Windows",
);
test.describe.configure({ mode: "serial" });

test("LIFE03 exits through this candidate's actual native tray menu", async () => {
  test.setTimeout(90_000);
  const {
    binding,
    bindingPath,
    executablePath,
    executableSha256,
    asarSha256,
    coreSha256,
    bindingSha256,
    sourceManifest,
    coreSourceManifest,
    specSha256,
  } = await loadBinding();
  const nativeMenuScriptSha256 = sha256(
    await readFile(OWNED_NATIVE_MENU_SCRIPT),
  );
  const session = await startCandidate("life03-native-tray");
  const result: Record<string, unknown> = {
    candidateExecutable: executablePath,
    executableSha256,
    bindingPath,
    asarSha256,
    coreSha256,
    bindingSha256,
    sourceManifest,
    coreSourceManifest,
    specSha256,
    candidateRoot: binding.candidate,
    runtimeRoot: session.runtimeRoot,
    pageSelection: session.pageSelection,
    owner: session.owner,
    core: session.core,
    nativeMenuScript: OWNED_NATIVE_MENU_SCRIPT,
    nativeMenuScriptSha256,
    interactionPath:
      "actual app Tray.popUpContextMenu attached to the real Tray menu, then exact-owner UI Automation InvokePattern on its Exit item",
  };
  const evidencePath = path.join(
    EVIDENCE_ROOT,
    `${path.basename(session.runtimeRoot)}-life03-result.json`,
  );
  try {
    await writeFileSafe(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
    const accessibilitySupport = await session.app.evaluate(
      ({ app: electronApp }) => {
        const before = electronApp.isAccessibilitySupportEnabled();
        electronApp.setAccessibilitySupportEnabled(true);
        return {
          before,
          after: electronApp.isAccessibilitySupportEnabled(),
        };
      },
    );
    result.accessibilitySupport = accessibilitySupport;
    expect(accessibilitySupport.after).toBe(true);
    const mainWindowIdentity = await session.app.evaluate(
      (_context, requireAnchor) => {
        const moduleApi = process.getBuiltinModule("node:module") as {
          createRequire(anchor: string): (id: string) => unknown;
        };
        const electron = moduleApi.createRequire(requireAnchor)("electron") as {
          BrowserWindow: {
            getAllWindows(): Array<{
              id: number;
              webContents: { getURL(): string };
              isDestroyed(): boolean;
              isVisible(): boolean;
              isFocused(): boolean;
              getNativeWindowHandle(): Buffer;
            }>;
          };
        };
        const matches = electron.BrowserWindow.getAllWindows().filter(
          (window) => window.webContents.getURL() === "xiangying://index.html/",
        );
        if (matches.length !== 1 || matches[0]?.isDestroyed())
          throw new Error("Expected one live exact candidate main window");
        const window = matches[0]!;
        const handle = window.getNativeWindowHandle();
        if (handle.length !== 8)
          throw new Error(
            `Unexpected native window handle size ${handle.length}`,
          );
        const nativeHwnd = `0x${handle.readBigUInt64LE().toString(16).toUpperCase()}`;
        return {
          id: window.id,
          url: window.webContents.getURL(),
          nativeHwnd,
          visible: window.isVisible(),
          electronFocusedObserved: window.isFocused(),
          destroyed: window.isDestroyed(),
        };
      },
      OBSERVER_SOURCE,
    );
    result.mainWindowIdentity = mainWindowIdentity;
    expect(mainWindowIdentity.visible).toBe(true);
    expect(mainWindowIdentity.destroyed).toBe(false);
    const foregroundPreflight = await runOwnedNativeMenuProbe(
      session.owner,
      "focus-main",
      mainWindowIdentity.nativeHwnd,
    );
    result.foregroundPreflight = foregroundPreflight;
    expect(foregroundPreflight.ownerPid).toBe(session.owner.pid);
    expect(foregroundPreflight.ownerCreationFileTime).toBe(
      session.owner.creationFileTime,
    );
    expect(foregroundPreflight.mainHwnd.toLowerCase()).toBe(
      mainWindowIdentity.nativeHwnd.toLowerCase(),
    );
    expect(foregroundPreflight.notifyIconHostWindows).toHaveLength(1);
    expect(foregroundPreflight.notifyIconHostWindows[0]!.windowClass).toBe(
      "Electron_NotifyIconHostWindow",
    );
    expect(foregroundPreflight.foregroundGatePassed).toBe(true);
    expect(foregroundPreflight.setFocusAttempted).toBe(true);
    expect(foregroundPreflight.focusError).toBeNull();
    expect(foregroundPreflight.foregroundAfter.pid).toBe(session.owner.pid);
    expect(foregroundPreflight.foregroundAfter.hwnd.toLowerCase()).toBe(
      mainWindowIdentity.nativeHwnd.toLowerCase(),
    );
    const beforePopup = await runOwnedNativeMenuProbe(
      session.owner,
      "observe",
      mainWindowIdentity.nativeHwnd,
    );
    result.nativeWindowsBeforePopup = beforePopup;
    expect(beforePopup.ownerPid).toBe(session.owner.pid);
    expect(beforePopup.ownerCreationFileTime).toBe(
      session.owner.creationFileTime,
    );
    expect(
      beforePopup.windows.filter(
        (window) =>
          window.hwnd.toLowerCase() ===
          mainWindowIdentity.nativeHwnd.toLowerCase(),
      ),
    ).toHaveLength(1);
    // Start the real attached menu on the candidate's main thread, then let
    // the external exact-owner HWND probe observe it concurrently. Tray menu
    // tracking can enter a nested native loop, so awaiting Inspector first
    // risks waiting for the menu to close before we can select its Exit item.
    const popupStartedAtUtc = new Date().toISOString();
    const popupState: {
      settledAtUtc: string | null;
      settlement: "pending" | "resolved" | "rejected";
      value: {
        bounds: { x: number; y: number; width: number; height: number };
      } | null;
      error: unknown;
    } = {
      settledAtUtc: null,
      settlement: "pending",
      value: null,
      error: undefined,
    };
    const readPopupState = () => ({ ...popupState });
    const popupPromise = openActualCandidateTrayMenu(session.app).then(
      (value) => {
        popupState.settledAtUtc = new Date().toISOString();
        popupState.settlement = "resolved";
        popupState.value = value;
        return { value };
      },
      (error: unknown) => {
        popupState.settledAtUtc = new Date().toISOString();
        popupState.settlement = "rejected";
        popupState.error = error;
        return { error };
      },
    );
    const popupWindows: NativeMenuObservation["windows"] = [];
    let exactLabelWindows: NativeMenuObservation["windows"] = [];
    const nativeWindowPolls: Array<Record<string, unknown>> = [];
    const observationDeadline = Date.now() + 15_000;
    for (let poll = 1; poll <= 5 && Date.now() < observationDeadline; poll++) {
      const startedAtUtc = new Date().toISOString();
      const remainingMs = Math.max(1, observationDeadline - Date.now());
      const observation = await runOwnedNativeMenuProbe(
        session.owner,
        "observe",
        mainWindowIdentity.nativeHwnd,
        remainingMs,
      );
      expect(observation.ownerPid).toBe(session.owner.pid);
      expect(observation.ownerCreationFileTime).toBe(
        session.owner.creationFileTime,
      );
      const mainWindows = observation.windows.filter(
        (window) =>
          window.hwnd.toLowerCase() ===
          mainWindowIdentity.nativeHwnd.toLowerCase(),
      );
      expect(mainWindows).toHaveLength(1);
      const ownedPopupWindows = observation.windows.filter(
        (window) =>
          window.hwnd.toLowerCase() !==
          mainWindowIdentity.nativeHwnd.toLowerCase(),
      );
      const matchingWindows = ownedPopupWindows.filter(
        (window) =>
          window.menuItems.filter(
            (item) =>
              item.name === "显示主窗口" &&
              item.controlType === "ControlType.MenuItem",
          ).length === 1 &&
          window.menuItems.filter(
            (item) =>
              item.name === "退出应用" &&
              item.controlType === "ControlType.MenuItem",
          ).length === 1,
      );
      const targetLabels = new Set(["显示主窗口", "退出应用"]);
      nativeWindowPolls.push({
        poll,
        startedAtUtc,
        completedAtUtc: new Date().toISOString(),
        ownerPid: observation.ownerPid,
        ownerCreationFileTime: observation.ownerCreationFileTime,
        mainWindowHwnd: mainWindows[0]!.hwnd,
        visibleOwnedWindows: observation.windows.map((window) => ({
          hwnd: window.hwnd,
          windowClass: window.windowClass,
          rectangle: window.rectangle,
          targetMenuItems: window.menuItems.filter((item) =>
            targetLabels.has(item.name),
          ),
        })),
        distinctPopupWindowCount: ownedPopupWindows.length,
        exactTargetMenuWindowCount: matchingWindows.length,
      });
      Object.assign(result, {
        nativeWindowPolls,
        popupInvocation: {
          startedAtUtc: popupStartedAtUtc,
          settledAtUtc: popupState.settledAtUtc,
          settlement: popupState.settlement,
        },
      });
      popupWindows.splice(0, popupWindows.length, ...ownedPopupWindows);
      exactLabelWindows = matchingWindows;
      if (exactLabelWindows.length > 0) break;
      const gapMs = Math.min(150, observationDeadline - Date.now());
      if (gapMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, gapMs));
      }
    }
    const popupOutcome = readPopupState();
    if (popupOutcome.settlement === "rejected") {
      result.trayPopupError =
        popupOutcome.error instanceof Error
          ? popupOutcome.error.message
          : String(popupOutcome.error);
      throw popupOutcome.error;
    }
    if (popupOutcome.value) {
      result.trayBounds = popupOutcome.value.bounds;
    }
    Object.assign(result, {
      nativeWindowPolls,
      popupInvocation: {
        startedAtUtc: popupStartedAtUtc,
        settledAtUtc: popupOutcome.settledAtUtc,
        settlement: popupOutcome.settlement,
      },
    });
    if (popupWindows.length === 0 || exactLabelWindows.length !== 1) {
      result.nativeMenuDecision = {
        popupWindowDistinctFromMainObserved: popupWindows.length > 0,
        exactTargetMenuWindowCount: exactLabelWindows.length,
        decision: "FAIL_CLOSED_BEFORE_ANY_MENU_ACTION",
      };
      throw new Error(
        "Read-only popup observation did not identify one non-main owner window with unique target MenuItems",
      );
    }
    const nativeMenu = await runOwnedNativeMenuProbe(session.owner, "inspect");
    result.nativeMenu = nativeMenu;
    expect(nativeMenu.ownerPid).toBe(session.owner.pid);
    expect(nativeMenu.ownerCreationFileTime).toBe(
      session.owner.creationFileTime,
    );
    expect(nativeMenu.showMainWindowItemCount).toBe(1);
    expect(nativeMenu.showMainWindowControlType).toBe("ControlType.MenuItem");
    expect(nativeMenu.exitApplicationItemCount).toBe(1);
    expect(nativeMenu.exitApplicationControlType).toBe("ControlType.MenuItem");
    expect(nativeMenu.exitInvoked).toBe(false);
    expect(nativeMenu.hwnd.toLowerCase()).toBe(
      exactLabelWindows[0]!.hwnd.toLowerCase(),
    );
    expect(nativeMenu.hwnd.toLowerCase()).not.toBe(
      mainWindowIdentity.nativeHwnd.toLowerCase(),
    );

    const selected = await runOwnedNativeMenuProbe(
      session.owner,
      "invoke-exit",
      nativeMenu.hwnd,
    );
    result.exitSelection = selected;
    expect(selected.hwnd).toBe(nativeMenu.hwnd);
    expect(selected.ownerPid).toBe(session.owner.pid);
    expect(selected.ownerCreationFileTime).toBe(session.owner.creationFileTime);
    expect(selected.exitInvoked).toBe(true);

    await Promise.race([
      popupPromise,
      new Promise((resolve) => setTimeout(resolve, 1_500)),
    ]);
    result.popupInvocation = {
      startedAtUtc: popupStartedAtUtc,
      settledAtUtc: popupState.settledAtUtc,
      settlement: popupState.settlement,
    };

    const ownerExited = await waitForWindowsProcessExit(session.owner, 20_000);
    const coreExited = session.core
      ? await waitForWindowsProcessExit(session.core, 20_000)
      : true;
    const corePortFree = await waitForPortFree("127.0.0.1", CORE_PORT, 20_000)
      .then(() => true)
      .catch(() => false);
    Object.assign(result, { ownerExited, coreExited, corePortFree });
    expect({ ownerExited, coreExited, corePortFree }).toEqual({
      ownerExited: true,
      coreExited: true,
      corePortFree: true,
    });
    result.classification = "PASS_NATIVE_TRAY_MENU_OWNED_EXIT";
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    let cleanup: Awaited<ReturnType<typeof stopCandidate>> | undefined;
    try {
      cleanup = await stopCandidate(session);
      result.cleanup = cleanup;
    } catch (error) {
      result.cleanupError =
        error instanceof Error ? error.message : String(error);
    } finally {
      await writeFileSafe(
        path.join(session.runtimeRoot, "life03-result.json"),
        `${JSON.stringify(result, null, 2)}\n`,
      );
      await writeFileSafe(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
    }
    expect(cleanup).toEqual({
      ownerExited: true,
      coreExited: true,
      corePortFree: true,
    });
  }
});

test("LIFE05 real update IPC hard gates stay local and block every observed outlet", async () => {
  test.setTimeout(120_000);
  const {
    binding,
    bindingPath,
    executablePath,
    asarSha256,
    coreSha256,
    bindingSha256,
    sourceManifest,
    coreSourceManifest,
    specSha256,
  } = await loadBinding();
  const session = await startCandidate("life05-egress", {
    updateObserver: true,
  });
  const result: Record<string, unknown> = {
    candidateExecutable: executablePath,
    bindingPath,
    asarSha256,
    coreSha256,
    bindingSha256,
    sourceManifest,
    coreSourceManifest,
    specSha256,
    candidateRoot: binding.candidate,
    runtimeRoot: session.runtimeRoot,
    pageSelection: session.pageSelection,
    owner: session.owner,
    core: session.core,
    updateCalls: ["check", "startDownload", "install"],
    observerFile: path.join(session.runtimeRoot, "update-egress-observer.json"),
  };
  try {
    const observerPath = result.observerFile as string;
    const observerBootstrap = await session.app.evaluate(
      (
        { app: electronApp }: { app: { getVersion(): string } },
        paths: { modulePath: string; stateFilePath: string },
      ) => {
        const { modulePath, stateFilePath } = paths;
        const moduleApi = process.getBuiltinModule(
          "node:module",
        ) as typeof import("node:module");
        const ownedRequire = moduleApi.createRequire(modulePath);
        ownedRequire(modulePath);
        const globals = globalThis as typeof globalThis &
          Record<string, unknown>;
        return {
          pid: process.pid,
          processType: (process as NodeJS.Process & { type: string }).type,
          electronVersion: process.versions.electron,
          appVersion: electronApp.getVersion(),
          injection: "after-launch require in candidate Electron main process",
          observerModulePath: modulePath,
          observerStateFilePathMatches:
            process.env.XIANGYING_UPDATE_EGRESS_OBSERVER_FILE === stateFilePath,
          observerGlobalPresent:
            typeof globals.xiangyingUpdateEgressObserver === "object",
        };
      },
      { modulePath: OBSERVER_SOURCE, stateFilePath: observerPath },
    );
    result.observerBootstrap = observerBootstrap;
    expect(observerBootstrap).toMatchObject({
      pid: session.owner.pid,
      processType: "browser",
      injection: "after-launch require in candidate Electron main process",
      observerModulePath: OBSERVER_SOURCE,
      observerStateFilePathMatches: true,
      observerGlobalPresent: true,
    });
    const networkObserver = await readUpdateObserver(observerPath);
    expect(networkObserver.networkArmed).toBe(true);
    expect(networkObserver.setupError).toBeNull();
    expect(networkObserver.ownerPid).toBe(session.owner.pid);
    expect(networkObserver.attempts).toEqual([]);
    const sinkInstrumentation = await armActualUpdaterSinks(session.app);
    const before = await readUpdateObserver(observerPath);
    expect(before.armed).toBe(true);
    expect(before.networkArmed).toBe(true);
    expect(before.updaterSinkArmed).toBe(true);
    expect(before.setupError).toBeNull();
    expect(before.ownerPid).toBe(session.owner.pid);
    expect(before.attempts).toEqual([]);

    const initialState = unwrap<UpdateState>(
      await session.page.evaluate(async () => {
        const update = (
          window as Window & {
            electron?: { update?: { getState(): Promise<unknown> } };
          }
        ).electron?.update;
        if (!update) throw new Error("update bridge unavailable");
        return update.getState();
      }),
    );
    expect(initialState).toMatchObject({
      status: "not-available",
      autoDownload: false,
    });

    const rawCalls = await session.page.evaluate(async () => {
      const update = (
        window as Window & {
          electron?: {
            update?: {
              check(): Promise<unknown>;
              startDownload(): Promise<unknown>;
              install(): Promise<unknown>;
            };
          };
        }
      ).electron?.update;
      if (!update) throw new Error("update bridge unavailable");
      const check = await update.check();
      const download = await update.startDownload();
      const install = await update.install();
      return { check, download, install };
    });
    const check = unwrap<{
      mode: string;
      state: UpdateState;
      externalUrl?: string;
    }>(rawCalls.check);
    const download = unwrap<UpdateState>(rawCalls.download);
    const install = unwrap<UpdateState>(rawCalls.install);
    expect(check.mode).toBe("in-app");
    expect(check.externalUrl).toBeUndefined();
    expect(check.state.error?.phase).toBe("check");
    expect(check.state.error?.message).toContain("尚未配置更新源");
    expect(download.error?.phase).toBe("download");
    expect(download.error?.message).toContain("尚未配置更新源");
    expect(install.error?.phase).toBe("install");
    expect(install.error?.message).toContain("本地安装包更新");

    const after = await readUpdateObserver(observerPath);
    expect(after.armed).toBe(true);
    expect(after.setupError).toBeNull();
    expect(after.ownerPid).toBe(session.owner.pid);
    expect(after.attempts).toEqual([]);
    expect(Object.values(after.counters).every((count) => count === 0)).toBe(
      true,
    );
    result.initialState = initialState;
    result.sinkInstrumentation = sinkInstrumentation;
    result.responses = { check, download, install };
    result.outletCounters = after.counters;
    result.blockedOrAttemptedSinks = after.attempts;
    result.classification =
      "PASS_PACKAGE_IPC_HARD_GATE_AND_ZERO_OBSERVED_SINK_CALLS";
  } finally {
    const cleanup = await stopCandidate(session);
    Object.assign(result, cleanup);
    await mkdir(EVIDENCE_ROOT, { recursive: true });
    await writeFileSafe(
      path.join(session.runtimeRoot, "life05-result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    expect(cleanup).toEqual({
      ownerExited: true,
      coreExited: true,
      corePortFree: true,
    });
  }
});

test("LIFE07 classifies an unavailable Core with the candidate window still running", async () => {
  test.setTimeout(90_000);
  const {
    binding,
    bindingPath,
    executablePath,
    asarSha256,
    coreSha256,
    bindingSha256,
    sourceManifest,
    coreSourceManifest,
    specSha256,
  } = await loadBinding();
  await mkdir(EVIDENCE_ROOT, { recursive: true });
  const missingCore = path.join(
    EVIDENCE_ROOT,
    "fixtures",
    `missing-core-${process.pid}-${Date.now()}`,
    "mediago-core.exe",
  );
  try {
    await access(missingCore);
    throw new Error("Missing-Core fixture unexpectedly exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const session = await startCandidate("life07-no-core", {
    coreBinaryOverride: missingCore,
  });
  const pageErrors: string[] = [];
  session.page.on("pageerror", (error) => pageErrors.push(error.message));
  const result: Record<string, unknown> = {
    candidateExecutable: executablePath,
    bindingPath,
    asarSha256,
    coreSha256,
    bindingSha256,
    sourceManifest,
    coreSourceManifest,
    specSha256,
    candidateRoot: binding.candidate,
    runtimeRoot: session.runtimeRoot,
    pageSelection: session.pageSelection,
    missingCorePath: missingCore,
    owner: session.owner,
    coreListenerPresent: false,
  };
  try {
    await expect(session.page).toHaveURL(/^xiangying:\/\/index\.html/);
    expect(session.pageSelection.selectedNativeWindowIds).toHaveLength(1);
    const selectedNativeWindow = session.pageSelection.nativeWindows.find(
      (window) =>
        window.id === session.pageSelection.selectedNativeWindowIds[0],
    );
    expect(selectedNativeWindow?.visible).toBe(true);
    await expect(session.page.locator("body")).toBeVisible();
    await expect(
      session.page.getByRole("heading", { name: "我的片库" }),
    ).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const logsDirectory = path.join(session.runtimeRoot, "data", "logs");
    const names = await readdir(logsDirectory);
    const logContents = await Promise.all(
      names
        .filter((name) => name.endsWith("-xiangying.log"))
        .map((name) => readFile(path.join(logsDirectory, name), "utf8")),
    );
    const joinedLogs = logContents.join("\n");
    expect(joinedLogs).toContain("Failed to start Go core service:");
    expect(joinedLogs).toContain("Executable not found or not accessible:");
    expect(await readCoreOwner(CORE_PORT)).toBeUndefined();
    await expect(session.page).not.toHaveURL("about:blank");
    result.pageErrors = pageErrors;
    result.mainWindowAvailable = true;
    result.expectedMissingBinaryReported = true;
    result.corePortFreeWhileWindowOpen = true;
    result.mainPageHeading = "我的片库";
    expect(pageErrors).toEqual([]);
    result.classification = "CORE_START_FAILED_WINDOW_REMAINS_CLASSIFIABLE";
  } finally {
    const cleanup = await stopCandidate(session);
    Object.assign(result, cleanup);
    await writeFileSafe(
      path.join(session.runtimeRoot, "life07-result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    expect(cleanup).toEqual({
      ownerExited: true,
      coreExited: true,
      corePortFree: true,
    });
  }
});

test("LIFE07 packaged MainWindow listeners classify only controlled renderer events", async () => {
  test.setTimeout(90_000);
  const {
    binding,
    bindingPath,
    executablePath,
    asarSha256,
    coreSha256,
    bindingSha256,
    sourceManifest,
    coreSourceManifest,
    specSha256,
  } = await loadBinding();
  const session = await startCandidate("life07-main-window-classification");
  const privateUrl =
    "https://private.invalid/watch?token=closure-lifecycle-synthetic-DO-NOT-LOG";
  const result: Record<string, unknown> = {
    candidateExecutable: executablePath,
    bindingPath,
    asarSha256,
    coreSha256,
    bindingSha256,
    sourceManifest,
    coreSourceManifest,
    specSha256,
    candidateRoot: binding.candidate,
    runtimeRoot: session.runtimeRoot,
    pageSelection: session.pageSelection,
    owner: session.owner,
    syntheticOnly: true,
    realNavigation: false,
    forcefullyCrashRenderer: false,
  };
  try {
    await expect(session.page).toHaveURL(/^xiangying:\/\/index\.html\/?$/);
    const beforeLogs = await readCandidateLogs(session.runtimeRoot);
    const probe = await session.app.evaluate((_context, requireAnchor) => {
      const moduleApi = process.getBuiltinModule("node:module") as {
        createRequire(anchor: string): (id: string) => unknown;
      };
      const crypto = moduleApi.createRequire(requireAnchor)("node:crypto") as {
        createHash(algorithm: string): {
          update(data: string): { digest(encoding: "hex"): string };
        };
      };
      const electron = moduleApi.createRequire(requireAnchor)("electron") as {
        BrowserWindow: {
          getAllWindows(): Array<{
            id: number;
            webContents: {
              id: number;
              getURL(): string;
              isDestroyed(): boolean;
              listenerCount(event: string): number;
              rawListeners(
                event: string,
              ): Array<(...args: unknown[]) => unknown>;
            };
            isDestroyed(): boolean;
            isVisible(): boolean;
          }>;
        };
      };
      const expectedRoot = "xiangying://index.html/";
      const exactWindows = electron.BrowserWindow.getAllWindows().filter(
        (window) => window.webContents.getURL() === expectedRoot,
      );
      if (exactWindows.length !== 1)
        throw new Error(
          `Expected one exact candidate root BrowserWindow, found ${exactWindows.length}`,
        );
      const window = exactWindows[0];
      if (!window || window.isDestroyed() || window.webContents.isDestroyed())
        throw new Error("Exact candidate BrowserWindow is destroyed");
      const contents = window.webContents;
      const loadListeners = contents.rawListeners("did-fail-load");
      const goneListeners = contents.rawListeners("render-process-gone");
      const classifierLoadListeners = loadListeners.filter((listener) =>
        String(listener).includes("renderer-main-frame-load-failed"),
      );
      const classifierGoneListeners = goneListeners.filter((listener) =>
        String(listener).includes("renderer-process-gone"),
      );
      const listenerFacts = {
        didFailLoadTotal: contents.listenerCount("did-fail-load"),
        didFailLoadClassifier: classifierLoadListeners.length,
        renderProcessGoneTotal: contents.listenerCount("render-process-gone"),
        renderProcessGoneClassifier: classifierGoneListeners.length,
      };
      if (
        classifierLoadListeners.length !== 1 ||
        classifierGoneListeners.length !== 1
      )
        throw new Error(
          `Packaged MainWindow classifier listeners are not unique: ${JSON.stringify(listenerFacts)}`,
        );
      const mainFrameEvent = { preventDefault() {}, sender: contents };
      const loadClassifier = classifierLoadListeners[0];
      const goneClassifier = classifierGoneListeners[0];
      if (!loadClassifier || !goneClassifier)
        throw new Error("Unique packaged classifier callback disappeared");
      const callbackText = {
        didFailLoad: String(loadClassifier),
        renderProcessGone: String(goneClassifier),
      };
      if (
        !callbackText.didFailLoad.includes("renderer-main-frame-load-failed") ||
        !callbackText.renderProcessGone.includes("renderer-process-gone")
      )
        throw new Error(
          "Unique callbacks do not match fixed classifier identities",
        );
      const classifierCallbackSha256 = {
        didFailLoad: crypto
          .createHash("sha256")
          .update(callbackText.didFailLoad)
          .digest("hex"),
        renderProcessGone: crypto
          .createHash("sha256")
          .update(callbackText.renderProcessGone)
          .digest("hex"),
      };
      loadClassifier.call(
        contents,
        mainFrameEvent,
        -105,
        "synthetic private description",
        "https://private.invalid/watch?token=closure-lifecycle-synthetic-DO-NOT-LOG",
        true,
        101,
        202,
      );
      loadClassifier.call(
        contents,
        mainFrameEvent,
        -105,
        "synthetic subframe description",
        "https://private.invalid/subframe?secret=do-not-log",
        false,
        101,
        203,
      );
      loadClassifier.call(
        contents,
        mainFrameEvent,
        -3,
        "synthetic aborted description",
        "https://private.invalid/aborted?secret=do-not-log",
        true,
        101,
        204,
      );
      goneClassifier.call(
        contents,
        { sender: contents },
        {
          reason: "clean-exit",
          exitCode: 0,
        },
      );
      goneClassifier.call(
        contents,
        { sender: contents },
        {
          reason: "crashed",
          exitCode: 23,
        },
      );
      return {
        browserWindowId: window.id,
        webContentsId: contents.id,
        url: contents.getURL(),
        visible: window.isVisible(),
        destroyed: window.isDestroyed(),
        listenerFacts,
        classifierCallbackSha256,
        directInvocationOfActualRegisteredClassifierCallbacks: true,
        webContentsEventEmitterDispatch: false,
        controlledCases: [
          "main-frame-net-error-105",
          "subframe-net-error-105",
          "main-frame-err-aborted-3",
          "renderer-clean-exit-0",
          "renderer-crashed-23",
        ],
      };
    }, OBSERVER_SOURCE);
    result.actualMainWindowProbe = probe;
    expect(probe.url).toBe("xiangying://index.html/");
    expect(probe.visible).toBe(true);
    expect(probe.destroyed).toBe(false);
    if (session.pageSelection.selectedNativeWindowIds.length > 0) {
      expect(session.pageSelection.selectedNativeWindowIds).toEqual([
        probe.browserWindowId,
      ]);
    } else {
      expect(session.pageSelection.nativeWindowInspectionError).toBeTruthy();
      result.nativeWindowSelectionCrossCheckUnavailable = true;
    }
    expect(probe.listenerFacts).toMatchObject({
      didFailLoadClassifier: 1,
      renderProcessGoneClassifier: 1,
    });

    await expect
      .poll(async () => readCandidateLogs(session.runtimeRoot), {
        timeout: 10_000,
      })
      .toContain("renderer-main-frame-load-failed");
    const afterLogs = await readCandidateLogs(session.runtimeRoot);
    const newLogs = afterLogs.slice(beforeLogs.length);
    expect(newLogs).toContain("renderer-main-frame-load-failed");
    expect(newLogs).toContain("-105");
    expect(newLogs).toContain("renderer-process-gone");
    expect(newLogs).toContain("crashed");
    expect(newLogs).toContain("23");
    expect(afterLogs).not.toContain(privateUrl);
    expect(afterLogs).not.toContain("private.invalid");
    expect(
      newLogs.match(/renderer-main-frame-load-failed/g) ?? [],
    ).toHaveLength(1);
    expect(newLogs.match(/renderer-process-gone/g) ?? []).toHaveLength(1);
    expect(newLogs).not.toContain("clean-exit");
    expect(newLogs).not.toContain("subframe description");
    expect(newLogs).not.toContain("aborted description");

    const ownerStillAlive = await readWindowsProcessIdentity(session.owner.pid);
    expect(ownerStillAlive).toEqual(session.owner);
    await expect(session.page).toHaveURL(/^xiangying:\/\/index\.html\/?$/);
    await expect(session.page.locator("body")).toBeVisible();
    await expect(
      session.page.getByRole("heading", { name: "我的片库" }),
    ).toBeVisible();
    await expect(
      session.page.getByRole("heading", { name: "片库还空着" }),
    ).toBeVisible();
    result.isolatedEmptyProfileAvailable = true;
    result.logDeltaSha256 = sha256(Buffer.from(newLogs, "utf8"));
    result.mainFrameFailureClassified = true;
    result.crashedRendererClassified = true;
    result.subframeAbortedAndCleanExitIgnored = true;
    result.privateUrlAbsentFromLogs = true;
    result.ownerAliveAndUiAvailable = true;
    result.classification =
      "PACKAGED_MAIN_WINDOW_SYNTHETIC_CLASSIFICATION_OBSERVED";
  } finally {
    const cleanup = await stopCandidate(session);
    Object.assign(result, cleanup);
    await writeFileSafe(
      path.join(
        session.runtimeRoot,
        "life07-main-window-classification-result.json",
      ),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    expect(cleanup).toEqual({
      ownerExited: true,
      coreExited: true,
      corePortFree: true,
    });
  }
});
