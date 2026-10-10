import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { provide } from "@inversifyjs/binding-decorators";
import type { CLIInstallOptions, CLIInstallStatus } from "@mediago/common";
import { injectable } from "inversify";
import { resolveCLIBinary } from "../utils/binaryResolver";

const execFileAsync = promisify(execFile);
const MANAGED_BLOCK_START = "# >>> MediaGo CLI >>>";
const MANAGED_BLOCK_END = "# <<< MediaGo CLI <<<";

@injectable()
@provide()
export class CLIInstaller {
  private readonly installDir = path.join(
    os.homedir(),
    ".mediago-community",
    "bin",
  );

  private readonly binaryPath = path.join(
    this.installDir,
    process.platform === "win32" ? "mediago.exe" : "mediago",
  );

  private readonly configPath = path.join(this.installDir, "cli.json");

  async getStatus(): Promise<CLIInstallStatus> {
    const installed = await fileExists(this.binaryPath);
    const sourceExists = await fileExists(resolveCLIBinary());
    const updateAvailable =
      installed && sourceExists
        ? (await hashFile(this.binaryPath)) !==
          (await hashFile(resolveCLIBinary()))
        : false;

    return {
      installed,
      updateAvailable,
      inPath: await this.isPathConfigured(),
      binaryPath: this.binaryPath,
      configPath: this.configPath,
    };
  }

  async install(options: CLIInstallOptions): Promise<CLIInstallStatus> {
    const source = resolveCLIBinary();
    if (!(await fileExists(source))) {
      throw new Error(
        `Bundled MediaGo CLI was not found at ${source}. Run the core build first.`,
      );
    }

    await fs.mkdir(this.installDir, { recursive: true });
    await fs.copyFile(source, this.binaryPath);
    if (process.platform !== "win32") {
      await fs.chmod(this.binaryPath, 0o755);
    }

    if (!(await fileExists(this.configPath))) {
      const config = {
        baseUrl: options.baseUrl || "http://127.0.0.1:39719",
        apiKey: options.apiKey || "",
      };
      await fs.writeFile(
        this.configPath,
        `${JSON.stringify(config, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    }

    if (process.platform === "win32") {
      await this.ensureWindowsUserPath();
    } else {
      await this.ensureUnixPath();
    }

    return this.getStatus();
  }

  private async isPathConfigured(): Promise<boolean> {
    if (process.platform === "win32") {
      const userPath = await this.getWindowsUserPath();
      const target = normalizePathEntry(this.installDir).toLowerCase();
      return splitPath(userPath).some(
        (item) => normalizePathEntry(item).toLowerCase() === target,
      );
    }

    if (splitPath(process.env.PATH || "").includes(this.installDir)) {
      return true;
    }
    const profile = this.getUnixProfile();
    const content = await readFileIfExists(profile);
    return (
      content.includes(MANAGED_BLOCK_START) && content.includes(this.installDir)
    );
  }

  private async getWindowsUserPath(): Promise<string> {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Environment]::GetEnvironmentVariable('Path', 'User')",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    return stdout.trim();
  }

  private async ensureWindowsUserPath(): Promise<void> {
    const script = [
      "$target = $env:MEDIAGO_CLI_DIR",
      "$current = [Environment]::GetEnvironmentVariable('Path', 'User')",
      "$items = @($current -split ';' | Where-Object { $_ -ne '' })",
      "$exists = $items | Where-Object { $_.TrimEnd('\\') -ieq $target.TrimEnd('\\') }",
      "if (-not $exists) {",
      "  $updated = (@($items) + $target) -join ';'",
      "  [Environment]::SetEnvironmentVariable('Path', $updated, 'User')",
      "}",
    ].join("\n");

    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, MEDIAGO_CLI_DIR: this.installDir },
      },
    );
  }

  private getUnixProfile(): string {
    const shell = process.env.SHELL || "";
    if (shell.endsWith("/zsh")) {
      return path.join(os.homedir(), ".zprofile");
    }
    if (shell.endsWith("/fish")) {
      return path.join(os.homedir(), ".config", "fish", "config.fish");
    }
    return path.join(os.homedir(), ".profile");
  }

  private async ensureUnixPath(): Promise<void> {
    const profile = this.getUnixProfile();
    await fs.mkdir(path.dirname(profile), { recursive: true });
    const current = await readFileIfExists(profile);
    const isFish = profile.endsWith("config.fish");
    const command = isFish
      ? `set -gx PATH '${escapeSingleQuotes(this.installDir)}' $PATH`
      : `export PATH='${escapeSingleQuotes(this.installDir)}':"$PATH"`;
    const block = `${MANAGED_BLOCK_START}\n${command}\n${MANAGED_BLOCK_END}`;
    const pattern = new RegExp(
      `${escapeRegExp(MANAGED_BLOCK_START)}[\\s\\S]*?${escapeRegExp(MANAGED_BLOCK_END)}`,
      "m",
    );
    const next = pattern.test(current)
      ? current.replace(pattern, block)
      : `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${block}\n`;
    await fs.writeFile(profile, next, "utf8");
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function readFileIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function splitPath(value: string): string[] {
  return value
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeSingleQuotes(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function normalizePathEntry(value: string): string {
  return path.normalize(value).replace(/[\\/]+$/, "");
}
