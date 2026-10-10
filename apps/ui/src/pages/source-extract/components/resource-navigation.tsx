import { useState } from "react";
import { useBrowserActions } from "@/hooks/use-browser-actions";
import { toast } from "sonner";
import {
  RESOURCE_CATEGORIES,
  filterResourceSites,
  type ResourceCategoryFilter,
} from "./resource-sites";

export function ResourceNavigation() {
  const [category, setCategory] = useState<ResourceCategoryFilter>("全部");
  const { loadUrl } = useBrowserActions();
  const sites = filterResourceSites(category);

  const openSite = async (url: string) => {
    try {
      await loadUrl(url);
    } catch {
      toast.error("打开网站失败，请稍后重试");
    }
  };

  return (
    <section
      className="mb-5 rounded-xl border border-border/70 bg-surface-raised p-4 md:p-5"
      aria-labelledby="resource-navigation-title"
    >
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2
            id="resource-navigation-title"
            className="text-base font-semibold text-foreground"
          >
            影视网站入口
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            网站入口用于找片，能否下载以检测结果和任务状态为准。
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5" aria-label="按内容类型筛选">
          {RESOURCE_CATEGORIES.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={category === item}
              onClick={() => setCategory(item)}
              className={`rounded-full border px-3 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${category === item ? "border-primary bg-primary/10 text-primary" : "border-border bg-surface text-muted-foreground hover:bg-surface-hover hover:text-foreground"}`}
            >
              {item}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
        {sites.map((site) => (
          <button
            key={site.name}
            type="button"
            onClick={() => void openSite(site.url)}
            className="group flex min-h-16 items-center gap-3 rounded-lg border border-border/70 bg-surface px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`打开${site.name}`}
          >
            <span
              className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-sm font-semibold text-primary"
              aria-hidden="true"
            >
              {site.mark}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-foreground">
                {site.name}
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                {site.categories.join(" · ")}
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
