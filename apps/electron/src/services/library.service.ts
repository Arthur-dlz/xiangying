import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { copyFile, lstat, stat } from "node:fs/promises";
import path from "node:path";
import { provide } from "@inversifyjs/binding-decorators";
import type {
  LibraryCategory,
  LibraryExportResult,
  LibraryImportResult,
  LibraryItem,
  LibraryItemPatch,
  LibrarySafety,
  LibrarySnapshot,
} from "@mediago/common";
import type {
  dialog as ElectronDialog,
  shell as ElectronShell,
} from "electron";
import { injectable, unmanaged } from "inversify";
import { scanWithMicrosoftDefender } from "./library-defender";
import { LibraryIndexStore } from "./library-index";
import {
  canonicalPathKey,
  fingerprintFile,
  MAX_IMPORT_PATHS,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  MAX_TITLE_LENGTH,
  validateMediaFile,
} from "./library-files";

export interface LibraryScanOutcome {
  status: "clean" | "blocked" | "unavailable";
  trusted: boolean;
  message?: string;
}

export interface LibraryRuntime {
  dialogs?: Pick<typeof ElectronDialog, "showOpenDialog" | "showMessageBox">;
  shell?: Pick<typeof ElectronShell, "openPath" | "showItemInFolder">;
  scan?: (filePath: string) => Promise<LibraryScanOutcome>;
  now?: () => Date;
  idFactory?: () => string;
}

const UNSCANNED_WARNING = "此文件尚未获得可信的安全扫描结果。仍要继续吗？";
const MAX_EXPORT_NAME_ATTEMPTS = 1000;

@injectable()
@provide()
export class LibraryService {
  private store?: LibraryIndexStore;
  private readonly runtime: LibraryRuntime;
  private readonly userDataPath?: string;
  private pendingMutation: Promise<unknown> = Promise.resolve();

  constructor(
    @unmanaged() userDataPath?: string,
    @unmanaged() runtime: LibraryRuntime = {},
  ) {
    this.userDataPath = userDataPath;
    this.runtime = runtime;
  }

  async list(): Promise<LibrarySnapshot> {
    return this.exclusive(async () => {
      const store = await this.getStore();
      const items = await store.read();
      let invalidatedSafety = false;
      const snapshotItems = await Promise.all(
        items.map(async (item) => {
          const current = await this.refreshSafetyIfChanged(item);
          if (current !== item) invalidatedSafety = true;
          let missing = false;
          try {
            const currentStat = await lstat(item.path);
            missing = !currentStat.isFile();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              missing = true;
            else throw error;
          }
          return { ...current, missing };
        }),
      );
      if (invalidatedSafety) await store.write(snapshotItems);
      return {
        items: snapshotItems,
        totalBytes: snapshotItems.reduce(
          (sum, item) => sum + (item.missing ? 0 : item.bytes),
          0,
        ),
      };
    });
  }

  async importFiles(
    paths: string[],
    source: "import" | "download" = "import",
  ): Promise<LibraryImportResult> {
    if (!Array.isArray(paths)) throw new Error("文件路径列表无效");
    if (paths.length > MAX_IMPORT_PATHS)
      throw new Error(`一次最多导入 ${MAX_IMPORT_PATHS} 个文件`);
    if (source !== "import" && source !== "download")
      throw new Error("片库来源无效");

    return this.exclusive(async () => {
      const store = await this.getStore();
      const items = await store.read();
      const knownPaths = new Set(
        items.map((item) => canonicalPathKey(item.path)),
      );
      const rejected: LibraryImportResult["rejected"] = [];
      let skipped = 0;
      const added: LibraryItem[] = [];
      for (const inputPath of paths) {
        try {
          const media = await validateMediaFile(inputPath);
          const key = canonicalPathKey(media.canonicalPath);
          if (knownPaths.has(key)) {
            skipped += 1;
            continue;
          }
          const now = this.timestamp();
          const item: LibraryItem = {
            id: this.runtime.idFactory?.() ?? randomUUID(),
            title: media.title,
            path: media.canonicalPath,
            bytes: media.bytes,
            category: "other",
            tags: [],
            screened: false,
            source,
            addedAt: now,
            updatedAt: now,
            safety: { status: "unscanned" },
            missing: false,
          };
          items.push(item);
          added.push(item);
          knownPaths.add(key);
        } catch (error) {
          rejected.push({
            path: typeof inputPath === "string" ? inputPath : String(inputPath),
            reason: errorMessage(error),
          });
        }
      }
      if (added.length > 0) await store.write(items);
      return { added: added.length, skipped, rejected, items: added };
    });
  }

