import type { PageCandidate } from "@mediago/browser-extension/site-adapters";
import { matchesPageAdapterLocation } from "@mediago/browser-extension/site-adapter-matches";
import { matchPageUrl } from "@mediago/common";

import type { PageActionErrorCode, PageActionResult } from "../shared/types";
import type {
  EnsureResolvedSourceResult,
  TabSourceService,
} from "./tab-sources";

export interface PageActionPorts {
  runtimeId: string;
  getTab(tabId: number): Promise<chrome.tabs.Tab>;
  openPopup(options: { windowId: number }): Promise<void>;
  reportPopupOpenFailure(error: unknown): void;
  now(): number;
}

export type PageActionCommand =
  | { type: "ADD_CURRENT_PAGE_TO_POPUP" }
  | { type: "ADD_PAGE_CANDIDATE_TO_POPUP"; candidate: unknown };

export type PageActionHandler = (
  sender: chrome.runtime.MessageSender,
  command: PageActionCommand,
) => Promise<PageActionResult>;

function defaultPorts(): PageActionPorts {
  return {
    runtimeId: chrome.runtime.id,
    getTab: (tabId) => chrome.tabs.get(tabId),
    openPopup: (options) => chrome.action.openPopup(options),
    reportPopupOpenFailure(error) {
      // eslint-disable-next-line no-console -- Popup UI failures need a diagnostic sink.
      console.warn(
        "[MediaGo extension] source added, but the popup could not be opened",
        error,
      );
    },
    now: () => Date.now(),
  };
}

class PageActionFailure extends Error {
  readonly code: PageActionErrorCode;

  constructor(code: PageActionErrorCode) {
    super(code);
    this.name = "PageActionFailure";
    this.code = code;
  }
}

function failure(error: PageActionErrorCode): PageActionResult {
  return { type: "PAGE_ACTION_RESULT", ok: false, error };
}

function isAdapterPageUrl(url: string): boolean {
  try {
    return matchesPageAdapterLocation(new URL(url));
  } catch {
    return false;
  }
}

function validateCandidate(candidate: unknown): PageCandidate | null {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return null;
  }
  const value = candidate as Record<string, unknown>;
  const name = value.name;
  const url = value.url;
  const type = value.type;
  if (typeof name !== "string" || typeof url !== "string") return null;

  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return null;
    }
  } catch {
    return null;
  }

  const filter = matchPageUrl(url);
  if (!filter || filter.type !== type) return null;
  return { name, url, type: filter.type };
}

export function createPageActionHandler(
  sourceService: TabSourceService,
  ports: PageActionPorts = defaultPorts(),
): PageActionHandler {
  return async (sender, command) => {
    const tabId = sender.tab?.id;
    const senderUrl = sender.url;
    if (
      sender.id !== ports.runtimeId ||
      sender.frameId !== 0 ||
      typeof senderUrl !== "string" ||
      senderUrl.length === 0 ||
      typeof tabId !== "number" ||
      !Number.isInteger(tabId) ||
      tabId < 0
    ) {
      return failure("INVALID_SENDER");
    }
    if (
      !command ||
      (command.type !== "ADD_CURRENT_PAGE_TO_POPUP" &&
        command.type !== "ADD_PAGE_CANDIDATE_TO_POPUP")
    ) {
      return failure("UNSUPPORTED_PAGE");
    }
    const candidateMode = command.type === "ADD_PAGE_CANDIDATE_TO_POPUP";
    const validatedCandidate = candidateMode
      ? validateCandidate(command.candidate)
      : undefined;
    if (candidateMode && !validatedCandidate) {
      return failure("UNSUPPORTED_PAGE");
    }
    if (validatedCandidate && !isAdapterPageUrl(senderUrl)) {
      return failure("UNSUPPORTED_PAGE");
    }
    let ensured: EnsureResolvedSourceResult<{ validatedUrl: string }>;
    try {
      ensured = await sourceService.ensureResolvedSource(tabId, async () => {
        let tab: chrome.tabs.Tab;
        try {
          tab = await ports.getTab(tabId);
        } catch {
          throw new PageActionFailure("TAB_UNAVAILABLE");
        }
        const url = tab.url;
        const filter = url ? matchPageUrl(url) : undefined;
        const sourceType = validatedCandidate?.type ?? filter?.type;
        if (
          !url ||
          !sourceType ||
          (validatedCandidate ? !isAdapterPageUrl(url) : !filter)
        ) {
          throw new PageActionFailure("UNSUPPORTED_PAGE");
        }
        if (url !== senderUrl) {
          throw new PageActionFailure("PAGE_CHANGED");
        }
        if (tab.active !== true) {
          throw new PageActionFailure("TAB_INACTIVE");
        }
        if (
          typeof tab.windowId !== "number" ||
          !Number.isInteger(tab.windowId) ||
          tab.windowId < 0
        ) {
          throw new PageActionFailure("WINDOW_UNAVAILABLE");
        }
        const detectedAt = ports.now();
        return {
          source: {
            id: `page-action-${tabId}-${detectedAt}`,
            url: validatedCandidate?.url ?? url,
            documentURL: url,
            name:
              validatedCandidate?.name.trim() ||
              validatedCandidate?.url ||
              tab.title ||
              url,
            type: sourceType,
            detectedAt,
          },
          meta: { validatedUrl: url },
        };
      });
    } catch (error) {
      return failure(
        error instanceof PageActionFailure
          ? error.code
          : "SOURCE_UPDATE_FAILED",
      );
    }
    let latestTab: chrome.tabs.Tab;
    try {
      latestTab = await ports.getTab(tabId);
    } catch {
      return failure("TAB_UNAVAILABLE");
    }

    const latestUrl = latestTab.url;
    if (
      !latestUrl ||
      latestUrl !== ensured.meta.validatedUrl ||
      (validatedCandidate
        ? !isAdapterPageUrl(latestUrl)
        : !matchPageUrl(latestUrl))
    ) {
      return failure("PAGE_CHANGED");
    }
    if (latestTab.active !== true) return failure("TAB_INACTIVE");

    const windowId = latestTab.windowId;
    if (
      typeof windowId !== "number" ||
      !Number.isInteger(windowId) ||
      windowId < 0
    ) {
      return failure("WINDOW_UNAVAILABLE");
    }

    try {
      await ports.openPopup({ windowId });
    } catch (error) {
      try {
        ports.reportPopupOpenFailure(error);
      } catch {
        // Diagnostics must not turn a successfully staged source into a failure.
      }
    }
    return { type: "PAGE_ACTION_RESULT", ok: true };
  };
}
