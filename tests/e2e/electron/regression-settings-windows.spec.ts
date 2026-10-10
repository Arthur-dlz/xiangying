import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import type { AppStore } from "@mediago/common";
import { trustedCoreClient } from "../support/xiangying-core-client.ts";
import {
  readWindowsProcessIdentity,
  terminateOwnedWindowsProcess,
  waitForWindowsProcessExit,
  type WindowsProcessIdentity,
} from "../support/xiangying-windows-process.ts";
import { assertPortFree, waitForPortFree } from "../support/ports.ts";
import {
  createRegressionSettingsRuntime,
  SETTINGS_EVIDENCE_ROOT,
} from "../support/regression-settings-runtime.ts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const EXECUTABLE = path.join(
  REPOSITORY_ROOT,
  "apps/electron/release-slim/win-unpacked/乡映.exe",
);
const ASAR = path.join(
  REPOSITORY_ROOT,
  "apps/electron/release-slim/win-unpacked/resources/app.asar",
);
const CORE = path.join(
  REPOSITORY_ROOT,
  "apps/electron/release-slim/win-unpacked/resources/bin/mediago-core.exe",
);
const CORE_PORT = 39_749;
const CONVERSION_SAMPLE = path.join(
  REPOSITORY_ROOT,
  "tests/media-service/public/v1/sample.mp4",
);
const CONVERSION_SAMPLE_SHA256 =
  "F0E2336FA30408A0D7A8B20CA8EAA0F34EAD938345BA0F976ECFF551FA21852B";

const EXPECTED_SHA256 = {
  executable:
    "2AD5E2599471100B3F46482FB1997DC85352BFA9F2A879FED5766B6970352E45",
  asar: "5BE7673E756C1CE0A371A9D54F6C55FE121D4DA316D34F1759D7C2F14727D0CA",
  core: "C2A15CF870663027676358934B058DA026F746E305B2A70E6D37DC064DA316AA",
} as const;

interface EnvPathResult {
  code?: number;
  data?: { coreUrl?: string; workspace?: string };
}

type BooleanSettingName = Extract<
  keyof AppStore,
  | "promptTone"
  | "showTerminal"
  | "enableMobilePlayer"
  | "audioMuted"
  | "openInNewWindow"
  | "useProxy"
  | "blockAds"
  | "isMobile"
  | "useExtension"
  | "privacy"
  | "downloadProxySwitch"
  | "deleteSegments"
>;

function unwrap<T>(value: unknown): T {
  if (typeof value === "object" && value !== null && "code" in value) {
    const response = value as {
      code?: unknown;
      data?: unknown;
      message?: unknown;
    };
    if (response.code !== 0)
      throw new Error(
        `Settings IPC failed: ${String(response.message ?? response.code)}`,
      );
    return response.data as T;
  }
  return value as T;
}

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex")
    .toUpperCase();
}

async function mainWindow(application: ElectronApplication): Promise<Page> {
  await expect
    .poll(() =>
      application.windows().some((candidate) => {
        try {
          const url = new URL(candidate.url());
          return (
            url.protocol === "xiangying:" &&
            url.hostname === "index.html" &&
            ["", "/", "/downloads", "/library", "/settings"].includes(
              url.pathname,
            )
          );
        } catch {
          return false;
        }
      }),
    )
    .toBe(true);
  const page = application.windows().find((candidate) => {
    try {
      const url = new URL(candidate.url());
      return (
        url.protocol === "xiangying:" &&
        url.hostname === "index.html" &&
        ["", "/", "/downloads", "/library", "/settings"].includes(url.pathname)
      );
    } catch {
      return false;
    }
  });
  if (!page) throw new Error("乡映 main window was not found");
  await expect
    .poll(
      async () =>
        (
          await page
            .locator("body")
            .innerText()
            .catch(() => "")
        ).trim().length > 0,
    )
    .toBe(true);
  await expect(page.getByTitle("设置")).toBeVisible();
  return page;
}

async function selectSettingOption(
  page: Page,
  client: ReturnType<typeof trustedCoreClient>,
  id: string,
  optionIndex: number,
  expectedValue: string,
  setting: "theme" | "language",
) {
  await page.locator(`#${id}`).click();
  const options = page.getByRole("option");
  await expect(options).toHaveCount(setting === "theme" ? 3 : 4);
  await options.nth(optionIndex).click();
  await expect
    .poll(async () => (await client.getConfig()).data[setting])
    .toBe(expectedValue);
}

async function setBooleanSetting(
  page: Page,
  client: ReturnType<typeof trustedCoreClient>,
  name: BooleanSettingName,
  target: boolean,
) {
  const toggle = page.locator(`#setting-${name}`);
  await expect(toggle).toBeVisible();
  const before = Boolean((await client.getConfig()).data[name]);
  await expect(toggle).toHaveAttribute("aria-checked", String(before));
  if (before === target) {
    await toggle.click();
    await expect
      .poll(async () => (await client.getConfig()).data[name])
      .toBe(!target);
    await expect(toggle).toHaveAttribute("aria-checked", String(!target));
  }
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(target));
  await expect
    .poll(async () => (await client.getConfig()).data[name])
    .toBe(target);
}

async function mockNextOpenDialog(
  application: ElectronApplication,
  filePaths: string[],
) {
  await application.evaluate(({ dialog }, selectedPaths) => {
    dialog.showOpenDialog = async () => ({
      canceled: selectedPaths.length === 0,
      filePaths: selectedPaths,
    });
  }, filePaths);
}

