import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export interface DefenderScanResult {
  status: "clean" | "blocked" | "unavailable";
  trusted: boolean;
  message?: string;
}

export interface DefenderScannerDependencies {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  resolveExecutable?: () => Promise<string | undefined>;
  spawn?: (
    executable: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/** Runs an on-demand custom scan without applying remediation. */
export async function scanWithMicrosoftDefender(
  filePath: string,
  dependencies: DefenderScannerDependencies = {},
): Promise<DefenderScanResult> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "win32") {
    return unavailable("Microsoft Defender 文件扫描仅支持 Windows");
  }

  let executable: string | undefined;
  try {
    executable = dependencies.resolveExecutable
      ? await dependencies.resolveExecutable()
      : await resolveMpCmdRunPath(dependencies.env ?? process.env);
  } catch (error) {
    return unavailable(`无法定位 Microsoft Defender：${errorMessage(error)}`);
  }
  if (!executable)
    return unavailable("未找到 Microsoft Defender 命令行扫描程序");

  const args = [
    "-Scan",
    "-ScanType",
    "3",
    "-File",
    path.resolve(filePath),
    "-DisableRemediation",
  ];
  let result: ProcessResult;
  try {
    result = await runProcess(
      dependencies.spawn ?? spawn,
      executable,
      args,
      dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      dependencies.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    );
  } catch (error) {
    return unavailable(`无法启动 Microsoft Defender：${errorMessage(error)}`);
  }
  if (result.timedOut) return unavailable("Microsoft Defender 扫描超时");
  if (result.outputExceeded)
    return unavailable("Microsoft Defender 输出超过安全捕获上限");
  if (result.spawnError)
    return unavailable(
      `无法启动 Microsoft Defender：${errorMessage(result.spawnError)}`,
    );

  return interpretDefenderResult(
    path.resolve(filePath),
    result.code,
    result.stdout,
    result.stderr,
  );
}

export async function resolveMpCmdRunPath(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform;
    listDirectories?: (directory: string) => Promise<string[]>;
    isFile?: (filePath: string) => Promise<boolean>;
  } = {},
): Promise<string | undefined> {
  if ((options.platform ?? process.platform) !== "win32") return undefined;
  const listDirectories =
    options.listDirectories ??
    (async (directory) => {
      const entries = await readdir(directory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    });
  const isFile =
    options.isFile ??
    (async (filePath) => {
      try {
        return (await stat(filePath)).isFile();
      } catch {
        return false;
      }
    });

  const programData = env.ProgramData;
  if (programData) {
    const platformDirectory = path.join(
      programData,
      "Microsoft",
      "Windows Defender",
      "Platform",
    );
    try {
      const versions = (await listDirectories(platformDirectory))
        .filter((name) => /^\d+(?:\.\d+)+$/.test(name))
        .sort(compareVersionsDescending);
      for (const version of versions) {
        const candidate = path.join(platformDirectory, version, "MpCmdRun.exe");
        if (await isFile(candidate)) return candidate;
      }
    } catch {
      // Fall back to the fixed inbox location when the platform directory is unavailable.
    }
  }

  const programFiles = env.ProgramFiles;
  if (!programFiles) return undefined;
  const inboxCandidate = path.join(
    programFiles,
    "Windows Defender",
    "MpCmdRun.exe",
  );
  return (await isFile(inboxCandidate)) ? inboxCandidate : undefined;
}

export function interpretDefenderResult(
  filePath: string,
  exitCode: number | null,
  stdout: string,
  stderr: string,
): DefenderScanResult {
  const output = `${stdout}\n${stderr}`.replace(/\r\n?/g, "\n");
  if (hasExplicitDetection(output)) {
    return {
      status: "blocked",
      trusted: true,
      message: "Microsoft Defender 报告发现威胁",
    };
  }

  if (exitCode !== 0) {
    return unavailable(
      `Microsoft Defender 未成功完成（退出码 ${String(exitCode)}）`,
    );
  }
  if (
    /\b(?:error|failed|failure|cannot|could not|0x[0-9a-f]{8})\b/i.test(output)
  ) {
    return unavailable("Microsoft Defender 报告错误，扫描结果不明确");
  }

  const normalizedTarget = normalizeWindowsPath(filePath);
  const completed = output
    .split("\n")
    .some((line) => /^\s*scan finished\.\s*$/i.test(line));
  const explicitNoThreats = output.split("\n").some((line) => {
    const match = line.match(/^\s*Scanning\s+(.+?)\s+found no threats\.?\s*$/i);
    return (
      match !== null &&
      normalizeWindowsPath(stripQuotes(match[1] ?? "")) === normalizedTarget
    );
  });
  if (!completed || !explicitNoThreats) {
    return unavailable(
      "Microsoft Defender 输出未包含可识别的“已完成且未发现威胁”结果",
    );
  }
  return {
    status: "clean",
    trusted: true,
    message: "Microsoft Defender 已完成文件扫描，未报告威胁",
  };
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputExceeded: boolean;
  spawnError?: Error;
}

function runProcess(
  spawnProcess: NonNullable<DefenderScannerDependencies["spawn"]>,
  executable: string,
  args: string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(executable, args, {
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        outputExceeded: false,
        spawnError: asError(error),
      });
      return;
    }

    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let outputExceeded = false;
    let settled = false;
    const capture = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer | string,
    ): Buffer<ArrayBufferLike> => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(
        0,
        maxOutputBytes - stdout.length - stderr.length,
      );
      if (buffer.length > remaining) outputExceeded = true;
      return Buffer.concat([current, buffer.subarray(0, remaining)]);
    };
    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        ...result,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        outputExceeded,
      });
    };
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = capture(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = capture(stderr, chunk);
    });
    const timeout = setTimeout(
      () => {
        try {
          child.kill();
        } catch {
          /* Best-effort termination after the deadline. */
        }
        finish({
          code: null,
          stdout: "",
          stderr: "",
          timedOut: true,
          outputExceeded,
        });
      },
      Math.max(1, timeoutMs),
    );
    child.once("error", (error) => {
      finish({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        outputExceeded,
        spawnError: error,
      });
    });
    child.once("close", (code) => {
      finish({ code, stdout: "", stderr: "", timedOut: false, outputExceeded });
    });
  });
}

function hasExplicitDetection(output: string): boolean {
  return (
    /STARTING LIST OF DETECTED THREATS/i.test(output) ||
    /\b(?:found|detected|identified)\s+[1-9]\d*\s+threats?\b/i.test(output) ||
    /\b(?:found|detected)\s+threats?\b/i.test(output) ||
    /^\s*Threat\s+Name\s*:/im.test(output)
  );
}

function compareVersionsDescending(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function normalizeWindowsPath(value: string): string {
  return path.win32
    .normalize(value.trim())
    .replace(/\//g, "\\")
    .toLocaleLowerCase("en-US");
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function unavailable(message: string): DefenderScanResult {
  return { status: "unavailable", trusted: false, message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
