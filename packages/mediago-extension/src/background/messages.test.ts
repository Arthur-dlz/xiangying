import { afterEach, expect, test, vi } from "vitest";

import type {
  ExtensionMessage,
  ExtensionResponse,
  PageActionResult,
} from "../shared/types";
import { registerMessageRouter } from "./messages";
import type { PageActionHandler } from "./page-action";
import type { TabSourceService } from "./tab-sources";

vi.mock("./mediago-client", () => ({
  importSources: vi.fn(),
  probe: vi.fn(),
}));

vi.mock("./page-cookies", () => ({
  enrichSourcesWithPageCookies: vi.fn(async (sources) => sources),
}));

type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: ExtensionResponse) => void,
) => boolean | undefined;

function serviceDouble(): TabSourceService {
  return {
    pendingTabCount: 0,
    addSource: vi.fn(async () => []),
    addSources: vi.fn(async () => []),
    clear: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    ensureResolvedSource: vi.fn(),
  } as unknown as TabSourceService;
}

function installRouter(
  sourceService: TabSourceService,
  pageActionHandler: PageActionHandler,
): MessageListener {
  let listener: MessageListener | undefined;
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: {
        addListener: vi.fn((registered: MessageListener) => {
          listener = registered;
        }),
      },
    },
  });
  registerMessageRouter(sourceService, pageActionHandler);
  if (!listener) throw new Error("message listener not registered");
  return listener;
}

function dispatch(
  listener: MessageListener,
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
): Promise<ExtensionResponse> {
  return new Promise((resolve) => {
    expect(listener(message, sender, resolve)).toBe(true);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("registered CLEAR_SOURCES messages delegate to TabSourceService", async () => {
  let listener: MessageListener | undefined;
  vi.stubGlobal("chrome", {
    action: { setBadgeText: vi.fn(async () => undefined) },
    runtime: {
      onMessage: {
        addListener: vi.fn((registered: MessageListener) => {
          listener = registered;
        }),
      },
    },
    storage: {
      session: { remove: vi.fn(async () => undefined) },
    },
  });
  const service = serviceDouble();
  registerMessageRouter(service);
  if (!listener) throw new Error("message listener not registered");

  const response = new Promise<ExtensionResponse>((resolve) => {
    expect(listener?.({ type: "CLEAR_SOURCES", tabId: 21 }, {}, resolve)).toBe(
      true,
    );
  });

  await expect(response).resolves.toEqual({ type: "OK" });
  expect(service.clear).toHaveBeenCalledWith(21);
});

test.each([
  { type: "PAGE_ACTION_RESULT", ok: true },
  {
    type: "PAGE_ACTION_RESULT",
    ok: false,
    error: "UNSUPPORTED_PAGE",
  },
] satisfies PageActionResult[])(
  "forwards the real sender and returns the page-action response %#",
  async (result) => {
    const service = serviceDouble();
    const pageActionHandler = vi.fn(async () => result);
    const listener = installRouter(service, pageActionHandler);
    const sender = {
      id: "extension-id",
      frameId: 0,
      tab: { id: 31 },
    } as chrome.runtime.MessageSender;

    const response = dispatch(
      listener,
      { type: "ADD_CURRENT_PAGE_TO_POPUP" },
      sender,
    );

    await expect(response).resolves.toEqual(result);
    expect(pageActionHandler).toHaveBeenCalledOnce();
    expect(pageActionHandler).toHaveBeenCalledWith(sender, {
      type: "ADD_CURRENT_PAGE_TO_POPUP",
    });
  },
);

test("forwards a page candidate and the real sender to the page-action handler", async () => {
  const service = serviceDouble();
  const result = { type: "PAGE_ACTION_RESULT", ok: true } as const;
  const pageActionHandler = vi.fn(async () => result);
  const listener = installRouter(service, pageActionHandler);
  const sender = {
    id: "extension-id",
    frameId: 0,
    tab: { id: 31 },
    url: "https://www.bilibili.com/",
  } as chrome.runtime.MessageSender;
  const candidate = {
    name: "Card title",
    url: "https://www.bilibili.com/video/BV1card",
    type: "bilibili",
  } as const;

  await expect(
    dispatch(
      listener,
      { type: "ADD_PAGE_CANDIDATE_TO_POPUP", candidate },
      sender,
    ),
  ).resolves.toEqual(result);
  expect(pageActionHandler).toHaveBeenCalledWith(sender, {
    type: "ADD_PAGE_CANDIDATE_TO_POPUP",
    candidate,
  });
});

test.each([
  ["missing", { type: "ADD_PAGE_CANDIDATE_TO_POPUP" }],
  ["null", { type: "ADD_PAGE_CANDIDATE_TO_POPUP", candidate: null }],
  ["false", { type: "ADD_PAGE_CANDIDATE_TO_POPUP", candidate: false }],
  ["zero", { type: "ADD_PAGE_CANDIDATE_TO_POPUP", candidate: 0 }],
  ["empty string", { type: "ADD_PAGE_CANDIDATE_TO_POPUP", candidate: "" }],
  ["array", { type: "ADD_PAGE_CANDIDATE_TO_POPUP", candidate: [] }],
] as const)(
  "preserves explicit candidate mode for a %s payload",
  async (_label, malformedMessage) => {
    const service = serviceDouble();
    const result = { type: "PAGE_ACTION_RESULT", ok: false } as const;
    const pageActionHandler = vi.fn(async () => result);
    const listener = installRouter(service, pageActionHandler);
    const sender = {
      id: "extension-id",
      frameId: 0,
      tab: { id: 31 },
      url: "https://www.bilibili.com/video/BV1current",
    } as chrome.runtime.MessageSender;

    await dispatch(
      listener,
      malformedMessage as unknown as ExtensionMessage,
      sender,
    );

    expect(pageActionHandler).toHaveBeenCalledWith(sender, malformedMessage);
  },
);

test("uses a PAGE_ACTION_RESULT fallback when the page-action handler rejects", async () => {
  const service = serviceDouble();
  const pageActionHandler = vi.fn(async () => {
    throw new Error("secret stack details");
  });
  const listener = installRouter(service, pageActionHandler);

  await expect(
    dispatch(listener, { type: "ADD_CURRENT_PAGE_TO_POPUP" }, {
      id: "extension-id",
      frameId: 0,
    } as chrome.runtime.MessageSender),
  ).resolves.toEqual({
    type: "PAGE_ACTION_RESULT",
    ok: false,
    error: "INTERNAL_ERROR",
  });
});

test("uses a PAGE_ACTION_RESULT fallback when the candidate handler rejects", async () => {
  const service = serviceDouble();
  const pageActionHandler = vi.fn(async () => {
    throw new Error("secret stack details");
  });
  const listener = installRouter(service, pageActionHandler);

  await expect(
    dispatch(
      listener,
      {
        type: "ADD_PAGE_CANDIDATE_TO_POPUP",
        candidate: {
          name: "Card title",
          url: "https://www.bilibili.com/video/BV1card",
          type: "bilibili",
        },
      },
      {
        id: "extension-id",
        frameId: 0,
      } as chrome.runtime.MessageSender,
    ),
  ).resolves.toEqual({
    type: "PAGE_ACTION_RESULT",
    ok: false,
    error: "INTERNAL_ERROR",
  });
});
