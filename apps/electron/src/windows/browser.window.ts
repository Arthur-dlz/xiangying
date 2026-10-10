import { provide } from "@inversifyjs/binding-decorators";
import isDev from "electron-is-dev";
import { inject, injectable } from "inversify";
import _ from "lodash";
import Window from "../core/window";
import GoConfigCache from "../services/go-config-cache";
import { defaultScheme, preloadUrl } from "../utils";
import ElectronStore from "../vendor/ElectronStore";
import { isTrustedAppURL } from "../core/trust-policy";

@injectable()
@provide()
export default class BrowserWindow extends Window {
  url = isDev
    ? "http://localhost:8500/browser"
    : `${defaultScheme}://index.html/browser`;

  constructor(
    @inject(ElectronStore)
    private readonly store: ElectronStore,
    @inject(GoConfigCache)
    private readonly configCache: GoConfigCache,
  ) {
    super({
      width: 1100,
      minWidth: 600,
      height: 680,
      minHeight: 680,
      show: false,
      frame: true,
      webPreferences: {
        preload: preloadUrl,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });

    this.configCache.onDidChange("openInNewWindow", this.handleNewWindowsVal);
  }

  handleNewWindowsVal = (newValue: unknown) => {
    if (!this.window) return;

    if (newValue === false && !this.window.isDestroyed()) {
      this.window.close();
    }
  };

  handleResize = () => {
    if (!this.window) return;

    const bounds = this.window.getBounds();
    this.store.set("browserBounds", _.omit(bounds, ["x", "y"]));
  };

  showWindow = () => {
    if (!this.window) {
      this.window = this.create();
      this.window.on("resized", this.handleResize);
      this.window.webContents.on("will-navigate", (event, url) => {
        if (!isTrustedAppURL(url, isDev)) event.preventDefault();
      });
      this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    }

    this.window.show();
    if (isDev && process.env.OPEN_DEVTOOLS === "true") {
      this.window.webContents.openDevTools();
    }

    const browserBounds = this.store.get("browserBounds");
    if (browserBounds) {
      this.window.setBounds(browserBounds);
    }
  };

  hideWindow = () => {
    if (!this.window) return;

    this.window.close();
  };

  send(channel: string, ...args: unknown[]) {
    if (!this.window) return;

    this.window.webContents.send(channel, ...args);
  }
}
