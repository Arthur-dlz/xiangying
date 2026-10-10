import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LibraryItem } from "@mediago/common";

const INDEX_VERSION = 1;

interface LibraryIndex {
  version: number;
  items: LibraryItem[];
}

export class LibraryIndexStore {
  readonly indexPath: string;

  constructor(userDataPath: string) {
    this.indexPath = path.join(userDataPath, "library-v1.json");
  }

  async read(): Promise<LibraryItem[]> {
    let raw: string;
    try {
      raw = await readFile(this.indexPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`片库索引损坏，原文件已保留：${this.indexPath}`);
    }

    if (!isLibraryIndex(parsed)) {
      throw new Error(
        `片库索引版本不兼容或字段无效，原文件已保留：${this.indexPath}`,
      );
    }
    return parsed.items;
  }

  async write(items: LibraryItem[]): Promise<void> {
    await mkdir(path.dirname(this.indexPath), { recursive: true });
    const temporaryPath = `${this.indexPath}.${randomUUID()}.tmp`;
    const contents = `${JSON.stringify({ version: INDEX_VERSION, items }, null, 2)}\n`;
    try {
      await writeFile(temporaryPath, contents, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporaryPath, this.indexPath);
    } catch (error) {
      const { rm } = await import("node:fs/promises");
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function isLibraryIndex(value: unknown): value is LibraryIndex {
  if (
    !isRecordWithKeys(value, ["version", "items"]) ||
    value.version !== INDEX_VERSION ||
    !Array.isArray(value.items)
  )
    return false;
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const item of value.items) {
    if (
      !isLibraryItem(item) ||
      ids.has(item.id) ||
      paths.has(item.path.toLocaleLowerCase("en-US"))
    )
      return false;
    ids.add(item.id);
    paths.add(item.path.toLocaleLowerCase("en-US"));
  }
  return true;
}

function isLibraryItem(value: unknown): value is LibraryItem {
  if (
    !isRecordWithKeys(value, [
      "id",
      "title",
      "path",
      "bytes",
      "category",
      "tags",
      "screened",
      "source",
      "addedAt",
      "updatedAt",
      "safety",
      "missing",
    ])
  )
    return false;
  const safety = value.safety;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.title === "string" &&
    typeof value.path === "string" &&
    path.isAbsolute(value.path) &&
    Number.isSafeInteger(value.bytes) &&
    (value.bytes as number) >= 0 &&
    ["movie", "documentary", "children", "other"].includes(
      String(value.category),
    ) &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === "string") &&
    typeof value.screened === "boolean" &&
    ["import", "download"].includes(String(value.source)) &&
    isIsoDate(value.addedAt) &&
    isIsoDate(value.updatedAt) &&
    isRecordWithKeys(safety, [
      "status",
      "checkedAt",
      "message",
      "fingerprint",
    ]) &&
    ["unscanned", "clean", "blocked", "unavailable"].includes(
      String(safety.status),
    ) &&
    (safety.checkedAt === undefined || isIsoDate(safety.checkedAt)) &&
    (safety.message === undefined || typeof safety.message === "string") &&
    (safety.fingerprint === undefined ||
      /^[a-f\d]{64}$/i.test(String(safety.fingerprint))) &&
    typeof value.missing === "boolean"
  );
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isRecordWithKeys(
  value: unknown,
  allowedKeys: string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowedKeys.includes(key))
  );
}
