import { describe, expect, test } from "vitest";

import { verifyArtifactGraphs } from "./verify-build-artifacts-core.ts";

const validWorkerAsset = "chrome.webRequest chrome.runtime.onMessage";
const validContentAsset = [
  "mediagoPageAction",
  "failureResetMs",
  "bili-video-card__wrap",
  "ytd-rich-item-renderer",
  "mediago-download-button",
  "data-mg-injected",
].join(" ");

function verify(
  overrides: { workerAsset?: string; contentAsset?: string } = {},
) {
  return verifyArtifactGraphs({
    workerAssetPath: "assets/worker.js",
    contentAssetPath: "assets/content.js",
    workerAsset: overrides.workerAsset ?? validWorkerAsset,
    contentAsset: overrides.contentAsset ?? validContentAsset,
  });
}

describe("extension artifact graph boundaries", () => {
  test("accepts separated worker and shared site-adapter content graphs", () => {
    expect(() => verify()).not.toThrow();
  });

  test.each([
    "bili-video-card__wrap",
    "ytd-rich-item-renderer",
    "mediago-download-button",
    "data-mg-injected",
    "startPageRuntime",
    "MutationObserver",
  ])("rejects worker graph DOM runtime marker %s", (marker) => {
    expect(() =>
      verify({ workerAsset: `${validWorkerAsset} ${marker}` }),
    ).toThrow("content-script code");
  });

  test.each([
    "showDownloadDialog",
    "window.electron",
    "globalThis.electron",
    "contextBridge",
  ])("rejects content graph Electron marker %s", (marker) => {
    expect(() =>
      verify({ contentAsset: `${validContentAsset} ${marker}` }),
    ).toThrow("forbidden runtime marker");
  });
});
