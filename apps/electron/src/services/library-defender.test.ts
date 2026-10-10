import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  interpretDefenderResult,
  resolveMpCmdRunPath,
  scanWithMicrosoftDefender,
} from "./library-defender";

function fakeChild(finish: (child: ChildProcess) => void): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  queueMicrotask(() => finish(child));
  return child;
}

describe("Microsoft Defender scan adapter", () => {
  test("uses the highest fixed platform installation and falls back to inbox", async () => {
    const platformRoot =
      "C:\\ProgramData\\Microsoft\\Windows Defender\\Platform";
    const latest = await resolveMpCmdRunPath(
      { ProgramData: "C:\\ProgramData", ProgramFiles: "C:\\Program Files" },
      {
        platform: "win32",
        listDirectories: async () => ["4.18.9.0", "4.18.10.2", "current"],
        isFile: async (candidate) =>
          candidate.endsWith("4.18.10.2\\MpCmdRun.exe"),
      },
    );
    expect(latest).toBe(
      path.win32.join(platformRoot, "4.18.10.2", "MpCmdRun.exe"),
    );

    const fallback = await resolveMpCmdRunPath(
      { ProgramFiles: "C:\\Program Files" },
      {
        platform: "win32",
        listDirectories: async () => {
          throw new Error("missing");
        },
        isFile: async () => true,
      },
    );
    expect(fallback).toBe(
      path.win32.join("C:\\Program Files", "Windows Defender", "MpCmdRun.exe"),
    );
    await expect(
      resolveMpCmdRunPath({}, { platform: "linux" }),
    ).resolves.toBeUndefined();
  });

  test("requires exit zero, completion, the target path, and explicit no-threat output", () => {
    const filePath = "C:\\Media Folder\\lesson.mp4";
    const explicitOutput = [
      "Scan starting...",
      "Scan finished.",
      `Scanning ${filePath} found no threats.`,
    ].join("\r\n");
    expect(
      interpretDefenderResult(filePath, 0, explicitOutput, ""),
    ).toMatchObject({
      status: "clean",
      trusted: true,
    });
    expect(
      interpretDefenderResult(filePath, 0, "Scan finished.", "").status,
    ).toBe("unavailable");
    expect(
      interpretDefenderResult(
        filePath,
        0,
        explicitOutput.replace(filePath, "C:\\Other.mp4"),
        "",
      ).status,
    ).toBe("unavailable");
    expect(
      interpretDefenderResult(filePath, 0, "扫描已完成，没有威胁。", "").status,
    ).toBe("unavailable");
    expect(
      interpretDefenderResult(filePath, 2, explicitOutput, "").status,
    ).toBe("unavailable");
  });

  test("passes fixed scan arguments without a shell and classifies explicit detections", async () => {
    const executable =
      "C:\\ProgramData\\Microsoft\\Windows Defender\\Platform\\4.18.1\\MpCmdRun.exe";
    const filePath = path.resolve("media with spaces.mp4");
    const spawnMock = vi.fn(
      (
        _executable: string,
        args: string[],
        options: { shell?: boolean; windowsHide?: boolean },
      ) =>
        fakeChild((child) => {
          child.stdout?.end(
            `Scan finished.\r\nScanning ${args[4]} found no threats.\r\n`,
          );
          child.stderr?.end();
          child.emit("close", 0, null);
          expect(options).toMatchObject({ shell: false, windowsHide: true });
        }),
    );
    const clean = await scanWithMicrosoftDefender(filePath, {
      platform: "win32",
      resolveExecutable: async () => executable,
      spawn: spawnMock as never,
    });
    expect(clean.status).toBe("clean");
    expect(spawnMock).toHaveBeenCalledWith(
      executable,
      ["-Scan", "-ScanType", "3", "-File", filePath, "-DisableRemediation"],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );

    const detected = interpretDefenderResult(
      filePath,
      2,
      "Threat Name: Trojan:Example/BadFile\r\n",
      "",
    );
    expect(detected).toMatchObject({ status: "blocked", trusted: true });
  });

  test("returns unavailable on process failure, timeout, and oversized output", async () => {
    const options = {
      platform: "win32" as const,
      resolveExecutable: async () => "C:\\Defender\\MpCmdRun.exe",
    };
    const failed = await scanWithMicrosoftDefender("C:\\clip.mp4", {
      ...options,
      spawn: (() =>
        fakeChild((child) =>
          child.emit("error", new Error("spawn denied")),
        )) as never,
    });
    expect(failed.status).toBe("unavailable");

    const timeoutSpawn = vi.fn(() => {
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      });
      return child;
    });
    const timedOut = await scanWithMicrosoftDefender("C:\\clip.mp4", {
      ...options,
      timeoutMs: 5,
      spawn: timeoutSpawn as never,
    });
    expect(timedOut).toMatchObject({
      status: "unavailable",
      message: expect.stringMatching(/超时/),
    });
    expect(timeoutSpawn.mock.results[0]?.value.kill).toHaveBeenCalled();

    const oversized = await scanWithMicrosoftDefender("C:\\clip.mp4", {
      ...options,
      maxOutputBytes: 8,
      spawn: (() =>
        fakeChild((child) => {
          child.stdout?.end("a very long output");
          child.stderr?.end();
          child.emit("close", 0, null);
        })) as never,
    });
    expect(oversized).toMatchObject({
      status: "unavailable",
      message: expect.stringMatching(/输出/),
    });
  });
});
