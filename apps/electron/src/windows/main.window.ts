import { provide } from "@inversifyjs/binding-decorators";
import {
  DOWNLOAD_EVENT_NAME,
  type DownloadFailedEvent,
  type DownloadProgress,
  type DownloadProgressEvent,
  type DownloadStoppedEvent,
  type DownloadSuccessEvent,
  type DownloadTask,
} from "@mediago/common";
import { i18n } from "../core/i18n";
import { DownloaderServer } from "../services/downloader.server";
import { app, nativeTheme, type RenderProcessGoneDetails } from "electron";
import isDev from "electron-is-dev";
import { inject, injectable } from "inversify";
import _ from "lodash";
import Window from "../core/window";
import { preloadUrl } from "../utils";
import { defaultScheme } from "../constants";
import GoConfigCache from "../services/go-config-cache";
import ElectronLogger from "../vendor/ElectronLogger";
import ElectronStore from "../vendor/ElectronStore";
import { showNativeNotification } from "../utils/native-notification";
import { resolveDownloadNotificationName } from "../utils/download-notification-name";

const ERR_ABORTED = -3;

@injectable()
@provide()
export default class MainWindow extends Window {
  url = isDev ? "http://localhost:8500/" : `${defaultScheme}://index.html/`;

  constructor(
    @inject(ElectronLogger)
    private readonly logger: ElectronLogger,
    @inject(ElectronStore)
    private readonly store: ElectronStore,
    @inject(GoConfigCache)
    private readonly configCache: GoConfigCache,
    @inject(DownloaderServer)
    private readonly downloaderServer: DownloaderServer,
  ) {
    super({
      width: 1100,
      minWidth: 1100,
      height: 680,
      minHeight: 680,
      show: false,
      frame: true,
      webPreferences: {
        preload: preloadUrl,
        spellcheck: false,
      },
    });

    this.downloaderServer.on("download-success", this.onDownloadSuccess);
    this.downloaderServer.on("download-failed", this.onDownloadFailed);
    this.downloaderServer.on("download-start", this.onDownloadStart);
    this.downloaderServer.on("download-progress", this.onDownloadProgress);
    this.downloaderServer.on("download-stop", this.onDownloadStop);
  }

  closeMainWindow = () => {
    const { closeMainWindow } = this.configCache.store;
    if (closeMainWindow) {
      app.quit();
    }
  };

  onDownloadProgress = async (tasks: DownloadProgress[]) => {
    const data: DownloadProgressEvent = {
      type: "progress",
      data: tasks,
    };
    this.send(DOWNLOAD_EVENT_NAME, data);
  };

  init(): void {
    if (this.window) {
      this.focusWindow();
      return;
    }

    this.options.backgroundColor = nativeTheme.shouldUseDarkColors
      ? "#1f1f1f"
      : "#ffffff";
    this.window = this.create();
    this.bindRendererClassification(this.window.webContents);

    const mainBounds = this.store.get("mainBounds");
    if (mainBounds) {
      this.window.setBounds(mainBounds);
    }

    // Handle current window resize
    this.window.on("resized", this.handleResize);
    this.window.on("close", this.closeMainWindow);
  }

  private bindRendererClassification(webContents: Electron.WebContents): void {
    webContents.on(
      "did-fail-load",
      (_event, errorCode, _errorDescription, _validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === ERR_ABORTED) return;
        this.logger.error("[MainWindow] Renderer main-frame load failed:", {
          category: "renderer-main-frame-load-failed",
          errorCode,
        });
      },
    );
    webContents.on(
      "render-process-gone",
      (_event, details: RenderProcessGoneDetails) => {
        if (details.reason === "clean-exit") return;
        this.logger.error("[MainWindow] Renderer process gone:", {
          category: "renderer-process-gone",
          reason: details.reason,
          exitCode: details.exitCode,
        });
      },
    );
  }

  handleResize = () => {
    if (!this.window) return;

    const bounds = this.window.getBounds();
    this.store.set("mainBounds", _.omit(bounds, ["x", "y"]));
  };

  // DB status updates are now handled by Go queue callbacks
  onDownloadSuccess = async (id: number) => {
    this.logger.info(`taskId: ${id} success`);

    const data: DownloadSuccessEvent = {
      type: "success",
      data: { id } as unknown as DownloadTask,
    };
    this.send(DOWNLOAD_EVENT_NAME, data);

    const promptTone = this.configCache.get("promptTone");
    if (promptTone) {
      const name = await this.getDownloadNotificationName(id);
      showNativeNotification(
        {
          title: i18n.t("downloadSuccess"),
          body: i18n.t("videoDownloadSuccess", { name }),
        },
        this.logger,
      );
    }
  };

  onDownloadFailed = async (id: number, err: unknown) => {
    this.logger.info(`taskId: ${id} failed`, err);

    const data: DownloadFailedEvent = {
      type: "failed",
      data: { id, error: String(err) },
    };
    this.send(DOWNLOAD_EVENT_NAME, data);

    const promptTone = this.configCache.get("promptTone");
    if (promptTone) {
      const name = await this.getDownloadNotificationName(id);
      showNativeNotification(
        {
          title: i18n.t("downloadFailed"),
          body: i18n.t("videoDownloadFailed", { name }),
        },
        this.logger,
      );
    }
  };

  onDownloadStart = async (id: number) => {
    this.logger.info(`taskId: ${id} start`);
  };

  onDownloadStop = async (id: number) => {
    this.logger.info(`taskId: ${id} stopped`);

    const data: DownloadStoppedEvent = {
      type: "stopped",
      data: { id },
    };
    this.send(DOWNLOAD_EVENT_NAME, data);
  };

  showWindow() {
    if (!this.window) this.init();
    this.focusWindow();
  }

  private getDownloadNotificationName(id: number): Promise<string> {
    return resolveDownloadNotificationName(
      id,
      (taskId) => this.downloaderServer.getClient().getDownloadTask(taskId),
      this.logger,
    );
  }

  private focusWindow() {
    if (!this.window) return;
    if (this.window.isMinimized()) this.window.restore();
    if (!this.window.isVisible()) this.window.show();
    this.window.focus();
  }
}
