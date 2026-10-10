import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  chmodSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { platform as osPlatform } from "node:os";
import { config } from "./config";

// ============================================================
// Utility Functions
// ============================================================

/**
 * Get executable file extension
 */
export function getExeExt(os: string = osPlatform()): string {
  return os === "win32" ? ".exe" : "";
}

/**
 * Create directory
 */
export function mkdir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Recursively delete a file or directory
 */
export function rmrf(path: string): void {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
}

/**
 * Copy a file or directory
 */
export function copyFile(src: string, dst: string): void {
  cpSync(src, dst, { recursive: true });
}

/**
 * Resolve a path under the release directory
 */
export function resolveReleasePath(...segments: string[]): string {
  return join(config.RELEASE_DIR, ...segments);
}

export interface RunCommandOptions {
  description?: string;
  env?: Record<string, string>;
  cwd?: string;
}

const childProcesses = new Set<ChildProcess>();
let cleanupRegistered = false;

function registerCleanup() {
  if (cleanupRegistered) {
    return;
  }
  cleanupRegistered = true;

  const cleanup = () => {
    for (const child of childProcesses) {
      if (!child.killed) {
        try {
          child.kill();
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
}

/**
 * Run a command (with live output)
 * @param command The command to execute
 * @param args Command arguments
 * @param options Options (description, env, cwd)
 */
export async function runCommand(
  command: string,
  args: string[] = [],
  options: RunCommandOptions = {},
): Promise<void> {
  registerCleanup();

  if (options.description) {
    console.log(`\n▶ ${options.description}: ${command} ${args.join(" ")}`);
  }

  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    // On Windows with shell mode, args containing spaces must be quoted
    // because Node.js joins them with spaces without escaping
    const escapedArgs = isWindows
      ? args.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg))
      : args;

    const child = spawn(command, escapedArgs, {
      cwd: options.cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        ...options.env,
      },
      shell: isWindows,
    });

    childProcesses.add(child);

    child.on("error", (error) => {
      childProcesses.delete(child);
      console.error(`执行命令失败: ${error.message}`);
      reject(error);
    });

    child.on("close", (code) => {
      childProcesses.delete(child);
      if (code !== 0) {
        const error = new Error(`命令执行失败，退出码: ${code}`);
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Set executable permissions on all files in a directory (Unix only)
 */
export function chmodExecutable(dir: string): void {
  if (osPlatform() === "win32" || !existsSync(dir)) {
    return;
  }
  const entries = readdirSync(dir);
  for (const entry of entries) {
    chmodSync(join(dir, entry), 0o755);
  }
}
