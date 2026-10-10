import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LibraryService, type LibraryRuntime } from "./library.service";

const temporaryDirectories: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediago-library-"));
  temporaryDirectories.push(root);
  const mediaDir = path.join(root, "media");
  const userDataDir = path.join(root, "user-data");
  await mkdir(mediaDir);
  await mkdir(userDataDir);
  const dialogMock = {
    showOpenDialog: vi.fn(async () => ({
      canceled: false,
      filePaths: [path.join(root, "export")],
    })),
    showMessageBox: vi.fn(async () => ({
      response: 1,
      checkboxChecked: false,
    })),
  };
  const shellMock = {
    openPath: vi.fn(async () => ""),
    showItemInFolder: vi.fn(),
  };
  const service = (runtime: LibraryRuntime = {}) =>
    new LibraryService(userDataDir, {
      dialogs: dialogMock as unknown as LibraryRuntime["dialogs"],
      shell: shellMock as unknown as LibraryRuntime["shell"],
      ...runtime,
    });
  return { root, mediaDir, userDataDir, dialogMock, shellMock, service };
}

async function writeMp4(filePath: string, payload = "movie-data") {
  await writeFile(
    filePath,
    Buffer.concat([
      Buffer.alloc(4),
      Buffer.from("ftypisom"),
      Buffer.from(payload),
    ]),
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("LibraryService", () => {
  test("persists imports across service instances and deduplicates canonical paths", async () => {
    const f = await fixture();
    const mediaPath = path.join(f.mediaDir, "lesson.mp4");
    await writeMp4(mediaPath);
    const first = f.service();
    const added = await first.importFiles([mediaPath]);
    const duplicate = await first.importFiles([
      path.join(f.mediaDir, ".", "lesson.mp4"),
    ]);

    expect(added.added).toBe(1);
    expect(duplicate).toMatchObject({ added: 0, skipped: 1, rejected: [] });
    expect(await f.service().list()).toMatchObject({
      totalBytes: (await readFile(mediaPath)).byteLength,
      items: [
        {
          title: "lesson",
          path: mediaPath,
          safety: { status: "unscanned" },
          missing: false,
        },
      ],
    });
  });

  test("rejects executable masquerades and distinguishes a missing indexed file", async () => {
    const f = await fixture();
    const fake = path.join(f.mediaDir, "fake.mp4");
    const valid = path.join(f.mediaDir, "real.mp4");
    await writeFile(fake, Buffer.concat([Buffer.from("MZ"), Buffer.alloc(20)]));
    await writeMp4(valid);
    const service = f.service({
      scan: async () => ({
        status: "unavailable",
        trusted: false,
        message: "Scanner not configured in test",
      }),
    });
    const result = await service.importFiles([fake, valid]);
    await rm(valid);

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toMatch(/可执行文件/);
    expect((await service.list()).items[0]).toMatchObject({ missing: true });
  });

  test("keeps a corrupt index intact and fails closed", async () => {
    const f = await fixture();
    const indexPath = path.join(f.userDataDir, "library-v1.json");
    const original = "{ invalid json";
    await writeFile(indexPath, original);

    await expect(f.service().list()).rejects.toThrow(/索引损坏/);
    expect(await readFile(indexPath, "utf8")).toBe(original);

    const incompatible = JSON.stringify({
      version: 2,
      items: [],
      newerField: true,
    });
    await writeFile(indexPath, incompatible);
    await expect(f.service().list()).rejects.toThrow(/版本不兼容/);
    expect(await readFile(indexPath, "utf8")).toBe(incompatible);
  });

  test("limits metadata edits to the declared fields and removes only the index entry", async () => {
    const f = await fixture();
    const mediaPath = path.join(f.mediaDir, "keep.mp4");
    await writeMp4(mediaPath);
    const service = f.service();
    const [item] = (await service.importFiles([mediaPath])).items;
    const updated = await service.update(item!.id, {
      title: "Village film",
      tags: [" family ", "family"],
      screened: true,
    });
    await expect(
      service.update(item!.id, { path: "C:\\new.mp4" } as never),
    ).rejects.toThrow(/只能修改/);
    await service.remove(item!.id);

    expect(updated).toMatchObject({
      title: "Village film",
      tags: ["family"],
      screened: true,
    });
    expect(await readFile(mediaPath)).toBeTruthy();
    expect((await service.list()).items).toEqual([]);
  });

  test("never treats an ambiguous scanner result as clean and invalidates changed files", async () => {
    const f = await fixture();
    const mediaPath = path.join(f.mediaDir, "scan.mp4");
    await writeMp4(mediaPath, "before");
    const ambiguous = f.service({
      scan: async () => ({
        status: "clean",
        trusted: false,
        message: "exit code 0 only",
      }),
    });
    const [item] = (await ambiguous.importFiles([mediaPath])).items;
    expect((await ambiguous.scan(item!.id)).safety.status).toBe("unavailable");

    const trustedAdapter = f.service({
      scan: async () => ({ status: "clean", trusted: true }),
    });
    const clean = await trustedAdapter.scan(item!.id);
    expect(clean.safety.status).toBe("clean");
    await writeMp4(mediaPath, "after content changed");
    expect((await trustedAdapter.list()).items[0]?.safety.status).toBe(
      "unscanned",
    );
    expect((await trustedAdapter.list()).items[0]?.safety.status).toBe(
      "unscanned",
    );
  });

  test("keeps unavailable scans unhashed and accepts correctly framed transport streams", async () => {
    const f = await fixture();
    const tsPath = path.join(f.mediaDir, "broadcast.ts");
    const transportStream = Buffer.alloc(377);
    transportStream[0] = 0x47;
    transportStream[188] = 0x47;
    transportStream[376] = 0x47;
    await writeFile(tsPath, transportStream);
    const service = f.service({
      scan: async () => ({
        status: "unavailable",
        trusted: false,
        message: "Scanner not configured in test",
      }),
    });
    const [item] = (await service.importFiles([tsPath])).items;
    const scanned = await service.scan(item!.id);

    expect(scanned.safety).toMatchObject({ status: "unavailable" });
    expect(scanned.safety.fingerprint).toBeUndefined();
    expect((await service.list()).items).toHaveLength(1);
  });

  test("invalidates a scan if the file changes while the scanner is running", async () => {
    const f = await fixture();
    const mediaPath = path.join(f.mediaDir, "racing.mp4");
    await writeMp4(mediaPath, "before scan");
    const service = f.service({
      scan: async () => {
        await writeMp4(mediaPath, "changed during scan");
        return { status: "clean", trusted: true };
      },
    });
    const [item] = (await service.importFiles([mediaPath])).items;

    const result = await service.scan(item!.id);
    expect(result.safety).toMatchObject({
      status: "unavailable",
      message: expect.stringMatching(/扫描期间文件发生变化/),
    });
    expect(result.safety.fingerprint).toBeUndefined();
  });

  test("exports to a numbered name when the basename already exists", async () => {
    const f = await fixture();
    const mediaPath = path.join(f.mediaDir, "copy.mp4");
    const destination = path.join(f.root, "export");
    await mkdir(destination);
    await writeMp4(mediaPath, "source");
    await writeFile(path.join(destination, "copy.mp4"), "existing target");
    f.dialogMock.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [destination],
    });
    const service = f.service();
    const [item] = (await service.importFiles([mediaPath])).items;
    const result = await service.exportFiles([item!.id]);
    const numberedPath = path.join(destination, "copy (1).mp4");

    expect(result).toMatchObject({
      cancelled: false,
      results: [{ id: item!.id, copied: true, path: numberedPath }],
    });
    expect(await readFile(path.join(destination, "copy.mp4"), "utf8")).toBe(
      "existing target",
    );
    expect(await readFile(numberedPath)).toEqual(await readFile(mediaPath));
  });

  test("sequential exports choose free numbered names and preserve a same-directory source", async () => {
    const f = await fixture();
    const destination = path.join(f.root, "export");
    await mkdir(destination);
    const mediaPath = path.join(destination, "copy.mp4");
    await writeMp4(mediaPath, "source bytes");
    const sourceBytes = await readFile(mediaPath);
    f.dialogMock.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [destination],
    });
    const service = f.service();
    const [item] = (await service.importFiles([mediaPath])).items;

    const first = await service.exportFiles([item!.id]);
    const second = await service.exportFiles([item!.id]);
    const firstNumbered = path.join(destination, "copy (1).mp4");
    const secondNumbered = path.join(destination, "copy (2).mp4");

    expect(first.results[0]).toMatchObject({
      copied: true,
      path: firstNumbered,
    });
    expect(second.results[0]).toMatchObject({
      copied: true,
      path: secondNumbered,
    });
    expect(await readFile(mediaPath)).toEqual(sourceBytes);
    expect(await readFile(firstNumbered)).toEqual(sourceBytes);
    expect(await readFile(secondNumbered)).toEqual(sourceBytes);
  });

  test("reports partial export failures per item and continues with later files", async () => {
    const f = await fixture();
    const mediaPath = path.join(f.mediaDir, "copy.mp4");
    const destination = path.join(f.root, "export");
    await mkdir(destination);
    await writeMp4(mediaPath, "source");
    f.dialogMock.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [destination],
    });
    const service = f.service();
    const [item] = (await service.importFiles([mediaPath])).items;

    const result = await service.exportFiles(["missing-id", item!.id]);

    expect(result.results).toMatchObject([
      { id: "missing-id", copied: false, error: "片库条目不存在" },
      { id: item!.id, copied: true, path: path.join(destination, "copy.mp4") },
    ]);
    expect(await readFile(path.join(destination, "copy.mp4"))).toEqual(
      await readFile(mediaPath),
    );
  });

  test("reports export cancellation and blocks flagged files", async () => {
    const f = await fixture();
    const mediaPath = path.join(f.mediaDir, "blocked.mp4");
    await writeMp4(mediaPath);
    f.dialogMock.showOpenDialog.mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    });
    const service = f.service({
      scan: async () => ({
        status: "blocked",
        trusted: true,
        message: "Threat found",
      }),
    });
    const [item] = (await service.importFiles([mediaPath])).items;
    expect(await service.exportFiles([item!.id])).toMatchObject({
      cancelled: true,
      results: [],
    });
    await service.scan(item!.id);
    const blocked = await service.exportFiles([item!.id]);
    expect(blocked.results[0]).toMatchObject({
      copied: false,
      error: expect.stringMatching(/阻止/),
    });
    expect(f.dialogMock.showMessageBox).not.toHaveBeenCalled();
  });
});
