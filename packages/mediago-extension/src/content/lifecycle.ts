import type { PageActionController } from "./page-action-controller";

export interface ContentScriptWindowTarget {
  addEventListener(type: "unload", listener: () => void): void;
  removeEventListener(type: "unload", listener: () => void): void;
}

const activeContentScripts = new WeakMap<object, () => void>();

export function installPageActionContentScript(
  windowTarget: ContentScriptWindowTarget,
  start: () => Promise<PageActionController>,
): () => void {
  const existing = activeContentScripts.get(windowTarget);
  if (existing) return existing;

  let controller: PageActionController | null = null;
  let disposed = false;

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    activeContentScripts.delete(windowTarget);
    windowTarget.removeEventListener("unload", cleanup);
    controller?.destroy();
    controller = null;
  };

  activeContentScripts.set(windowTarget, cleanup);
  windowTarget.addEventListener("unload", cleanup);
  void start().then((nextController) => {
    if (disposed) nextController.destroy();
    else controller = nextController;
  }, cleanup);
  return cleanup;
}