async function installSaveAndShellMocks(
  application: ElectronApplication,
  exportPath: string,
) {
  await application.evaluate(({ dialog, shell }, targetPath) => {
    const state = globalThis as typeof globalThis & {
      settingsOpenedPaths?: string[];
      settingsSaveDialogCalls?: number;
    };
    state.settingsOpenedPaths = [];
    state.settingsSaveDialogCalls = 0;
    dialog.showSaveDialog = async () => {
      state.settingsSaveDialogCalls = (state.settingsSaveDialogCalls ?? 0) + 1;
      return { canceled: false, filePath: targetPath };
    };
    shell.openPath = async (target) => {
      state.settingsOpenedPaths?.push(target);
      return "";
    };
  }, exportPath);
}

async function armToastCapture(page: Page) {
  await page.evaluate(() => {
    const target = window as Window & {
      settingsToastCapture?: Promise<string[]>;
    };
    target.settingsToastCapture = new Promise((resolve) => {
      const readToastText = () =>
        Array.from(document.querySelectorAll("[data-sonner-toast]"))
          .map((toast) => toast.textContent?.trim() ?? "")
          .filter(Boolean);
      const observer = new MutationObserver(() => {
        const text = readToastText();
        if (text.length > 0) {
          observer.disconnect();
          resolve(text);
        }
      });
      observer.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
      });
      setTimeout(() => {
        observer.disconnect();
        resolve(readToastText());
      }, 3_000);
    });
  });
}

async function readToastCapture(page: Page) {
  return page.evaluate(async () => {
    const target = window as Window & {
      settingsToastCapture?: Promise<string[]>;
    };
    return (await target.settingsToastCapture) ?? [];
  });
}

test.skip(
  process.platform !== "win32",
  "Windows packaged candidate acceptance",
);

test("alpha3 theme and language options write through Core and survive restart", async () => {
  const hashes = await Promise.all([
    sha256(EXECUTABLE),
    sha256(ASAR),
    sha256(CORE),
  ]);
  expect(hashes).toEqual([
    EXPECTED_SHA256.executable,
    EXPECTED_SHA256.asar,
    EXPECTED_SHA256.core,
  ]);
  await assertPortFree(
    "127.0.0.1",
    CORE_PORT,
    "乡映 settings theme/language Core",
  );
  const runtime = await createRegressionSettingsRuntime();
  let application: ElectronApplication | undefined;
  let processIdentity: WindowsProcessIdentity | undefined;
  try {
    application = await _electron.launch({
      executablePath: EXECUTABLE,
      args: [],
      env: runtime.environment,
      timeout: 30_000,
    });
    processIdentity = await readWindowsProcessIdentity(
      await application.evaluate(() => process.pid),
    );
    if (!processIdentity)
      throw new Error("乡映 main process exited during startup");
    const windowSnapshots = await Promise.all(
      application.windows().map(async (candidate) => ({
        url: candidate.url(),
        title: await candidate.title().catch(() => ""),
        body: (
          await candidate
            .locator("body")
            .innerText()
            .catch(() => "")
        ).slice(0, 800),
        links: await candidate
          .getByRole("link")
          .allTextContents()
          .catch(() => []),
        buttons: await candidate
          .getByRole("button")
          .allTextContents()
          .catch(() => []),
      })),
    );
    const windowSnapshotPath = path.join(
      SETTINGS_EVIDENCE_ROOT,
      `theme-language-windows-${Date.now()}.json`,
    );
    await writeFile(
      windowSnapshotPath,
      JSON.stringify(windowSnapshots, null, 2),
      "utf8",
    );
    const page = await mainWindow(application);
    const settingsNavigation = page.getByTitle("设置");
    if ((await settingsNavigation.count()) !== 1)
      throw new Error(
        `Settings navigation absent; window snapshot: ${windowSnapshotPath}`,
      );
    await settingsNavigation.click();
    const envResult = (await page.evaluate(async () => {
      const getEnvPath = (
        window as Window & {
          electron?: { app?: { getEnvPath(): Promise<unknown> } };
        }
      ).electron?.app?.getEnvPath;
      if (!getEnvPath) throw new Error("getEnvPath API is unavailable");
      return getEnvPath();
    })) as EnvPathResult;
    const envPath = unwrap<{ coreUrl: string; workspace: string }>(envResult);
    expect(path.resolve(envPath.workspace).toLocaleLowerCase("en-US")).toBe(
      path.resolve(runtime.runtimeRoot, "data").toLocaleLowerCase("en-US"),
    );
    const client = trustedCoreClient(page, envPath.coreUrl);

    const themeOptions: Array<[number, string]> = [
      [1, "dark"],
      [2, "light"],
      [0, "system"],
    ];
    for (const [index, value] of themeOptions) {
      await selectSettingOption(
        page,
        client,
        "setting-theme",
        index,
        value,
        "theme",
      );
    }
    const languageOptions: Array<[number, string]> = [
      [1, "zh"],
      [2, "en"],
      [3, "it"],
      [0, "system"],
    ];
    for (const [index, value] of languageOptions) {
      await selectSettingOption(
        page,
        client,
        "setting-language",
        index,
        value,
        "language",
      );
    }

    await application.evaluate(({ app }) => app.quit());
    await application.close();
    expect(await waitForWindowsProcessExit(processIdentity, 5_000)).toBe(true);
    await waitForPortFree("127.0.0.1", CORE_PORT, 10_000);

    application = await _electron.launch({
      executablePath: EXECUTABLE,
      args: [],
      env: runtime.environment,
      timeout: 30_000,
    });
    processIdentity = await readWindowsProcessIdentity(
      await application.evaluate(() => process.pid),
    );
    if (!processIdentity)
      throw new Error("乡映 main process exited during profile restart");
    const restartedPage = await mainWindow(application);
    const restartedResult = (await restartedPage.evaluate(async () => {
      const getEnvPath = (
        window as Window & {
          electron?: { app?: { getEnvPath(): Promise<unknown> } };
        }
      ).electron?.app?.getEnvPath;
      if (!getEnvPath)
        throw new Error("getEnvPath API is unavailable after restart");
      return getEnvPath();
    })) as EnvPathResult;
    const restartedPath = unwrap<{ coreUrl: string; workspace: string }>(
      restartedResult,
    );
    expect(
      path.resolve(restartedPath.workspace).toLocaleLowerCase("en-US"),
    ).toBe(
      path.resolve(runtime.runtimeRoot, "data").toLocaleLowerCase("en-US"),
    );
    const persisted = (
      await trustedCoreClient(restartedPage, restartedPath.coreUrl).getConfig()
    ).data;
    expect(persisted.theme).toBe("system");
    expect(persisted.language).toBe("system");
  } finally {
    if (application) {
      await application
        .evaluate(({ app }) => app.quit())
        .catch(() => undefined);
      await application.close().catch(() => undefined);
      if (
        processIdentity &&
        !(await waitForWindowsProcessExit(processIdentity, 5_000))
      ) {
        await terminateOwnedWindowsProcess(processIdentity);
      }
    }
    await waitForPortFree("127.0.0.1", CORE_PORT, 10_000);
    await runtime.cleanup();
  }
});

