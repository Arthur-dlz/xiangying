import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sign, type SignOptions } from "@electron/osx-sign";

const MANIFEST_SCHEMA_VERSION = 2;
const MANIFEST_FILENAME = "runtime.json";
const AD_HOC_SIGNING_MODE = "ad-hoc";

export interface MacOSDevelopmentRuntimeOptions {
  appId: string;
  architecture: string;
  cacheRoot: string;
  electronExecutable: string;
  electronVersion: string;
  iconPath: string;
  productName: string;
}

export interface MacOSDevelopmentRuntimeManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  appId: string;
  appPath: string;
  architecture: string;
  electronVersion: string;
  executablePath: string;
  productName: string;
  signingMode: typeof AD_HOC_SIGNING_MODE;
}

export interface MacOSDevelopmentRuntimeDependencies {
  copyApp: (sourceApp: string, destinationApp: string) => Promise<void>;
  runTool: (command: string, args: readonly string[]) => string;
  signApp: (options: SignOptions) => Promise<void>;
}

const defaultDependencies: MacOSDevelopmentRuntimeDependencies = {
  copyApp: copyMacOSAppBundle,
  runTool,
  signApp: sign,
};

export function findMacOSAppBundle(electronExecutable: string): string {
  let current = path.resolve(path.dirname(electronExecutable));
  const root = path.parse(current).root;

  while (current !== root) {
    if (current.endsWith(".app")) return current;
    current = path.dirname(current);
  }

  throw new Error(
    `Electron executable is not inside a macOS app bundle: ${electronExecutable}`,
  );
}

export async function prepareMacOSDevelopmentRuntime(
  options: MacOSDevelopmentRuntimeOptions,
  dependencies: MacOSDevelopmentRuntimeDependencies = defaultDependencies,
): Promise<MacOSDevelopmentRuntimeManifest> {
  validateOptions(options);
  const sourceApp = findMacOSAppBundle(options.electronExecutable);
  const runtimeKey = createRuntimeKey(options);
  const runtimeDirectory = path.join(options.cacheRoot, runtimeKey);
  const appPath = path.join(runtimeDirectory, `${options.productName}.app`);
  const executablePath = path.join(
    appPath,
    "Contents",
    "MacOS",
    path.basename(options.electronExecutable),
  );
  const manifest: MacOSDevelopmentRuntimeManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    appId: options.appId,
    appPath,
    architecture: options.architecture,
    electronVersion: options.electronVersion,
    executablePath,
    productName: options.productName,
    signingMode: AD_HOC_SIGNING_MODE,
  };

  await fs.mkdir(options.cacheRoot, { recursive: true });
  const cached = await readMacOSDevelopmentRuntimeManifest(
    options.cacheRoot,
  ).catch(() => undefined);
  if (cached && manifestsMatch(cached, manifest)) {
    try {
      await fs.access(cached.executablePath);
      verifySignedRuntime(cached, dependencies);
      return cached;
    } catch {
      // Rebuild a stale or invalid cached runtime below.
    }
  }

  const temporaryDirectory = await fs.mkdtemp(
    path.join(options.cacheRoot, ".prepare-"),
  );
  const temporaryApp = path.join(
    temporaryDirectory,
    `${options.productName}.app`,
  );

  try {
    await dependencies.copyApp(sourceApp, temporaryApp);
    await rebrandAppBundle(temporaryApp, options, dependencies);
    await dependencies.signApp({
      app: temporaryApp,
      identity: "-",
      identityValidation: false,
      optionsForFile: () => ({
        hardenedRuntime: false,
        timestamp: "none",
      }),
      platform: "darwin",
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      strictVerify: true,
      type: "development",
    });
    verifySignedRuntime({ ...manifest, appPath: temporaryApp }, dependencies);

    await fs.mkdir(runtimeDirectory, { recursive: true });
    await fs.rm(appPath, { recursive: true, force: true });
    await fs.rename(temporaryApp, appPath);
    verifySignedRuntime(manifest, dependencies);
    await writeManifest(options.cacheRoot, manifest);
    return manifest;
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function readMacOSDevelopmentRuntimeManifest(
  cacheRoot: string,
): Promise<MacOSDevelopmentRuntimeManifest> {
  const manifestPath = path.join(cacheRoot, MANIFEST_FILENAME);
  const parsed = JSON.parse(
    await fs.readFile(manifestPath, "utf8"),
  ) as Partial<MacOSDevelopmentRuntimeManifest>;

  if (
    parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    !isNonEmptyString(parsed.appId) ||
    !isNonEmptyString(parsed.appPath) ||
    !isNonEmptyString(parsed.architecture) ||
    !isNonEmptyString(parsed.electronVersion) ||
    !isNonEmptyString(parsed.executablePath) ||
    !isNonEmptyString(parsed.productName) ||
    parsed.signingMode !== AD_HOC_SIGNING_MODE
  ) {
    throw new Error(
      `Invalid macOS development runtime manifest: ${manifestPath}`,
    );
  }

  return parsed as MacOSDevelopmentRuntimeManifest;
}

function validateOptions(options: MacOSDevelopmentRuntimeOptions): void {
  for (const [name, value] of Object.entries(options)) {
    if (!value.trim()) throw new Error(`${name} must not be empty`);
  }
  if (!/^[A-Za-z0-9.-]+$/.test(options.appId)) {
    throw new Error(`Invalid macOS development app ID: ${options.appId}`);
  }
  if (/[\\/]/.test(options.productName)) {
    throw new Error("macOS development product name must not contain slashes");
  }
}

function createRuntimeKey(options: MacOSDevelopmentRuntimeOptions): string {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        appId: options.appId,
        architecture: options.architecture,
        electronVersion: options.electronVersion,
        productName: options.productName,
        signingMode: AD_HOC_SIGNING_MODE,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return `${options.electronVersion}-${options.architecture}-${fingerprint}`;
}

async function rebrandAppBundle(
  appPath: string,
  options: MacOSDevelopmentRuntimeOptions,
  dependencies: MacOSDevelopmentRuntimeDependencies,
): Promise<void> {
  const infoFiles = await findAppInfoPlists(appPath);
  for (const infoFile of infoFiles) {
    const bundleName = path.basename(path.dirname(path.dirname(infoFile)));
    const role = /^Electron Helper \((Renderer|Plugin|GPU)\)\.app$/.exec(
      bundleName,
    )?.[1];
    const isRoot = infoFile === path.join(appPath, "Contents", "Info.plist");
    const bundleId = isRoot
      ? options.appId
      : role
        ? `${options.appId}.helper.${role}`
        : `${options.appId}.helper`;
    const displayName = isRoot
      ? options.productName
      : role
        ? `${options.productName} Helper (${role})`
        : `${options.productName} Helper`;

    replacePlistString(infoFile, "CFBundleIdentifier", bundleId, dependencies);
    replacePlistString(infoFile, "CFBundleName", displayName, dependencies);
    if (isRoot) {
      replacePlistString(
        infoFile,
        "CFBundleDisplayName",
        displayName,
        dependencies,
      );
    }
  }

  const iconFilename = "mediago-dev.icns";
  await fs.mkdir(path.join(appPath, "Contents", "Resources"), {
    recursive: true,
  });
  await fs.copyFile(
    options.iconPath,
    path.join(appPath, "Contents", "Resources", iconFilename),
  );
  replacePlistString(
    path.join(appPath, "Contents", "Info.plist"),
    "CFBundleIconFile",
    iconFilename,
    dependencies,
  );
}

async function findAppInfoPlists(appPath: string): Promise<string[]> {
  const infoFiles: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const child = path.join(directory, entry.name);
          if (entry.name.endsWith(".app")) {
            const infoFile = path.join(child, "Contents", "Info.plist");
            if (await exists(infoFile)) infoFiles.push(infoFile);
          }
          await visit(child);
        }),
    );
  }

  const rootInfo = path.join(appPath, "Contents", "Info.plist");
  if (await exists(rootInfo)) infoFiles.push(rootInfo);
  await visit(path.join(appPath, "Contents"));
  return infoFiles;
}

