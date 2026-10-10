import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { provide } from "@inversifyjs/binding-decorators";
import type {
  ResourceEpisode,
  ResourceProvider,
  ResourceSearchApi,
  ResourceSearchItem,
  ResourceSearchResult,
} from "@mediago/common";
import { app, net } from "electron";
import { injectable, unmanaged } from "inversify";

const MAX_PROVIDERS = 10;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_TEXT_LENGTH = 200;
const REQUEST_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 20;

export const DEFAULT_RESOURCE_PROVIDERS: ResourceProvider[] = [
  {
    id: "bfzy",
    name: "暴风资源",
    apiUrl: "http://bfzyapi.com/api.php/provide/vod",
    enabled: true,
  },
  {
    id: "ffzy",
    name: "非凡资源",
    apiUrl: "http://api.ffzyapi.com/api.php/provide/vod",
    enabled: true,
  },
];

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
type LookupLike = typeof lookup;

export interface ResourceSearchRuntime {
  userDataPath?: string;
  fetch?: FetchLike;
  lookup?: LookupLike;
}

function electronFetch(input: string, init: RequestInit): Promise<Response> {
  return net.fetch(input, init) as Promise<Response>;
}

function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase().split("%", 1)[0];
  if (isIP(value) === 6) {
    if (value.startsWith("::ffff:")) return isPrivateAddress(value.slice(7));
    const first = Number.parseInt(value.split(":", 1)[0] || "0", 16);
    return (
      value === "::" ||
      value === "::1" ||
      (first & 0xfe00) === 0xfc00 ||
      (first & 0xffc0) === 0xfe80 ||
      (first & 0xff00) === 0xff00 ||
      (first & 0xe000) !== 0x2000 ||
      value.startsWith("2001:db8:")
    );
  }
  if (isIP(value) !== 4) return true;
  const octets = value.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  )
    return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0)
  );
}

function validateProvider(value: unknown): value is ResourceProvider {
  if (!value || typeof value !== "object") return false;
  const provider = value as Record<string, unknown>;
  if (typeof provider.id !== "string" || !/^[\w-]{1,64}$/.test(provider.id))
    return false;
  if (
    typeof provider.name !== "string" ||
    !provider.name.trim() ||
    provider.name.length > 64
  )
    return false;
  if (
    typeof provider.enabled !== "boolean" ||
    typeof provider.apiUrl !== "string" ||
    provider.apiUrl.length > 2048
  )
    return false;
  try {
    const url = new URL(provider.apiUrl);
    return (
      ((url.protocol === "http:" && (url.port === "" || url.port === "80")) ||
        (url.protocol === "https:" &&
          (url.port === "" || url.port === "443"))) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !!url.hostname
    );
  } catch {
    return false;
  }
}

function cleanText(
  value: unknown,
  maxLength = MAX_TEXT_LENGTH,
): string | undefined {
  if (typeof value === "number" && Number.isFinite(value))
    value = String(value);
  if (typeof value !== "string") return undefined;
  const plain = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot);/gi, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain ? plain.slice(0, maxLength) : undefined;
}

function safeId(value: string): string {
  return encodeURIComponent(value).slice(0, 180);
}

