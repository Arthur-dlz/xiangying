import {
  DownloadFilter,
  type LibraryCategory,
  type LibraryItem,
  type LibrarySnapshot,
} from "@mediago/common";
import {
  Check,
  CircleAlert,
  Clapperboard,
  Download,
  Film,
  FolderOpen,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { getDownloadTasks } from "@/api/download-task";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePlatform } from "@/hooks/use-platform";
import { isWeb } from "@/utils";
import { completedLocalTaskPaths, filterLibraryItems } from "./library-filters";

const CATEGORY_LABELS: Record<LibraryCategory, string> = {
  movie: "电影",
  documentary: "纪录片",
  children: "儿童",
  other: "其他",
};

async function completedLocalPaths() {
  const pageSize = 100;
  const tasks = [];
  let current = 1;
  let total = Number.POSITIVE_INFINITY;
  /* oxlint-disable eslint/no-await-in-loop -- Each page determines whether another page exists. */
  while ((current - 1) * pageSize < total) {
    const page = await getDownloadTasks({
      current,
      pageSize,
      filter: DownloadFilter.done,
    });
    tasks.push(...page.list);
    total = page.total;
    if (page.list.length === 0) break;
    current += 1;
  }
  /* oxlint-enable eslint/no-await-in-loop */
  return completedLocalTaskPaths(tasks);
}

function reportError(cause: unknown, fallback: string) {
  toast.error(cause instanceof Error ? cause.message : fallback);
}

