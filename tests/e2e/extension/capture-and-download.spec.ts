import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  expect,
  test as base,
  type BrowserContext,
  type CDPSession,
  type Locator,
  type Page,
  type TestInfo,
  type Worker,
} from "@playwright/test";
import { chromium } from "playwright";
import {
  attachBoundedCoreLogs,
  attachBoundedProcessLogs,
  finalizeManualContextArtifacts,
  manualArtifactPaths,
  startManualContextArtifacts,
} from "../support/artifacts.ts";
import {
  BILIBILI_COOKIE,
  BILIBILI_HEADERS,
  BILIBILI_REFERER,
  BILIBILI_SOURCE_URL,
  BILIBILI_TASK_NAME,
  MALFORMED_BILIBILI_RESPONSES,
  badgeTextForActiveTab,
  captureRealBilibiliImport,
  clickBilibiliImport,
  enableImmediateDownload,
  expectNoInvalidDownloadIDRequests,
  importControlledBilibiliSource,
  openControlledBilibiliPopup,
  readBBDownArguments,
} from "../support/bilibili-capture-fixture.ts";
import {
  startCoreProcess,
  type StartedCoreProcess,
} from "../support/core-process.ts";
import {
  createFakeBilibiliDependencyLeaf,
  type FakeBilibiliDependencyLeaf,
} from "../support/fake-dependencies.ts";
import {
  loadMediaFixture,
  type MediaFixture,
  verifyFixtureCopy,
} from "../support/media.ts";
import {
  assertNoBlockedRequests,
  guardBrowserContext,
  type BrowserNetworkGuard,
} from "../support/network.ts";
import { assertPortFree, waitForPortFree } from "../support/ports.ts";
import { redactDiagnostic } from "../support/process.ts";
import { startTestPage, type StartedTestPage } from "../support/test-page.ts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const EXTENSION_DIRECTORY = path.join(
  REPOSITORY_ROOT,
  "packages/mediago-extension/dist",
);
const CORE_PORT = 39_719;
const TASK_NAME = "MediaGo E2E Fixture";
const PAGE_ACTION_BILIBILI_URL = "https://www.bilibili.com/";
const PAGE_ACTION_TITLE = "MediaGo Bilibili Homepage Fixture";
const PAGE_ACTION_CARD_URL =
  "https://www.bilibili.com/video/BV1PageActionFixture";
const PAGE_ACTION_CARD_TITLE = "MediaGo Bilibili Card Fixture";
const PAGE_ACTION_UNSUPPORTED_URL =
  "https://www.youtube.com/feed/subscriptions";
const PAGE_ACTION_ACCESSIBLE_NAME = "Add current page to MediaGo";
const CDP_COMMAND_TIMEOUT_MS = 5_000;
const DOWNLOAD_DEADLINE_MS = 30_000;
const EXTENSION_FIXTURE_TIMEOUT_MS = 60_000;
const GRACEFUL_CLOSE_TIMEOUT_MS = 3_000;
const PROCESS_EXIT_TIMEOUT_MS = 5_000;
const TERMINATION_GRACE_MS = 2_000;
const DIAGNOSTIC_LIMIT = 16 * 1024;
const FORCE_TEST_TIMEOUT = process.env.MEDIAGO_E2E_FORCE_TEST_TIMEOUT === "1";
const FORCE_CLOSE_FAILURE = process.env.MEDIAGO_E2E_FORCE_CLOSE_FAILURE === "1";
const FORCE_CLOSE_TIMEOUT = process.env.MEDIAGO_E2E_FORCE_CLOSE_TIMEOUT === "1";
const FORCE_LATE_NETWORK_VIOLATION =
  process.env.MEDIAGO_E2E_FORCE_LATE_NETWORK_VIOLATION === "1";

interface ProcessIdentity {
  pid: number;
  startTime: string;
}

interface ExtensionRuntime {
  bbdownArgumentsPath: string;
  context: BrowserContext;
  coreRequestURLs: string[];
  core: StartedCoreProcess;
  extensionURL(relativePath: string): string;
  media: MediaFixture;
  optionsPage: Page;
  testPage: StartedTestPage;
  trackPage(page: Page): void;
  worker: Worker;
}

interface ExtensionResources {
  browserIdentity?: ProcessIdentity;
  context?: BrowserContext;
  core?: StartedCoreProcess;
  fakeBilibiliDependencies?: FakeBilibiliDependencyLeaf;
  media?: MediaFixture;
  page?: Page;
  testPage?: StartedTestPage;
}

function diagnosticMessage(error: unknown): string {
  return redactDiagnostic(
    error instanceof Error ? error.message : String(error),
  );
}

function boundedDiagnostics(errors: readonly string[]): string {
  const contents = Buffer.from(errors.join("\n"), "utf8");
  return contents
    .subarray(Math.max(0, contents.length - DIAGNOSTIC_LIMIT))
    .toString("utf8");
}

async function attachDiagnostic(
  testInfo: TestInfo,
  name: string,
  message: string,
): Promise<void> {
  await testInfo.attach(name, {
    body: boundedDiagnostics([message]),
    contentType: "text/plain; charset=utf-8",
  });
}

function hasPrimaryTestError(testInfo: TestInfo): boolean {
  return (
    testInfo.errors.length > 0 ||
    testInfo.status === "failed" ||
    testInfo.status === "timedOut" ||
    testInfo.status === "interrupted"
  );
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readProcessIdentity(
  pid: number,
): Promise<ProcessIdentity | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0 || Number(stat.slice(0, stat.indexOf(" "))) !== pid) {
      throw new Error(`Malformed /proc stat for PID ${pid}`);
    }
    const fields = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
    const startTime = fields[19];
    if (!startTime)
      throw new Error(`Missing process start time for PID ${pid}`);
    return { pid, startTime };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return undefined;
    throw error;
  }
}

async function identityIsAlive(identity: ProcessIdentity): Promise<boolean> {
  const current = await readProcessIdentity(identity.pid);
  return current?.startTime === identity.startTime;
}

async function readProcessArguments(pid: number): Promise<string[]> {
  try {
    return (await readFile(`/proc/${pid}/cmdline`, "utf8"))
      .split("\0")
      .filter(Boolean);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return [];
    throw error;
  }
}

