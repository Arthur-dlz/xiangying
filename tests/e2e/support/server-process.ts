import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPortFree } from "./ports.ts";
import { startManagedProcess, type ManagedProcess } from "./process.ts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SERVER_PORT = 9900;
const CORE_EXECUTABLE = path.join(
  REPOSITORY_ROOT,
  "apps/core/bin",
  `mediago-core${process.platform === "win32" ? ".exe" : ""}`,
);
const LOCAL_NO_PROXY =
  "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";

export interface StartedServerProcess {
  process: ManagedProcess;
  baseURL: string;
}

function serverEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      /^(?:http|https|all|ftp)_proxy$/i.test(key) ||
      /^no_proxy$/i.test(key)
    ) {
      delete environment[key];
    }
  }
  return {
    ...environment,
    NO_PROXY: LOCAL_NO_PROXY,
    no_proxy: LOCAL_NO_PROXY,
  };
}

export async function startServerProcess(
  runtimeRoot: string,
): Promise<StartedServerProcess> {
  await assertPortFree("127.0.0.1", SERVER_PORT, "MediaGo Web Core");
  const dataDir = path.join(runtimeRoot, "data");
  const logsDir = path.join(runtimeRoot, "logs");
  const downloadsDir = path.join(runtimeRoot, "downloads");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(logsDir, { recursive: true }),
    mkdir(downloadsDir, { recursive: true }),
  ]);
  const baseURL = `http://127.0.0.1:${SERVER_PORT}`;
  const managedProcess = await startManagedProcess({
    label: "MediaGo Web Core",
    command: CORE_EXECUTABLE,
    args: [
      `--port=${SERVER_PORT}`,
      "--enable-auth",
      "--log-level=debug",
      `--log-dir=${logsDir}`,
      `--local-dir=${downloadsDir}`,
      `--deps-dir=${path.join(REPOSITORY_ROOT, ".deps", `${os.platform()}-${os.arch()}`)}`,
      `--db-path=${path.join(dataDir, "mediago.db")}`,
      `--config-dir=${dataDir}`,
    ],
    cwd: REPOSITORY_ROOT,
    env: serverEnvironment(),
    readinessURL: `${baseURL}/healthy`,
  });
  return { process: managedProcess, baseURL };
}