test("alpha3 remaining settings controls use isolated profile state", async () => {
  const skipVerifiedCacheFavorites =
    process.env.SETTINGS_SKIP_VERIFIED_CACHE_FAVORITES === "1";
  const hashes = await Promise.all([
    sha256(EXECUTABLE),
    sha256(ASAR),
    sha256(CORE),
  ]);
  expect(hashes).toEqual([
    EXPECTED_SHA256.executable,
    EXPECTED_SHA256.asar,
    EXPECTED_SHA256.core,
  ]);
  await assertPortFree("127.0.0.1", CORE_PORT, "乡映 settings controls Core");

  const runtime = await createRegressionSettingsRuntime();
  const fixturesDir = path.join(runtime.runtimeRoot, "settings-fixtures");
  const outputDir = path.join(runtime.runtimeRoot, "settings-output");
  await mkdir(fixturesDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  const selectedDirectoryA = path.join(
    runtime.runtimeRoot,
    "chosen-downloads-a",
  );
  const selectedDirectoryB = path.join(
    runtime.runtimeRoot,
    "chosen-downloads-b",
  );
  await mkdir(selectedDirectoryA, { recursive: true });
  await mkdir(selectedDirectoryB, { recursive: true });
  const validFavoritesPath = path.join(fixturesDir, "favorites.json");
  const invalidFavoritesPath = path.join(fixturesDir, "invalid.json");
  const exportedFavoritesPath = path.join(outputDir, "favorites-export.json");
  const fixtureFavorite = {
    title: "settings-regression-fixture",
    url: "https://fixture.invalid/settings-regression",
  };
  await writeFile(
    validFavoritesPath,
    JSON.stringify([fixtureFavorite]),
    "utf8",
  );
  await writeFile(invalidFavoritesPath, "{not-json", "utf8");

  let application: ElectronApplication | undefined;
  let processIdentity: WindowsProcessIdentity | undefined;
  let primaryError: unknown;
  let cleanupErrors: string[] = [];
  let failureEvidencePath: string | undefined;
  try {
    application = await _electron.launch({
      executablePath: EXECUTABLE,
      args: [],
      env: runtime.environment,
      timeout: 30_000,
    });
    processIdentity = await readWindowsProcessIdentity(
      await application.evaluate(() => process.pid),
    );
    if (!processIdentity)
      throw new Error("乡映 main process exited during startup");
    let page = await mainWindow(application);
    await page.getByTitle("设置").click();
    const envResult = (await page.evaluate(async () => {
      const getEnvPath = (
        window as Window & {
          electron?: { app?: { getEnvPath(): Promise<unknown> } };
        }
      ).electron?.app?.getEnvPath;
      if (!getEnvPath) throw new Error("getEnvPath API is unavailable");
      return getEnvPath();
    })) as EnvPathResult;
    const envPath = unwrap<{
      coreUrl: string;
      workspace: string;
      configDir: string;
      binDir: string;
    }>(envResult);
    expect(path.resolve(envPath.workspace).toLowerCase()).toBe(
      path.resolve(runtime.runtimeRoot, "data").toLowerCase(),
    );
    const client = trustedCoreClient(page, envPath.coreUrl);

    await mockNextOpenDialog(application, [selectedDirectoryA]);
    await page.getByRole("button", { name: "选择文件夹" }).click();
    await expect
      .poll(async () => (await client.getConfig()).data.local)
      .toBe(selectedDirectoryA);
    await mockNextOpenDialog(application, []);
    await page.getByRole("button", { name: "选择文件夹" }).click();
    await expect
      .poll(async () => (await client.getConfig()).data.local)
      .toBe(selectedDirectoryA);

    await setBooleanSetting(page, client, "promptTone", false);
    await setBooleanSetting(page, client, "enableMobilePlayer", true);
    await setBooleanSetting(page, client, "audioMuted", true);
    await setBooleanSetting(page, client, "openInNewWindow", true);
    await setBooleanSetting(page, client, "blockAds", false);
    await setBooleanSetting(page, client, "isMobile", true);
    await setBooleanSetting(page, client, "useExtension", true);
    await setBooleanSetting(page, client, "privacy", true);

    await installSaveAndShellMocks(application, exportedFavoritesPath);
    if (!skipVerifiedCacheFavorites) {
      const cacheCleared = page.getByRole("button", { name: "清除缓存" });
      await armToastCapture(page);
      await cacheCleared.click();
      const cacheToastText = await readToastCapture(page);
      const cacheApiResult = await page.evaluate(async () => {
        const browser = (
          window as Window & {
            electron?: { browser?: { clearCache?: () => Promise<unknown> } };
          }
        ).electron?.browser;
        if (!browser?.clearCache)
          return { available: false, error: "clearCache API unavailable" };
        try {
          return { available: true, result: await browser.clearCache() };
        } catch (error) {
          return { available: true, error: String(error) };
        }
      });
      await writeFile(
        path.join(
          SETTINGS_EVIDENCE_ROOT,
          `candidate-cache-control-${new Date().toISOString().replaceAll(":", "-")}.json`,
        ),
        JSON.stringify(
          {
            candidate: EXECUTABLE,
            profile: runtime.runtimeRoot,
            toastTextAfterClick: cacheToastText,
            secondIsolatedIpcCall: cacheApiResult,
          },
          null,
          2,
        ),
        "utf8",
      );

      await mockNextOpenDialog(application, []);
      await page.getByRole("button", { name: "导入收藏" }).click();
      expect((await client.getFavorites()).data).toEqual([]);
      await mockNextOpenDialog(application, [invalidFavoritesPath]);
      await armToastCapture(page);
      await page.getByRole("button", { name: "导入收藏" }).click();
      const invalidImportToastText = await readToastCapture(page);
      expect((await client.getFavorites()).data).toEqual([]);
      await writeFile(
        path.join(
          SETTINGS_EVIDENCE_ROOT,
          `candidate-invalid-favorites-${new Date().toISOString().replaceAll(":", "-")}.json`,
        ),
        JSON.stringify(
          {
            candidate: EXECUTABLE,
            profile: runtime.runtimeRoot,
            toastTextAfterInvalidImport: invalidImportToastText,
            favoritesAfterInvalidImport: (await client.getFavorites()).data,
          },
          null,
          2,
        ),
        "utf8",
      );
      await mockNextOpenDialog(application, [validFavoritesPath]);
      await page.getByRole("button", { name: "导入收藏" }).click();
      await expect
        .poll(async () => (await client.getFavorites()).data.length)
        .toBe(1);

      await armToastCapture(page);
      await page.getByRole("button", { name: "导出收藏" }).click();
      const exportToastText = await readToastCapture(page);
      const exportedContent = await readFile(exportedFavoritesPath, "utf8")
        .then((content) => content)
        .catch(() => null);
      const exportDialogCalls = await application.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              settingsSaveDialogCalls?: number;
            }
          ).settingsSaveDialogCalls ?? 0,
      );
      await writeFile(
        path.join(
          SETTINGS_EVIDENCE_ROOT,
          `candidate-favorites-export-${new Date().toISOString().replaceAll(":", "-")}.json`,
        ),
        JSON.stringify(
          {
            candidate: EXECUTABLE,
            profile: runtime.runtimeRoot,
            dialogCalls: exportDialogCalls,
            toastText: exportToastText,
            exportedContent,
          },
          null,
          2,
        ),
        "utf8",
      );
    }
    const extensionDirResult = await page.evaluate(async () => {
      const getExtensionDir = (
        window as Window & {
          electron?: { app?: { getExtensionDir(): Promise<string> } };
        }
      ).electron?.app?.getExtensionDir;
      if (!getExtensionDir)
        throw new Error("getExtensionDir API is unavailable");
      return getExtensionDir();
    });
    const extensionDir = unwrap<string>(extensionDirResult);
    const envApiResponse = (await client.getEnvPaths()).data as unknown as {
      data?: { configDir?: string; binDir?: string };
      configDir?: string;
      binDir?: string;
    };
    const serverEnv = envApiResponse.data ?? envApiResponse;
    if (!serverEnv.configDir || !serverEnv.binDir)
      throw new Error(
        `Core /api/env omitted expected directory paths: ${JSON.stringify(envApiResponse)}`,
      );
    await mockNextOpenDialog(application, [selectedDirectoryB]);
    await page.getByRole("button", { name: "选择文件夹" }).click();
    await expect
      .poll(async () => (await client.getConfig()).data.local)
      .toBe(selectedDirectoryB);

    const openedDirectoryEvidence: Array<{
      label: string;
      expectedPath: string;
      actualPath: string | undefined;
    }> = [];
    for (const [label, expectedPath] of [
      ["配置文件目录", serverEnv.configDir],
      ["可执行程序目录", serverEnv.binDir],
      ["本地存储目录", selectedDirectoryB],
      ["浏览器扩展目录", extensionDir],
    ] as const) {
      await page.getByRole("button", { name: label }).click();
      const openedPaths = await application.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              settingsOpenedPaths?: string[];
            }
          ).settingsOpenedPaths ?? [],
      );
      const actualPath = openedPaths.at(-1);
      openedDirectoryEvidence.push({ label, expectedPath, actualPath });
      expect(actualPath).toBe(expectedPath);
    }
    await writeFile(
      path.join(
        SETTINGS_EVIDENCE_ROOT,
        `candidate-open-directory-targets-${new Date().toISOString().replaceAll(":", "-")}.json`,
      ),
      JSON.stringify(
        {
          candidate: EXECUTABLE,
          profile: runtime.runtimeRoot,
          openedDirectoryEvidence,
        },
        null,
        2,
      ),
      "utf8",
    );
    await application.evaluate(({ app }) => app.quit());
    await application.close();
    expect(await waitForWindowsProcessExit(processIdentity, 5_000)).toBe(true);
    await waitForPortFree("127.0.0.1", CORE_PORT, 10_000);

    application = await _electron.launch({
      executablePath: EXECUTABLE,
      args: [],
      env: runtime.environment,
      timeout: 30_000,
    });
    processIdentity = await readWindowsProcessIdentity(
      await application.evaluate(() => process.pid),
    );
    if (!processIdentity)
      throw new Error("乡映 main process exited during profile restart");
    const restartedPage = await mainWindow(application);
    const restartedEnvResult = (await restartedPage.evaluate(async () => {
      const getEnvPath = (
        window as Window & {
          electron?: { app?: { getEnvPath(): Promise<unknown> } };
        }
      ).electron?.app?.getEnvPath;
      if (!getEnvPath)
        throw new Error("getEnvPath API is unavailable after restart");
      return getEnvPath();
    })) as EnvPathResult;
    const restartedEnv = unwrap<{ coreUrl: string; workspace: string }>(
      restartedEnvResult,
    );
    const persisted = (
      await trustedCoreClient(restartedPage, restartedEnv.coreUrl).getConfig()
    ).data;
    expect(persisted.local).toBe(path.join(runtime.runtimeRoot, "downloads"));
    expect(persisted.promptTone).toBe(false);
    expect(persisted.enableMobilePlayer).toBe(true);
    expect(persisted.audioMuted).toBe(true);
    expect(persisted.openInNewWindow).toBe(true);
    expect(persisted.blockAds).toBe(false);
    expect(persisted.isMobile).toBe(true);
    expect(persisted.useExtension).toBe(true);
    expect(persisted.privacy).toBe(true);
    if (!skipVerifiedCacheFavorites) {
      expect(
        (
          await trustedCoreClient(
            restartedPage,
            restartedEnv.coreUrl,
          ).getFavorites()
        ).data,
      ).toHaveLength(1);
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (application) {
      try {
        await application
          .evaluate(({ app }) => app.quit())
          .catch(() => undefined);
        await application.close().catch(() => undefined);
        if (
          processIdentity &&
          !(await waitForWindowsProcessExit(processIdentity, 5_000))
        ) {
          await terminateOwnedWindowsProcess(processIdentity);
          expect(await waitForWindowsProcessExit(processIdentity, 5_000)).toBe(
            true,
          );
        }
      } catch (error) {
        cleanupErrors.push(`Owned Electron shutdown: ${String(error)}`);
      }
    }
    try {
      await waitForPortFree("127.0.0.1", CORE_PORT, 10_000);
    } catch (error) {
      cleanupErrors.push(
        `Core port ${CORE_PORT} remains occupied: ${String(error)}`,
      );
    }
    if (primaryError === undefined && cleanupErrors.length === 0) {
      await runtime.cleanup();
    } else {
      failureEvidencePath = path.join(
        SETTINGS_EVIDENCE_ROOT,
        `remaining-settings-runtime-retained-${Date.now()}.txt`,
      );
      await writeFile(
        failureEvidencePath,
        `Runtime retained: ${runtime.runtimeRoot}\n${cleanupErrors.join("\n")}`,
        "utf8",
      );
    }
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupErrors.length > 0)
    throw new Error(`Settings cleanup failed; see ${failureEvidencePath}`);
});

