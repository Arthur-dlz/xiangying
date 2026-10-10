import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const MAX_IMPORT_PATHS = 500;
export const MAX_TITLE_LENGTH = 160;
export const MAX_TAGS = 30;
export const MAX_TAG_LENGTH = 40;

const MEDIA_EXTENSIONS = new Set([
  ".avi",
  ".flv",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".ogv",
  ".ts",
  ".webm",
  ".wmv",
]);

export interface ValidatedMedia {
  canonicalPath: string;
  bytes: number;
  title: string;
  modifiedAt: number;
}

export function canonicalPathKey(
  value: string,
  platform = process.platform,
): string {
  const normalized = path.normalize(value);
  return platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

export async function validateMediaFile(
  input: string,
): Promise<ValidatedMedia> {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error("请选择有效的本地文件");
  }

  const absolutePath = path.resolve(input);
  const linkStat = await lstat(absolutePath);
  if (!linkStat.isFile()) throw new Error("只允许导入普通文件");
  const canonicalPath = await realpath(absolutePath);
  const fileStat = await stat(canonicalPath);
  if (!fileStat.isFile()) throw new Error("目标不是普通文件");

  const extension = path.extname(canonicalPath).toLowerCase();
  if (!MEDIA_EXTENSIONS.has(extension)) {
    throw new Error("文件扩展名不是支持的视频格式");
  }
  if (fileStat.size < (extension === ".ts" ? 377 : 12))
    throw new Error("文件过小，缺少有效的视频容器头");

  const handle = await open(canonicalPath, "r");
  let header: Buffer;
  try {
    header = Buffer.alloc(extension === ".ts" ? 377 : 16);
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  if (isExecutableHeader(header))
    throw new Error("拒绝可执行文件或快捷方式伪装成视频");
  if (!matchesContainer(extension, header)) {
    throw new Error("文件内容与视频扩展名不匹配，或容器格式不受支持");
  }

  return {
    canonicalPath,
    bytes: fileStat.size,
    title:
      path.basename(canonicalPath, extension).slice(0, MAX_TITLE_LENGTH) ||
      "未命名视频",
    modifiedAt: fileStat.mtimeMs,
  };
}

function isExecutableHeader(header: Buffer): boolean {
  return (
    header.subarray(0, 2).toString("ascii") === "MZ" ||
    header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    header.subarray(0, 2).toString("ascii") === "#!" ||
    header.subarray(0, 4).toString("ascii") === "LNK\x00"
  );
}

function matchesContainer(extension: string, header: Buffer): boolean {
  const text = header.toString("ascii", 0, 16);
  if ([".mp4", ".m4v", ".mov"].includes(extension))
    return text.slice(4, 8) === "ftyp";
  if ([".mkv", ".webm"].includes(extension))
    return header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (extension === ".avi")
    return text.slice(0, 4) === "RIFF" && text.slice(8, 12) === "AVI ";
  if (extension === ".flv") return text.slice(0, 3) === "FLV";
  if ([".mpg", ".mpeg"].includes(extension)) {
    return (
      header.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0xba])) ||
      header.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0xb3]))
    );
  }
  if (extension === ".ogv") return text.slice(0, 4) === "OggS";
  if (extension === ".ts")
    return [0, 188, 376].every((offset) => header[offset] === 0x47);
  if (extension === ".wmv")
    return header
      .subarray(0, 16)
      .equals(Buffer.from("3026b2758e66cf11a6d900aa0062ce6c", "hex"));
  return false;
}

export async function fingerprintFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