async function findOwnedChromiumIdentity(
  userDataDirectory: string,
): Promise<ProcessIdentity> {
  const expectedArgument = `--user-data-dir=${path.resolve(userDataDirectory)}`;
  const deadline = Date.now() + 3_000;
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- Each ownership poll needs a fresh /proc snapshot.
    const entries = await readdir("/proc", { withFileTypes: true });
    // oxlint-disable-next-line no-await-in-loop -- Candidate reads are parallelized within one polling iteration.
    const candidateIdentities = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
        .map(async (entry) => {
          const pid = Number(entry.name);
          const args = await readProcessArguments(pid);
          const commandLine = args.join("\0");
          if (
            !commandLine.includes(expectedArgument) ||
            args.some((argument) => /(?:^|\s)--type=/.test(argument))
          ) {
            return undefined;
          }
          return readProcessIdentity(pid);
        }),
    );
    const candidates = candidateIdentities.filter(
      (identity): identity is ProcessIdentity => identity !== undefined,
    );
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      throw new Error(
        `Multiple Chromium processes own ${userDataDirectory}: ${candidates
          .map((identity) => identity.pid)
          .join(", ")}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Could not identify the Chromium process for ${userDataDirectory}`,
      );
    }
    // oxlint-disable-next-line no-await-in-loop -- Polling backoff separates process-table snapshots.
    await delay(50);
  }
}

async function collectOwnedProcessTree(
  root: ProcessIdentity,
): Promise<ProcessIdentity[]> {
  const collected: ProcessIdentity[] = [];
  const visited = new Set<number>();

  const visit = async (identity: ProcessIdentity): Promise<void> => {
    if (visited.has(identity.pid) || !(await identityIsAlive(identity))) return;
    visited.add(identity.pid);
    let children = "";
    try {
      children = await readFile(
        `/proc/${identity.pid}/task/${identity.pid}/children`,
        "utf8",
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ESRCH") throw error;
    }
    await Promise.all(
      children
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(async (value) => {
          const child = await readProcessIdentity(Number(value));
          if (child) await visit(child);
        }),
    );
    if (await identityIsAlive(identity)) collected.push(identity);
  };

  await visit(root);
  return collected;
}

async function waitForIdentitiesExit(
  identities: readonly ProcessIdentity[],
  timeoutMs: number,
): Promise<ProcessIdentity[]> {
  const deadline = Date.now() + timeoutMs;
  let candidates = [...identities];
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- Liveness reads are parallelized within one polling iteration.
    const liveness = await Promise.all(
      candidates.map(async (identity) => ({
        identity,
        alive: await identityIsAlive(identity),
      })),
    );
    const alive = liveness.flatMap((result) =>
      result.alive ? [result.identity] : [],
    );
    if (alive.length === 0 || Date.now() >= deadline) return alive;
    candidates = alive;
    // oxlint-disable-next-line no-await-in-loop -- Backoff separates survivor-set liveness checks.
    await delay(50);
  }
}

async function signalIdentities(
  identities: readonly ProcessIdentity[],
  signal: NodeJS.Signals,
): Promise<void> {
  await Promise.all(
    identities.map(async (identity) => {
      if (!(await identityIsAlive(identity))) return;
      if (identity.pid <= 1 || identity.pid === process.pid) {
        throw new Error(`Refusing to signal unsafe PID ${identity.pid}`);
      }
      try {
        process.kill(identity.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }),
  );
}

async function terminateOwnedProcessTree(
  root: ProcessIdentity,
  knownProcesses: readonly ProcessIdentity[] = [],
): Promise<void> {
  const currentTree = await collectOwnedProcessTree(root);
  const identitiesByPid = new Map(
    [...knownProcesses, ...currentTree].map((identity) => [
      identity.pid,
      identity,
    ]),
  );
  const tree = [...identitiesByPid.values()];
  if (tree.length === 0) return;
  await signalIdentities(tree, "SIGTERM");
  const survivors = await waitForIdentitiesExit(tree, TERMINATION_GRACE_MS);
  if (survivors.length === 0) return;
  await signalIdentities(survivors, "SIGKILL");
  const stubborn = await waitForIdentitiesExit(survivors, TERMINATION_GRACE_MS);
  if (stubborn.length > 0) {
    throw new Error(
      `Owned Chromium process(es) did not exit: ${stubborn
        .map((identity) => identity.pid)
        .join(", ")}`,
    );
  }
}

async function waitForProcessExit(
  identity: ProcessIdentity,
  timeoutMs: number,
): Promise<void> {
  const survivors = await waitForIdentitiesExit([identity], timeoutMs);
  if (survivors.length > 0) {
    throw new Error(`Chromium PID ${identity.pid} did not exit`);
  }
}

async function waitForWorker(context: BrowserContext): Promise<Worker> {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  await expect
    .poll(
      () =>
        worker.evaluate(() => {
          const extensionChrome = (
            globalThis as typeof globalThis & {
              chrome: {
                runtime: {
                  onMessage: { hasListeners(): boolean };
                };
              };
            }
          ).chrome;
          return extensionChrome.runtime.onMessage.hasListeners();
        }),
      {
        timeout: 10_000,
        intervals: [50, 100],
      },
    )
    .toBe(true);
  return worker;
}

async function waitForSuccessfulDownload(
  core: StartedCoreProcess,
  taskName = TASK_NAME,
): Promise<void> {
  const deadline = Date.now() + DOWNLOAD_DEADLINE_MS;
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- Each task poll must finish before status is evaluated.
    const response = await core.client.getDownloadTasks({
      current: 1,
      pageSize: 20,
    });
    const task = response.data.list.find(
      (candidate) => candidate.name === taskName,
    );
    if (task?.status === "success") return;
    if (task?.status === "failed" || task?.status === "stopped") {
      throw new Error(
        `Extension download entered terminal status ${task.status}`,
      );
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `Extension download did not succeed within ${DOWNLOAD_DEADLINE_MS}ms`,
      );
    }
    // oxlint-disable-next-line no-await-in-loop -- Backoff respects the shared download deadline.
    await delay(Math.min(100, remaining));
  }
}

interface InspectedTabState {
  badge: string;
  sourceCount: number;
  sources: Array<{
    documentURL: string;
    name: string;
    type: string;
    url: string;
  }>;
  storageEntryPresent: boolean;
}

