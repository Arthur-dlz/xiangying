import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_RESOURCE_PROVIDERS,
  ResourceSearchService,
  type ResourceSearchRuntime,
} from "./resource-search.service";

const roots: string[] = [];
const provider = {
  id: "catalog",
  name: "Catalog",
  apiUrl: "https://catalog.example/api.php",
  enabled: true,
};

async function fixture(
  runtime: Omit<ResourceSearchRuntime, "userDataPath"> = {},
) {
  const userDataPath = await mkdtemp(
    path.join(os.tmpdir(), "mediago-resource-search-"),
  );
  roots.push(userDataPath);
  const service = new ResourceSearchService({
    userDataPath,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    ...runtime,
  });
  return { service, userDataPath };
}

function jsonResponse(body: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ResourceSearchService", () => {
  test("parses MacCMS groups and episodes into provider-qualified search results", async () => {
    const f = await fixture({
      fetch: async (input) => {
        const url = new URL(input);
        expect(url.searchParams.get("ac")).toBe("detail");
        expect(url.searchParams.get("wd")).toBe("哪吒 2");
        expect(url.searchParams.get("pg")).toBe("1");
        return jsonResponse({
          list: [
            {
              vod_id: 42,
              vod_name: "<b>哪吒 2</b>",
              vod_year: 2025,
              vod_lang: "国语",
              vod_remarks: "HD",
              type_name: "动画",
              vod_play_from: "线路一$$线路二",
              vod_play_url:
                "正片$https://cdn.example/film.m3u8#花絮$http://cdn.example/clip.mp4$$$备用$https://site.example/watch?id=1#恶意$http://127.0.0.1/secret.mp4#凭据$https://user:pass@cdn.example/secret.mp4",
            },
          ],
        });
      },
    });
    await f.service.saveProviders([provider]);
    await expect(f.service.search("哪吒 2")).resolves.toMatchObject({
      items: [
        {
          id: "catalog:42",
          title: "哪吒 2",
          year: "2025",
          language: "国语",
          quality: "HD",
          typeName: "动画",
          episodes: [
            { name: "正片", kind: "m3u8" },
            { name: "花絮", kind: "direct" },
            { name: "备用", kind: "page" },
          ],
        },
      ],
    });
  });

  test("loads validated defaults when no user config exists and persists edits", async () => {
    const f = await fixture();
    await expect(f.service.listProviders()).resolves.toEqual(
      DEFAULT_RESOURCE_PROVIDERS,
    );
    await f.service.saveProviders([provider]);
    expect(
      JSON.parse(
        await readFile(
          path.join(f.userDataPath, "resource-search-providers.json"),
          "utf8",
        ),
      ),
    ).toEqual([provider]);
  });

  test("rejects duplicate IDs, credentials, fragments, bad ports, and excessive providers", async () => {
    const f = await fixture();
    await expect(
      f.service.saveProviders([
        { ...provider, apiUrl: "https://user:pass@catalog.example/api.php" },
      ]),
    ).rejects.toThrow("配置无效");
    await expect(
      f.service.saveProviders([
        { ...provider, apiUrl: "https://catalog.example:8443/api.php" },
      ]),
    ).rejects.toThrow("配置无效");
    await expect(
      f.service.saveProviders([
        { ...provider, apiUrl: "https://catalog.example/api.php#secret" },
      ]),
    ).rejects.toThrow("配置无效");
    await expect(f.service.saveProviders([provider, provider])).rejects.toThrow(
      "配置无效",
    );
    await expect(
      f.service.saveProviders(
        Array.from({ length: 11 }, (_, id) => ({ ...provider, id: `p${id}` })),
      ),
    ).rejects.toThrow("配置无效");
  });

  test("rejects any DNS answer that resolves to a private address before requesting", async () => {
    const fetch = vi.fn(async () => jsonResponse({ list: [] }));
    const f = await fixture({
      fetch,
      lookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    });
    await f.service.saveProviders([provider]);
    const result = await f.service.search("movie");
    expect(result.errors[0]?.message).toContain("非公网 IP");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("reports provider HTTP, JSON, and redirect errors while keeping successful peers", async () => {
    const f = await fixture({
      fetch: async (input) =>
        new URL(input).hostname === "catalog.example"
          ? jsonResponse({ list: [{ vod_id: "ok", vod_name: "Film" }] })
          : new Response("", {
              status: 302,
              headers: { location: "http://127.0.0.1" },
            }),
    });
    await f.service.saveProviders([
      provider,
      {
        ...provider,
        id: "redirect",
        name: "Redirect",
        apiUrl: "https://other.example/api.php",
      },
    ]);
    const result = await f.service.search("movie");
    expect(result.items).toHaveLength(1);
    expect(result.errors).toMatchObject([
      { providerId: "redirect", message: "资源站重定向已拒绝" },
    ]);
  });

  test("rejects declared and streamed bodies larger than four MiB", async () => {
    const f = await fixture({
      fetch: async () =>
        jsonResponse({}, { "content-length": String(4 * 1024 * 1024 + 1) }),
    });
    await f.service.saveProviders([provider]);
    const result = await f.service.search("movie");
    expect(result.errors[0]?.message).toContain("4 MiB");
  });

  test("counts streamed bytes when Content-Length is absent", async () => {
    const f = await fixture({
      fetch: async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(4 * 1024 * 1024));
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        });
        return new Response(body, { status: 200 });
      },
    });
    await f.service.saveProviders([provider]);
    await expect(f.service.search("movie")).resolves.toMatchObject({
      errors: [{ message: "资源站响应超过 4 MiB 限制" }],
    });
  });

  test("aborts a request after the ten second timeout", async () => {
    vi.useFakeTimers();
    const f = await fixture({
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    });
    await f.service.saveProviders([provider]);
    const pending = f.service.search("movie");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toMatchObject({
      items: [],
      errors: [{ providerId: "catalog" }],
    });
  });

  test("bounds DNS resolution to the same ten second request deadline", async () => {
    vi.useFakeTimers();
    const f = await fixture({
      lookup: async () => new Promise<never>(() => undefined),
      fetch: vi.fn(async () => jsonResponse({ list: [] })),
    });
    await f.service.saveProviders([provider]);
    const pending = f.service.search("movie");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toMatchObject({
      items: [],
      errors: [{ providerId: "catalog" }],
    });
  });

  test("cancels active work and prevents its late provider result from escaping", async () => {
    let release!: (response: Response) => void;
    const f = await fixture({
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          release = _resolve;
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    });
    await f.service.saveProviders([provider]);
    const pending = f.service.search("movie");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await f.service.cancel();
    release(jsonResponse({ list: [{ vod_id: "stale", vod_name: "Stale" }] }));
    await expect(pending).resolves.toMatchObject({ items: [], errors: [] });
  });

  test("preserves invalid existing config instead of silently replacing it", async () => {
    const f = await fixture();
    const config = path.join(f.userDataPath, "resource-search-providers.json");
    await writeFile(config, "{bad json", "utf8");
    await expect(f.service.listProviders()).rejects.toThrow("配置读取失败");
    await expect(readFile(config, "utf8")).resolves.toBe("{bad json");
  });

  test("rejects a response that is not valid MacCMS JSON", async () => {
    const f = await fixture({ fetch: async () => new Response("not json") });
    await f.service.saveProviders([provider]);
    await expect(f.service.search("movie")).resolves.toMatchObject({
      items: [],
      errors: [{ message: "资源站返回了无效 JSON" }],
    });
  });
});
