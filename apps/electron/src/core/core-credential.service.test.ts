import { afterEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  listener: undefined as unknown,
  onBeforeSendHeaders: vi.fn(),
}));

vi.mock("electron", () => ({
  session: {
    defaultSession: {
      webRequest: {
        onBeforeSendHeaders: (...args: unknown[]) => {
          electronMocks.onBeforeSendHeaders(...args);
          electronMocks.listener = args[1];
        },
      },
    },
  },
}));
vi.mock("electron-is-dev", () => ({ default: true }));

import {
  applyCoreAuthorization,
  CoreCredentialService,
} from "./core-credential.service";
import {
  registerTrustedAppContents,
  unregisterTrustedAppContents,
} from "./trust-policy";

describe("CoreCredentialService", () => {
  afterEach(() => {
    electronMocks.onBeforeSendHeaders.mockReset();
    electronMocks.listener = undefined;
    unregisterTrustedAppContents(123);
  });

  it("replaces the trusted UI API key only for its exact Core request", () => {
    const service = new CoreCredentialService(undefined, true);
    service.start("http://127.0.0.1:39719", "secret");
    registerTrustedAppContents(123);
    const mainFrame = { url: "http://localhost:8500/" };
    const handler = electronMocks.listener as (
      details: Record<string, unknown>,
      callback: (response: { requestHeaders: Record<string, string> }) => void,
    ) => void;
    const requestHeaders = { Authorization: "Bearer user-key", Accept: "*/*" };

    const authorized = vi.fn();
    handler(
      {
        url: "http://127.0.0.1:39719/api/config",
        webContentsId: 123,
        frame: mainFrame,
        webContents: { id: 123, mainFrame },
        requestHeaders,
      },
      authorized,
    );
    expect(authorized.mock.calls[0]?.[0].requestHeaders).toEqual({
      Authorization: "Bearer secret",
      Accept: "*/*",
    });

    const remote = vi.fn();
    handler(
      {
        url: "http://127.0.0.1:39719/api/config",
        webContentsId: 456,
        frame: { url: "https://remote.example" },
        webContents: { id: 456, mainFrame: { url: "https://remote.example" } },
        requestHeaders: { Authorization: "Bearer secret" },
      },
      remote,
    );
    expect(remote.mock.calls[0]?.[0].requestHeaders).toEqual({});

    const redirected = vi.fn();
    handler(
      {
        url: "https://attacker.example/collect",
        webContentsId: 123,
        frame: mainFrame,
        webContents: { id: 123, mainFrame },
        requestHeaders: { Authorization: "Bearer secret" },
      },
      redirected,
    );
    expect(redirected.mock.calls[0]?.[0].requestHeaders).toEqual({});

    service.stop();
    expect(electronMocks.onBeforeSendHeaders).toHaveBeenLastCalledWith(null);
  });

  it("preserves unrelated Authorization headers when it does not inject", () => {
    expect(
      applyCoreAuthorization(
        { authorization: "Bearer user-key", Accept: "*/*" },
        "secret",
        false,
      ),
    ).toEqual({ authorization: "Bearer user-key", Accept: "*/*" });
  });
});