interface CdpTargetInfo {
  attached: boolean;
  targetId: string;
  title: string;
  type: string;
  url: string;
}

interface CdpTargetCommandResponse<T> {
  error?: { code: number; message: string };
  id: number;
  result?: T;
}

interface ActionPopupSnapshot {
  bodyText: string;
  detectedText: string;
  href: string;
  importButtonLabels: string[];
  pageTitle: string;
  pageUrl: string;
  popupState: string;
  sourceCount: number;
  sourceNames: string[];
  sourceTypes: string[];
}

interface ActionPopupTarget {
  close(): Promise<void>;
  clickImport(): Promise<void>;
  snapshot(): Promise<ActionPopupSnapshot>;
}

async function findTabIdByUrl(worker: Worker, url: string): Promise<number> {
  const tabId = await worker.evaluate(async (expectedUrl) => {
    const extensionChrome = (
      globalThis as typeof globalThis & {
        chrome: {
          tabs: {
            query(
              options: Record<string, never>,
            ): Promise<Array<{ id?: number; url?: string }>>;
          };
        };
      }
    ).chrome;
    const tabs = await extensionChrome.tabs.query({});
    return tabs.find((tab) => tab.url === expectedUrl)?.id;
  }, url);
  if (tabId === undefined) throw new Error(`Missing extension tab for ${url}`);
  return tabId;
}

async function inspectTabState(
  worker: Worker,
  tabId: number,
): Promise<InspectedTabState> {
  return worker.evaluate(async (targetTabId) => {
    const extensionChrome = (
      globalThis as typeof globalThis & {
        chrome: {
          action: {
            getBadgeText(options: { tabId: number }): Promise<string>;
          };
          storage: {
            session: {
              get(key: string): Promise<Record<string, unknown>>;
            };
          };
        };
      }
    ).chrome;
    const key = `mediago.tab.${targetTabId}`;
    const stored = await extensionChrome.storage.session.get(key);
    const sources = stored[key];
    const sourceList = Array.isArray(sources)
      ? sources.map((source) => {
          const item = source as Record<string, unknown>;
          return {
            documentURL: String(item.documentURL ?? ""),
            name: String(item.name ?? ""),
            type: String(item.type ?? ""),
            url: String(item.url ?? ""),
          };
        })
      : [];
    return {
      badge: await extensionChrome.action.getBadgeText({ tabId: targetTabId }),
      sourceCount: sourceList.length,
      sources: sourceList,
      storageEntryPresent: Object.hasOwn(stored, key),
    };
  }, tabId);
}

