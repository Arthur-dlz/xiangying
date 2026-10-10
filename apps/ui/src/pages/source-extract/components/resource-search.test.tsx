/** @vitest-environment happy-dom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DownloadType,
  type ResourceProvider,
  type ResourceSearchItem,
} from "@mediago/common";

const mocks = vi.hoisted(() => ({
  createDownloadTasks: vi.fn(),
  loadUrl: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  listProviders: vi.fn(),
  saveProviders: vi.fn(),
  search: vi.fn(),
  cancel: vi.fn(),
}));
const resourceSearch = {
  listProviders: mocks.listProviders,
  saveProviders: mocks.saveProviders,
  search: mocks.search,
  cancel: mocks.cancel,
};

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock("@/api/download-task", () => ({
  createDownloadTasks: mocks.createDownloadTasks,
}));

vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({ resourceSearch }),
}));

vi.mock("@/hooks/use-browser-actions", () => ({
  useBrowserActions: () => ({ loadUrl: mocks.loadUrl }),
}));

const { ResourceSearch } = await import("./resource-search");

const providers: ResourceProvider[] = [
  {
    id: "meta-a",
    name: "元数据源 A",
    apiUrl: "https://a.example/api",
    enabled: true,
  },
  {
    id: "meta-b",
    name: "元数据源 B",
    apiUrl: "https://b.example/api",
    enabled: true,
  },
];

const resultItem: ResourceSearchItem = {
  id: "movie-1",
  providerId: "meta-a",
  providerName: "元数据源 A",
  title: "示例影片",
  episodes: [
    { name: "正片", url: "https://media.example/video.mp4", kind: "direct" },
  ],
};

function setInput(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ResourceSearch interactions", () => {
  let container: HTMLDivElement;
  let root: Root;

  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(label),
    );

  const input = (label: string) =>
    container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);

  const render = async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(ResourceSearch));
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listProviders.mockResolvedValue(providers);
    mocks.saveProviders.mockResolvedValue(providers);
    mocks.search.mockResolvedValue({
      keyword: "示例影片",
      page: 1,
      items: [resultItem],
      errors: [],
      hasMore: false,
    });
    mocks.cancel.mockResolvedValue(undefined);
    mocks.createDownloadTasks.mockResolvedValue([{ id: 11 }]);
    mocks.loadUrl.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("searches, lets the user choose an episode, and submits only after confirmation", async () => {
    await render();
    const keyword = input("搜索影视名称");
    if (!keyword) throw new Error("Search input was not rendered");
    await act(async () => {
      setInput(keyword, "示例影片");
      button("搜索")?.click();
    });

    expect(mocks.search).toHaveBeenCalledWith("示例影片", 1);
    expect(container.textContent).toContain("示例影片");
    expect(container.textContent).toContain("未知");
    expect(mocks.createDownloadTasks).not.toHaveBeenCalled();

    await act(async () => button("选择地址")?.click());
    const episodeCheckbox = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]:not([aria-label^="启用"])',
    );
    if (!episodeCheckbox) throw new Error("Episode checkbox was not rendered");
    await act(async () => episodeCheckbox.click());
    await act(async () => button("加入下载任务")?.click());

    expect(mocks.createDownloadTasks).toHaveBeenCalledWith(
      [
        {
          url: "https://media.example/video.mp4",
          name: "示例影片 - 正片",
          type: DownloadType.direct,
          folder: "",
        },
      ],
      true,
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith("已加入下载任务");
    expect(container.textContent).toContain("已加入下载任务");
  });

  it("shows an error when task creation returns an empty list", async () => {
    mocks.createDownloadTasks.mockResolvedValueOnce([]);
    await render();
    await act(async () => {
      const keyword = input("搜索影视名称");
      if (!keyword) throw new Error("Search input was not rendered");
      setInput(keyword, "示例影片");
      button("搜索")?.click();
    });
    await act(async () => button("选择地址")?.click());
    const episodeCheckbox = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]:not([aria-label^="启用"])',
    );
    if (!episodeCheckbox) throw new Error("Episode checkbox was not rendered");
    await act(async () => episodeCheckbox.click());
    await act(async () => button("加入下载任务")?.click());

    expect(container.textContent).toContain("未能创建下载任务，请稍后重试");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("ignores a search result that arrives after cancellation", async () => {
    let resolveSearch!: (value: {
      keyword: string;
      page: number;
      items: ResourceSearchItem[];
      errors: [];
      hasMore: boolean;
    }) => void;
    mocks.search.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSearch = resolve;
      }),
    );
    await render();
    await act(async () => {
      const keyword = input("搜索影视名称");
      if (!keyword) throw new Error("Search input was not rendered");
      setInput(keyword, "示例影片");
      button("搜索")?.click();
    });
    await act(async () => button("取消")?.click());
    await act(async () =>
      resolveSearch({
        keyword: "示例影片",
        page: 1,
        items: [resultItem],
        errors: [],
        hasMore: false,
      }),
    );

    expect(mocks.cancel).toHaveBeenCalled();
    expect(container.textContent).not.toContain("示例影片");
  });

  it("surfaces provider configuration save failures", async () => {
    mocks.saveProviders.mockRejectedValueOnce(new Error("配置存储不可用"));
    await render();
    await act(async () => button("资源源配置")?.click());
    await act(async () => button("保存配置")?.click());

    expect(mocks.saveProviders).toHaveBeenCalledWith(providers);
    expect(container.textContent).toContain("配置存储不可用");
  });
});
