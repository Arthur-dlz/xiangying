import { DownloadType, IPC } from "@mediago/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElectronControllerBinder } from "./electronBinder";
import {
  bindRemotePayloadToTab,
  getIpcTrust,
  isAllowedRemoteBrowserChannel,
  isTrustedAppURL,
  registerRemoteBrowserContents,
  registerTrustedAppContents,
  unregisterRemoteBrowserContents,
  unregisterTrustedAppContents,
} from "./trust-policy";

function makeEvent(url: string, id = 17, destroyed = false) {
  const mainFrame = { url };
  const sender = {
    id,
    isDestroyed: () => destroyed,
    mainFrame,
    getURL: () => url,
  };
  return { sender, senderFrame: mainFrame };
}

describe("Electron IPC sender trust policy", () => {
  beforeEach(() => {
    unregisterRemoteBrowserContents(17);
    unregisterTrustedAppContents(17);
    registerTrustedAppContents(17);
    process.env.APP_NAME = "xiangying";
  });

  it("accepts only the exact loopback development origin and app scheme", () => {
    expect(isTrustedAppURL("http://localhost:8500/browser", true)).toBe(true);
    expect(isTrustedAppURL("http://127.0.0.1:8500/", true)).toBe(true);
    expect(isTrustedAppURL("http://localhost.evil:8500/", true)).toBe(false);
    expect(isTrustedAppURL("http://localhost:8501/", true)).toBe(false);
    expect(isTrustedAppURL("http://localhost:8500.evil/", true)).toBe(false);
    expect(isTrustedAppURL("xiangying://index.html/browser", false)).toBe(true);
    expect(isTrustedAppURL("xiangying://index.html.evil/browser", false)).toBe(
      false,
    );
  });

  it("requires a live sender's top frame and an allowed app origin", () => {
    const event = makeEvent("http://localhost:8500/");
    expect(getIpcTrust(event, true)).toEqual({ trusted: true, kind: "app" });
    expect(
      getIpcTrust(
        {
          ...event,
          senderFrame: { url: "http://localhost:8500/iframe" },
        },
        true,
      ),
    ).toEqual({ trusted: false });
    expect(getIpcTrust(makeEvent("https://attacker.example"), true)).toEqual({
      trusted: false,
    });
    expect(
      getIpcTrust(makeEvent("http://localhost:8500/", 17, true), true),
    ).toEqual({
      trusted: false,
    });
  });

  it("limits remote pages to the sniffed download handoff and binds the sender tab", () => {
    registerRemoteBrowserContents(17, "owned-tab", true);
    expect(
      getIpcTrust(makeEvent("https://media.example/watch", 17), true),
    ).toEqual({
      trusted: true,
      kind: "remote-browser",
      tabId: "owned-tab",
      canSubmitCandidates: true,
    });
    expect(isAllowedRemoteBrowserChannel(IPC.browser.showDownloadDialog)).toBe(
      true,
    );
    expect(isAllowedRemoteBrowserChannel(IPC.library.list)).toBe(false);
    expect(getIpcTrust(makeEvent("http://localhost:8500/", 17), true)).toEqual({
      trusted: true,
      kind: "remote-browser",
      tabId: "owned-tab",
      canSubmitCandidates: true,
    });
    expect(
      getIpcTrust(makeEvent("xiangying://index.html/", 17), false),
    ).toEqual({ trusted: false });
    expect(
      bindRemotePayloadToTab(
        IPC.browser.showDownloadDialog,
        {
          tabId: "attacker-tab",
          data: [
            {
              name: "video",
              url: "https://media.example/a.m3u8",
              type: DownloadType.m3u8,
            },
          ],
        },
        "owned-tab",
      ),
    ).toEqual({
      tabId: "owned-tab",
      data: [
        {
          name: "video",
          url: "https://media.example/a.m3u8",
          type: DownloadType.m3u8,
        },
      ],
    });
    expect(
      bindRemotePayloadToTab(
        IPC.browser.showDownloadDialog,
        [
          {
            name: "bad",
            url: "javascript:alert(1)",
            type: DownloadType.direct,
          },
        ],
        "owned-tab",
      ),
    ).toBeNull();
    expect(
      bindRemotePayloadToTab(
        IPC.browser.showDownloadDialog,
        [
          {
            name: "bad",
            url: "https://media.example/video.mp4",
            type: DownloadType.direct,
            downloadDir: "C:/",
          },
        ],
        "owned-tab",
      ),
    ).toBeNull();
  });

  it("rejects untrusted and remote privileged IPC before calling a controller", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = {
      handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
      on: vi.fn(),
    };
    const logger = { error: vi.fn() };
    const controller = { handle: vi.fn(() => "called") };
    const binder = createElectronControllerBinder(ipc, logger as never);
    const invoke = (channel: string) =>
      handlers.get(channel)?.(makeEvent("https://attacker.example"));

    binder({
      controller,
      propertyKey: "handle",
      handler: controller.handle,
      event: IPC.dialog.open,
      method: "handle",
    });
    binder({
      controller,
      propertyKey: "handle",
      handler: controller.handle,
      event: IPC.browser.showDownloadDialog,
      method: "handle",
    });
    binder({
      controller,
      propertyKey: "handle",
      handler: controller.handle,
      event: IPC.library.list,
      method: "handle",
    });

    await expect(invoke(IPC.dialog.open)).resolves.toMatchObject({ code: -1 });
    await expect(
      handlers.get(IPC.library.list)?.(makeEvent("xiangying://index.html/")),
    ).resolves.toMatchObject({ code: 0 });
    expect(
      getIpcTrust(makeEvent("xiangying://index.html/", 18), false),
    ).toEqual({ trusted: false });
    await expect(
      handlers.get(IPC.browser.showDownloadDialog)?.(
        makeEvent("https://media.example/watch", 17),
        [],
      ),
    ).resolves.toMatchObject({ code: -1 });
    registerRemoteBrowserContents(17, "agent-tab", false);
    await expect(
      handlers.get(IPC.browser.showDownloadDialog)?.(
        makeEvent("https://media.example/watch", 17),
        [
          {
            name: "ok",
            url: "https://media.example/a.mp4",
            type: DownloadType.direct,
          },
        ],
      ),
    ).resolves.toMatchObject({ code: -1 });
    expect(controller.handle).toHaveBeenCalledOnce();
  });
});