  async update(id: string, patch: LibraryItemPatch): Promise<LibraryItem> {
    return this.exclusive(async () => {
      const store = await this.getStore();
      const items = await store.read();
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("片库条目不存在");
      const normalized = normalizePatch(patch);
      const updated = {
        ...items[index],
        ...normalized,
        updatedAt: this.timestamp(),
      };
      items[index] = updated;
      await store.write(items);
      return updated;
    });
  }

  async remove(id: string): Promise<void> {
    return this.exclusive(async () => {
      const store = await this.getStore();
      const items = await store.read();
      const remaining = items.filter((item) => item.id !== id);
      if (remaining.length === items.length) throw new Error("片库条目不存在");
      await store.write(remaining);
    });
  }

  async scan(id: string): Promise<LibraryItem> {
    return this.exclusive(async () => {
      const store = await this.getStore();
      const items = await store.read();
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("片库条目不存在");
      const item = await this.requireValidMedia(items[index]);
      const beforeScan = await stat(item.path);
      let outcome: LibraryScanOutcome;
      try {
        outcome = this.runtime.scan
          ? await this.runtime.scan(item.path)
          : await scanWithMicrosoftDefender(item.path);
      } catch (error) {
        outcome = {
          status: "unavailable",
          trusted: false,
          message: `扫描器不可用：${errorMessage(error)}`,
        };
      }
      let fingerprint: string | undefined;
      if (outcome.trusted && outcome.status !== "unavailable") {
        const afterScan = await stat(item.path);
        if (!sameFileMetadata(beforeScan, afterScan)) {
          outcome = {
            status: "unavailable",
            trusted: false,
            message: "扫描期间文件发生变化，扫描结果已作废",
          };
        } else {
          fingerprint = await fingerprintFile(item.path);
          const afterFingerprint = await stat(item.path);
          if (!sameFileMetadata(afterScan, afterFingerprint)) {
            fingerprint = undefined;
            outcome = {
              status: "unavailable",
              trusted: false,
              message: "记录文件指纹期间文件发生变化，扫描结果已作废",
            };
          }
        }
      }
      const safety: LibrarySafety = {
        status: outcome.trusted ? outcome.status : "unavailable",
        checkedAt: this.timestamp(),
        ...(fingerprint ? { fingerprint } : {}),
        message:
          outcome.message ??
          (outcome.trusted ? undefined : "扫描结果不明确，不能确认文件安全"),
      };
      const updated = {
        ...item,
        safety,
        bytes: (await stat(item.path)).size,
        updatedAt: this.timestamp(),
      };
      items[index] = updated;
      await store.write(items);
      return updated;
    });
  }

  async play(id: string): Promise<void> {
    return this.exclusive(async () => {
      const item = await this.requireActionable(id, "播放");
      const error = await (await this.getShell()).openPath(item.path);
      if (error) throw new Error(`无法打开系统播放器：${error}`);
    });
  }

  async reveal(id: string): Promise<void> {
    return this.exclusive(async () => {
      const item = await this.requireActionable(id, "打开文件位置");
      (await this.getShell()).showItemInFolder(item.path);
    });
  }

