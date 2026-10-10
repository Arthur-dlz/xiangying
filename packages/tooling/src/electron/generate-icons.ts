import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const electronRoot = path.join(projectRoot, "apps/electron");
const assetRoot = path.join(electronRoot, "assets");
const sourceRoot = path.join(assetRoot, "source");
const linuxIconRoot = path.join(assetRoot, "icons/linux");

const WINDOWS_ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const WINDOWS_TRAY_ICON_SIZES = [16, 20, 24, 32, 40, 48];
const LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const MACOS_ICON_CHUNKS = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
] as const;

async function renderComposedIcon(
  markSource: string,
  output: string,
  size: number,
  placement: { left: number; top: number; width: number },
  backgroundSource?: string,
): Promise<void> {
  await mkdir(path.dirname(output), { recursive: true });
  const background = backgroundSource
    ? await sharp(backgroundSource, { density: 192 })
        .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
        .png()
        .toBuffer()
    : await sharp({
        create: {
          width: size,
          height: size,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .png()
        .toBuffer();
  const markSize = Math.round((placement.width / 1024) * size);
  const mark = await sharp(markSource, { density: 192 })
    .resize(markSize, markSize, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3,
    })
    .png()
    .toBuffer();
  await sharp(background)
    .composite([
      {
        input: mark,
        left: Math.round((placement.left / 1024) * size),
        top: Math.round((placement.top / 1024) * size),
      },
    ])
    .png()
    .toFile(output);
}

async function renderTrayIcon(
  input: string,
  output: string,
  canvasSize: number,
  monochrome: boolean,
): Promise<void> {
  const markSize = Math.round(canvasSize * 0.8125);
  const offset = Math.floor((canvasSize - markSize) / 2);
  let mark = sharp(input, { density: 192 })
    .resize(markSize, markSize, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3,
    })
    .ensureAlpha();
  if (monochrome) {
    mark = mark.linear([0, 0, 0, 1], [0, 0, 0, 0]);
  }
  const markBuffer = await mark.png().toBuffer();
  await sharp({
    create: {
      width: canvasSize,
      height: canvasSize,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: markBuffer, left: offset, top: offset }])
    .png()
    .toFile(output);
}

async function renderWindowsTrayIcon(
  input: string,
  output: string,
  canvasSize: number,
): Promise<void> {
  await renderTrayIcon(input, output, canvasSize, false);
}

async function writeWindowsIcon(
  output: string,
  images: readonly { size: number; file: string }[],
): Promise<void> {
  const payloads = await Promise.all(
    images.map(async ({ size, file }) => ({
      size,
      data: await readFile(file),
    })),
  );
  const directory = Buffer.alloc(6 + payloads.length * 16);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(payloads.length, 4);

  let payloadOffset = directory.length;
  payloads.forEach(({ size, data }, index) => {
    const entryOffset = 6 + index * 16;
    directory.writeUInt8(size === 256 ? 0 : size, entryOffset);
    directory.writeUInt8(size === 256 ? 0 : size, entryOffset + 1);
    directory.writeUInt8(0, entryOffset + 2);
    directory.writeUInt8(0, entryOffset + 3);
    directory.writeUInt16LE(1, entryOffset + 4);
    directory.writeUInt16LE(32, entryOffset + 6);
    directory.writeUInt32LE(data.length, entryOffset + 8);
    directory.writeUInt32LE(payloadOffset, entryOffset + 12);
    payloadOffset += data.length;
  });
  await writeFile(
    output,
    Buffer.concat([directory, ...payloads.map((it) => it.data)]),
  );
}

async function writeMacOSIcon(
  output: string,
  images: ReadonlyMap<number, string>,
): Promise<void> {
  const chunks = await Promise.all(
    MACOS_ICON_CHUNKS.map(async ([type, size]) => {
      const file = images.get(size);
      if (!file) throw new Error(`Missing macOS icon source for ${size}px`);
      const data = await readFile(file);
      const chunk = Buffer.alloc(8 + data.length);
      chunk.write(type, 0, "ascii");
      chunk.writeUInt32BE(chunk.length, 4);
      data.copy(chunk, 8);
      return chunk;
    }),
  );
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(
    8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    4,
  );
  await writeFile(output, Buffer.concat([header, ...chunks]));
}

async function generate(): Promise<void> {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "mediago-electron-icons-"),
  );
  try {
    const windowsSource = path.join(sourceRoot, "app-icon-windows.svg");
    const macOSSource = path.join(sourceRoot, "app-icon-macos.svg");
    const markSource = path.join(projectRoot, "assets/mediago.svg");

    const windowsImages = await Promise.all(
      WINDOWS_ICON_SIZES.map(async (size) => {
        const file = path.join(temporaryRoot, `windows-${size}.png`);
        await renderComposedIcon(
          markSource,
          file,
          size,
          { left: 266, top: 266, width: 492 },
          windowsSource,
        );
        return { size, file };
      }),
    );
    await writeWindowsIcon(path.join(assetRoot, "icon.ico"), windowsImages);
    await renderComposedIcon(
      markSource,
      path.join(assetRoot, "icon.png"),
      512,
      { left: 266, top: 266, width: 492 },
      windowsSource,
    );

    const windowsTrayImages = await Promise.all(
      WINDOWS_TRAY_ICON_SIZES.map(async (size) => {
        const file = path.join(temporaryRoot, `windows-tray-${size}.png`);
        await renderWindowsTrayIcon(markSource, file, size);
        return { size, file };
      }),
    );
    await writeWindowsIcon(path.join(assetRoot, "tray.ico"), windowsTrayImages);

    const macOSSizes = [...new Set(MACOS_ICON_CHUNKS.map(([, size]) => size))];
    const macOSImages = new Map(
      await Promise.all(
        macOSSizes.map(async (size) => {
          const file = path.join(temporaryRoot, `macos-${size}.png`);
          await renderComposedIcon(
            markSource,
            file,
            size,
            { left: 281, top: 273, width: 462 },
            macOSSource,
          );
          return [size, file] as const;
        }),
      ),
    );
    await writeMacOSIcon(path.join(assetRoot, "icon.icns"), macOSImages);

    await rm(linuxIconRoot, { recursive: true, force: true });
    await mkdir(linuxIconRoot, { recursive: true });
    await Promise.all(
      LINUX_ICON_SIZES.map((size) =>
        renderComposedIcon(
          markSource,
          path.join(linuxIconRoot, `${size}x${size}.png`),
          size,
          { left: 102, top: 102, width: 820 },
        ),
      ),
    );

    await Promise.all([
      renderTrayIcon(markSource, path.join(assetRoot, "tray.png"), 32, false),
      renderTrayIcon(
        markSource,
        path.join(assetRoot, "tray@2x.png"),
        64,
        false,
      ),
      renderTrayIcon(
        markSource,
        path.join(assetRoot, "trayTemplate.png"),
        16,
        true,
      ),
      renderTrayIcon(
        markSource,
        path.join(assetRoot, "trayTemplate@2x.png"),
        32,
        true,
      ),
    ]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await generate();