test("alpha3 maxRunner invalid feedback bounded diagnostic", async () => {
  const runtime = await createRegressionSettingsRuntime();
  let application: ElectronApplication | undefined;
  let processIdentity: WindowsProcessIdentity | undefined;
  let page: Page | undefined;
  let diagnostic: Array<Record<string, unknown>> = [];
  let primaryError: unknown;
  let cleanupErrors: string[] = [];
  try {
    await assertPortFree(
      "127.0.0.1",
      CORE_PORT,
      "乡映 maxRunner diagnostic Core",
    );
    application = await _electron.launch({
      executablePath: EXECUTABLE,
      args: [],
      env: runtime.environment,
      timeout: 30_000,
    });
    processIdentity = await readWindowsProcessIdentity(
      await application.evaluate(() => process.pid),
    );
    if (!processIdentity)
      throw new Error("乡映 main process exited during startup");
    page = await mainWindow(application);
    await page.getByTitle("设置").click();
    const envResult = (await page.evaluate(async () => {
      const getEnvPath = (
        window as Window & {
          electron?: { app?: { getEnvPath(): Promise<unknown> } };
        }
      ).electron?.app?.getEnvPath;
      if (!getEnvPath) throw new Error("getEnvPath API is unavailable");
      return getEnvPath();
    })) as EnvPathResult;
    const envPath = unwrap<{ coreUrl: string; workspace: string }>(envResult);
    const client = trustedCoreClient(page, envPath.coreUrl);

    await setBooleanSetting(page, client, "promptTone", false);
    await setBooleanSetting(page, client, "enableMobilePlayer", true);
    await setBooleanSetting(page, client, "audioMuted", true);
    await setBooleanSetting(page, client, "openInNewWindow", true);
    await setBooleanSetting(page, client, "blockAds", false);
    await setBooleanSetting(page, client, "isMobile", true);
    await setBooleanSetting(page, client, "useExtension", true);
    await setBooleanSetting(page, client, "privacy", true);

    const maxRunner = page.locator("#setting-maxRunner");

    await maxRunner.fill("1");
    await maxRunner.press("Tab");
    await expect
      .poll(async () => (await client.getConfig()).data.maxRunner)
      .toBe(1);

    const capture = async (value: string, stage: string) => {
      const ui = await page!.evaluate(() => {
        const input =
          document.querySelector<HTMLInputElement>("#setting-maxRunner");
        const row = input?.closest<HTMLElement>("[data-invalid]");
        return {
          inputValue: input?.value ?? null,
          ariaInvalid: input?.getAttribute("aria-invalid") ?? null,
          rowInvalid: row?.getAttribute("data-invalid") ?? null,
          fieldErrorText:
            row
              ?.querySelector<HTMLElement>('[data-slot="field-error"]')
              ?.innerText?.trim() ?? null,
          activeElementId:
            document.activeElement instanceof HTMLElement
              ? document.activeElement.id
              : null,
        };
      });
      const coreValue = (await client.getConfig()).data.maxRunner;
      diagnostic.push({ inputRequested: value, stage, ...ui, coreValue });
    };

    for (const invalidValue of ["0", "51"]) {
      if (invalidValue === "51") {
        await maxRunner.fill("1");
        await maxRunner.press("Tab");
        await expect
          .poll(async () => (await client.getConfig()).data.maxRunner)
          .toBe(1);
      }
      await maxRunner.fill(invalidValue);
      await capture(invalidValue, "after-fill-before-blur");
      await maxRunner.press("Tab");
      await capture(invalidValue, "immediate-after-tab");
      await page.waitForTimeout(100);
      await capture(invalidValue, "after-tab-100ms");
      await page.waitForTimeout(400);
      await capture(invalidValue, "after-tab-500ms");
    }

    const evidencePath = path.join(
      SETTINGS_EVIDENCE_ROOT,
      `maxrunner-interaction-diagnostic-${Date.now()}.json`,
    );
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          candidate: EXECUTABLE,
          expectedHashes: EXPECTED_SHA256,
          profile: runtime.runtimeRoot,
          isolatedWorkspace: envPath.workspace,
          results: diagnostic,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (error) {
    primaryError = error;
    const evidencePath = path.join(
      SETTINGS_EVIDENCE_ROOT,
      `maxrunner-interaction-diagnostic-error-${Date.now()}.json`,
    );
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          profile: runtime.runtimeRoot,
          results: diagnostic,
          error: String(error),
        },
        null,
        2,
      ),
      "utf8",
    );
  } finally {
    if (application) {
      try {
        await application
          .evaluate(({ app }) => app.quit())
          .catch(() => undefined);
        await application.close().catch(() => undefined);
        if (
          processIdentity &&
          !(await waitForWindowsProcessExit(processIdentity, 5_000))
        ) {
          await terminateOwnedWindowsProcess(processIdentity);
          if (!(await waitForWindowsProcessExit(processIdentity, 5_000))) {
            cleanupErrors.push(
              "Owned Electron process did not exit after termination",
            );
          }
        }
      } catch (error) {
        cleanupErrors.push(`Owned Electron shutdown: ${String(error)}`);
      }
    }
    try {
      await waitForPortFree("127.0.0.1", CORE_PORT, 10_000);
    } catch (error) {
      cleanupErrors.push(
        `Core port ${CORE_PORT} remains occupied: ${String(error)}`,
      );
    }
    if (primaryError === undefined && cleanupErrors.length === 0) {
      try {
        await runtime.cleanup();
      } catch (error) {
        cleanupErrors.push(`Isolated runtime cleanup: ${String(error)}`);
      }
    }
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupErrors.length > 0)
    throw new Error(
      `MaxRunner diagnostic cleanup failed: ${cleanupErrors.join("; ")}`,
    );
});

