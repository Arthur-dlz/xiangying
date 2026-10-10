import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { scrubElectronEnvironment } from "../support/electron-network.ts";
import { assertPortFree, waitForPortFree } from "../support/ports.ts";
import { trustedCoreClient } from "../support/xiangying-core-client.ts";
import {
  readWindowsProcessIdentity,
  waitForWindowsProcessExit,
  type WindowsProcessIdentity,
} from "../support/xiangying-windows-process.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const EVIDENCE = path.join(ROOT, ".task/review77-20261006/settings");
const BINDING_PATH = path.join(
  ROOT,
  ".task/repair-20261006/candidate-ui-binding.json",
);
const SAMPLE_PATH = path.join(ROOT, "tests/media-service/public/v1/sample.mp4");
const FFMPEG_PATH = path.join(ROOT, ".deps/win32-x64/ffmpeg.exe");
const CORE_PORT = Number(process.env.MEDIAGO_CORE_PORT || 39_849);
const EXPECTED_BINDING = {
  asarSha256:
    "c5d612dece56542150fc92d2af0d8dd111ee9ce9ab7cad42638edd3a226731bb",
  coreSha256:
    "0b68bd3f7110deba7417bc82a4647f6a7639cf8a2551067d0beb45696cd25c8f",
  settingSourceSha256:
    "901de3685a8e38b404dd80a016a3be692e2472183bf533cb0fbc6ded8fe6be90",
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function candidatePage(application: ElectronApplication): Promise<Page> {
  await expect
    .poll(
      () =>
        application.windows().some((window) => {
          try {
            const url = new URL(window.url());
            return (
              url.protocol === "xiangying:" && url.hostname === "index.html"
            );
          } catch {
            return false;
          }
        }),
      { timeout: 15_000 },
    )
    .toBe(true);
  const page = application.windows().find((window) => {
    try {
      const url = new URL(window.url());
      return url.protocol === "xiangying:" && url.hostname === "index.html";
    } catch {
      return false;
    }
  });
  if (!page) throw new Error("candidate main window was not found");
  return page;
}

async function coreClient(page: Page) {
  const result = (await page.evaluate(async () => {
    const app = (
      window as Window & {
        electron?: { app?: { getEnvPath(): Promise<unknown> } };
      }
    ).electron?.app;
    if (!app) throw new Error("trusted app API missing");
    return app.getEnvPath();
  })) as unknown as {
    code: number;
    data: { coreUrl: string; workspace: string };
  };
  if (result.code !== 0 || !result.data?.coreUrl)
    throw new Error("candidate Core URL unavailable");
  return { result, client: trustedCoreClient(page, result.data.coreUrl) };
}

async function stubNextOpenDialog(
  application: ElectronApplication,
  selectedPath: string,
) {
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [filePath],
    });
  }, selectedPath);
}

test.skip(
  process.platform !== "win32",
  "candidate-bound Windows settings acceptance",
);

