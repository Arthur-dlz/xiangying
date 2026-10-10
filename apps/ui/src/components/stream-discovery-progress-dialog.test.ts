/** @vitest-environment happy-dom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { StreamDiscoveryProgressDialog } =
  await import("./stream-discovery-progress-dialog");

describe("StreamDiscoveryProgressDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("shows probing state and the submitted URL in a separate dialog", async () => {
    await act(async () => {
      root.render(
        createElement(StreamDiscoveryProgressDialog, {
          onCancel: vi.fn(),
          open: true,
          phase: "probing",
          url: "https://example.com/watch",
        }),
      );
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("probingStreamSource");
    expect(dialog?.textContent).toContain("https://example.com/watch");
  });

  it("cancels discovery from the progress dialog", async () => {
    const onCancel = vi.fn();
    await act(async () => {
      root.render(
        createElement(StreamDiscoveryProgressDialog, {
          onCancel,
          open: true,
          phase: "discovering",
          url: "https://example.com/watch",
        }),
      );
    });

    const cancel = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "cancel",
    );
    await act(async () => cancel?.click());

    expect(onCancel).toHaveBeenCalledOnce();
  });
});