test("alpha3 conversion dialog queues selected options without starting conversion", async () => {
  const hashes = await Promise.all([
    sha256(EXECUTABLE),
    sha256(ASAR),
    sha256(CORE),
  ]);
  expect(hashes).toEqual([
    EXPECTED_SHA256.executable,
    EXPECTED_SHA256.asar,
    EXPECTED_SHA256.core,
  ]);
  expect(await sha256(CONVERSION_SAMPLE)).toBe(CONVERSION_SAMPLE_SHA256);
  await assertPortFree("127.0.0.1", CORE_PORT, "乡映 conversion settings Core");

  const runtime = await createRegressionSettingsRuntime();
  const fixtureDir = path.join(runtime.runtimeRoot, "conversion-fixture");
  await mkdir(fixtureDir, { recursive: true });
  const fixturePath = path.join(fixtureDir, "sample.mp4");
  await copyFile(CONVERSION_SAMPLE, fixturePath);
  expect(await sha256(fixturePath)).toBe(CONVERSION_SAMPLE_SHA256);

  let application: ElectronApplication | undefined;
  let processIdentity: WindowsProcessIdentity | undefined;
  let primaryError: unknown;
  let cleanupErrors: string[] = [];
  let failureEvidencePath: string | undefined;
  try {
    application = await _electron.launch({
      executablePath: EXECUTABLE,
      args: [],
      env: runtime.environment,
      timeout: 30_000,
    });
    processIdentity = await readWindowsProcessIdentity(
      await application.evaluate(() => process.pid),
    );
    if (!processIdentity)
      throw new Error("乡映 main process exited during startup");
    const page = await mainWindow(application);
    await page.evaluate(() => {
      window.history.pushState(null, "", "/converter");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const createTask = page.getByRole("button", { name: "创建任务" });
    await expect(createTask).toBeVisible();
    await createTask.click();
    await expect(page.getByRole("heading", { name: "创建任务" })).toBeVisible();

    await mockNextOpenDialog(application, [fixturePath]);
    await page.getByRole("button", { name: "选择文件" }).click();
    await expect(page.getByText("sample.mp4", { exact: true })).toBeVisible();

    await page.locator("#conversion-output-type").click();
    await expect(
      page.getByRole("option", { name: "视频", exact: true }),
    ).toBeVisible();
    await page.getByRole("option", { name: "音频", exact: true }).click();
    await page.locator("#conversion-output-format").click();
    await expect(
      page.getByRole("option", { name: "flac", exact: true }),
    ).toBeVisible();
    await page.getByRole("option", { name: "flac", exact: true }).click();

    await page.locator("#conversion-output-type").click();
    await page.getByRole("option", { name: "视频", exact: true }).click();
    await page.locator("#conversion-output-format").click();
    await page.getByRole("option", { name: "mkv", exact: true }).click();
    await page.locator("#conversion-quality").click();
    await page.getByRole("option", { name: "较小体积", exact: true }).click();

    const envResult = (await page.evaluate(async () => {
      const getEnvPath = (
        window as Window & {
          electron?: { app?: { getEnvPath(): Promise<unknown> } };
        }
      ).electron?.app?.getEnvPath;
      if (!getEnvPath) throw new Error("getEnvPath API is unavailable");
      return getEnvPath();
    })) as EnvPathResult;
    const envPath = unwrap<{ coreUrl: string; workspace: string }>(envResult);
    expect(path.resolve(envPath.workspace).toLowerCase()).toBe(
      path.resolve(runtime.runtimeRoot, "data").toLowerCase(),
    );
    const client = trustedCoreClient(page, envPath.coreUrl);
    await page.getByRole("button", { name: "添加到列表" }).click();
    await expect(page.getByRole("heading", { name: "创建任务" })).toHaveCount(
      0,
    );

    await expect
      .poll(async () => {
        const list = (await client.getConversions({ current: 1, pageSize: 10 }))
          .data.list;
        return list.find((item) => item.path === fixturePath);
      })
      .toMatchObject({
        path: fixturePath,
        outputFormat: "mkv",
        quality: "low",
        status: "pending",
        progress: 0,
      });
  } catch (error) {
    primaryError = error;
  } finally {
    if (application) {
      try {
        await application
          .evaluate(({ app }) => app.quit())
          .catch(() => undefined);
        await application.close().catch(() => undefined);
        if (
          processIdentity &&
          !(await waitForWindowsProcessExit(processIdentity, 5_000))
        ) {
          await terminateOwnedWindowsProcess(processIdentity);
          if (!(await waitForWindowsProcessExit(processIdentity, 5_000))) {
            cleanupErrors.push(
              "Owned Electron process did not exit after termination",
            );
          }
        }
      } catch (error) {
        cleanupErrors.push(`Owned Electron shutdown: ${String(error)}`);
      }
    }
    try {
      await waitForPortFree("127.0.0.1", CORE_PORT, 10_000);
    } catch (error) {
      cleanupErrors.push(
        `Core port ${CORE_PORT} remains occupied: ${String(error)}`,
      );
    }
    if (primaryError === undefined && cleanupErrors.length === 0) {
      await runtime.cleanup();
    } else {
      failureEvidencePath = path.join(
        SETTINGS_EVIDENCE_ROOT,
        `conversion-dialog-runtime-retained-${Date.now()}.txt`,
      );
      await writeFile(
        failureEvidencePath,
        [
          `Runtime retained: ${runtime.runtimeRoot}`,
          `Candidate: ${EXECUTABLE}`,
          `Fixture: ${fixturePath}`,
          `SHA256 fixture=${CONVERSION_SAMPLE_SHA256}`,
          ...cleanupErrors,
        ].join("\n"),
        "utf8",
      );
    }
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupErrors.length > 0)
    throw new Error(
      `Conversion dialog cleanup failed; see ${failureEvidencePath}`,
    );
});

// Playwright supplies testInfo after the fixture object; the empty pattern is intentional.
// eslint-disable-next-line no-empty-pattern
test("乡映 settings controls persist in the isolated alpha3 profile", async ({}, testInfo) => {
  const executableHash = await sha256(EXECUTABLE);
  const asarHash = await sha256(ASAR);
  const coreHash = await sha256(CORE);
  expect(executableHash).toBe(EXPECTED_SHA256.executable);
  expect(asarHash).toBe(EXPECTED_SHA256.asar);
  expect(coreHash).toBe(EXPECTED_SHA256.core);
  await assertPortFree("127.0.0.1", CORE_PORT, "乡映 settings Core");

  const runtime = await createRegressionSettingsRuntime();
  let application: ElectronApplication | undefined;
  let processIdentity: WindowsProcessIdentity | undefined;
  let page: Page | undefined;
  let cleanupErrors: string[] = [];
  let primaryError: unknown;
  let failureEvidencePath: string | undefined;

  try {
    application = await _electron.launch({
      executablePath: EXECUTABLE,
      args: [],
      env: runtime.environment,
      timeout: 30_000,
    });
    const processId = await application.evaluate(() => process.pid);
    processIdentity = await readWindowsProcessIdentity(processId);
    if (!processIdentity)
      throw new Error("乡映 main process exited during startup");

    page = await mainWindow(application);
    await expect(page.locator("#setting-showTerminal")).toHaveCount(0);
    await page.getByTitle("设置").click();
    await expect(page.locator("#setting-showTerminal")).toBeVisible();
    await expect(page.locator("#setting-maxRunner")).toBeVisible();

    const envResult = (await page.evaluate(async () => {
      const getEnvPath = (
        window as Window & {
          electron?: { app?: { getEnvPath(): Promise<unknown> } };
        }
      ).electron?.app?.getEnvPath;
      if (!getEnvPath) throw new Error("getEnvPath API is unavailable");
      return getEnvPath();
    })) as EnvPathResult;
    const envPath = unwrap<{ coreUrl: string; workspace: string }>(envResult);
    expect(path.resolve(envPath.workspace).toLocaleLowerCase("en-US")).toBe(
      path.resolve(runtime.runtimeRoot, "data").toLocaleLowerCase("en-US"),
    );
    expect(envPath.coreUrl).toContain(`:${CORE_PORT}`);
    const client = trustedCoreClient(page, envPath.coreUrl);

    const initialConfig = (await client.getConfig()).data;
    expect(initialConfig.showTerminal).toBe(false);
    const showTerminal = page.locator("#setting-showTerminal");
    await showTerminal.click();
    await expect(showTerminal).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(async () => (await client.getConfig()).data.showTerminal)
      .toBe(true);
    await showTerminal.screenshot({
      path: path.join(
        SETTINGS_EVIDENCE_ROOT,
        `show-terminal-${testInfo.retry}-${Date.now()}.png`,
      ),
    });

    const maxRunner = page.locator("#setting-maxRunner");
    await maxRunner.fill("50");
    await maxRunner.blur();
    await expect
      .poll(async () => (await client.getConfig()).data.maxRunner)
      .toBe(50);
    await maxRunner.fill("51");
    await maxRunner.blur();
    await expect(page.getByText("1–50", { exact: true })).toBeVisible();
    expect((await client.getConfig()).data.maxRunner).toBe(50);

    const proxy = page.locator("#setting-proxy");
    await proxy.fill("http://127.0.0.1:9");
    await proxy.blur();
    await expect
      .poll(async () => (await client.getConfig()).data.proxy)
      .toBe("http://127.0.0.1:9");
    expect((await client.getConfig()).data.useProxy).toBe(false);
    const useProxy = page.locator("#setting-useProxy");
    await useProxy.click();
    await expect(useProxy).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(async () => (await client.getConfig()).data.useProxy)
      .toBe(true);
    await useProxy.click();
    await expect(useProxy).toHaveAttribute("aria-checked", "false");
    await expect
      .poll(async () => (await client.getConfig()).data.useProxy)
      .toBe(false);

    const downloadProxy = page.locator("#setting-downloadProxySwitch");
    await downloadProxy.click();
    await expect(downloadProxy).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(async () => (await client.getConfig()).data.downloadProxySwitch)
      .toBe(true);
    await downloadProxy.click();
    await expect(downloadProxy).toHaveAttribute("aria-checked", "false");
    await expect
      .poll(async () => (await client.getConfig()).data.downloadProxySwitch)
      .toBe(false);
    await downloadProxy.click();
    await expect(downloadProxy).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(async () => (await client.getConfig()).data.downloadProxySwitch)
      .toBe(true);

    const deleteSegments = page.locator("#setting-deleteSegments");
    await deleteSegments.click();
    await expect(deleteSegments).toHaveAttribute("aria-checked", "false");
    await expect
      .poll(async () => (await client.getConfig()).data.deleteSegments)
      .toBe(false);
    await deleteSegments.click();
    await expect(deleteSegments).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(async () => (await client.getConfig()).data.deleteSegments)
      .toBe(true);
    await deleteSegments.click();
    await expect(deleteSegments).toHaveAttribute("aria-checked", "false");
    await expect
      .poll(async () => (await client.getConfig()).data.deleteSegments)
      .toBe(false);

    const updateState = await page.evaluate(async () => {
      const getState = (
        window as Window & {
          electron?: { update?: { getState(): Promise<unknown> } };
        }
      ).electron?.update?.getState;
      if (!getState) throw new Error("Update status API is unavailable");
      return getState();
    });
    const update = unwrap<{ status: string; autoDownload: boolean }>(
      updateState,
    );
    expect(update.status).toBe("not-available");
    expect(update.autoDownload).toBe(false);

    await application.evaluate(({ app }) => app.quit());
    await application.close();
    expect(await waitForWindowsProcessExit(processIdentity, 5_000)).toBe(true);
    await waitForPortFree("127.0.0.1", CORE_PORT, 10_000);

    application = await _electron.launch({
      executablePath: EXECUTABLE,
      args: [],
      env: runtime.environment,
      timeout: 30_000,
    });
    const restartedProcessId = await application.evaluate(() => process.pid);
    processIdentity = await readWindowsProcessIdentity(restartedProcessId);
    if (!processIdentity)
      throw new Error(
        "乡映 main process exited during isolated-profile restart",
      );
    page = await mainWindow(application);

    const restartedEnvResult = (await page.evaluate(async () => {
      const getEnvPath = (
        window as Window & {
          electron?: { app?: { getEnvPath(): Promise<unknown> } };
        }
      ).electron?.app?.getEnvPath;
      if (!getEnvPath)
        throw new Error("getEnvPath API is unavailable after restart");
      return getEnvPath();
    })) as EnvPathResult;
    const restartedEnvPath = unwrap<{ coreUrl: string; workspace: string }>(
      restartedEnvResult,
    );
    expect(
      path.resolve(restartedEnvPath.workspace).toLocaleLowerCase("en-US"),
    ).toBe(
      path.resolve(runtime.runtimeRoot, "data").toLocaleLowerCase("en-US"),
    );
    const restartedConfig = (
      await trustedCoreClient(page, restartedEnvPath.coreUrl).getConfig()
    ).data;
    expect(restartedConfig.showTerminal).toBe(true);
    expect(restartedConfig.maxRunner).toBe(50);
    expect(restartedConfig.proxy).toBe("http://127.0.0.1:9");
    expect(restartedConfig.useProxy).toBe(false);
    expect(restartedConfig.downloadProxySwitch).toBe(true);
    expect(restartedConfig.deleteSegments).toBe(false);
  } catch (error) {
    primaryError = error;
  } finally {
    if (application) {
      try {
        await application
          .evaluate(({ app }) => app.quit())
          .catch(() => undefined);
        await application.close().catch(() => undefined);
        if (
          processIdentity &&
          !(await waitForWindowsProcessExit(processIdentity, 5_000))
        ) {
          await terminateOwnedWindowsProcess(processIdentity);
          expect(await waitForWindowsProcessExit(processIdentity, 5_000)).toBe(
            true,
          );
        }
      } catch (error) {
        cleanupErrors.push(`Owned Electron shutdown: ${String(error)}`);
      }
    }
    try {
      await waitForPortFree("127.0.0.1", CORE_PORT, 10_000);
    } catch (error) {
      cleanupErrors.push(
        `Core port ${CORE_PORT} remains occupied: ${String(error)}`,
      );
    }

    if (primaryError === undefined && cleanupErrors.length === 0) {
      await runtime.cleanup();
    } else {
      failureEvidencePath = path.join(
        SETTINGS_EVIDENCE_ROOT,
        `runtime-retained-${testInfo.retry}-${Date.now()}.txt`,
      );
      await writeFile(
        failureEvidencePath,
        [
          `Runtime retained: ${runtime.runtimeRoot}`,
          `Candidate: ${EXECUTABLE}`,
          `SHA256 EXE=${executableHash}`,
          `SHA256 ASAR=${asarHash}`,
          `SHA256 Core=${coreHash}`,
          ...cleanupErrors,
        ].join("\n"),
        "utf8",
      );
    }
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupErrors.length > 0)
    throw new Error(`Settings cleanup failed; see ${failureEvidencePath}`);
});
