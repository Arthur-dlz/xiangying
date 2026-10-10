import { IpcEvent } from "@mediago/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getIpcTrust } from "../core/trust-policy";

const mocks = vi.hoisted(() => ({
  views: [] as Array<{
    options: { webPreferences?: Record<string, unknown> };
    setBackgroundColor: ReturnType<typeof vi.fn>;
    setBounds: ReturnType<typeof vi.fn>;
    webContents: Record<string, any>;
    handlers: Map<string, Array<(...args: any[]) => void>>;
    openHandler?: (details: unknown) => unknown;
    trustDuringLoad?: unknown;
    emit(event: string, ...args: unknown[]): void;
  }>,
  nextId: 50,
}));

vi.mock("electron", () => ({
  WebContentsView: class {
    constructor(options: { webPreferences?: Record<string, unknown> }) {
      const handlers = new Map<string, Array<(...args: any[]) => void>>();
      const view: (typeof mocks.views)[number] = {
        options,
        handlers,
        setBackgroundColor: vi.fn(),
        setBounds: vi.fn(),
        webContents: {} as Record<string, any>,
      };
      Object.assign(this, view);
      let currentURL = "";
      const wc = view.webContents;
      wc.id = mocks.nextId++;
      wc.isDestroyed = vi.fn(() => false);
      wc.getURL = vi.fn(() => currentURL);
      wc.mainFrame = {
        get url() {
          return currentURL;
        },
      };
      wc.on = vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      });
      wc.once = vi.fn((event: string, handler: (...args: any[]) => void) => {
        const onceHandler = (...args: any[]) => {
          handlers.set(
            event,
            (handlers.get(event) ?? []).filter((item) => item !== onceHandler),
          );
          handler(...args);
        };
        handlers.set(event, [...(handlers.get(event) ?? []), onceHandler]);
      });
      wc.loadURL = vi.fn(async (url: string) => {
        currentURL = url;
        const frame = { url };
        wc.mainFrame = frame;
        view.trustDuringLoad = getIpcTrust(
          { sender: wc, senderFrame: frame },
          false,
        );
      });
      wc.setWindowOpenHandler = vi.fn(
        (handler: (details: unknown) => unknown) => {
          view.openHandler = handler;
        },
      );
      wc.send = vi.fn();
      wc.openDevTools = vi.fn();
      view.emit = (event: string, ...args: unknown[]) => {
        for (const handler of handlers.get(event) ?? []) handler(...args);
      };
      mocks.views.push(view);
    }
  },
}));

vi.mock("electron-is-dev", () => ({ default: false }));
vi.mock("../utils", () => ({
  defaultScheme: "xiangying",
  preloadUrl: "C:/test/preload.cjs",
}));
vi.mock("../windows/browser.window", () => ({
  default: class BrowserWindow {},
}));
vi.mock("../windows/main.window", () => ({ default: class MainWindow {} }));
vi.mock("../vendor/ElectronLogger", () => ({
  default: class ElectronLogger {},
}));

import OverlayDialogService from "./overlay-dialog.service";

describe("OverlayDialogService", () => {
  const previousAppName = process.env.APP_NAME;
  let service: OverlayDialogService;
  let parentWindow: {
    contentView: {
      addChildView: ReturnType<typeof vi.fn>;
      removeChildView: ReturnType<typeof vi.fn>;
    };
    getContentBounds: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    process.env.APP_NAME = "xiangying";
    mocks.views.length = 0;
    parentWindow = {
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      getContentBounds: vi.fn(() => ({ width: 800, height: 600 })),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    service = new OverlayDialogService(
      { window: null } as never,
      { window: parentWindow } as never,
      { error: vi.fn() } as never,
    );
  });

  afterEach(() => {
    if (previousAppName === undefined) delete process.env.APP_NAME;
    else process.env.APP_NAME = previousAppName;
  });

  it("registers the local overlay before loading with safe preferences", async () => {
    await service.init();
    const view = mocks.views[0];
    expect(view.options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      sandbox: true,
    });
    expect(view.trustDuringLoad).toEqual({ trusted: true, kind: "app" });
    expect(view.webContents.loadURL).toHaveBeenCalledWith(
      "xiangying://index.html/download-dialog",
    );
  });

  it("unregisters the overlay when its WebContents is destroyed", async () => {
    await service.init();
    const view = mocks.views[0];
    const trustedEvent = {
      sender: view.webContents,
      senderFrame: view.webContents.mainFrame,
    };
    expect(getIpcTrust(trustedEvent, false)).toEqual({
      trusted: true,
      kind: "app",
    });

    view.emit("destroyed");

    expect(getIpcTrust(trustedEvent, false)).toEqual({ trusted: false });
  });

  it("blocks external navigation and new windows while keeping overlay show/hide", async () => {
    await service.init();
    const view = mocks.views[0];
    const preventDefault = vi.fn();
    view.emit("will-navigate", { preventDefault }, "https://example.com/");
    expect(preventDefault).toHaveBeenCalledOnce();
    const preventRedirect = vi.fn();
    view.emit(
      "will-redirect",
      { preventDefault: preventRedirect },
      "https://example.com/redirected",
    );
    expect(preventRedirect).toHaveBeenCalledOnce();
    const allowNavigation = vi.fn();
    view.emit(
      "will-navigate",
      { preventDefault: allowNavigation },
      "xiangying://index.html/download-dialog",
    );
    expect(allowNavigation).not.toHaveBeenCalled();
    expect(view.openHandler?.({})).toEqual({ action: "deny" });

    view.emit("dom-ready");
    service.show([
      {
        name: "fixture",
        url: "https://example.com/file.mp4",
        type: "direct",
      } as never,
    ]);
    expect(parentWindow.contentView.addChildView).toHaveBeenCalledOnce();
    expect(view.webContents.send).toHaveBeenCalledWith(
      IpcEvent.browser.showOverlayDialog,
      [
        {
          name: "fixture",
          url: "https://example.com/file.mp4",
          type: "direct",
        },
      ],
    );
    service.hide();
    expect(parentWindow.contentView.removeChildView).toHaveBeenCalledOnce();
    expect(parentWindow.removeListener).toHaveBeenCalledWith(
      "resize",
      expect.any(Function),
    );
  });
});
