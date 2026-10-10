import { provide } from "@inversifyjs/binding-decorators";
import {
  type BrowserBoundsPayload,
  type BrowserLoadURLPayload,
  type BrowserDeviceModePayload,
  type Controller,
  type CreateBrowserTabInput,
  type DownloadTask,
  IPC,
} from "@mediago/common";
import { handle } from "../core/decorators";
import OverlayDialogService from "../services/overlay-dialog.service";
import { TYPES } from "../types/symbols";
import { type IpcMainEvent } from "electron";
import { inject, injectable } from "inversify";
import BrowserTabManagerService from "../services/browser-tab-manager.service";
import { SniffingHelper } from "../services/sniffing-helper.service";

@injectable()
@provide(TYPES.Controller)
export default class WebviewController implements Controller {
  constructor(
    @inject(BrowserTabManagerService)
    private readonly tabs: BrowserTabManagerService,
    @inject(SniffingHelper)
    private readonly sniffingHelper: SniffingHelper,
    @inject(OverlayDialogService)
    private readonly overlayDialog: OverlayDialogService,
  ) {}

  @handle(IPC.browser.createTab)
  createTab(_event: IpcMainEvent, options?: CreateBrowserTabInput) {
    return this.tabs.createTab(options);
  }

  @handle(IPC.browser.activateTab)
  activateTab(_event: IpcMainEvent, tabId: string) {
    return this.tabs.activateTab(tabId);
  }

  @handle(IPC.browser.closeTab)
  closeTab(_event: IpcMainEvent, tabId: string) {
    return this.tabs.closeTab(tabId);
  }

  @handle(IPC.browser.getTabs)
  getTabs() {
    return this.tabs.getSnapshot();
  }

  @handle(IPC.browser.setBounds)
  setWebviewBounds(
    _event: IpcMainEvent,
    payload: BrowserBoundsPayload | Electron.Rectangle,
  ) {
    if ("bounds" in payload) {
      this.tabs.setBounds(this.tabId(payload.tabId), payload.bounds);
      return;
    }
    this.tabs.setBounds(this.tabId(), payload);
  }

  @handle(IPC.browser.loadURL)
  async browserViewLoadUrl(
    _event: IpcMainEvent,
    payload: BrowserLoadURLPayload | string,
  ): Promise<void> {
    const tabId =
      typeof payload === "string" ? this.tabId() : this.tabId(payload.tabId);
    const url = typeof payload === "string" ? payload : payload.url;
    await this.tabs.loadURL(tabId, url);
  }

  @handle(IPC.browser.back)
  async webviewGoBack(_event: IpcMainEvent, tabId?: string): Promise<boolean> {
    return this.tabs.goBack(this.tabId(tabId));
  }

  @handle(IPC.browser.reload)
  async webviewReload(_event: IpcMainEvent, tabId?: string) {
    await this.tabs.reload(this.tabId(tabId));
  }

  @handle(IPC.browser.show)
  webviewShow(_event: IpcMainEvent, tabId?: string) {
    this.tabs.show(this.tabId(tabId));
  }

  @handle(IPC.browser.hide)
  webviewHide(_event: IpcMainEvent, tabId?: string) {
    this.tabs.hide(this.tabId(tabId));
  }

  @handle(IPC.browser.home)
  async webviewGoHome(_event: IpcMainEvent, tabId?: string) {
    await this.tabs.goHome(this.tabId(tabId));
  }

  @handle(IPC.browser.setUserAgent)
  webviewChangeDeviceMode(
    _event: IpcMainEvent,
    payload: BrowserDeviceModePayload | boolean,
  ) {
    const isMobile = typeof payload === "boolean" ? payload : payload.isMobile;
    const tabId =
      typeof payload === "boolean" ? this.tabId() : this.tabId(payload.tabId);
    this.tabs.setDeviceMode(tabId, isMobile);
  }

  @handle(IPC.browser.pluginReady)
  pluginReady(_event: IpcMainEvent, tabId?: string) {
    this.sniffingHelper.pluginReady(this.tabId(tabId));
  }

  @handle(IPC.browser.clearCache)
  async clearWebviewCache() {
    return this.tabs.clearCache();
  }

  @handle(IPC.browser.showDownloadDialog)
  async showDownloadDialog(
    _event: IpcMainEvent,
    payload: { data: DownloadTask[]; tabId: string } | DownloadTask[],
  ) {
    const tabId = this.tabId(
      Array.isArray(payload) ? undefined : payload.tabId,
    );
    const data = Array.isArray(payload) ? payload : payload.data;
    this.overlayDialog.show(
      await Promise.all(
        data.map(async (task) =>
          this.tabs.withSessionCookies(tabId, {
            ...task,
            headers:
              task.headers ||
              this.sniffingHelper.getPageHeaders(tabId, task.type),
          }),
        ),
      ),
    );
  }

  @handle(IPC.browser.dismissOverlayDialog)
  async dismissOverlayDialog() {
    this.overlayDialog.hide();
  }

  private tabId(tabId?: string): string {
    return tabId || this.tabs.getActiveTabId();
  }
}
