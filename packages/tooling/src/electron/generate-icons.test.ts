import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const assetRoot = path.join(projectRoot, "apps/electron/assets");

const WINDOWS_ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const WINDOWS_TRAY_ICON_SIZES = [16, 20, 24, 32, 40, 48];
const LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const MACOS_ICON_TYPES = [
  "icp4",
  "icp5",
  "icp6",
  "ic07",
  "ic08",
  "ic09",
  "ic10",
  "ic11",
  "ic12",
  "ic13",
  "ic14",
];

function readPngDimensions(buffer: Buffer): [number, number] {
  expect(buffer.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(buffer.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

async function expectPngSize(file: string, size: number): Promise<void> {
  expect(readPngDimensions(await readFile(file))).toEqual([size, size]);
}

async function expectIcoSizes(
  file: string,
  expectedSizes: readonly number[],
): Promise<void> {
  const icon = await readFile(file);
  expect(icon.readUInt16LE(0)).toBe(0);
  expect(icon.readUInt16LE(2)).toBe(1);
  expect(icon.readUInt16LE(4)).toBe(expectedSizes.length);

  const actualSizes: number[] = [];
  for (let index = 0; index < expectedSizes.length; index += 1) {
    const entry = 6 + index * 16;
    const width = icon.readUInt8(entry) || 256;
    const height = icon.readUInt8(entry + 1) || 256;
    const payloadLength = icon.readUInt32LE(entry + 8);
    const payloadOffset = icon.readUInt32LE(entry + 12);
    const payload = icon.subarray(payloadOffset, payloadOffset + payloadLength);

    expect(height).toBe(width);
    expect(icon.readUInt16LE(entry + 4)).toBe(1);
    expect(icon.readUInt16LE(entry + 6)).toBe(32);
    expect(readPngDimensions(payload)).toEqual([width, height]);
    actualSizes.push(width);
  }

  expect(actualSizes).toEqual(expectedSizes);
  expect(new Set(actualSizes).size).toBe(expectedSizes.length);
}

describe("Electron desktop icon assets", () => {
  test("keeps every Windows ICO entry unique and correctly sized", async () => {
    await expectIcoSizes(path.join(assetRoot, "icon.ico"), WINDOWS_ICON_SIZES);
    await expectIcoSizes(
      path.join(assetRoot, "tray.ico"),
      WINDOWS_TRAY_ICON_SIZES,
    );
  });

  test("contains the complete modern macOS icon set", async () => {
    const icon = await readFile(path.join(assetRoot, "icon.icns"));
    expect(icon.subarray(0, 4).toString("ascii")).toBe("icns");
    expect(icon.readUInt32BE(4)).toBe(icon.length);

    const types: string[] = [];
    let offset = 8;
    while (offset < icon.length) {
      const length = icon.readUInt32BE(offset + 4);
      expect(length).toBeGreaterThan(8);
      types.push(icon.subarray(offset, offset + 4).toString("ascii"));
      offset += length;
    }

    expect(offset).toBe(icon.length);
    expect(types).toEqual(MACOS_ICON_TYPES);
  });

  test("provides native Linux and tray PNG sizes", async () => {
    await Promise.all(
      LINUX_ICON_SIZES.map((size) =>
        expectPngSize(
          path.join(assetRoot, `icons/linux/${size}x${size}.png`),
          size,
        ),
      ),
    );
    await Promise.all([
      expectPngSize(path.join(assetRoot, "tray.png"), 32),
      expectPngSize(path.join(assetRoot, "tray@2x.png"), 64),
      expectPngSize(path.join(assetRoot, "trayTemplate.png"), 16),
      expectPngSize(path.join(assetRoot, "trayTemplate@2x.png"), 32),
    ]);
  });

  test("keeps the shared logo source transparent and canvas-based", async () => {
    const source = await readFile(
      path.join(projectRoot, "assets/mediago.svg"),
      "utf8",
    );
    expect(source).toContain('viewBox="0 0 512 512"');
    expect(source).not.toContain("<rect");
    expect(source).not.toContain("clipPath");
  });

  test("wires platform-specific assets into packaging and runtime", async () => {
    const [buildSource, appSource] = await Promise.all([
      readFile(
        path.join(projectRoot, "packages/tooling/src/electron/build.ts"),
        "utf8",
      ),
      readFile(path.join(projectRoot, "apps/electron/src/app.ts"), "utf8"),
    ]);

    expect(buildSource).toContain('icon: "../assets/icon.ico"');
    expect(buildSource).toContain('icon: "../assets/icon.icns"');
    expect(buildSource).toContain('icon: "../assets/icons/linux"');
    expect(appSource).toContain('from "../assets/tray.ico"');
    expect(appSource).toContain('from "../assets/trayTemplate@2x.png"');
  });
});
