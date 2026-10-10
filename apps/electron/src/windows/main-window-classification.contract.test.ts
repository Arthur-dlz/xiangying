import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, test, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  app: { quit: vi.fn() },
  BrowserWindow: vi.fn(),
  nativeTheme: { shouldUseDarkColors: false },
}));

vi.mock("electron", () => electronMocks);
vi.mock("electron-is-dev", () => ({ default: false }));
vi.mock("../core/desktop-icons", () => ({
  resolveWindowIcon: vi.fn(() => undefined),
}));
vi.mock("../core/trust-policy", () => ({
  registerTrustedAppContents: vi.fn(),
  unregisterTrustedAppContents: vi.fn(),
}));
vi.mock("../core/i18n", () => ({ i18n: { t: vi.fn((key: string) => key) } }));
vi.mock("../constants", () => ({ defaultScheme: "xiangying", isMac: false }));
vi.mock("../utils", () => ({ preloadUrl: "test-preload.cjs" }));
vi.mock("../utils/native-notification", () => ({
  showNativeNotification: vi.fn(),
}));
vi.mock("../utils/download-notification-name", () => ({
  resolveDownloadNotificationName: vi.fn(),
}));
vi.mock("../services/downloader.server", () => ({
  DownloaderServer: class DownloaderServer {},
}));
vi.mock("../services/go-config-cache", () => ({
  default: class GoConfigCache {},
}));
vi.mock("../vendor/ElectronLogger", () => ({
  default: class ElectronLogger {},
}));
vi.mock("../vendor/ElectronStore", () => ({
  default: class ElectronStore {},
}));

const { default: MainWindow } = await import("./main.window");

class FakeWebContents extends EventEmitter {
  id = 41;
  loadURL = vi.fn(async (_url: string) => undefined);
  openDevTools = vi.fn();
  send = vi.fn();
}

class FakeBrowserWindow extends EventEmitter {
  webContents = new FakeWebContents();
  loadURL = vi.fn(async (_url: string) => undefined);
  getBounds = vi.fn(() => ({ x: 0, y: 0, width: 1100, height: 680 }));
  isMinimized = vi.fn(() => false);
  isVisible = vi.fn(() => true);
  focus = vi.fn();
  restore = vi.fn();
  setBounds = vi.fn();
  show = vi.fn();
}

describe("main window renderer classification contract", () => {
  let browserWindow: FakeBrowserWindow;
  let logger: {
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };
  let mainWindow: InstanceType<typeof MainWindow>;

  beforeEach(() => {
    vi.clearAllMocks();
    browserWindow = new FakeBrowserWindow();
    electronMocks.BrowserWindow.mockImplementation(
      function BrowserWindowMock() {
        return browserWindow;
      },
    );
    logger = { error: vi.fn(), info: vi.fn() };
    const configCache = { store: { closeMainWindow: false }, get: vi.fn() };
    const store = { get: vi.fn(), set: vi.fn() };
    const downloaderServer = { on: vi.fn() };
    mainWindow = new MainWindow(
      logger as never,
      store as never,
      configCache as never,
      downloaderServer as never,
    );
    mainWindow.init();
  });

  test("records a main-frame load failure without logging its URL", () => {
    const privateUrl = "https://private.invalid/watch?token=do-not-log";
    browserWindow.webContents.emit(
      "did-fail-load",
      {},
      -105,
      "ERR_NAME_NOT_RESOLVED",
      privateUrl,
      true,
      7,
      9,
    );

    expect(logger.error).toHaveBeenCalledWith(
      "[MainWindow] Renderer main-frame load failed:",
      { category: "renderer-main-frame-load-failed", errorCode: -105 },
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(privateUrl);
  });

  test("ignores subframe and aborted loads plus ordinary window shutdown", () => {
    browserWindow.webContents.emit(
      "did-fail-load",
      {},
      -105,
      "ERR_NAME_NOT_RESOLVED",
      "https://private.invalid/frame?token=do-not-log",
      false,
      7,
      9,
    );
    browserWindow.webContents.emit(
      "did-fail-load",
      {},
      -3,
      "ABORTED",
      "https://private.invalid/reload?token=do-not-log",
      true,
      7,
      9,
    );
    browserWindow.emit("close");
    browserWindow.webContents.emit("destroyed");

    expect(logger.error).not.toHaveBeenCalled();
  });

  test("does not classify a clean renderer exit as a crash", () => {
    browserWindow.webContents.emit(
      "render-process-gone",
      {},
      {
        reason: "clean-exit",
        exitCode: 0,
      },
    );

    expect(logger.error).not.toHaveBeenCalled();
  });

  test("records renderer process termination using safe reason and exit code", () => {
    browserWindow.webContents.emit(
      "render-process-gone",
      {},
      {
        reason: "crashed",
        exitCode: 23,
      },
    );

    expect(logger.error).toHaveBeenCalledWith(
      "[MainWindow] Renderer process gone:",
      { category: "renderer-process-gone", reason: "crashed", exitCode: 23 },
    );
  });
});
