import type { ExtensionMessage, ExtensionResponse } from "../shared/types";
import { importSources, probe } from "./mediago-client";
import { enrichSourcesWithPageCookies } from "./page-cookies";
import { createPageActionHandler, type PageActionHandler } from "./page-action";
import { loadSettings, loadTabSources, saveSettings } from "./storage";
import { tabSourceService, type TabSourceService } from "./tab-sources";

/**
 * Central message router used by the popup and options page.
 *
 * Return type is intentionally a Promise so we can use
 * `chrome.runtime.onMessage`'s `sendResponse` with `return true`
 * semantics cleanly via an async wrapper.
 */
async function handle(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
  sourceService: TabSourceService,
  pageActionHandler: PageActionHandler,
): Promise<ExtensionResponse> {
  switch (message.type) {
    case "GET_SOURCES": {
      const sources = await loadTabSources(message.tabId);
      return { type: "SOURCES", sources };
    }
    case "CLEAR_SOURCES": {
      await sourceService.clear(message.tabId);
      return { type: "OK" };
    }
    case "ADD_CURRENT_PAGE_TO_POPUP": {
      return pageActionHandler(sender, message);
    }
    case "ADD_PAGE_CANDIDATE_TO_POPUP": {
      return pageActionHandler(sender, message);
    }
    case "GET_SETTINGS": {
      const settings = await loadSettings();
      return { type: "SETTINGS", settings };
    }
    case "SAVE_SETTINGS": {
      await saveSettings(message.settings);
      return { type: "OK" };
    }
    case "TEST_CONNECTION": {
      const settings = await loadSettings();
      const status = await probe(
        message.mode,
        message.serverUrl,
        message.apiKey || undefined,
        settings.language === "system" ? undefined : settings.language,
      );
      return { type: "STATUS", status };
    }
    case "IMPORT_SOURCES": {
      const settings = await loadSettings();
      const sources =
        settings.mode !== "desktop-schema" && settings.downloadNow
          ? await enrichSourcesWithPageCookies(message.sources)
          : message.sources;
      const result = await importSources(settings, sources);
      return {
        type: "IMPORT_RESULT",
        ok: result.ok,
        count: result.count,
        error: result.error,
      };
    }
  }
}

export function registerMessageRouter(
  sourceService: TabSourceService = tabSourceService,
  pageActionHandler: PageActionHandler = createPageActionHandler(sourceService),
): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // `handle` returns a promise; we funnel it into sendResponse and
    // return `true` to keep the channel open (MV3 requirement).
    void handle(
      message as ExtensionMessage,
      sender,
      sourceService,
      pageActionHandler,
    )
      .then(sendResponse)
      .catch((err) => {
        const messageType = (message as { type?: unknown } | null)?.type;
        if (
          messageType === "ADD_CURRENT_PAGE_TO_POPUP" ||
          messageType === "ADD_PAGE_CANDIDATE_TO_POPUP"
        ) {
          sendResponse({
            type: "PAGE_ACTION_RESULT",
            ok: false,
            error: "INTERNAL_ERROR",
          });
          return;
        }
        sendResponse({
          type: "IMPORT_RESULT",
          ok: false,
          count: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return true;
  });
}