  async exportFiles(ids: string[]): Promise<LibraryExportResult> {
    if (!Array.isArray(ids)) throw new Error("导出条目列表无效");
    if (ids.length > MAX_IMPORT_PATHS)
      throw new Error(`一次最多导出 ${MAX_IMPORT_PATHS} 个文件`);
    return this.exclusive(async () => {
      const selection = await (
        await this.getDialogs()
      ).showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        title: "选择导出目录",
      });
      if (selection.canceled || selection.filePaths.length === 0)
        return { cancelled: true, results: [] };
      const destination = path.resolve(selection.filePaths[0]);
      const items = await (await this.getStore()).read();
      const distinctIds = [...new Set(ids)];
      const results: LibraryExportResult["results"] = [];
      for (const id of distinctIds) {
        const item = items.find((entry) => entry.id === id);
        if (!item) {
          results.push({ id, copied: false, error: "片库条目不存在" });
          continue;
        }
        try {
          const actionable = await this.requireActionableItem(item, "导出");
          const targetPath = await this.copyToAvailableName(
            actionable.path,
            destination,
          );
          results.push({ id, copied: true, path: targetPath });
        } catch (error) {
          results.push({ id, copied: false, error: errorMessage(error) });
        }
      }
      return { cancelled: false, destination, results };
    });
  }

  private async requireActionable(
    id: string,
    action: string,
  ): Promise<LibraryItem> {
    const items = await (await this.getStore()).read();
    const item = items.find((entry) => entry.id === id);
    if (!item) throw new Error("片库条目不存在");
    return this.requireActionableItem(item, action);
  }

  private async copyToAvailableName(
    sourcePath: string,
    destination: string,
  ): Promise<string> {
    const { name, ext } = path.parse(path.basename(sourcePath));
    for (let attempt = 0; attempt < MAX_EXPORT_NAME_ATTEMPTS; attempt += 1) {
      const filename =
        attempt === 0 ? `${name}${ext}` : `${name} (${attempt})${ext}`;
      const targetPath = path.join(destination, filename);
      try {
        await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
        return targetPath;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new Error(
      "可用文件名过多，无法安全导出；请更换导出目录或清理同名文件后重试",
    );
  }

  private async requireActionableItem(
    item: LibraryItem,
    action: string,
  ): Promise<LibraryItem> {
    const current = await this.requireValidMedia(item);
    if (current.safety.status === "blocked")
      throw new Error("安全扫描已阻止此文件，不能播放或导出");
    if (current.safety.status !== "clean") {
      const result = await (
        await this.getDialogs()
      ).showMessageBox({
        type: "warning",
        buttons: ["取消", `仍要${action}`],
        defaultId: 0,
        cancelId: 0,
        title: "安全状态未确认",
        message: UNSCANNED_WARNING,
        detail: current.safety.message,
      });
      if (result.response !== 1) throw new Error("用户取消操作");
    }
    return current;
  }

  private async requireValidMedia(item: LibraryItem): Promise<LibraryItem> {
    const media = await validateMediaFile(item.path);
    if (canonicalPathKey(media.canonicalPath) !== canonicalPathKey(item.path)) {
      throw new Error("文件路径身份已变化，请重新导入");
    }
    let current = item;
    if (item.safety.fingerprint) {
      const fileStat = await stat(media.canonicalPath);
      const checkedAt = item.safety.checkedAt
        ? Date.parse(item.safety.checkedAt)
        : 0;
      const needsHash =
        fileStat.size !== item.bytes ||
        fileStat.mtimeMs > checkedAt ||
        fileStat.ctimeMs > checkedAt;
      const currentFingerprint = needsHash
        ? await fingerprintFile(media.canonicalPath)
        : item.safety.fingerprint;
      if (currentFingerprint !== item.safety.fingerprint) {
        current = {
          ...item,
          bytes: media.bytes,
          safety: { status: "unscanned" },
          updatedAt: this.timestamp(),
        };
        await this.replaceStoredItem(current);
      } else if (needsHash) {
        current = {
          ...item,
          bytes: media.bytes,
          safety: { ...item.safety, checkedAt: this.timestamp() },
        };
        await this.replaceStoredItem(current);
      }
    }
    return { ...current, bytes: media.bytes, missing: false };
  }

  private async refreshSafetyIfChanged(
    item: LibraryItem,
  ): Promise<LibraryItem> {
    if (!item.safety.fingerprint) return item;
    try {
      const currentStat = await stat(item.path);
      if (!currentStat.isFile())
        return { ...item, safety: { status: "unscanned" } };
      const checkedAt = item.safety.checkedAt
        ? Date.parse(item.safety.checkedAt)
        : 0;
      if (
        currentStat.size === item.bytes &&
        currentStat.mtimeMs <= checkedAt &&
        currentStat.ctimeMs <= checkedAt
      )
        return item;
      const fingerprint = await fingerprintFile(item.path);
      if (fingerprint === item.safety.fingerprint) {
        return {
          ...item,
          bytes: currentStat.size,
          safety: { ...item.safety, checkedAt: this.timestamp() },
        };
      }
      return {
        ...item,
        bytes: currentStat.size,
        safety: { status: "unscanned" },
        updatedAt: this.timestamp(),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return item;
      throw error;
    }
  }

  private async replaceStoredItem(updated: LibraryItem): Promise<void> {
    const store = await this.getStore();
    const items = await store.read();
    const index = items.findIndex((item) => item.id === updated.id);
    if (index >= 0) {
      items[index] = updated;
      await store.write(items);
    }
  }

  private timestamp(): string {
    return (this.runtime.now?.() ?? new Date()).toISOString();
  }

  private async getStore(): Promise<LibraryIndexStore> {
    if (!this.store) {
      let dataPath = this.userDataPath;
      if (!dataPath)
        dataPath = (await import("electron")).app.getPath("userData");
      this.store = new LibraryIndexStore(dataPath);
    }
    return this.store;
  }

  private async getDialogs(): Promise<NonNullable<LibraryRuntime["dialogs"]>> {
    return this.runtime.dialogs ?? (await import("electron")).dialog;
  }

  private async getShell(): Promise<NonNullable<LibraryRuntime["shell"]>> {
    return this.runtime.shell ?? (await import("electron")).shell;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pendingMutation.then(operation, operation);
    this.pendingMutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function normalizePatch(patch: LibraryItemPatch): LibraryItemPatch {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch))
    throw new Error("修改内容无效");
  const allowed = new Set(["title", "category", "tags", "screened"]);
  if (Object.keys(patch).some((key) => !allowed.has(key)))
    throw new Error("只能修改标题、分类、标签和已放映状态");
  const result: LibraryItemPatch = {};
  if (patch.title !== undefined) {
    if (typeof patch.title !== "string") throw new Error("标题格式无效");
    const title = patch.title.trim();
    if (title.length === 0 || title.length > MAX_TITLE_LENGTH)
      throw new Error(`标题长度需为 1 至 ${MAX_TITLE_LENGTH} 个字符`);
    result.title = title;
  }
  if (patch.category !== undefined) {
    if (!["movie", "documentary", "children", "other"].includes(patch.category))
      throw new Error("分类无效");
    result.category = patch.category as LibraryCategory;
  }
  if (patch.tags !== undefined) {
    if (
      !Array.isArray(patch.tags) ||
      patch.tags.length > MAX_TAGS ||
      patch.tags.some(
        (tag) => typeof tag !== "string" || tag.trim().length > MAX_TAG_LENGTH,
      )
    ) {
      throw new Error(
        `标签最多 ${MAX_TAGS} 个，每个不超过 ${MAX_TAG_LENGTH} 个字符`,
      );
    }
    result.tags = [
      ...new Set(patch.tags.map((tag) => tag.trim()).filter(Boolean)),
    ];
  }
  if (patch.screened !== undefined) {
    if (typeof patch.screened !== "boolean") throw new Error("已放映状态无效");
    result.screened = patch.screened;
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameFileMetadata(left: Stats, right: Stats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}
