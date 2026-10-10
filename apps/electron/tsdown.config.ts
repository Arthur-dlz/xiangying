import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readMacOSDevelopmentRuntimeManifest } from "@mediago/tooling/electron/macos-development-runtime";
import { loadProfileEnv } from "@mediago/tooling/env";
import electron from "electron";
import { defineConfig } from "tsdown";
import copy from "rollup-plugin-copy";
import fs from "node:fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");
loadProfileEnv(projectRoot);
const isDev = process.env.NODE_ENV === "development";
const appRoot = path.resolve(projectRoot, "apps/electron/app");
const packageJsonPath = path.resolve(appRoot, "package.json");
const pkg = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));
const rendererDevServerUrl = "http://localhost:8500/";

async function resolveElectronExecutable(): Promise<string> {
  if (!isDev || process.platform !== "darwin") return String(electron);

  const cacheRoot = path.resolve(projectRoot, ".task/electron-dev");
  let runtime;
  try {
    runtime = await readMacOSDevelopmentRuntimeManifest(cacheRoot);
    await fs.access(runtime.executablePath);
  } catch (error) {
    throw new Error(
      "The signed macOS development runtime is missing. Start Electron through task dev:electron or task dev:all. " +
        formatError(error),
    );
  }
  return runtime.executablePath;
}

async function waitForRendererDevServer(
  url = rendererDevServerUrl,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status < 500) return;
      lastError = new Error("HTTP " + response.status);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    "Renderer development server did not become ready at " +
      url +
      ". " +
      formatError(lastError),
  );
}

const electronExecutable = await resolveElectronExecutable();

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ElectronApp {
  process: ChildProcessWithoutNullStreams | null = null;
  private generation = 0;

  private async start(generation: number) {
    await waitForRendererDevServer();
    if (generation !== this.generation) return;

    const args = [
      "--inspect=5858",
      "--trace-deprecation",
      path.resolve(__dirname, "./build/index.js"),
    ];

    this.process = spawn(electronExecutable, args);

    this.process.stdout.on("data", (data) => {
      process.stdout.write(String(data));
    });

    this.process.stderr.on("data", (data) => {
      process.stderr.write(String(data));
    });
  }

  restart() {
    const generation = ++this.generation;
    this.killProcess();
    void this.start(generation).catch((error: unknown) => {
      process.stderr.write(
        "[electron-dev] failed to start Electron: " +
          (error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)) +
          "\n",
      );
    });
  }

  kill() {
    this.generation += 1;
    this.killProcess();
  }

  private killProcess() {
    if (this.process?.pid) {
      if (process.platform === "win32") {
        process.kill(this.process.pid);
      } else {
        spawn("kill", ["-9", String(this.process.pid)]);
      }
      this.process = null;
    }
  }
}

const app = new ElectronApp();

export default defineConfig({
  outDir: "build",
  dts: false,
  fixedExtension: false,
  shims: true,
  deps: {
    alwaysBundle: [/.*/],
    onlyBundle: false,
    neverBundle: ["electron"],
  },
  minify: !isDev,
  sourcemap: isDev,
  define: {
    "process.env.NODE_ENV": JSON.stringify(
      process.env.NODE_ENV || "production",
    ),
    "process.env.APP_TARGET": JSON.stringify(
      process.env.APP_TARGET || "electron",
    ),
    "process.env.APP_VERSION": JSON.stringify(pkg.version),
    "process.env.APP_NAME": JSON.stringify(process.env.APP_NAME),
  },
  loader: {
    ".jpg": "asset",
    ".png": "asset",
    ".ico": "asset",
  },
  hooks: {
    "build:done": () => {
      if (isDev) {
        app.restart();
      }
    },
  },
  plugins: [
    isDev &&
      copy({
        targets: [{ src: "./dev-app-update.yml", dest: "build" }],
      }),
  ],
});