function replacePlistString(
  infoFile: string,
  key: string,
  value: string,
  dependencies: MacOSDevelopmentRuntimeDependencies,
): void {
  dependencies.runTool("plutil", ["-replace", key, "-string", value, infoFile]);
}

function verifySignedRuntime(
  manifest: Pick<MacOSDevelopmentRuntimeManifest, "appId" | "appPath">,
  dependencies: MacOSDevelopmentRuntimeDependencies,
): void {
  dependencies.runTool("codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    manifest.appPath,
  ]);
  const signature = dependencies.runTool("codesign", [
    "--display",
    "--verbose=4",
    manifest.appPath,
  ]);
  if (!signature.includes(`Identifier=${manifest.appId}`)) {
    throw new Error(
      `Signed development runtime does not use bundle ID ${manifest.appId}`,
    );
  }
  if (!/Signature=adhoc|flags=[^\r\n]*\badhoc\b/i.test(signature)) {
    throw new Error(
      "Signed development runtime does not use full-bundle ad-hoc signing",
    );
  }
  if (/\blinker-signed\b/i.test(signature)) {
    throw new Error(
      "Signed development runtime still uses a linker-only signature",
    );
  }
}

function manifestsMatch(
  actual: MacOSDevelopmentRuntimeManifest,
  expected: MacOSDevelopmentRuntimeManifest,
): boolean {
  return (
    actual.schemaVersion === expected.schemaVersion &&
    actual.appId === expected.appId &&
    actual.appPath === expected.appPath &&
    actual.architecture === expected.architecture &&
    actual.electronVersion === expected.electronVersion &&
    actual.executablePath === expected.executablePath &&
    actual.productName === expected.productName &&
    actual.signingMode === expected.signingMode
  );
}

async function writeManifest(
  cacheRoot: string,
  manifest: MacOSDevelopmentRuntimeManifest,
): Promise<void> {
  const manifestPath = path.join(cacheRoot, MANIFEST_FILENAME);
  const temporaryManifest = `${manifestPath}.${process.pid}.tmp`;
  await fs.writeFile(
    temporaryManifest,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await fs.rename(temporaryManifest, manifestPath);
}

async function exists(filename: string): Promise<boolean> {
  return fs
    .access(filename)
    .then(() => true)
    .catch(() => false);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function runTool(command: string, args: readonly string[]): string {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${String(result.status)}${output.trim() ? `: ${output.trim()}` : ""}`,
    );
  }
  return output;
}

async function copyMacOSAppBundle(
  sourceApp: string,
  destinationApp: string,
): Promise<void> {
  runTool("ditto", [sourceApp, destinationApp]);
}
