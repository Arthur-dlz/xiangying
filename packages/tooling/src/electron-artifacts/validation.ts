import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  isElectronUpdateChannel,
  type ElectronArtifactValidation,
} from "./contracts.ts";
import { fileDigest } from "./files.ts";
import {
  parseUpdaterManifestEntry,
  parseYamlScalar,
  parseUpdaterManifest,
  releaseAssetName,
  type UpdaterManifestEntry,
} from "./manifest.ts";

const DOS_HEADER_SIZE = 64;
const PE_HEADER_SIZE = 24;
const PE_SECTION_HEADER_SIZE = 40;
const MAX_PE_SECTIONS = 96;
const MIN_NSIS_PAYLOAD_SIZE = 1024 * 1024;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
}

function requireSingleAsset(
  names: readonly string[],
  description: string,
  suffix: string,
): string {
  const pattern = new RegExp(`^.+-${escapeRegExp(suffix)}$`, "i");
  const matches = names.filter((name) => pattern.test(name));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${description}, found ${matches.length}: ${matches.join(", ") || "none"}`,
    );
  }
  return matches[0];
}

async function validateWindowsInstaller(
  installerPath: string,
  installerName: string,
): Promise<void> {
  const handle = await open(installerPath, "r");
  try {
    const fileSize = (await handle.stat()).size;
    const readAt = async (
      length: number,
      position: number,
    ): Promise<Buffer> => {
      if (
        !Number.isSafeInteger(position) ||
        position < 0 ||
        position + length > fileSize
      ) {
        throw new Error(
          `Windows installer ${installerName} contains an invalid PE header`,
        );
      }
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead !== length) {
        throw new Error(
          `Windows installer ${installerName} contains a truncated PE header`,
        );
      }
      return buffer;
    };

    const dosHeader = await readAt(DOS_HEADER_SIZE, 0);
    if (dosHeader.toString("ascii", 0, 2) !== "MZ") {
      throw new Error(
        `Windows installer ${installerName} is not a PE executable`,
      );
    }

    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = await readAt(PE_HEADER_SIZE, peOffset);
    if (peHeader.toString("binary", 0, 4) !== "PE\0\0") {
      throw new Error(
        `Windows installer ${installerName} contains an invalid PE signature`,
      );
    }

    const sectionCount = peHeader.readUInt16LE(6);
    if (sectionCount === 0 || sectionCount > MAX_PE_SECTIONS) {
      throw new Error(
        `Windows installer ${installerName} contains an invalid PE section count: ${sectionCount}`,
      );
    }
    const optionalHeaderSize = peHeader.readUInt16LE(20);
    const sectionTableOffset = peOffset + PE_HEADER_SIZE + optionalHeaderSize;
    const sectionTable = await readAt(
      sectionCount * PE_SECTION_HEADER_SIZE,
      sectionTableOffset,
    );

    let imageEnd = 0;
    for (let index = 0; index < sectionCount; index += 1) {
      const sectionOffset = index * PE_SECTION_HEADER_SIZE;
      const rawSize = sectionTable.readUInt32LE(sectionOffset + 16);
      const rawPointer = sectionTable.readUInt32LE(sectionOffset + 20);
      if (rawSize === 0) continue;
      const sectionEnd = rawPointer + rawSize;
      if (sectionEnd > fileSize) {
        throw new Error(
          `Windows installer ${installerName} contains a truncated PE section`,
        );
      }
      imageEnd = Math.max(imageEnd, sectionEnd);
    }
    if (imageEnd === 0) {
      throw new Error(
        `Windows installer ${installerName} does not contain a PE image`,
      );
    }

    const payloadSize = fileSize - imageEnd;
    if (payloadSize < MIN_NSIS_PAYLOAD_SIZE) {
      throw new Error(
        `Windows installer ${installerName} contains only ${payloadSize} bytes of appended NSIS payload; expected at least ${MIN_NSIS_PAYLOAD_SIZE}`,
      );
    }
  } finally {
    await handle.close();
  }
}

function parseOptionalSize(
  raw: string | undefined,
  key: "blockMapSize" | "size",
  source: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const value = parseYamlScalar(raw, source);
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${source} contains an invalid ${key}: ${value}`);
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size)) {
    throw new Error(`${source} contains an unsafe ${key}: ${value}`);
  }
  return size;
}