async function cdpTargetCommand<T>(
  browserSession: CDPSession,
  targetId: string,
  targetSessionId: string,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const commandLabel = `CDP ${method} for target ${targetId}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onMessage = (event: { message: string; sessionId: string }) => {
    if (event.sessionId !== targetSessionId) return;
    let parsed: CdpTargetCommandResponse<T>;
    try {
      parsed = JSON.parse(event.message) as CdpTargetCommandResponse<T>;
    } catch (error) {
      rejectCommand(
        new Error(
          `${commandLabel} received invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }
    if (parsed.id !== id) return;
    if (parsed.error) {
      rejectCommand(
        new Error(
          `${commandLabel} failed (${parsed.error.code}): ${parsed.error.message}`,
        ),
      );
      return;
    }
    if (parsed.result === undefined) {
      rejectCommand(new Error(`${commandLabel} returned no result`));
      return;
    }
    resolveCommand(parsed.result);
  };
  const onDetached = (event: { sessionId: string }) => {
    if (event.sessionId === targetSessionId) {
      rejectCommand(new Error(`${commandLabel} target session detached`));
    }
  };
  const onTargetDestroyed = (event: { targetId: string }) => {
    if (event.targetId === targetId) {
      rejectCommand(new Error(`${commandLabel} target was destroyed`));
    }
  };
  let resolveCommand!: (value: T) => void;
  let rejectCommand!: (reason: unknown) => void;

  try {
    return await new Promise<T>((resolve, reject) => {
      resolveCommand = resolve;
      rejectCommand = reject;
      browserSession.on("Target.receivedMessageFromTarget", onMessage);
      browserSession.on("Target.detachedFromTarget", onDetached);
      browserSession.on("Target.targetDestroyed", onTargetDestroyed);
      timer = setTimeout(() => {
        reject(
          new Error(
            `${commandLabel} timed out after ${CDP_COMMAND_TIMEOUT_MS}ms`,
          ),
        );
      }, CDP_COMMAND_TIMEOUT_MS);
      try {
        void browserSession
          .send("Target.sendMessageToTarget", {
            sessionId: targetSessionId,
            message: JSON.stringify({ id, method, params }),
          })
          .catch((error: unknown) => {
            reject(
              new Error(
                `${commandLabel} could not be sent: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          });
      } catch (error) {
        reject(
          new Error(
            `${commandLabel} could not be sent: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    browserSession.off("Target.receivedMessageFromTarget", onMessage);
    browserSession.off("Target.detachedFromTarget", onDetached);
    browserSession.off("Target.targetDestroyed", onTargetDestroyed);
  }
}

async function useActionPopup<T>(
  popup: ActionPopupTarget,
  operation: (popup: ActionPopupTarget) => Promise<T>,
): Promise<T> {
  let operationResult!: T;
  let operationError: unknown;
  let operationFailed = false;
  let cleanupError: unknown;
  let cleanupFailed = false;
  try {
    operationResult = await operation(popup);
  } catch (error) {
    operationError = error;
    operationFailed = true;
  } finally {
    try {
      await popup.close();
    } catch (error) {
      cleanupError = error;
      cleanupFailed = true;
    }
  }
  if (operationFailed && cleanupFailed) {
    throw new AggregateError(
      [operationError, cleanupError],
      "Action popup operation and cleanup both failed",
      { cause: operationError },
    );
  }
  if (operationFailed) throw operationError;
  if (cleanupFailed) throw cleanupError;
  return operationResult;
}

function actionPopupCleanupError(
  primaryError: unknown,
  cleanupError: unknown,
  message: string,
): AggregateError {
  return new AggregateError([primaryError, cleanupError], message, {
    cause: primaryError,
  });
}

async function clickAndCaptureActionPopup(
  context: BrowserContext,
  sourceButton: Locator,
  expectedUrl: string,
  activation: "click" | "keyboard" = "click",
): Promise<ActionPopupTarget> {
  const browser = context.browser();
  if (!browser) throw new Error("Chromium browser is unavailable");
  const browserSession = await browser.newBrowserCDPSession();
  let actionTargetId: string | undefined;
  let targetClosePromise: Promise<void> | undefined;
  let browserDetachPromise: Promise<void> | undefined;
  let resourceClosePromise: Promise<void> | undefined;
  const closeDiscoveredTarget = (): Promise<void> => {
    if (actionTargetId === undefined) return Promise.resolve();
    targetClosePromise ??= browserSession
      .send("Target.closeTarget", { targetId: actionTargetId })
      .then((response) => {
        const { success } = response as { success: boolean };
        if (!success) {
          throw new Error(
            `Failed to close action popup target ${actionTargetId}`,
          );
        }
      });
    return targetClosePromise;
  };
  const detachBrowserSession = (): Promise<void> => {
    browserDetachPromise ??= browserSession.detach();
    return browserDetachPromise;
  };
  const closeResources = (): Promise<void> => {
    resourceClosePromise ??= (async () => {
      let targetCloseError: unknown;
      let targetCloseFailed = false;
      let detachError: unknown;
      let detachFailed = false;
      try {
        await closeDiscoveredTarget();
      } catch (error) {
        targetCloseError = error;
        targetCloseFailed = true;
      } finally {
        try {
          await detachBrowserSession();
        } catch (error) {
          detachError = error;
          detachFailed = true;
        }
      }
      if (targetCloseFailed && detachFailed) {
        throw new AggregateError(
          [targetCloseError, detachError],
          "Action popup target close and CDP detach both failed",
          { cause: targetCloseError },
        );
      }
      if (targetCloseFailed) throw targetCloseError;
      if (detachFailed) throw detachError;
    })();
    return resourceClosePromise;
  };

  try {
    await browserSession.send("Target.setDiscoverTargets", { discover: true });
    const before = (await browserSession.send("Target.getTargets")) as {
      targetInfos: CdpTargetInfo[];
    };
    const existingTargetIds = new Set(
      before.targetInfos.map((target) => target.targetId),
    );
    if (activation === "keyboard") {
      await sourceButton.focus();
      await sourceButton.press("Enter");
    } else {
      await sourceButton.click();
    }

    let targetInfo: CdpTargetInfo | undefined;
    await expect
      .poll(
        async () => {
          const targets = (await browserSession.send("Target.getTargets")) as {
            targetInfos: CdpTargetInfo[];
          };
          targetInfo = targets.targetInfos.find(
            (target) =>
              !existingTargetIds.has(target.targetId) &&
              target.url === expectedUrl,
          );
          if (targetInfo) actionTargetId = targetInfo.targetId;
          return targetInfo
            ? {
                title: targetInfo.title,
                type: targetInfo.type,
                url: targetInfo.url,
              }
            : null;
        },
        { timeout: 10_000, intervals: [50, 100] },
      )
      .toEqual({ title: "MediaGo", type: "page", url: expectedUrl });
    if (!targetInfo) throw new Error("Action popup target was not created");
    const actionTargetInfo = targetInfo;

    const attached = (await browserSession.send("Target.attachToTarget", {
      targetId: actionTargetInfo.targetId,
      flatten: false,
    })) as { sessionId: string };
    let commandId = 0;
    const evaluate = async <T>(expression: string): Promise<T> => {
      commandId += 1;
      const response = await cdpTargetCommand<{
        exceptionDetails?: { text?: string };
        result: { value?: T };
      }>(
        browserSession,
        actionTargetInfo.targetId,
        attached.sessionId,
        commandId,
        "Runtime.evaluate",
        {
          expression,
          awaitPromise: true,
          returnByValue: true,
        },
      );
      if (response.exceptionDetails) {
        throw new Error(
          `Action popup evaluation failed for target ${actionTargetInfo.targetId}: ${response.exceptionDetails.text ?? "unknown exception"}`,
        );
      }
      return response.result.value as T;
    };
    await expect
      .poll(() => evaluate<string>("document.readyState"), {
        timeout: 10_000,
        intervals: [50, 100],
      })
      .toBe("complete");

    return {
      close: closeResources,
      clickImport() {
        return evaluate<void>(`(() => {
        const button = document.querySelector('button[data-action="import-source"]');
        if (!(button instanceof HTMLButtonElement)) {
          throw new Error("Import button is unavailable");
        }
        button.click();
      })()`);
      },
      snapshot() {
        return evaluate<ActionPopupSnapshot>(`(() => {
        const root = document.querySelector("[data-popup-state]");
        const pageContext = document.querySelector('section[aria-label="Current page"]');
        const pageLines = pageContext ? Array.from(pageContext.querySelectorAll("p")) : [];
        const sourceRows = Array.from(document.querySelectorAll('ul[aria-label="Detected resources"] > li'));
        return {
          bodyText: document.body.innerText,
          detectedText: pageContext?.querySelector("span")?.textContent?.trim() ?? "",
          href: location.href,
          importButtonLabels: sourceRows.map((row) => row.querySelector('button[data-action="import-source"]')?.getAttribute("aria-label") ?? ""),
          pageTitle: pageLines[0]?.textContent?.trim() ?? "",
          pageUrl: pageLines[1]?.textContent?.trim() ?? "",
          popupState: root?.getAttribute("data-popup-state") ?? "",
          sourceCount: sourceRows.length,
          sourceNames: sourceRows.map((row) => row.querySelector("p")?.textContent?.trim() ?? ""),
          sourceTypes: sourceRows.map((row) => row.querySelector('div[aria-hidden="true"]')?.textContent?.trim() ?? ""),
        };
      })()`);
      },
    };
  } catch (error) {
    let cleanupError: unknown;
    let cleanupFailed = false;
    try {
      await closeResources();
    } catch (caughtCleanupError) {
      cleanupError = caughtCleanupError;
      cleanupFailed = true;
    }
    if (cleanupFailed) {
      throw actionPopupCleanupError(
        error,
        cleanupError,
        "Action popup initialization and cleanup both failed",
      );
    }
    throw error;
  }
}

async function expectSinglePageActionSource(
  popup: ActionPopupTarget,
): Promise<void> {
  await expect
    .poll(() => popup.snapshot(), {
      timeout: 10_000,
      intervals: [50, 100],
    })
    .toMatchObject({
      detectedText: "1 resource detected",
      importButtonLabels: [`Import ${PAGE_ACTION_CARD_TITLE}`],
      pageTitle: PAGE_ACTION_TITLE,
      pageUrl: PAGE_ACTION_BILIBILI_URL,
      popupState: "ready",
      sourceCount: 1,
      sourceNames: [PAGE_ACTION_CARD_TITLE],
      sourceTypes: ["BILI"],
    });
}

const test = base.extend<{ extensionRuntime: ExtensionRuntime }>({
  extensionRuntime: [
    async ({ browserName: _browserName }, use, testInfo) => {
      // This automatic fixture has no page/context dependency, so its teardown
      // keeps a separate timeout budget after the test body has timed out.
      const runtimeRoot = await mkdtemp(
        path.join(tmpdir(), "mediago-e2e-extension-"),
      );
      const userDataDirectory = path.join(runtimeRoot, "chromium-profile");
      const resources: ExtensionResources = {};
      const coreRequestURLs: string[] = [];
      let setupError: unknown;
      let tracingStarted = false;
      let contextClosed = false;
      let networkGuard: BrowserNetworkGuard | undefined;
      let networkViolation: Error | undefined;
      let gracefulCloseError: unknown;
      let ownedProcessesBeforeClose: ProcessIdentity[] = [];

      try {
        resources.media = await loadMediaFixture();
        resources.fakeBilibiliDependencies =
          await createFakeBilibiliDependencyLeaf(runtimeRoot);
        await assertPortFree("127.0.0.1", CORE_PORT, "MediaGo extension Core");

        const artifactPaths = manualArtifactPaths(testInfo);
        resources.context = await chromium.launchPersistentContext(
          userDataDirectory,
          {
            headless: false,
            args: [
              `--disable-extensions-except=${EXTENSION_DIRECTORY}`,
              `--load-extension=${EXTENSION_DIRECTORY}`,
            ],
            locale: "en-US",
            artifactsDir: artifactPaths.artifactsDir,
            recordVideo: { dir: artifactPaths.videoDir },
          },
        );
        resources.browserIdentity =
          await findOwnedChromiumIdentity(userDataDirectory);
        networkGuard = await guardBrowserContext(resources.context);
        resources.context.on("request", (request) => {
          if (request.url().startsWith(`http://127.0.0.1:${CORE_PORT}/`)) {
            coreRequestURLs.push(request.url());
          }
        });
        await startManualContextArtifacts(resources.context);
        tracingStarted = true;

        const worker = await waitForWorker(resources.context);
        const extensionId = new URL(worker.url()).hostname;
        expect(extensionId).not.toBe("");
        const extensionURL = (relativePath: string): string =>
          `chrome-extension://${extensionId}/${relativePath}`;

        const optionsPage =
          resources.context.pages()[0] ?? (await resources.context.newPage());
        resources.page = optionsPage;
        await optionsPage.goto(extensionURL("src/options/index.html"));

        const desktopRadio = optionsPage.getByRole("radio", {
          name: /^Desktop \/ HTTP local/,
        });
        const schemaRadio = optionsPage.getByRole("radio", {
          name: /^Desktop \/ Schema protocol/,
        });
        await expect(desktopRadio).toBeChecked();
        await schemaRadio.check();
        await desktopRadio.check();
        await optionsPage.getByRole("button", { name: "Save" }).click();
        await expect(
          optionsPage.getByText("Saved", { exact: true }),
        ).toBeVisible();
        await optionsPage.reload();
        await expect(desktopRadio).toBeChecked();

        await optionsPage
          .getByRole("button", { name: "Test connection" })
          .click();
        const status = optionsPage.getByRole("status");
        await expect(status).toBeVisible();
        await expect(status).not.toContainText(/connected/i);

        resources.core = await startCoreProcess({
          runtimeRoot,
          port: CORE_PORT,
          depsDirectory: resources.fakeBilibiliDependencies.depsDirectory,
        });
        await optionsPage
          .getByRole("button", { name: "Test connection" })
          .click();
        await expect(status).toHaveText("connected");

        resources.testPage = await startTestPage(resources.media.sampleURL);
        await use({
          bbdownArgumentsPath:
            resources.fakeBilibiliDependencies.bbdownArgumentsPath,
          context: resources.context,
          core: resources.core,
          coreRequestURLs,
          extensionURL,
          media: resources.media,
          optionsPage,
          testPage: resources.testPage,
          trackPage: (page) => {
            resources.page = page;
          },
          worker,
        });
      } catch (error) {
        setupError = error;
      }

      const primaryExists =
        setupError !== undefined || hasPrimaryTestError(testInfo);
      const cleanupErrors: string[] = [];
      const context = resources.context;
      const auditNetwork = async (): Promise<void> => {
        if (!networkGuard) return;
        try {
          assertNoBlockedRequests(networkGuard);
        } catch (error) {
          networkViolation ??=
            error instanceof Error
              ? error
              : new Error(diagnosticMessage(error));
        }
      };

      // This preliminary audit decides whether failure-only artifacts should be
      // retained. The close callback and post-finalizer audit cover later I/O.
      await auditNetwork();

      const auditAndClose = async (): Promise<void> => {
        if (!context) return;
        if (resources.browserIdentity) {
          try {
            ownedProcessesBeforeClose = await collectOwnedProcessTree(
              resources.browserIdentity,
            );
          } catch (error) {
            cleanupErrors.push(
              `snapshot owned Chromium tree: ${diagnosticMessage(error)}`,
            );
          }
        }
        if (FORCE_LATE_NETWORK_VIOLATION && resources.page) {
          try {
            await resources.page.evaluate(async () => {
              try {
                await fetch("https://guard-probe.invalid/extension-close");
              } catch {
                // The guaranteed final teardown audit reports this violation.
              }
            });
          } catch (error) {
            cleanupErrors.push(
              `trigger late network probe: ${diagnosticMessage(error)}`,
            );
          }
        }
        await auditNetwork();
        try {
          if (FORCE_CLOSE_FAILURE) {
            throw new Error("Controlled extension context close failure");
          }
          if (FORCE_CLOSE_TIMEOUT) {
            await withDeadline(
              new Promise<never>(() => {}),
              GRACEFUL_CLOSE_TIMEOUT_MS,
              "Controlled extension context close",
            );
          }
          await withDeadline(
            context.close(),
            GRACEFUL_CLOSE_TIMEOUT_MS,
            "Extension context close",
          );
          contextClosed = true;
        } catch (error) {
          gracefulCloseError = error;
          if (resources.browserIdentity) {
            try {
              await terminateOwnedProcessTree(
                resources.browserIdentity,
                ownedProcessesBeforeClose,
              );
              await waitForProcessExit(
                resources.browserIdentity,
                PROCESS_EXIT_TIMEOUT_MS,
              );
            } catch (terminationError) {
              cleanupErrors.push(
                `terminate Chromium after close failure: ${diagnosticMessage(
                  terminationError,
                )}`,
              );
            }
          }
          throw error;
        } finally {
          // Browser routes can still fire while trace/video/context shutdown is
          // in progress. This audit is guaranteed even if close or termination fails.
          await auditNetwork();
        }
      };

      if (context) {
        if (tracingStarted) {
          try {
            await finalizeManualContextArtifacts({
              testInfo,
              context,
              page: resources.page,
              close: auditAndClose,
              failed:
                primaryExists ||
                networkViolation !== undefined ||
                FORCE_CLOSE_FAILURE ||
                FORCE_CLOSE_TIMEOUT ||
                FORCE_LATE_NETWORK_VIOLATION,
              name: "extension",
              processes: { core: resources.core?.process },
              coreLogDirectory: resources.core
                ? path.join(runtimeRoot, "logs")
                : undefined,
            });
          } catch (error) {
            cleanupErrors.push(
              `finalize extension context: ${diagnosticMessage(error)}`,
            );
          }
        } else {
          try {
            await auditAndClose();
          } catch (error) {
            cleanupErrors.push(
              `close extension context: ${diagnosticMessage(error)}`,
            );
          }
        }
      }

      // Video finalization happens after the close callback; this audit makes
      // the complete trace/video/context interval observable to the guard.
      await auditNetwork();

      if (gracefulCloseError !== undefined) {
        cleanupErrors.push(
          `graceful extension close: ${diagnosticMessage(gracefulCloseError)}`,
        );
      }

      if (resources.browserIdentity) {
        const ownedBrowserProcesses = [
          ...new Map(
            [resources.browserIdentity, ...ownedProcessesBeforeClose].map(
              (identity) => [identity.pid, identity],
            ),
          ).values(),
        ];
        try {
          if (!contextClosed) {
            await terminateOwnedProcessTree(
              resources.browserIdentity,
              ownedProcessesBeforeClose,
            );
          }
          let survivors = await waitForIdentitiesExit(
            ownedBrowserProcesses,
            PROCESS_EXIT_TIMEOUT_MS,
          );
          if (survivors.length > 0) {
            await terminateOwnedProcessTree(
              resources.browserIdentity,
              ownedProcessesBeforeClose,
            );
            survivors = await waitForIdentitiesExit(
              survivors,
              PROCESS_EXIT_TIMEOUT_MS,
            );
          }
          if (survivors.length > 0) {
            throw new Error(
              `Owned Chromium process(es) did not exit: ${survivors
                .map((identity) => identity.pid)
                .join(", ")}`,
            );
          }
        } catch (error) {
          cleanupErrors.push(
            `terminate owned Chromium tree: ${diagnosticMessage(error)}`,
          );
        }
      }

      try {
        await resources.core?.process.stop();
      } catch (error) {
        cleanupErrors.push(`stop Core: ${diagnosticMessage(error)}`);
      }
      try {
        await resources.testPage?.close();
      } catch (error) {
        cleanupErrors.push(`stop fixture page: ${diagnosticMessage(error)}`);
      }
      try {
        await resources.media?.close();
      } catch (error) {
        cleanupErrors.push(`stop media: ${diagnosticMessage(error)}`);
      }
      try {
        await waitForPortFree("127.0.0.1", CORE_PORT, 10_000);
      } catch (error) {
        cleanupErrors.push(`wait for Core port: ${diagnosticMessage(error)}`);
      }

      if (networkViolation) {
        try {
          await attachDiagnostic(
            testInfo,
            "extension-network-violation.log",
            diagnosticMessage(networkViolation),
          );
        } catch (error) {
          cleanupErrors.push(
            `attach browser network violation: ${diagnosticMessage(error)}`,
          );
        }
      }
      if (
        (primaryExists || networkViolation) &&
        (!resources.context || !tracingStarted)
      ) {
        try {
          await attachBoundedProcessLogs(testInfo, {
            core: resources.core?.process,
          });
          if (resources.core) {
            await attachBoundedCoreLogs(
              testInfo,
              path.join(runtimeRoot, "logs"),
            );
          }
        } catch (error) {
          cleanupErrors.push(
            `attach failure logs: ${diagnosticMessage(error)}`,
          );
        }
      }

      try {
        await rm(runtimeRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(
          `remove runtime directory: ${diagnosticMessage(error)}`,
        );
      }
      if (cleanupErrors.length > 0) {
        try {
          await attachDiagnostic(
            testInfo,
            "extension-cleanup-errors.log",
            boundedDiagnostics(cleanupErrors),
          );
        } catch {
          // Preserve the primary test, network, or cleanup error.
        }
      }

      if (setupError !== undefined) throw setupError;
      if (primaryExists) return;
      if (networkViolation) throw networkViolation;
      if (cleanupErrors.length > 0) {
        throw new Error(boundedDiagnostics(cleanupErrors));
      }
    },
    { auto: true, timeout: EXTENSION_FIXTURE_TIMEOUT_MS },
  ],
});

test.use({ screenshot: "off", trace: "off", video: "off" });

test("adds a supported page from the in-page shortcut and opens the real action popup", async ({
  extensionRuntime,
}, testInfo) => {
  testInfo.setTimeout(90_000);
  await extensionRuntime.context.route(
    PAGE_ACTION_BILIBILI_URL,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${PAGE_ACTION_TITLE}</title></head>
  <body>
    <main class="bili-feed4-layout">
      <h1>${PAGE_ACTION_TITLE}</h1>
      <article class="bili-video-card__wrap">
        <a class="bili-video-card__image--link" href="${PAGE_ACTION_CARD_URL}"></a>
        <h3 class="bili-video-card__info--tit">${PAGE_ACTION_CARD_TITLE}</h3>
      </article>
    </main>
  </body>
</html>`,
      });
    },
  );
  await extensionRuntime.context.route(
    PAGE_ACTION_UNSUPPORTED_URL,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Unsupported YouTube Feed</title></head>
  <body><main><h1>Unsupported YouTube Feed</h1></main></body>
</html>`,
      });
    },
  );

  const bilibiliPage = await extensionRuntime.context.newPage();
  extensionRuntime.trackPage(bilibiliPage);
  await bilibiliPage.goto(PAGE_ACTION_BILIBILI_URL, {
    waitUntil: "load",
  });
  const cardButton = bilibiliPage.getByRole("button", { name: "下载" });
  await expect(cardButton).toBeVisible();

  const bilibiliTabId = await findTabIdByUrl(
    extensionRuntime.worker,
    PAGE_ACTION_BILIBILI_URL,
  );
  await expect
    .poll(() => inspectTabState(extensionRuntime.worker, bilibiliTabId), {
      timeout: 10_000,
      intervals: [100],
    })
    .toEqual({
      badge: "",
      sourceCount: 0,
      sources: [],
      storageEntryPresent: false,
    });

  const emptyPopup = await extensionRuntime.context.newPage();
  await emptyPopup.goto(extensionRuntime.extensionURL("src/popup/index.html"));
  await bilibiliPage.bringToFront();
  await emptyPopup.reload();
  await expect(emptyPopup.locator('[data-popup-state="empty"]')).toBeVisible();
  await expect(emptyPopup.getByRole("listitem")).toHaveCount(0);
  await emptyPopup.close();

  const shortcutSwitch = extensionRuntime.optionsPage.getByRole("switch", {
    name: "Show the page shortcut",
  });
  await expect(shortcutSwitch).toHaveAttribute("aria-checked", "true");
  await shortcutSwitch.click();
  await expect(shortcutSwitch).toHaveAttribute("aria-checked", "false");
  await expect(cardButton).toHaveCount(0);
  await shortcutSwitch.click();
  await expect(shortcutSwitch).toHaveAttribute("aria-checked", "true");
  await expect(cardButton).toHaveText("下载");

  await bilibiliPage.bringToFront();
  const firstActionPopup = await clickAndCaptureActionPopup(
    extensionRuntime.context,
    cardButton,
    extensionRuntime.extensionURL("src/popup/index.html"),
    "keyboard",
  );
  await useActionPopup(firstActionPopup, expectSinglePageActionSource);

  await expect
    .poll(() => inspectTabState(extensionRuntime.worker, bilibiliTabId), {
      timeout: 10_000,
      intervals: [100],
    })
    .toEqual({
      badge: "1",
      sourceCount: 1,
      sources: [
        {
          documentURL: PAGE_ACTION_BILIBILI_URL,
          name: PAGE_ACTION_CARD_TITLE,
          type: "bilibili",
          url: PAGE_ACTION_CARD_URL,
        },
      ],
      storageEntryPresent: true,
    });

  await bilibiliPage.bringToFront();
  const secondActionPopup = await clickAndCaptureActionPopup(
    extensionRuntime.context,
    cardButton,
    extensionRuntime.extensionURL("src/popup/index.html"),
  );
  await useActionPopup(secondActionPopup, async (popup) => {
    await expectSinglePageActionSource(popup);

    await expect(
      extensionRuntime.optionsPage.getByRole("switch", {
        name: "Start downloading immediately",
      }),
    ).toHaveAttribute("aria-checked", "false");
    const readCoreTaskSummaries = async () => {
      const tasks = await extensionRuntime.core.client.getDownloadTasks({
        current: 1,
        pageSize: 20,
      });
      return tasks.data.list.map((task) => ({
        name: task.name,
        url: task.url,
      }));
    };
    await expect
      .poll(readCoreTaskSummaries, {
        timeout: 3_000,
        intervals: [100],
      })
      .toEqual([]);
    await popup.clickImport();
    await expect
      .poll(async () => (await popup.snapshot()).bodyText, {
        timeout: 10_000,
        intervals: [50, 100],
      })
      .toContain("Imported 1 task(s)");
    await expect
      .poll(readCoreTaskSummaries, {
        timeout: 10_000,
        intervals: [100],
      })
      .toEqual([{ name: PAGE_ACTION_CARD_TITLE, url: PAGE_ACTION_CARD_URL }]);
  });

  const unsupportedPage = await extensionRuntime.context.newPage();
  extensionRuntime.trackPage(unsupportedPage);
  await unsupportedPage.goto(PAGE_ACTION_UNSUPPORTED_URL, {
    waitUntil: "load",
  });
  const unsupportedButton = unsupportedPage.getByRole("button", {
    name: PAGE_ACTION_ACCESSIBLE_NAME,
  });
  await expect(unsupportedButton).toHaveCount(0);
  await unsupportedPage.evaluate(() => {
    window.history.pushState(null, "", "/watch?v=PageActionFixture");
  });
  await expect(unsupportedButton).toBeVisible();
  await unsupportedPage.evaluate(() => {
    window.history.pushState(null, "", "/feed/subscriptions");
  });
  await expect(unsupportedButton).toHaveCount(0);
});

test("captures a direct MP4 and downloads it through the MV3 popup", async ({
  extensionRuntime,
}, testInfo) => {
  if (FORCE_TEST_TIMEOUT) {
    testInfo.setTimeout(1);
    await new Promise<never>(() => {});
  }

  const downloadNow = extensionRuntime.optionsPage.getByRole("switch", {
    name: "Start downloading immediately",
  });
  await expect(downloadNow).toHaveAttribute("aria-checked", "false");
  await downloadNow.click();
  await expect(
    extensionRuntime.optionsPage.getByText("Saved", { exact: true }),
  ).toBeVisible();
  await expect(downloadNow).toHaveAttribute("aria-checked", "true");

  await extensionRuntime.optionsPage.reload();
  await expect(
    extensionRuntime.optionsPage.getByRole("radio", {
      name: /^Desktop \/ HTTP local/,
    }),
  ).toBeChecked();
  await expect(
    extensionRuntime.optionsPage.getByRole("switch", {
      name: "Start downloading immediately",
    }),
  ).toHaveAttribute("aria-checked", "true");

  const popupPage = await extensionRuntime.context.newPage();
  await popupPage.goto(extensionRuntime.extensionURL("src/popup/index.html"));
  await expect(popupPage).toHaveTitle("MediaGo");

  const fixturePage = await extensionRuntime.context.newPage();
  extensionRuntime.trackPage(fixturePage);
  await fixturePage.goto(extensionRuntime.testPage.url);
  await fixturePage.waitForFunction(
    () =>
      (window as Window & { fixtureMediaLoaded?: boolean | string })
        .fixtureMediaLoaded === true,
  );
  await fixturePage.bringToFront();

  await expect
    .poll(() => badgeTextForActiveTab(extensionRuntime.worker), {
      timeout: 10_000,
      intervals: [100],
    })
    .toBe("1");

  await popupPage.reload();
  extensionRuntime.trackPage(popupPage);
  await expect(
    popupPage.getByText(TASK_NAME, { exact: true }).first(),
  ).toBeVisible();
  await expect(popupPage.getByText("FILE", { exact: true })).toBeVisible();

  const sourceRow = popupPage
    .getByRole("listitem")
    .filter({ hasText: TASK_NAME });
  await sourceRow.getByRole("button", { name: "Import" }).click();
  await expect(
    popupPage.getByText("Imported 1 task(s)", { exact: true }),
  ).toBeVisible();

  await waitForSuccessfulDownload(extensionRuntime.core);
  await verifyFixtureCopy(extensionRuntime.core.downloadDirectory);
});

test("imports a controlled Bilibili capture with the real Core response and fake BBDown", async ({
  extensionRuntime,
}) => {
  await enableImmediateDownload(extensionRuntime.optionsPage);
  const capture = await captureRealBilibiliImport(
    extensionRuntime.context,
    extensionRuntime.core.baseURL,
  );

  const { popupPage, sourceRow } = await openControlledBilibiliPopup({
    context: extensionRuntime.context,
    extensionURL: extensionRuntime.extensionURL,
    localPageURL: extensionRuntime.testPage.blankURL,
    trackPage: extensionRuntime.trackPage,
    worker: extensionRuntime.worker,
  });
  await clickBilibiliImport(sourceRow);
  await expect(
    popupPage.getByText("Imported 1 task(s)", { exact: true }),
  ).toBeVisible();

  expect(capture.requestCount).toBe(1);
  expect(capture.postedBody).toMatchObject({
    tasks: [
      {
        type: "bilibili",
        url: BILIBILI_SOURCE_URL,
        headers: BILIBILI_HEADERS,
      },
    ],
    startDownload: true,
  });
  expect(capture.realResponseBody).toMatchObject({
    success: true,
    data: [{ id: expect.any(Number) }],
  });
  const responseData = (
    capture.realResponseBody as { data: Array<{ id: number }> }
  ).data;
  expect(responseData).toHaveLength(1);
  const responseID = responseData[0]?.id;
  expect(Number.isSafeInteger(responseID)).toBe(true);
  expect(responseID).toBeGreaterThan(0);

  await waitForSuccessfulDownload(extensionRuntime.core, BILIBILI_TASK_NAME);
  await expect
    .poll(() => readBBDownArguments(extensionRuntime.bbdownArgumentsPath), {
      timeout: DOWNLOAD_DEADLINE_MS,
      intervals: [50, 100, 250],
    })
    .toHaveLength(1);
  const [arguments_] = await readBBDownArguments(
    extensionRuntime.bbdownArgumentsPath,
  );
  expect(arguments_).toContain(BILIBILI_SOURCE_URL);
  const cookieIndex = arguments_.indexOf("--cookie");
  expect(cookieIndex).toBeGreaterThanOrEqual(0);
  expect(arguments_[cookieIndex + 1]).toBe(BILIBILI_COOKIE);
  expect(arguments_).not.toContain(BILIBILI_REFERER);
  expectNoInvalidDownloadIDRequests(extensionRuntime.coreRequestURLs);
});

for (const malformedResponse of MALFORMED_BILIBILI_RESPONSES) {
  test(`rejects a Bilibili import with ${malformedResponse.label}`, async ({
    extensionRuntime,
  }) => {
    await enableImmediateDownload(extensionRuntime.optionsPage);
    let interceptedRequests = 0;
    await extensionRuntime.context.route(
      `${extensionRuntime.core.baseURL}/api/downloads`,
      async (route) => {
        interceptedRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: malformedResponse.body,
        });
      },
    );

    const { popupPage, sourceRow } = await openControlledBilibiliPopup({
      context: extensionRuntime.context,
      extensionURL: extensionRuntime.extensionURL,
      localPageURL: extensionRuntime.testPage.blankURL,
      trackPage: extensionRuntime.trackPage,
      worker: extensionRuntime.worker,
    });
    await clickBilibiliImport(sourceRow);
    const failureToast = popupPage.getByText(malformedResponse.error);
    await expect(failureToast, malformedResponse.label).toHaveCount(1);
    await expect(failureToast, malformedResponse.label).toBeVisible();
    await expect(
      popupPage.getByText("Imported 1 task(s)", { exact: true }),
    ).toHaveCount(0);
    // The direct message exposes the same response object consumed by the
    // popup, so count=0 is asserted without weakening the visible UI check.
    const result = await importControlledBilibiliSource(popupPage);
    expect(result, malformedResponse.label).toMatchObject({
      type: "IMPORT_RESULT",
      ok: false,
      count: 0,
    });
    expect(interceptedRequests).toBe(2);
    expect(
      await readBBDownArguments(extensionRuntime.bbdownArgumentsPath),
    ).toEqual([]);
    const tasks = await extensionRuntime.core.client.getDownloadTasks({
      current: 1,
      pageSize: 20,
    });
    expect(
      tasks.data.list.filter((task) => task.name === BILIBILI_TASK_NAME),
    ).toEqual([]);
    expectNoInvalidDownloadIDRequests(extensionRuntime.coreRequestURLs);
  });
}
