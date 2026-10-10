function fail(message: string): never {
  throw new Error(`Extension build artifact check failed: ${message}`);
}

const WORKER_CONTENT_MARKERS = [
  "bili-video-card__wrap",
  "ytd-rich-item-renderer",
  "mediago-download-button",
  "data-mg-injected",
  "startPageRuntime",
  "MutationObserver",
];

const CONTENT_FORBIDDEN_RUNTIME_MARKERS = [
  "showDownloadDialog",
  ".electron",
  "electronAPI",
  "ipcRenderer",
  "contextBridge",
  "react-dom",
  "i18next",
];

export function verifyArtifactGraphs({
  workerAssetPath,
  contentAssetPath,
  workerAsset,
  contentAsset,
}: {
  workerAssetPath: string;
  contentAssetPath: string;
  workerAsset: string;
  contentAsset: string;
}): void {
  if (
    !workerAsset.includes("chrome.webRequest") ||
    !workerAsset.includes("chrome.runtime.onMessage")
  ) {
    fail(`${workerAssetPath} does not register background listeners`);
  }
  for (const marker of [
    "mediagoPageAction",
    "failureResetMs",
    ...WORKER_CONTENT_MARKERS,
  ]) {
    if (workerAsset.includes(marker)) {
      fail(
        `${workerAssetPath} contains page action content-script code marker ${marker}`,
      );
    }
  }
  if (
    !contentAsset.includes("mediagoPageAction") ||
    !contentAsset.includes("failureResetMs")
  ) {
    fail(
      `${contentAssetPath} does not initialize the page action content script`,
    );
  }
  if (contentAsset.includes("chrome.webRequest")) {
    fail(`${contentAssetPath} contains background sniffer registration`);
  }

  for (const marker of [
    "bili-video-card__wrap",
    "ytd-rich-item-renderer",
    "mediago-download-button",
    "data-mg-injected",
  ]) {
    if (!contentAsset.includes(marker)) {
      fail(
        `${contentAssetPath} does not contain shared adapter marker ${marker}`,
      );
    }
  }

  for (const marker of CONTENT_FORBIDDEN_RUNTIME_MARKERS) {
    if (contentAsset.includes(marker)) {
      fail(`${contentAssetPath} contains forbidden runtime marker ${marker}`);
    }
  }
}
