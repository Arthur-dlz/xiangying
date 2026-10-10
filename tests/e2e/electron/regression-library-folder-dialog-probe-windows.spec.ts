import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { _electron, expect, test } from "@playwright/test";
import { scrubElectronEnvironment } from "../support/electron-network.ts";
import {
  readWindowsProcessIdentity,
  terminateOwnedWindowsProcess,
  waitForWindowsProcessExit,
} from "../support/xiangying-windows-process.ts";
import { waitForPortFree } from "../support/ports.ts";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const EXECUTABLE = path.join(
  ROOT,
  "apps/electron/release-slim/win-unpacked/乡映.exe",
);
const EXPECTED_EXE_SHA256 =
  "2AD5E2599471100B3F46482FB1997DC85352BFA9F2A879FED5766B6970352E45";
const CORE_PORT = Number(process.env.MEDIAGO_CORE_PORT || 39_739);
const FIXTURE_SOURCE = path.join(
  ROOT,
  "tests/media-service/public/v1/sample.mp4",
);
const EVIDENCE_DIRECTORY = path.join(ROOT, ".task/regression-20261006/library");
const PRIVATE_DIALOG_HELPER = path.join(
  ROOT,
  "packages/tooling/src/acceptance/regression-library-native-dialog.ps1",
);

test("alpha3 owned export folder dialog exposes a bounded read-only control tree", async () => {
  const runtimeRoot = await mkdtemp(
    path.join(tmpdir(), "xiangying-dialog-probe-"),
  );
  const fixturePath = path.join(
    runtimeRoot,
    "fixture",
    "library-dialog-probe.mp4",
  );
  let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  let identity: Awaited<ReturnType<typeof readWindowsProcessIdentity>>;
  try {
    await waitForPortFree("127.0.0.1", CORE_PORT, 1_000);
    await mkdir(path.dirname(fixturePath), { recursive: true });
    await mkdir(EVIDENCE_DIRECTORY, { recursive: true });
    const executable = path.resolve(
      process.env.XIANGYING_E2E_EXECUTABLE || EXECUTABLE,
    );
    expect(executable.toLocaleLowerCase("en-US")).toBe(
      path.resolve(EXECUTABLE).toLocaleLowerCase("en-US"),
    );
    expect(
      createHash("sha256")
        .update(await readFile(executable))
        .digest("hex")
        .toUpperCase(),
    ).toBe(EXPECTED_EXE_SHA256);
    await copyFile(FIXTURE_SOURCE, fixturePath);
    application = await _electron.launch({
      executablePath: executable,
      args: [],
      timeout: 30_000,
      env: {
        ...scrubElectronEnvironment(process.env),
        APP_NAME: "xiangying",
        APP_TARGET: "electron",
        NODE_ENV: "production",
        ELECTRON_IS_DEV: "0",
        MEDIAGO_RUNTIME_ROOT: runtimeRoot,
        MEDIAGO_CORE_PORT: String(CORE_PORT),
        APPDATA: path.join(runtimeRoot, "appdata"),
        LOCALAPPDATA: path.join(runtimeRoot, "localappdata"),
      },
    });
    const main = await application.evaluate(() => ({ pid: process.pid }));
    identity = await readWindowsProcessIdentity(main.pid);
    if (!identity)
      throw new Error("Candidate Electron main process identity unavailable");
    const page = application
      .windows()
      .find((candidate) =>
        /^xiangying:\/\/index\.html\/(?:library)?$/.test(candidate.url()),
      );
    if (!page) throw new Error("Candidate library page unavailable");
    await expect(page.getByRole("heading", { name: "我的片库" })).toBeVisible();
    await page.evaluate(async (mediaPath) => {
      const api = (
        window as unknown as {
          electron?: {
            library?: {
              importFiles(
                paths: string[],
                source?: "import" | "download",
              ): Promise<unknown>;
            };
          };
        }
      ).electron?.library;
      if (!api) throw new Error("Production preload library API unavailable");
      await api.importFiles([mediaPath], "import");
    }, fixturePath);
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "library-dialog-probe", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("checkbox", { name: "选择library-dialog-probe" })
      .check();
    await page.getByRole("button", { name: "导出所选" }).click();
    const powershell = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    const { stdout } = await execFileAsync(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        PRIVATE_DIALOG_HELPER,
        "-Action",
        "InspectTree",
        "-OwnerPid",
        String(main.pid),
      ],
      { timeout: 5_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
    );
    const observation = JSON.parse(stdout.trim()) as {
      action: string;
      ownerPid: number;
      inspectedOnly: boolean;
      roots: { processId: number; className: string }[];
      controls: {
        ProcessId: number;
        controlType: string;
        automationId: string;
        className: string;
        win32ControlId: number | null;
      }[];
    };
    expect(observation.action).toBe("InspectTree");
    expect(observation.ownerPid).toBe(main.pid);
    expect(observation.inspectedOnly).toBe(true);
    expect(observation.roots.length).toBeGreaterThan(0);
    expect(observation.roots.every((root) => root.processId === main.pid)).toBe(
      true,
    );
    await writeFile(
      path.join(EVIDENCE_DIRECTORY, "native-folder-dialog-tree.json"),
      JSON.stringify(observation, null, 2),
      "utf8",
    );
    expect(
      observation.controls.every((control) => control.ProcessId === main.pid),
    ).toBe(true);
  } finally {
    if (application) {
      await application
        .evaluate(({ app }) => app.quit())
        .catch(() => undefined);
      await application.close().catch(() => undefined);
    }
    if (identity && !(await waitForWindowsProcessExit(identity, 5_000))) {
      await terminateOwnedWindowsProcess(identity);
      expect(await waitForWindowsProcessExit(identity, 5_000)).toBe(true);
    }
    await waitForPortFree("127.0.0.1", CORE_PORT, 10_000);
    await rm(runtimeRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 250,
    });
  }
});
