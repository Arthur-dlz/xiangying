/** @vitest-environment happy-dom */

import { DownloadType } from "@mediago/common";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadFormItem } from "@/store/download-dialog";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/store/config", () => ({
  downloadFormSelector: (state: unknown) => state,
  useConfigStore: (selector: (state: unknown) => unknown) =>
    selector({
      setLastDownloadTypes: vi.fn(),
      setLastIsBatch: vi.fn(),
    }),
}));

const { DownloadFormFields } = await import("./download-form-fields");

function SingleDownloadFields() {
  const form = useForm<DownloadFormItem>({
    defaultValues: {
      batch: false,
      name: "",
      type: DownloadType.m3u8,
      url: "",
    },
  });
  return createElement(DownloadFormFields, {
    advancedOpen: false,
    form,
    formId: "download-form",
    isEdit: false,
    onAdvancedOpenChange: vi.fn(),
    onShowTextMenu: vi.fn(),
    videoFolders: [],
  });
}

describe("DownloadFormFields", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(SingleDownloadFields)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("places the video link before the video name", () => {
    const urlInput = container.querySelector("#download-form-url");
    const nameInput = container.querySelector("#download-form-name");

    expect(urlInput).not.toBeNull();
    expect(nameInput).not.toBeNull();
    expect(urlInput?.compareDocumentPosition(nameInput as Node) ?? 0).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});