function SafetyLabel({ item }: { item: LibraryItem }) {
  if (item.missing)
    return (
      <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
        <CircleAlert className="size-3.5" />
        文件已移走
      </span>
    );
  if (item.safety.status === "clean")
    return (
      <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
        <ShieldCheck className="size-3.5" />
        扫描未发现威胁
      </span>
    );
  if (item.safety.status === "blocked")
    return (
      <span className="inline-flex items-center gap-1 rounded bg-red-50 px-2 py-1 text-xs text-red-800">
        <ShieldAlert className="size-3.5" />
        已阻止
      </span>
    );
  if (item.safety.status === "unavailable")
    return (
      <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
        <ShieldQuestion className="size-3.5" />
        无法扫描
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1 text-xs text-slate-700">
      <ShieldQuestion className="size-3.5" />
      尚未扫描
    </span>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export default function LibraryPage() {
  const platform = usePlatform();
  const library = platform.library;
  const available = !isWeb && Boolean(library?.list);
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | LibraryCategory>("all");
  const [screened, setScreened] = useState<"all" | "true" | "false">("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<LibraryItem | null>(null);
  const [removing, setRemoving] = useState<LibraryItem | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editCategory, setEditCategory] = useState<LibraryCategory>("movie");
  const [editTags, setEditTags] = useState("");
  const [editScreened, setEditScreened] = useState(false);
  const [rejections, setRejections] = useState<
    { path: string; reason: string }[]
  >([]);

  const refresh = useCallback(async () => {
    if (!library?.list) return;
    setLoading(true);
    setError("");
    try {
      setSnapshot(await library.list());
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "读取片库失败，请重试。",
      );
    } finally {
      setLoading(false);
    }
  }, [library]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const items = snapshot?.items ?? [];
  const visibleItems = useMemo(() => {
    return filterLibraryItems(items, { query, category, screened });
  }, [category, items, query, screened]);

  const importPaths = async (
    paths: string[],
    source: "import" | "download" = "import",
  ) => {
    if (!paths.length || !library) return;
    setBusy(true);
    try {
      const result = await library.importFiles(paths, source);
      setRejections(result.rejected);
      await refresh();
      if (result.rejected.length)
        toast.warning(
          `已加入 ${result.added} 部，${result.rejected.length} 个文件未能导入；请查看页面中的原因。`,
        );
      else if (result.added) toast.success(`已加入片库 ${result.added} 部`);
      else toast.info("这些文件已在片库中。");
    } catch (cause) {
      reportError(cause, "导入失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const chooseFiles = async () => {
    try {
      const paths = await platform.dialog.open({
        type: "file",
        multiple: true,
        filters: [
          {
            name: "视频文件",
            extensions: [
              "avi",
              "flv",
              "m4v",
              "mkv",
              "mov",
              "mp4",
              "mpeg",
              "mpg",
              "ogv",
              "webm",
              "wmv",
            ],
          },
        ],
      });
      await importPaths(paths);
    } catch (cause) {
      reportError(cause, "打开文件选择器失败。");
    }
  };

  const syncDownloads = async () => {
    setBusy(true);
    try {
      const paths = await completedLocalPaths();
      if (!paths.length) {
        toast.info("还没有可加入片库的本地完整下载。");
        return;
      }
      const result = await library.importFiles(paths, "download");
      setRejections(result.rejected);
      await refresh();
      if (result.added) toast.success(`已同步 ${result.added} 部完整下载`);
      else if (!result.rejected.length) toast.info("完整下载已在片库中。");
      if (result.rejected.length)
        toast.warning(`${result.rejected.length} 个文件未能加入片库。`);
    } catch (cause) {
      reportError(cause, "同步下载任务失败。");
    } finally {
      setBusy(false);
    }
  };

  const invoke = async (
    operation: () => Promise<unknown>,
    success?: string,
  ) => {
    setBusy(true);
    try {
      await operation();
      await refresh();
      if (success) toast.success(success);
    } catch (cause) {
      reportError(cause, "操作失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const beginEdit = (item: LibraryItem) => {
    setEditing(item);
    setEditTitle(item.title);
    setEditCategory(item.category);
    setEditTags(item.tags.join("，"));
    setEditScreened(item.screened);
  };

  const saveEdit = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await library.update(editing.id, {
        title: editTitle.trim(),
        category: editCategory,
        tags: editTags
          .split(/[，,]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
        screened: editScreened,
      });
      setEditing(null);
      await refresh();
      toast.success("片目信息已保存");
    } catch (cause) {
      reportError(cause, "保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const toggleSelected = (id: string, checked: boolean) =>
    setSelected((current) =>
      checked
        ? [...new Set([...current, id])]
        : current.filter((value) => value !== id),
    );

  if (!available)
    return (
      <main className="flex h-full items-center justify-center p-6">
        <section className="max-w-md rounded-lg border bg-white p-8 text-center">
          <Film className="mx-auto mb-3 size-8 text-teal-700" />
          <h1 className="text-lg font-semibold">我的片库</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            本地片库仅在乡映 Windows
            桌面版中提供。浏览器版本无法访问您电脑上的视频文件。
          </p>
        </section>
      </main>
    );

  return (
    <main
      className="flex h-full min-h-0 flex-col overflow-hidden bg-[#f7f9f8] p-5 max-[719px]:p-3"
      aria-busy={loading || busy}
    >
      <header className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-wide">我的片库</h1>
            <span className="rounded-full bg-teal-50 px-2.5 py-1 text-xs text-teal-800">
              {items.length} 部
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            收好本地影片，活动时随时播放
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void syncDownloads()}
          >
            <Download />
            同步完整下载
          </Button>
          <Button disabled={busy} onClick={() => void chooseFiles()}>
            <Plus />
            导入视频
          </Button>
        </div>
      </header>

      <section className="mb-4 flex shrink-0 flex-wrap items-center gap-2 rounded-lg border bg-white p-3">
        <label className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="搜索片名或标签"
            placeholder="搜索片名或标签"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-9"
          />
        </label>
        <Select
          value={category}
          onValueChange={(value) =>
            setCategory(value as "all" | LibraryCategory)
          }
        >
          <SelectTrigger aria-label="按分类筛选" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部分类</SelectItem>
            {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
              <SelectItem key={key} value={key}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={screened}
          onValueChange={(value) =>
            setScreened(value as "all" | "true" | "false")
          }
        >
          <SelectTrigger aria-label="按放映状态筛选" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="true">已放映</SelectItem>
            <SelectItem value="false">未放映</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          disabled={busy || loading}
          onClick={() => void refresh()}
        >
          刷新
        </Button>
      </section>

      {selected.length ? (
        <div className="mb-3 flex shrink-0 items-center gap-2 rounded-md bg-teal-50 px-3 py-2 text-sm text-teal-900">
          <span>已选 {selected.length} 部</span>
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void invoke(async () => {
                const result = await library.exportFiles(selected);
                if (result.cancelled) return;
                const copied = result.results.filter(
                  (entry) => entry.copied,
                ).length;
                if (copied) toast.success(`已导出 ${copied} 部`);
                const failed = result.results.filter((entry) => !entry.copied);
                if (failed.length)
                  toast.error(
                    failed.map((entry) => entry.error || "导出失败").join("；"),
                  );
                setSelected([]);
              })
            }
          >
            <Download />
            导出所选
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setSelected([])}
          >
            清除选择
          </Button>
        </div>
      ) : null}

      {rejections.length ? (
        <section
          role="status"
          aria-live="polite"
          className="mb-3 max-h-32 shrink-0 overflow-y-auto rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950"
        >
          <h2 className="font-medium">以下文件未能加入片库</h2>
          <ul className="mt-1 space-y-1">
            {rejections.map(({ path, reason }, index) => (
              <li key={`${path}-${index}`} className="break-all">
                <span className="font-medium">{path}</span>
                <span>：{reason}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section
        className="min-h-0 flex-1 overflow-y-auto rounded-lg border bg-white p-4"
        aria-live="polite"
      >
        {loading ? (
          <div className="flex h-full min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            正在打开片库…
          </div>
        ) : error ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 text-center">
            <CircleAlert className="size-8 text-amber-600" />
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" onClick={() => void refresh()}>
              重新加载
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-full min-h-56 flex-col items-center justify-center text-center">
            <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-teal-50 text-teal-800">
              <Clapperboard className="size-8" />
            </div>
            <h2 className="text-lg font-semibold">片库还空着</h2>
            <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
              导入电脑里的视频，或把已完成的本地下载同步到这里。视频仍保存在原来的位置。
            </p>
            <div className="mt-4 flex gap-2">
              <Button onClick={() => void chooseFiles()} disabled={busy}>
                <Plus />
                导入视频
              </Button>
              <Button
                variant="outline"
                onClick={() => window.location.assign("/source")}
              >
                找视频
              </Button>
            </div>
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 text-center">
            <Search className="size-7 text-muted-foreground" />
            <h2 className="font-medium">没有找到匹配的影片</h2>
            <p className="text-sm text-muted-foreground">
              试试更短的片名，或清除筛选条件。
            </p>
            <Button
              variant="ghost"
              onClick={() => {
                setQuery("");
                setCategory("all");
                setScreened("all");
              }}
            >
              清除筛选
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {visibleItems.map((item) => (
              <article
                key={item.id}
                className={`flex min-w-0 gap-3 rounded-lg border p-3 transition-colors ${selected.includes(item.id) ? "border-teal-300 bg-teal-50/40" : "bg-white hover:bg-slate-50"}`}
              >
                <Checkbox
                  aria-label={`选择${item.title}`}
                  checked={selected.includes(item.id)}
                  onCheckedChange={(checked) =>
                    toggleSelected(item.id, checked === true)
                  }
                  disabled={
                    busy || item.safety.status === "blocked" || item.missing
                  }
                  className="mt-1"
                />
                <div className="flex size-16 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-teal-50 to-slate-100 text-teal-800">
                  <Film className="size-7" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="truncate font-medium" title={item.title}>
                        {item.title}
                      </h2>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="rounded bg-slate-100 px-2 py-0.5">
                          {CATEGORY_LABELS[item.category]}
                        </span>
                        <span>{formatBytes(item.bytes)}</span>
                        {item.screened ? (
                          <span className="inline-flex items-center gap-1 text-teal-800">
                            <Check className="size-3.5" />
                            已放映
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <SafetyLabel item={item} />
                  </div>
                  {item.tags.length ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {item.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">
                      尚未添加标签
                    </p>
                  )}
                  <p
                    className="mt-2 truncate text-xs text-muted-foreground"
                    title={item.path}
                  >
                    {item.path}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      disabled={
                        busy || item.missing || item.safety.status === "blocked"
                      }
                      onClick={() => void invoke(() => library.play(item.id))}
                    >
                      <Play />
                      播放
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || item.missing}
                      onClick={() => void invoke(() => library.reveal(item.id))}
                    >
                      <FolderOpen />
                      打开位置
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        busy || item.missing || item.safety.status === "blocked"
                      }
                      onClick={() =>
                        void invoke(() => library.scan(item.id), "扫描完成")
                      }
                    >
                      <ShieldCheck />
                      扫描
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`编辑${item.title}`}
                      onClick={() => beginEdit(item)}
                    >
                      <Pencil />
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`从片库移除${item.title}`}
                      onClick={() => setRemoving(item)}
                    >
                      <Trash2 />
                      移除
                    </Button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      {snapshot && snapshot.totalBytes > 0 ? (
        <footer className="pt-2 text-right text-xs text-muted-foreground">
          片库占用 {formatBytes(snapshot.totalBytes)} · 视频文件保留在原位置
        </footer>
      ) : null}

      <Dialog
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditing(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑片目信息</DialogTitle>
            <DialogDescription>
              修改片名、分类、标签和放映状态。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block text-sm">
              片名
              <Input
                className="mt-1"
                value={editTitle}
                onChange={(event) => setEditTitle(event.target.value)}
                maxLength={160}
              />
            </label>
            <label className="block text-sm">
              分类
              <Select
                value={editCategory}
                onValueChange={(value) =>
                  setEditCategory(value as LibraryCategory)
                }
              >
                <SelectTrigger className="mt-1 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="block text-sm">
              标签
              <Input
                className="mt-1"
                value={editTags}
                onChange={(event) => setEditTags(event.target.value)}
                placeholder="用逗号分隔多个标签"
                maxLength={500}
              />
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={editScreened}
                onCheckedChange={(checked) => setEditScreened(checked === true)}
              />
              已放映
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button
              disabled={busy || !editTitle.trim()}
              onClick={() => void saveEdit()}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>从片库移除？</DialogTitle>
            <DialogDescription>
              “{removing?.title}”将从片库列表中移除，电脑上的视频文件不会删除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (!removing) return;
                const item = removing;
                setRemoving(null);
                void invoke(() => library.remove(item.id), "已从片库移除");
                setSelected((current) =>
                  current.filter((id) => id !== item.id),
                );
              }}
            >
              移除条目
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