async function validateManifestEntry(
  entry: UpdaterManifestEntry,
  source: string,
  fileByName: ReadonlyMap<string, string>,
): Promise<string> {
  const assetName = releaseAssetName(entry.url, source);
  const assetPath = fileByName.get(assetName);
  if (!assetPath) {
    throw new Error(`${source} references missing release asset ${assetName}`);
  }

  const expectedSha512 = parseYamlScalar(entry.sha512Value, source);
  const actualSha512 = await fileDigest(assetPath, "sha512", "base64");
  if (actualSha512 !== expectedSha512) {
    throw new Error(`${source} contains the wrong sha512 for ${assetName}`);
  }

  const assetSize = (await stat(assetPath)).size;
  const declaredSize = parseOptionalSize(entry.sizeValue, "size", source);
  if (declaredSize !== undefined && declaredSize !== assetSize) {
    throw new Error(`${source} contains the wrong size for ${assetName}`);
  }

  const blockMapSize = parseOptionalSize(
    entry.blockMapSizeValue,
    "blockMapSize",
    source,
  );
  if (blockMapSize !== undefined) {
    const blockmapPath = fileByName.get(`${assetName}.blockmap`);
    if (!blockmapPath) {
      throw new Error(
        `${source} references a blockmap for ${assetName}, but it is missing`,
      );
    }
    if ((await stat(blockmapPath)).size !== blockMapSize) {
      throw new Error(
        `${source} contains the wrong blockMapSize for ${assetName}`,
      );
    }
  }
  return assetName;
}

function assertExactInventory(
  names: readonly string[],
  expectedNames: ReadonlySet<string>,
): void {
  const unexpected = names.filter((name) => !expectedNames.has(name));
  const missing = [...expectedNames].filter((name) => !names.includes(name));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `Electron release inventory mismatch; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`,
    );
  }
}

async function validateManifest(
  manifestName: string,
  expectedAssets: readonly string[],
  expectedVersion: string,
  fileByName: ReadonlyMap<string, string>,
): Promise<void> {
  const manifestPath = fileByName.get(manifestName);
  if (!manifestPath) {
    throw new Error(`Missing required updater manifest: ${manifestName}`);
  }

  const manifest = parseUpdaterManifest(
    await readFile(manifestPath, "utf8"),
    manifestName,
  );
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `${manifestName} contains version ${manifest.version}, expected ${expectedVersion}`,
    );
  }

  const references = await Promise.all(
    manifest.entries.map((entry) =>
      validateManifestEntry(
        parseUpdaterManifestEntry(entry, manifestName),
        manifestName,
        fileByName,
      ),
    ),
  );
  if (new Set(references).size !== references.length) {
    throw new Error(`${manifestName} contains duplicate updater URLs`);
  }

  const expectedSet = new Set(expectedAssets);
  const unexpected = references.filter((name) => !expectedSet.has(name));
  const missing = expectedAssets.filter((name) => !references.includes(name));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `${manifestName} updater inventory mismatch; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`,
    );
  }
}

export async function validateCompleteRelease(
  files: readonly string[],
  validation: ElectronArtifactValidation,
): Promise<void> {
  if (!isElectronUpdateChannel(validation.channel)) {
    throw new Error(`Unsupported updater channel: ${validation.channel}`);
  }

  const names = files.map((file) => path.basename(file));
  const fileByName = new Map(
    files.map((file) => [path.basename(file), file] as const),
  );
  const asset = (description: string, suffix: string) =>
    requireSingleAsset(names, description, suffix);
  const version = validation.version;

  const windowsInstaller = asset(
    "Windows installer",
    `setup-win32-x64-${version}.exe`,
  );
  const windowsPortable = asset(
    "Windows portable executable",
    `portable-win32-x64-${version}.exe`,
  );
  const macArmDmg = asset(
    "macOS arm64 DMG",
    `setup-darwin-arm64-${version}.dmg`,
  );
  const macArmZip = asset(
    "macOS arm64 ZIP",
    `setup-darwin-arm64-${version}.zip`,
  );
  const macIntelDmg = asset("macOS x64 DMG", `setup-darwin-x64-${version}.dmg`);
  const macIntelZip = asset("macOS x64 ZIP", `setup-darwin-x64-${version}.zip`);
  // electron-builder maps Electron's x64 architecture to Debian's amd64 name.
  const linuxDeb = asset("Linux amd64 DEB", `setup-linux-amd64-${version}.deb`);

  await validateWindowsInstaller(
    fileByName.get(windowsInstaller) as string,
    windowsInstaller,
  );

  const manifestAssets = new Map<string, string[]>([
    [`${validation.channel}.yml`, [windowsInstaller]],
    [
      `${validation.channel}-mac.yml`,
      [macArmDmg, macArmZip, macIntelDmg, macIntelZip],
    ],
    [`${validation.channel}-linux.yml`, [linuxDeb]],
  ]);
  const blockmaps = [
    windowsInstaller,
    macArmDmg,
    macArmZip,
    macIntelDmg,
    macIntelZip,
  ].map((name) => `${name}.blockmap`);
  const releaseAssets = [
    windowsInstaller,
    windowsPortable,
    macArmDmg,
    macArmZip,
    macIntelDmg,
    macIntelZip,
    linuxDeb,
  ];

  assertExactInventory(
    names,
    new Set([...releaseAssets, ...blockmaps, ...manifestAssets.keys()]),
  );
  await Promise.all(
    [...manifestAssets].map(([manifestName, expectedAssets]) =>
      validateManifest(
        manifestName,
        expectedAssets,
        validation.version,
        fileByName,
      ),
    ),
  );
}