function parseEpisodes(value: unknown): ResourceEpisode[] {
  if (typeof value !== "string") return [];
  const episodes: ResourceEpisode[] = [];
  for (const group of value.split(/\${2,3}/)) {
    for (const entry of group.split("#")) {
      const separator = entry.indexOf("$");
      if (separator <= 0) continue;
      const name = cleanText(entry.slice(0, separator), 120);
      const rawUrl = entry.slice(separator + 1).trim();
      if (!name || rawUrl.length > 2048) continue;
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        continue;
      }
      if (
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        (url.protocol === "https:" && url.port && url.port !== "443") ||
        (url.protocol === "http:" && url.port && url.port !== "80") ||
        url.username ||
        url.password ||
        url.hostname === "localhost" ||
        url.hostname.endsWith(".localhost") ||
        (isIP(url.hostname) !== 0 && isPrivateAddress(url.hostname))
      )
        continue;
      const kind: ResourceEpisode["kind"] = /\.m3u8(?:$|[?#])/i.test(url.href)
        ? "m3u8"
        : /\.mp4(?:$|[?#])/i.test(url.href)
          ? "direct"
          : "page";
      episodes.push({ name, url: url.href, kind });
      if (episodes.length >= 200) return episodes;
    }
  }
  return episodes;
}

function parseItems(
  payload: unknown,
  provider: ResourceProvider,
): ResourceSearchItem[] {
  if (!payload || typeof payload !== "object") throw new Error("响应格式无效");
  const data = (payload as { list?: unknown }).list;
  if (!Array.isArray(data)) throw new Error("响应缺少影片列表");
  return data.slice(0, PAGE_SIZE).flatMap((row: unknown) => {
    if (!row || typeof row !== "object") return [];
    const record = row as Record<string, unknown>;
    const title = cleanText(record.vod_name, MAX_TITLE_LENGTH);
    const providerKey = cleanText(record.vod_id, 120);
    if (!title || !providerKey) return [];
    return [
      {
        id: `${provider.id}:${safeId(providerKey)}`,
        providerId: provider.id,
        providerName: provider.name,
        title,
        year: cleanText(record.vod_year),
        language: cleanText(record.vod_lang),
        quality: cleanText(record.vod_remarks),
        typeName: cleanText(record.type_name),
        episodes: parseEpisodes(record.vod_play_url),
      },
    ];
  });
}

@injectable()
@provide()
export class ResourceSearchService implements ResourceSearchApi {
  private providers?: ResourceProvider[];
  private pendingWrite: Promise<void> = Promise.resolve();
  private activeController?: AbortController;

  constructor(
    @unmanaged() private readonly runtime: ResourceSearchRuntime = {},
  ) {}

  async listProviders(): Promise<ResourceProvider[]> {
    await this.loadProviders();
    return this.providers!.map((provider) => ({ ...provider }));
  }

  async saveProviders(
    providers: ResourceProvider[],
  ): Promise<ResourceProvider[]> {
    if (
      !Array.isArray(providers) ||
      providers.length > MAX_PROVIDERS ||
      !providers.every(validateProvider) ||
      new Set(providers.map((provider) => provider.id)).size !==
        providers.length
    ) {
      throw new Error(
        "资源站配置无效：最多支持 10 个来源，且 ID、名称、API 地址必须有效",
      );
    }
    const saved = providers.map((provider) => ({
      ...provider,
      name: provider.name.trim(),
      apiUrl: new URL(provider.apiUrl).href,
    }));
    await this.serialize(async () => {
      const destination = await this.getConfigPath();
      await mkdir(dirname(destination), { recursive: true });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
        await rename(temporary, destination);
      } catch (error) {
        const { unlink } = await import("node:fs/promises");
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    });
    this.providers = saved;
    return saved.map((provider) => ({ ...provider }));
  }

  async search(keyword: string, page = 1): Promise<ResourceSearchResult> {
    const term = typeof keyword === "string" ? keyword.trim() : "";
    if (!term || term.length >= 200)
      throw new Error("搜索关键词须为 1 到 199 个字符");
    if (!Number.isInteger(page) || page < 1 || page > 100)
      throw new Error("搜索页码必须在 1 到 100 之间");
    this.activeController?.abort();
    const controller = new AbortController();
    this.activeController = controller;
    const providers = (await this.listProviders()).filter(
      (provider) => provider.enabled,
    );
    const result: ResourceSearchResult = {
      keyword: term,
      page,
      items: [],
      errors: [],
      hasMore: false,
    };
    const tasks = providers.map(async (provider) => {
      try {
        const items = await this.searchProvider(
          provider,
          term,
          page,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          result.items.push(...items);
          result.hasMore ||= items.length >= PAGE_SIZE;
        }
      } catch (error) {
        if (!controller.signal.aborted)
          result.errors.push({
            providerId: provider.id,
            providerName: provider.name,
            message:
              error instanceof Error
                ? error.message.slice(0, 160)
                : "资源站请求失败",
          });
      }
    });
    await Promise.all(tasks);
    if (this.activeController === controller) this.activeController = undefined;
    if (controller.signal.aborted) {
      result.items = [];
      result.errors = [];
      return result;
    }
    const seen = new Set<string>();
    result.items = result.items.filter((item) => {
      const key = `${item.providerId}\0${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return result;
  }

  async cancel(): Promise<void> {
    this.activeController?.abort();
    this.activeController = undefined;
  }

  private async searchProvider(
    provider: ResourceProvider,
    keyword: string,
    page: number,
    signal: AbortSignal,
  ): Promise<ResourceSearchItem[]> {
    const apiUrl = new URL(provider.apiUrl);
    if (apiUrl.protocol !== "https:" && apiUrl.protocol !== "http:")
      throw new Error("仅支持 HTTP(S) API 地址");
    const url = new URL(apiUrl);
    url.searchParams.set("ac", "detail");
    url.searchParams.set("wd", keyword);
    url.searchParams.set("pg", String(page));
    const requestController = new AbortController();
    const abortRequest = () => requestController.abort();
    signal.addEventListener("abort", abortRequest, { once: true });
    const timeout = setTimeout(abortRequest, REQUEST_TIMEOUT_MS);
    const aborted = new Promise<never>((_resolve, reject) => {
      requestController.signal.addEventListener(
        "abort",
        () => reject(new Error("资源站请求超时或已取消")),
        { once: true },
      );
    });
    try {
      if (signal.aborted) throw new Error("资源站请求超时或已取消");
      const addresses = await Promise.race([
        (this.runtime.lookup ?? lookup)(apiUrl.hostname, {
          all: true,
          verbatim: true,
        }),
        aborted,
      ]);
      if (
        !addresses.length ||
        addresses.some(({ address }) => isPrivateAddress(address))
      )
        throw new Error("资源站地址解析到非公网 IP");
      const response = await (this.runtime.fetch ?? electronFetch)(url.href, {
        method: "GET",
        credentials: "omit",
        redirect: "manual",
        signal: requestController.signal,
        headers: { accept: "application/json" },
      });
      if (response.status >= 300 && response.status < 400)
        throw new Error("资源站重定向已拒绝");
      if (!response.ok) throw new Error(`资源站返回 HTTP ${response.status}`);
      const declaredLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAX_RESPONSE_BYTES
      )
        throw new Error("资源站响应超过 4 MiB 限制");
      if (!response.body) throw new Error("资源站响应为空");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error("资源站响应超过 4 MiB 限制");
        }
        chunks.push(value);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(
          new TextDecoder().decode(
            Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
          ),
        );
      } catch {
        throw new Error("资源站返回了无效 JSON");
      }
      return parseItems(payload, provider);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abortRequest);
    }
  }

  private async loadProviders(): Promise<void> {
    if (this.providers) return;
    const configPath = await this.getConfigPath();
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(configPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.providers = DEFAULT_RESOURCE_PROVIDERS.map((provider) => ({
          ...provider,
        }));
        return;
      }
      throw new Error("资源站配置读取失败；原文件已保留");
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length > MAX_PROVIDERS ||
      !parsed.every(validateProvider) ||
      new Set(parsed.map((provider) => provider.id)).size !== parsed.length
    ) {
      throw new Error("资源站配置无效；原文件已保留");
    }
    this.providers = parsed as ResourceProvider[];
  }

  private async getConfigPath(): Promise<string> {
    const userData = this.runtime.userDataPath ?? app.getPath("userData");
    return join(userData, "resource-search-providers.json");
  }

  private async serialize(operation: () => Promise<void>): Promise<void> {
    const current = this.pendingWrite.then(operation);
    this.pendingWrite = current.catch(() => undefined);
    await current;
  }
}
