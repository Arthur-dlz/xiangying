import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  _electron,
  expect,
  test,
  type ElectronApplication,
} from "@playwright/test";
import { scrubElectronEnvironment } from "../support/electron-network.ts";
import { waitForPortFree } from "../support/ports.ts";
import {
  readWindowsProcessIdentity,
  terminateOwnedWindowsProcess,
  waitForWindowsProcessExit,
  type WindowsProcessIdentity,
} from "../support/xiangying-windows-process.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const EXECUTABLE = path.join(
  ROOT,
  "apps/electron/release-slim/win-unpacked/乡映.exe",
);
const EXPECTED_EXE_SHA256 =
  "2AD5E2599471100B3F46482FB1997DC85352BFA9F2A879FED5766B6970352E45";
const CORE_PORT = Number(process.env.MEDIAGO_CORE_PORT || 39_739);
const SAMPLE =
  process.env.XIANGYING_E2E_NATIVE_MEDIA ||
  path.join(ROOT, "tests/media-service/public/v1/sample.mp4");
const EVIDENCE_DIRECTORY = path.join(
  ROOT,
  ".task/regression-20261006/library/native",
);
const UIA_SCRIPT = path.join(
  ROOT,
  "packages/tooling/src/acceptance/xiangying-native-dialog.ps1",
);
const execFileAsync = promisify(execFile);

test.skip(process.platform !== "win32", "Windows native UI acceptance");

interface NativeObservation {
  processes: { pid: number; name: string; fixtureVisible: boolean }[];
  windows: {
    pid: number;
    processName: string;
    fixtureVisible: boolean;
    fixtureSelected: boolean;
  }[];
  selectedFiles: { pid: number; name: string; selected: boolean }[];
  mp4ProgId?: string;
  fixtureName?: string;
}