test("current candidate settings reachability, protected writes, and controlled conversion start", async () => {
  test.setTimeout(180_000);
  await assertPortFree("127.0.0.1", CORE_PORT, "review77 settings Core");
  await mkdir(EVIDENCE, { recursive: true });
  const binding = JSON.parse(await readFile(BINDING_PATH, "utf8")) as {
    candidate: string;
    asarSha256: string;
    coreSha256: string;
    settingSourceSha256: string;
  };
  expect(binding).toMatchObject(EXPECTED_BINDING);
  const candidate = path.resolve(binding.candidate);
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    path.join(candidate, "乡映.exe"),
  );
  expect(
    sha256(await readFile(path.join(candidate, "resources/app.asar"))),
  ).toBe(binding.asarSha256);
  expect(
    sha256(
      await readFile(path.join(candidate, "resources/bin/mediago-core.exe")),
    ),
  ).toBe(binding.coreSha256);
  expect(
    sha256(
      await readFile(
        path.join(ROOT, "apps/ui/src/pages/setting-page/setting-fields.tsx"),
      ),
    ),
  ).toBe(binding.settingSourceSha256);
  expect(sha256(await readFile(SAMPLE_PATH))).toBe(
    "f0e2336fa30408a0d7a8b20ca8eaa0f34ead938345ba0f976ecff551fa21852b",
  );
  const runtimeRoot = await mkdtemp(path.join(EVIDENCE, "runtime-"));
  const fixtureDir = path.join(runtimeRoot, "conversion-fixture");
  const tempDir = path.join(runtimeRoot, "temp");
  await Promise.all([
    mkdir(fixtureDir, { recursive: true }),
    mkdir(path.join(runtimeRoot, "appdata"), { recursive: true }),
    mkdir(path.join(runtimeRoot, "localappdata"), { recursive: true }),
    mkdir(tempDir, { recursive: true }),
  ]);
  const fixturePath = path.join(fixtureDir, "sample.mp4");
  await copyFile(SAMPLE_PATH, fixturePath);
  const fixtureHash = sha256(await readFile(fixturePath));
  let application: ElectronApplication | undefined;
  let identity: WindowsProcessIdentity | undefined;
  let passed = false;
  try {
    application = await _electron.launch({
      executablePath: path.join(candidate, "乡映.exe"),
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
        TEMP: tempDir,
        TMP: tempDir,
      },
    });
    identity = await readWindowsProcessIdentity(application.process().pid!);
    if (!identity)
      throw new Error("unable to verify candidate process identity");
    const page = await candidatePage(application);
    const { result: envResult, client } = await coreClient(page);
    expect(path.resolve(envResult.data.workspace).toLowerCase()).toBe(
      path.resolve(runtimeRoot, "data").toLowerCase(),
    );

    // R-SET-01: check allowed settings sections are reachable; the product brand
    // contract intentionally hides the promotional card in the Xiangying build.
    await page.getByRole("link", { name: "设置", exact: true }).click();
    const allowedSections = [
      "基础设置",
      "浏览器设置",
      "下载设置",
      "浏览器扩展",
      "更多设置",
    ];
    for (const title of allowedSections) {
      const section = page.getByText(title, { exact: true }).first();
      await expect(section).toBeAttached();
      await section.scrollIntoViewIfNeeded();
      await expect(section).toBeVisible();
    }
    await expect(page.getByLabel("推广")).toHaveCount(0);

    // R-SET-07: only isolated UI preference writes/readback; no update action.
    await client.setConfig({
      autoUpgrade: false,
      allowBeta: false,
      closeMainWindow: false,
      maxRunner: 1,
    });
    await page.reload();
    await page.getByRole("link", { name: "设置", exact: true }).click();
    for (const key of ["autoUpgrade", "allowBeta"] as const) {
      const toggle = page.locator(`#setting-${key}`);
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await expect
        .poll(async () => (await client.getConfig()).data[key])
        .toBe(true);
    }
    await page.locator("#setting-closeMainWindow-true").click();
    await expect
      .poll(async () => (await client.getConfig()).data.closeMainWindow)
      .toBe(true);

    // R-SET-15: Enter blurs/commits, then Tab must not issue a second config write.
    await expect
      .poll(async () => (await client.getConfig()).data.maxRunner)
      .toBe(1);
    let maxRunnerWrites = 0;
    const configUrl = new URL("/api/config", envResult.data.coreUrl).href;
    await page.route(configUrl, async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        try {
          const body = request.postDataJSON() as { maxRunner?: unknown };
          if (body.maxRunner === 2) maxRunnerWrites++;
        } catch {
          /* other config requests are not relevant to this counter */
        }
      }
      await route.continue();
    });
    const maxRunner = page.locator("#setting-maxRunner");
    await maxRunner.fill("2");
    await maxRunner.press("Enter");
    await maxRunner.press("Tab");
    await expect(maxRunner).toHaveValue("2");
    await expect
      .poll(async () => (await client.getConfig()).data.maxRunner)
      .toBe(2);
    await expect.poll(() => maxRunnerWrites).toBe(1);
    await page.unroute(configUrl);

    // R-SET-21/22: modal options plus the explicitly authorized start=true
    // path with a hash-verified, repository-owned fixture in disposable storage.
    await page.evaluate(() => {
      window.history.pushState(null, "", "/converter");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.getByRole("button", { name: "创建任务" }).click();
    await expect(page.getByRole("heading", { name: "创建任务" })).toBeVisible();
    await stubNextOpenDialog(application, fixturePath);
    await page.getByRole("button", { name: "选择文件" }).click();
    await expect(page.getByText("sample.mp4", { exact: true })).toBeVisible();
    await page.locator("#conversion-output-type").click();
    await page.getByRole("option", { name: "音频", exact: true }).click();
    await page.locator("#conversion-output-format").click();
    await page.getByRole("option", { name: "flac", exact: true }).click();
    await page.locator("#conversion-output-type").click();
    await page.getByRole("option", { name: "视频", exact: true }).click();
    await page.locator("#conversion-output-format").click();
    await page.getByRole("option", { name: "mkv", exact: true }).click();
    await page.locator("#conversion-quality").click();
    await page.getByRole("option", { name: "较小体积", exact: true }).click();
    await page.getByRole("button", { name: "开始转换 1 个文件" }).click();
    await expect(page.getByRole("heading", { name: "创建任务" })).toHaveCount(
      0,
    );
    await expect
      .poll(
        async () => {
          const result = await client.getConversions({
            current: 1,
            pageSize: 20,
          });
          return result.data.list.find(
            (item) => item.path === fixturePath && item.outputFormat === "mkv",
          );
        },
        { timeout: 90_000 },
      )
      .toMatchObject({ outputFormat: "mkv", quality: "low", status: "done" });
    const records = (await client.getConversions({ current: 1, pageSize: 20 }))
      .data.list;
    const completed = records.find(
      (item) => item.path === fixturePath && item.outputFormat === "mkv",
    );
    if (!completed?.outputPath)
      throw new Error("completed conversion has no output path");
    const outputPath = path.resolve(completed.outputPath);
    expect(path.dirname(outputPath)).toBe(fixtureDir);
    const output = await readFile(outputPath);
    expect(output.length).toBeGreaterThan(0);
    const ffmpeg = await stat(FFMPEG_PATH);
    expect(ffmpeg.isFile()).toBe(true);
    await promisify(execFile)(
      FFMPEG_PATH,
      [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-err_detect",
        "explode",
        "-i",
        outputPath,
        "-map",
        "0",
        "-f",
        "null",
        "-",
      ],
      { timeout: 45_000, windowsHide: true },
    );
    expect(sha256(await readFile(fixturePath))).toBe(fixtureHash);
    await writeFile(
      path.join(EVIDENCE, "settings-review-runtime-result.json"),
      JSON.stringify(
        {
          candidate,
          binding,
          runtimeRoot,
          allowedSections,
          promotionVisible: false,
          settings: {
            autoUpgrade: true,
            allowBeta: true,
            closeMainWindow: true,
          },
          maxRunner: {
            value: 2,
            configWritesAfterEnterThenTab: maxRunnerWrites,
          },
          conversion: {
            input: fixturePath,
            inputSha256: fixtureHash,
            output: outputPath,
            outputBytes: output.length,
            outputFormat: completed.outputFormat,
            quality: completed.quality,
            status: completed.status,
            ffmpegDecodeExitCode: 0,
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    passed = true;
  } finally {
    if (application) await application.close().catch(() => undefined);
    if (identity)
      expect(await waitForWindowsProcessExit(identity, 10_000)).toBe(true);
    await waitForPortFree("127.0.0.1", CORE_PORT, 10_000);
    if (!passed)
      await writeFile(
        path.join(EVIDENCE, `runtime-retained-${Date.now()}.txt`),
        `Runtime retained for failure inspection: ${runtimeRoot}\n`,
        "utf8",
      );
  }
});

test("current candidate settings persist across an isolated Electron process restart", async () => {
  test.setTimeout(120_000);
  await assertPortFree(
    "127.0.0.1",
    CORE_PORT,
    "review77 settings restart Core",
  );
  await mkdir(EVIDENCE, { recursive: true });
  const binding = JSON.parse(await readFile(BINDING_PATH, "utf8")) as {
    candidate: string;
    asarSha256: string;
    coreSha256: string;
    settingSourceSha256: string;
  };
  expect(binding).toMatchObject(EXPECTED_BINDING);
  const candidate = path.resolve(binding.candidate);
  const executablePath = path.join(candidate, "乡映.exe");
  expect(path.resolve(process.env.XIANGYING_E2E_EXECUTABLE || "")).toBe(
    executablePath,
  );
  expect(
    sha256(await readFile(path.join(candidate, "resources/app.asar"))),
  ).toBe(binding.asarSha256);
  expect(
    sha256(
      await readFile(path.join(candidate, "resources/bin/mediago-core.exe")),
    ),
  ).toBe(binding.coreSha256);
  expect(
    sha256(
      await readFile(
        path.join(ROOT, "apps/ui/src/pages/setting-page/setting-fields.tsx"),
      ),
    ),
  ).toBe(binding.settingSourceSha256);

  const runtimeRoot = await mkdtemp(path.join(EVIDENCE, "restart-runtime-"));
  const tempDir = path.join(runtimeRoot, "temp");
  await Promise.all(
    ["appdata", "localappdata", "temp"].map((name) =>
      mkdir(path.join(runtimeRoot, name), { recursive: true }),
    ),
  );

  const launchCandidate = async () => {
    const application = await _electron.launch({
      executablePath,
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
        TEMP: tempDir,
        TMP: tempDir,
      },
    });
    const owner = await readWindowsProcessIdentity(application.process().pid!);
    if (!owner) {
      await application.close();
      throw new Error("unable to verify isolated candidate process identity");
    }
    return { application, owner };
  };

  let first: Awaited<ReturnType<typeof launchCandidate>> | undefined;
  let second: Awaited<ReturnType<typeof launchCandidate>> | undefined;
  let passed = false;
  try {
    first = await launchCandidate();
    const firstPage = await candidatePage(first.application);
    const firstEnv = await coreClient(firstPage);
    expect(path.resolve(firstEnv.result.data.workspace).toLowerCase()).toBe(
      path.resolve(runtimeRoot, "data").toLowerCase(),
    );
    await firstEnv.client.setConfig({
      autoUpgrade: false,
      allowBeta: false,
      closeMainWindow: false,
    });
    await firstPage.reload();
    await firstPage.getByRole("link", { name: "设置", exact: true }).click();
    for (const key of ["autoUpgrade", "allowBeta"] as const) {
      const toggle = firstPage.locator(`#setting-${key}`);
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await expect
        .poll(async () => (await firstEnv.client.getConfig()).data[key])
        .toBe(true);
    }
    const closeMainWindow = firstPage.locator("#setting-closeMainWindow-true");
    await closeMainWindow.click();
    await expect(closeMainWindow).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(
        async () => (await firstEnv.client.getConfig()).data.closeMainWindow,
      )
      .toBe(true);

    await first.application.close();
    expect(await waitForWindowsProcessExit(first.owner, 10_000)).toBe(true);
    await waitForPortFree("127.0.0.1", CORE_PORT, 10_000);

    second = await launchCandidate();
    expect(second.owner.pid).not.toBe(first.owner.pid);
    const secondPage = await candidatePage(second.application);
    const secondEnv = await coreClient(secondPage);
    expect(path.resolve(secondEnv.result.data.workspace).toLowerCase()).toBe(
      path.resolve(runtimeRoot, "data").toLowerCase(),
    );
    await expect
      .poll(async () => {
        const config = (await secondEnv.client.getConfig()).data;
        return [config.autoUpgrade, config.allowBeta, config.closeMainWindow];
      })
      .toEqual([true, true, true]);
    await secondPage.locator('a[href$="/settings"]').first().click();
    await expect(secondPage.locator("#setting-autoUpgrade")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(secondPage.locator("#setting-allowBeta")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(
      secondPage.locator("#setting-closeMainWindow-true"),
    ).toHaveAttribute("aria-checked", "true");

    await writeFile(
      path.join(EVIDENCE, "settings-process-restart-runtime-result.json"),
      JSON.stringify(
        {
          candidate,
          binding,
          runtimeRoot,
          firstOwner: first.owner,
          secondOwner: second.owner,
          sameProfile: true,
          settings: {
            autoUpgrade: true,
            allowBeta: true,
            closeMainWindow: true,
          },
          updaterActionPerformed: false,
        },
        null,
        2,
      ),
      "utf8",
    );
    passed = true;
  } finally {
    if (second) await second.application.close().catch(() => undefined);
    if (second)
      expect(await waitForWindowsProcessExit(second.owner, 10_000)).toBe(true);
    if (first)
      expect(await waitForWindowsProcessExit(first.owner, 10_000)).toBe(true);
    await waitForPortFree("127.0.0.1", CORE_PORT, 10_000);
    if (!passed)
      await writeFile(
        path.join(EVIDENCE, `restart-runtime-retained-${Date.now()}.txt`),
        `Runtime retained for failure inspection: ${runtimeRoot}\n`,
        "utf8",
      );
  }
});
