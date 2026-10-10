import { provide } from "@inversifyjs/binding-decorators";
import {
  type BrowserStore,
  type BrowserTabsSnapshot,
  type Controller,
  EnvPath,
  IPC,
} from "@mediago/common";
import { handle } from "../core/decorators";
import { DownloaderServer } from "../services/downloader.server";
import { TYPES } from "../types/symbols";
import { type IpcMainEvent } from "electron";
import { inject, injectable } from "inversify";
import { exePath, workspace } from "../utils";
import { resolveExtensionDir } from "../utils/binaryResolver";
import ElectronUpdater from "../vendor/ElectronUpdater";
import BrowserWindow from "../windows/browser.window";
import MainWindow from "../windows/main.window";
import ShareIntentService from "../services/share-intent.service";
import { getPreferredSystemLanguage } from "../core/system-language";
import BrowserTabManagerService from "../services/browser-tab-manager.service";

@injectable()
@provide(TYPES.Controller)
export default class HomeController implements Controller {
  constructor(
    @inject(MainWindow)
    private readonly mainWindow: MainWindow,
    @inject(BrowserWindow)
    private readonly browserWindow: BrowserWindow,
    @inject(ElectronUpdater)
    private readonly updater: ElectronUpdater,
    @inject(DownloaderServer)
    private readonly downloaderServer: DownloaderServer,
    @inject(ShareIntentService)
    private readonly shareIntentService: ShareIntentService,
    @inject(BrowserTabManagerService)
    private readonly tabs: BrowserTabManagerService,
  ) {}

  @handle(IPC.app.getEnvPath)
  async getEnvPath(): Promise<EnvPath> {
    const client = this.downloaderServer.getClient();
    const { data: config } = await client.getConfig();
    const coreUrl = (await this.downloaderServer.getURL()) ?? "";
    return {
      binPath: exePath,
      dbPath: "",
      workspace: workspace,
      platform: process.platform,
      local: config.local,
      playerUrl: coreUrl ? `${coreUrl}/player/` : "",
      coreUrl,
    };
  }

  /**
   * Path to the bundled MediaGo browser-extension directory.
   *
   * The UI pairs this with the generic `shell.open()` IPC — no
   * dedicated "open extension dir" action is needed, we just return
   * the path and let the renderer treat it like any other folder
   * shortcut (configDir / binDir / localDir). In dev this resolves to
   * `packages/mediago-extension/dist/` inside the monorepo; in prod
   * it's `resources/extension/` inside the installer.
   */
  @handle(IPC.app.getExtensionDir)
  async getExtensionDir(): Promise<string> {
    return resolveExtensionDir().extensionDir;
  }

  @handle(IPC.app.getPreferredSystemLanguage)
  getPreferredSystemLanguage(): string {
    return getPreferredSystemLanguage();
  }

  @handle(IPC.app.showBrowserWindow)
  async showBrowserWindow() {
    const client = this.downloaderServer.getClient();
    await client.setConfigKey("openInNewWindow", true);
    this.browserWindow.showWindow();
    this.tabs.reparentActiveView();
  }

  @handle(IPC.app.combineToHomePage)
  async combineToHomePage(
    _event: IpcMainEvent,
    state?: BrowserTabsSnapshot | BrowserStore,
  ) {
    if (isTabsSnapshot(state)) this.tabs.restoreSnapshot(state);
    this.browserWindow.hideWindow();
    const client = this.downloaderServer.getClient();
    await client.setConfigKey("openInNewWindow", false);
    this.tabs.reparentActiveView();
  }

  @handle(IPC.app.getSharedState)
  getSharedState(): BrowserTabsSnapshot {
    return this.tabs.getSnapshot();
  }

  @handle(IPC.app.setSharedState)
  setSharedState(_event: IpcMainEvent, state: unknown): BrowserTabsSnapshot {
    return isTabsSnapshot(state)
      ? this.tabs.restoreSnapshot(state)
      : this.tabs.getSnapshot();
  }

  @handle(IPC.app.drainShareIntents)
  drainShareIntents() {
    return this.shareIntentService.drain();
  }
  @handle(IPC.update.getState)
  getUpdateState() {
    return this.updater.getState();
  }

  @handle(IPC.update.check)
  checkUpdate() {
    return this.updater.manualUpdate();
  }

  @handle(IPC.update.startDownload)
  startUpdate() {
    return this.updater.startDownload();
  }

  @handle(IPC.update.install)
  installUpdate() {
    return this.updater.install();
  }

  @handle(IPC.update.openLogDirectory)
  openUpdateLogDirectory() {
    return this.updater.openLogDirectory();
  }

  @handle(IPC.update.getDiagnosticInfo)
  getUpdateDiagnosticInfo() {
    return this.updater.getDiagnosticInfo();
  }
}

function isTabsSnapshot(state: unknown): state is BrowserTabsSnapshot {
  return Boolean(
    state &&
    typeof state === "object" &&
    "tabs" in state &&
    Array.isArray(state.tabs),
  );
}
