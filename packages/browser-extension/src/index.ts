import { startPageRuntime } from "./runtime";
import { findPageAdapter } from "./site-adapters/registry";

const RUNTIME_CLEANUP_KEY = "__mediagoPageRuntimeCleanup__";

type RuntimeWindow = Window & {
  [RUNTIME_CLEANUP_KEY]?: () => void;
};

const runtimeWindow = window as RuntimeWindow;
const adapter = findPageAdapter(window.location);

if (adapter && !runtimeWindow[RUNTIME_CLEANUP_KEY]) {
  const stopRuntime = startPageRuntime({
    adapter,
    document,
    transport(candidate) {
      window.electron.browser.showDownloadDialog([candidate]);
    },
  });

  const cleanup = () => {
    stopRuntime();
    window.removeEventListener("unload", cleanup);
    if (runtimeWindow[RUNTIME_CLEANUP_KEY] === cleanup) {
      delete runtimeWindow[RUNTIME_CLEANUP_KEY];
    }
  };

  runtimeWindow[RUNTIME_CLEANUP_KEY] = cleanup;
  window.addEventListener("unload", cleanup, { once: true });
}