async function runUia(
  action: "ChooseFile" | "ChooseFolder" | "Click" | "Observe" | "Describe",
  ownerPid: number,
  values: { value?: string; names?: string[]; fileName?: string } = {},
): Promise<string> {
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    UIA_SCRIPT,
    "-Action",
    action,
    "-OwnerPid",
    String(ownerPid),
  ];
  if (values.value) args.push("-Value", values.value);
  if (values.names) args.push("-Names", values.names.join("|"));
  if (values.fileName) args.push("-FileName", values.fileName);
  const result = await execFileAsync("powershell.exe", args, {
    timeout: 30_000,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function actWhenReady(
  action: "ChooseFile" | "ChooseFolder" | "Click",
  ownerPid: number,
  values: { value?: string; names?: string[] },
  timeoutMs = 75_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await runUia(action, ownerPid, values);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  const description = await runUia("Describe", ownerPid).catch((error) =>
    String(error),
  );
  await writeFile(
    path.join(EVIDENCE_DIRECTORY, `native-dialog-failure-${Date.now()}.json`),
    description,
  );
  throw new Error(`Native dialog action ${action} did not complete`, {
    cause: lastError,
  });
}

async function observeWindows(
  ownerPid: number,
  fixturePath: string,
): Promise<NativeObservation> {
  const raw = await runUia("Observe", ownerPid, {
    fileName: path.basename(fixturePath),
  });
  return JSON.parse(raw) as NativeObservation;
}

// oxlint-disable-next-line no-empty-pattern -- Playwright requires the fixture parameter to be destructured.
test("原生文件导入、未扫描确认、系统播放/定位和冲突保护导出", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const runtimeRoot = await mkdtemp(
    path.join(tmpdir(), "xiangying-native-e2e-"),
  );
  const unique = `xiangying-native-${Date.now()}`;
  const sourceDirectory = path.join(runtimeRoot, "source");
  const exportDirectory = path.join(runtimeRoot, "export-target");
  const cancelDirectory = path.join(runtimeRoot, "cancel-target");
  const successfulExportDirectory = path.join(runtimeRoot, "successful-export");
  const fixturePath = path.join(sourceDirectory, `${unique}.mp4`);
  const targetPath = path.join(exportDirectory, `${unique}.mp4`);
  const successfulTargetPath = path.join(
    successfulExportDirectory,
    path.basename(fixturePath),
  );
  const numberedCollisionPath = path.join(exportDirectory, `${unique} (1).mp4`);
  const sentinel = Buffer.from(`existing export target: ${unique}`);
  const evidenceDirectory = EVIDENCE_DIRECTORY;
  let application: ElectronApplication | undefined;
  let identity: WindowsProcessIdentity | undefined;
  let cleaned = false;
  let passed = false;
  let preserveFixtureForPossiblePlayer = false;
  let portReleased = false;
  try {
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
    await waitForPortFree("127.0.0.1", CORE_PORT, 1_000);
    await mkdir(sourceDirectory, { recursive: true });
    await mkdir(exportDirectory, { recursive: true });
    await mkdir(cancelDirectory, { recursive: true });
    await mkdir(successfulExportDirectory, { recursive: true });
    await mkdir(evidenceDirectory, { recursive: true });
    await copyFile(SAMPLE, fixturePath);
    await writeFile(targetPath, sentinel, { flag: "wx" });
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
    const mainPid = await application.evaluate(() => process.pid);
    identity = await readWindowsProcessIdentity(mainPid);
    if (!identity)
      throw new Error("Electron main process exited during startup");
    await expect
      .poll(() =>
        application
          ?.windows()
          .some((page) =>
            /^xiangying:\/\/index\.html\/(?:library)?$/.test(page.url()),
          ),
      )
      .toBe(true);
    const page = application
      .windows()
      .find((entry) =>
        /^xiangying:\/\/index\.html\/(?:library)?$/.test(entry.url()),
      );
    if (!page) throw new Error("Packaged library page not found");
    await expect(page.getByRole("heading", { name: "我的片库" })).toBeVisible();

    const importButtons = page.getByRole("button", { name: "导入视频" });
    await importButtons.first().click();
    await writeFile(
      path.join(evidenceDirectory, "native-initial-dialog.json"),
      await runUia("Describe", mainPid),
    );
    await actWhenReady("ChooseFile", mainPid, { value: fixturePath });
    const card = page.locator("article").filter({
      has: page.getByRole("heading", { name: unique, exact: true }),
    });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByText("尚未扫描", { exact: true })).toBeVisible();
    await page.screenshot({
      path: path.join(evidenceDirectory, `${unique}-import.png`),
    });

    const beforeReveal = await observeWindows(mainPid, fixturePath);
    expect(
      beforeReveal.selectedFiles.some(
        (file) => file.name === path.basename(fixturePath),
      ),
    ).toBe(false);
    await card.getByRole("button", { name: "打开位置" }).click();
    await actWhenReady("Click", mainPid, {
      names: ["仍要打开文件位置"],
    });
    await expect
      .poll(
        async () => {
          const observation = await observeWindows(mainPid, fixturePath);
          return observation.selectedFiles.some(
            (file) => file.name === path.basename(fixturePath) && file.selected,
          );
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    const afterReveal = await observeWindows(mainPid, fixturePath);
    expect(
      afterReveal.selectedFiles.some(
        (file) => file.name === path.basename(fixturePath) && file.selected,
      ),
    ).toBe(true);
    await page.screenshot({
      path: path.join(evidenceDirectory, `${unique}-reveal.png`),
    });

    const playerBefore = await observeWindows(mainPid, fixturePath);
    expect(playerBefore.mp4ProgId).toBeTruthy();
    await card.getByRole("button", { name: "播放" }).click();
    preserveFixtureForPossiblePlayer = true;
    await actWhenReady("Click", mainPid, {
      names: ["仍要播放", "仍要继续", "Continue Anyway"],
    });
    await expect
      .poll(
        async () => {
          const observation = await observeWindows(mainPid, fixturePath);
          const hasFixture = observation.windows.some(
            (window) =>
              /^(wmplayer|video\.ui|microsoft\.media\.player|applicationframehost)\.exe$/i.test(
                window.processName,
              ) && window.fixtureVisible,
          );
          return hasFixture;
        },
        { timeout: 25_000, intervals: [500, 1000, 2000] },
      )
      .toBe(true);
    const playerAfter = await observeWindows(mainPid, fixturePath);
    const playerEvidence = {
      mp4ProgId: playerAfter.mp4ProgId,
      before: playerBefore.processes.filter((entry) =>
        /^(wmplayer|video\.ui|microsoft\.media\.player|applicationframehost)\.exe$/i.test(
          entry.name,
        ),
      ),
      after: playerAfter.processes.filter((entry) =>
        /^(wmplayer|video\.ui|microsoft\.media\.player|applicationframehost)\.exe$/i.test(
          entry.name,
        ),
      ),
      windows: playerAfter.windows.filter((entry) =>
        /^(wmplayer|video\.ui|microsoft\.media\.player|applicationframehost)\.exe$/i.test(
          entry.processName,
        ),
      ),
      fixtureName: path.basename(fixturePath),
    };
    expect(playerEvidence.windows.some((entry) => entry.fixtureVisible)).toBe(
      true,
    );
    await page.screenshot({
      path: path.join(evidenceDirectory, `${unique}-play.png`),
    });
    await writeFile(
      path.join(evidenceDirectory, `${unique}-observations.json`),
      JSON.stringify({ beforeReveal, afterReveal, playerEvidence }, null, 2),
    );

    await page.getByRole("checkbox", { name: `选择${unique}` }).check();
    await page.getByRole("button", { name: "导出所选" }).click();
    await actWhenReady("Click", mainPid, { names: ["取消", "Cancel"] });
    expect(await readFile(targetPath)).toEqual(sentinel);
    expect(await readdir(cancelDirectory)).toEqual([]);
    await page.screenshot({
      path: path.join(evidenceDirectory, `${unique}-export-cancel.png`),
    });

    await page.getByRole("button", { name: "导出所选" }).click();
    await actWhenReady("ChooseFolder", mainPid, {
      value: successfulExportDirectory,
    });
    await actWhenReady("Click", mainPid, {
      names: ["仍要导出", "仍要继续", "Continue Anyway"],
    });
    await expect(page.getByText("已导出 1 部", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    expect(await readFile(successfulTargetPath)).toEqual(
      await readFile(fixturePath),
    );
    expect(await readFile(fixturePath)).toEqual(await readFile(SAMPLE));
    await page.screenshot({
      path: path.join(evidenceDirectory, `${unique}-export-success.png`),
    });

    await page.getByRole("checkbox", { name: `选择${unique}` }).check();
    await page.getByRole("button", { name: "导出所选" }).click();
    await actWhenReady("ChooseFolder", mainPid, { value: exportDirectory });
    await actWhenReady("Click", mainPid, {
      names: ["仍要导出", "仍要继续", "Continue Anyway"],
    });
    await expect(page.getByText("已导出 1 部", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    expect(await readFile(targetPath)).toEqual(sentinel);
    expect(await readFile(numberedCollisionPath)).toEqual(
      await readFile(fixturePath),
    );
    await page.screenshot({
      path: path.join(evidenceDirectory, `${unique}-export-conflict.png`),
    });

    await page
      .getByRole("heading", { name: "我的片库" })
      .waitFor({ state: "visible" });
    passed = true;
  } finally {
    if (application) {
      try {
        await application.evaluate(({ app }) => app.quit());
      } catch {
        // The main process may already have exited after a failed assertion.
      }
      await application.close().catch(() => undefined);
      if (identity && !(await waitForWindowsProcessExit(identity, 5_000))) {
        await terminateOwnedWindowsProcess(identity);
        expect(await waitForWindowsProcessExit(identity, 5_000)).toBe(true);
      }
      application = undefined;
    }
    try {
      await waitForPortFree("127.0.0.1", CORE_PORT, 10_000);
      portReleased = true;
    } catch (error) {
      await testInfo.attach("library-native-port-not-released.txt", {
        body: String(error),
        contentType: "text/plain",
      });
    }
    cleaned =
      (!identity || (await waitForWindowsProcessExit(identity, 1_000))) &&
      portReleased;
    if (passed && cleaned && !preserveFixtureForPossiblePlayer) {
      await rm(runtimeRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    } else {
      await testInfo.attach("xiangying-native-runtime-root.txt", {
        body: [
          runtimeRoot,
          `preserveFixtureForPossiblePlayer=${preserveFixtureForPossiblePlayer}`,
          "The fixture is preserved because the system player is not an owned candidate process.",
        ].join("\n"),
        contentType: "text/plain",
      });
    }
  }
});
