import {
  DownloadType,
  type ResourceEpisode,
  type ResourceProvider,
  type ResourceSearchItem,
  type DownloadTask,
} from "@mediago/common";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePlatform } from "@/hooks/use-platform";
import { useBrowserActions } from "@/hooks/use-browser-actions";
import { createDownloadTasks } from "@/api/download-task";
import {
  appendUniqueSearchItems,
  createRequestSequence,
  displayResourceValue,
} from "./resource-search-logic";

const MAX_PROVIDERS = 10;

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function episodeKey(item: ResourceSearchItem, index: number) {
  return `${item.providerId}:${item.id}:${index}`;
}

export function ResourceSearch() {
  const { resourceSearch } = usePlatform();
  const { loadUrl } = useBrowserActions();
  const sequence = useRef(createRequestSequence());
  const [keyword, setKeyword] = useState("");
  const [providers, setProviders] = useState<ResourceProvider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providerError, setProviderError] = useState("");
  const [configError, setConfigError] = useState("");
  const [savingProviders, setSavingProviders] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [items, setItems] = useState<ResourceSearchItem[]>([]);
  const [providerErrors, setProviderErrors] = useState<
    { providerId: string; providerName: string; message: string }[]
  >([]);
  const [searchError, setSearchError] = useState("");
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [didSearch, setDidSearch] = useState(false);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selectedEpisodes, setSelectedEpisodes] = useState<
    Record<string, boolean>
  >({});
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");

  const loadProviders = useCallback(async () => {
    if (!resourceSearch) {
      setProvidersLoading(false);
      setProviderError("资源搜索服务尚未连接，请稍后重试");
      return;
    }
    setProvidersLoading(true);
    setProviderError("");
    try {
      setProviders(await resourceSearch.listProviders());
    } catch (error) {
      setProviderError(errorText(error, "资源源配置加载失败"));
    } finally {
      setProvidersLoading(false);
    }
  }, [resourceSearch]);

  useEffect(() => {
    void loadProviders();
    return () => {
      sequence.current.next();
      void resourceSearch?.cancel().catch(() => undefined);
    };
  }, [loadProviders, resourceSearch]);

  const enabledProviders = useMemo(
    () => providers.filter((provider) => provider.enabled),
    [providers],
  );
  const selectedCount = useMemo(
    () => Object.values(selectedEpisodes).filter(Boolean).length,
    [selectedEpisodes],
  );

  const cancelSearch = useCallback(
    async (clear = false) => {
      sequence.current.next();
      setSearching(false);
      setLoadingMore(false);
      if (clear) {
        setItems([]);
        setProviderErrors([]);
        setHasMore(false);
        setPage(1);
        setExpanded([]);
        setSelectedEpisodes({});
      }
      try {
        await resourceSearch?.cancel();
      } catch {
        // The current request is already invalidated locally.
      }
    },
    [resourceSearch],
  );

  const handleKeywordChange = (value: string) => {
    setKeyword(value);
    if (searching || items.length) void cancelSearch(true);
    setSearchError("");
    setDidSearch(false);
  };

  const runSearch = async (requestedPage = 1) => {
    const normalized = keyword.trim();
    if (!normalized || !resourceSearch || enabledProviders.length === 0) return;
    const requestId = sequence.current.next();
    setSearchError("");
    if (requestedPage === 1) {
      setItems([]);
      setProviderErrors([]);
      setSelectedEpisodes({});
      setExpanded([]);
      setSearching(true);
    } else {
      setLoadingMore(true);
    }
    try {
      const result = await resourceSearch.search(normalized, requestedPage);
      if (!sequence.current.isCurrent(requestId)) return;
      setItems((current) =>
        requestedPage === 1
          ? result.items
          : appendUniqueSearchItems(current, result.items),
      );
      setProviderErrors(result.errors ?? []);
      setPage(result.page || requestedPage);
      setHasMore(result.hasMore);
      setDidSearch(true);
    } catch (error) {
      if (!sequence.current.isCurrent(requestId)) return;
      setSearchError(errorText(error, "搜索失败，请稍后重试"));
    } finally {
      if (sequence.current.isCurrent(requestId)) {
        setSearching(false);
        setLoadingMore(false);
      }
    }
  };

  const saveProviders = async () => {
    if (!resourceSearch) return;
    setConfigError("");
    if (providers.length > MAX_PROVIDERS) {
      setConfigError(`最多配置 ${MAX_PROVIDERS} 个资源源`);
      return;
    }
    if (
      providers.some(
        ({ id, name, apiUrl }) => !id.trim() || !name.trim() || !apiUrl.trim(),
      )
    ) {
      setConfigError("请填写每个资源源的 ID、名称和接口地址");
      return;
    }
    setSavingProviders(true);
    try {
      setProviders(await resourceSearch.saveProviders(providers));
      setConfigOpen(false);
      setConfigError("");
      setSearchError("");
    } catch (error) {
      setConfigError(errorText(error, "保存资源源配置失败"));
    } finally {
      setSavingProviders(false);
    }
  };

  const updateProvider = (index: number, patch: Partial<ResourceProvider>) => {
    setProviders((current) =>
      current.map((provider, row) =>
        row === index ? { ...provider, ...patch } : provider,
      ),
    );
  };

  const toggleEpisode = (key: string) => {
    setSelectedEpisodes((current) => ({ ...current, [key]: !current[key] }));
    setAddError("");
  };

  const addSelectedEpisodes = async () => {
    if (adding) return;
    const tasks: Omit<DownloadTask, "id">[] = [];
    items.forEach((item) =>
      item.episodes.forEach((episode, index) => {
        if (
          !selectedEpisodes[episodeKey(item, index)] ||
          episode.kind === "page"
        )
          return;
        tasks.push({
          url: episode.url,
          name: `${item.title} - ${episode.name}`,
          type:
            episode.kind === "m3u8" ? DownloadType.m3u8 : DownloadType.direct,
          folder: "",
        });
      }),
    );
    if (!tasks.length) {
      setAddError("请选择可下载的播放地址；网页播放页请使用“打开播放页”");
      return;
    }
    setAdding(true);
    setAddError("");
    try {
      const created = await createDownloadTasks(tasks, true);
      if (!Array.isArray(created) || created.length === 0)
        throw new Error("未能创建下载任务，请稍后重试");
      setSelectedEpisodes({});
      setAddError("已加入下载任务");
      toast.success("已加入下载任务");
    } catch (error) {
      setAddError(errorText(error, "加入下载任务失败"));
    } finally {
      setAdding(false);
    }
  };

  const openEpisodePage = async (episode: ResourceEpisode) => {
    try {
      await loadUrl(episode.url);
    } catch (error) {
      setSearchError(errorText(error, "打开播放页失败"));
    }
  };

  return (
    <section
      className="mb-4 rounded-xl border border-border/70 bg-surface-raised p-3"
      aria-labelledby="resource-search-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2
            id="resource-search-title"
            className="text-sm font-semibold text-foreground"
          >
            资源聚合搜索
          </h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            默认的两个资源源仅提供检索信息，播放与下载可用性尚未验证。
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setConfigError("");
            setConfigOpen((open) => !open);
          }}
          aria-expanded={configOpen}
        >
          <Settings2 />
          资源源配置{configOpen ? <ChevronUp /> : <ChevronDown />}
        </Button>
      </div>

      {configOpen && (
        <div className="mt-3 rounded-lg border border-border/70 bg-surface p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <h3 className="text-xs font-semibold">资源源配置</h3>
              <p className="text-[11px] text-muted-foreground">
                最多 {MAX_PROVIDERS} 个；请使用你信任的资源站接口。
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={providers.length >= MAX_PROVIDERS}
              onClick={() =>
                setProviders((current) => [
                  ...current,
                  {
                    id: `provider-${Date.now()}`,
                    name: "",
                    apiUrl: "",
                    enabled: true,
                  },
                ])
              }
            >
              <Plus />
              添加
            </Button>
          </div>
          {providersLoading ? (
            <p className="text-xs text-muted-foreground">正在加载配置…</p>
          ) : providerError ? (
            <div className="flex items-center gap-2 text-xs text-destructive">
              <AlertCircle className="size-4" />
              {providerError}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void loadProviders()}
              >
                <RefreshCw />
                重试
              </Button>
            </div>
          ) : providers.length === 0 ? (
            <p className="rounded-md bg-surface-subtle px-3 py-2 text-xs text-muted-foreground">
              尚未配置资源源。添加并保存后才能搜索。
            </p>
          ) : (
            <div className="max-h-40 space-y-2 overflow-auto pr-1">
              {providers.map((provider, index) => (
                <div
                  key={`${provider.id}-${index}`}
                  className="grid grid-cols-[auto_minmax(5rem,0.8fr)_minmax(7rem,1fr)_minmax(10rem,2fr)_auto] items-center gap-2 rounded-md border border-border/60 p-2"
                >
                  <input
                    type="checkbox"
                    aria-label={`启用${provider.name || `第${index + 1}个资源源`}`}
                    checked={provider.enabled}
                    onChange={(event) =>
                      updateProvider(index, {
                        enabled: event.currentTarget.checked,
                      })
                    }
                  />
                  <Input
                    aria-label="资源源 ID"
                    placeholder="ID"
                    value={provider.id}
                    onChange={(event) =>
                      updateProvider(index, { id: event.currentTarget.value })
                    }
                  />
                  <Input
                    aria-label="资源源名称"
                    placeholder="名称"
                    value={provider.name}
                    onChange={(event) =>
                      updateProvider(index, { name: event.currentTarget.value })
                    }
                  />
                  <Input
                    aria-label="接口地址"
                    placeholder="接口地址"
                    value={provider.apiUrl}
                    onChange={(event) =>
                      updateProvider(index, {
                        apiUrl: event.currentTarget.value,
                      })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`删除${provider.name || `第${index + 1}个资源源`}`}
                    onClick={() =>
                      setProviders((current) =>
                        current.filter((_, row) => row !== index),
                      )
                    }
                  >
                    <X />
                  </Button>
                </div>
              ))}
            </div>
          )}
          {configError && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {configError}
            </p>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadProviders()}
              disabled={providersLoading}
            >
              重新加载
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void saveProviders()}
              disabled={savingProviders || providersLoading}
            >
              {savingProviders && <LoaderCircle className="animate-spin" />}
              保存配置
            </Button>
          </div>
        </div>
      )}

      {providerError && !configOpen && (
        <div
          role="alert"
          className="mt-3 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          资源源配置加载失败：{providerError}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadProviders()}
          >
            <RefreshCw />
            重试
          </Button>
        </div>
      )}
      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch(1);
        }}
      >
        <Input
          aria-label="搜索影视名称"
          placeholder="输入片名"
          value={keyword}
          onChange={(event) => handleKeywordChange(event.currentTarget.value)}
        />
        {searching || loadingMore ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => void cancelSearch()}
          >
            <X />
            取消
          </Button>
        ) : (
          <Button
            type="submit"
            disabled={
              !keyword.trim() ||
              providersLoading ||
              enabledProviders.length === 0
            }
          >
            <Search />
            搜索
          </Button>
        )}
      </form>
      {!providersLoading && !providerError && enabledProviders.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          需要配置并启用至少一个资源源后才能搜索。
        </p>
      )}
      {searchError && (
        <p
          role="alert"
          className="mt-2 flex items-center gap-1.5 text-xs text-destructive"
        >
          <AlertCircle className="size-4" />
          {searchError}
        </p>
      )}
      {providerErrors.length > 0 && (
        <div
          role="status"
          className="mt-2 space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs"
        >
          <p className="font-medium">部分资源源搜索失败</p>
          {providerErrors.map((error) => (
            <p key={error.providerId} className="text-muted-foreground">
              {error.providerName || error.providerId}：
              {error.message || "请求失败"}
            </p>
          ))}
        </div>
      )}

      {items.length > 0 && (
        <div className="mt-3 max-h-64 space-y-2 overflow-auto pr-1">
          {items.map((item) => {
            const key = `${item.providerId}:${item.id}`;
            const isExpanded = expanded.includes(key);
            return (
              <article
                key={key}
                className="rounded-lg border border-border/70 bg-surface p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-semibold text-foreground">
                      {item.title || "未知"}
                    </h3>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {item.providerName || "未知"} ·{" "}
                      {displayResourceValue(item.year)} ·{" "}
                      {displayResourceValue(item.language)} ·{" "}
                      {displayResourceValue(item.quality)}
                    </p>
                  </div>
                  {item.episodes.length > 0 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-expanded={isExpanded}
                      onClick={() =>
                        setExpanded((current) =>
                          isExpanded
                            ? current.filter((id) => id !== key)
                            : [...current, key],
                        )
                      }
                    >
                      {isExpanded
                        ? "收起选集"
                        : `选择地址（${item.episodes.length}）`}
                      {isExpanded ? <ChevronUp /> : <ChevronDown />}
                    </Button>
                  )}
                </div>
                {item.episodes.length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    暂无可下载地址
                  </p>
                ) : (
                  isExpanded && (
                    <div className="mt-2 space-y-1.5 border-t border-border/60 pt-2">
                      {item.episodes.map((episode, index) => (
                        <div
                          key={episodeKey(item, index)}
                          className="flex flex-wrap items-center justify-between gap-2 text-xs"
                        >
                          <label className="flex min-w-0 items-center gap-2">
                            <input
                              type="checkbox"
                              checked={
                                !!selectedEpisodes[episodeKey(item, index)]
                              }
                              onChange={() =>
                                toggleEpisode(episodeKey(item, index))
                              }
                              disabled={episode.kind === "page"}
                            />
                            <span className="truncate">
                              {episode.name || `播放地址 ${index + 1}`}
                            </span>
                            <span className="shrink-0 text-muted-foreground">
                              {episode.kind === "page"
                                ? "网页"
                                : episode.kind === "m3u8"
                                  ? "M3U8"
                                  : "直链"}
                            </span>
                          </label>
                          {episode.kind === "page" && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => void openEpisodePage(episode)}
                            >
                              打开播放页
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )
                )}
              </article>
            );
          })}
        </div>
      )}
      {items.length === 0 && !searching && !searchError && keyword.trim() && (
        <p className="mt-3 text-xs text-muted-foreground">
          {didSearch ? "未找到匹配结果。" : "尚无搜索结果，请点击“搜索”。"}
        </p>
      )}
      {searching && (
        <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          正在搜索已启用的资源源…
        </p>
      )}
      {hasMore && (
        <div className="mt-2 flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loadingMore}
            onClick={() => void runSearch(page + 1)}
          >
            {loadingMore && <LoaderCircle className="animate-spin" />}加载更多
          </Button>
        </div>
      )}
      {selectedCount > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
          <p className="text-xs text-muted-foreground">
            已选择 {selectedCount} 个可下载地址
          </p>
          <Button
            type="button"
            disabled={adding}
            onClick={() => void addSelectedEpisodes()}
          >
            {adding ? <LoaderCircle className="animate-spin" /> : <Check />}
            加入下载任务
          </Button>
        </div>
      )}
      {addError && (
        <p
          role={addError === "已加入下载任务" ? "status" : "alert"}
          className={`mt-2 text-xs ${addError === "已加入下载任务" ? "text-primary" : "text-destructive"}`}
        >
          {addError}
        </p>
      )}
    </section>
  );
}

export default ResourceSearch;
