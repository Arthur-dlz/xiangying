import {
  AlertCircle,
  DownloadCloud,
  LoaderCircle,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  Trash2,
  WifiOff,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "../components/ui/button";
import { renderLocalized } from "../i18n/localized-message";
import type {
  DetectedSource,
  ExtensionSettings,
  ServerStatus,
} from "../shared/types";
import { EmptyState } from "./components/EmptyState";
import { SourceItem } from "./components/SourceItem";
import { StatusBadge } from "./components/StatusBadge";
import type { PopupLoadError } from "./popup-data-loader";
import {
  derivePopupViewState,
  isPopupImportDisabled,
  type PopupViewState,
} from "./popup-view-state";

export interface PopupViewProps {
  tab: chrome.tabs.Tab | null;
  sources: DetectedSource[];
  settings: ExtensionSettings | null;
  serverStatus: ServerStatus | null;
  loading: boolean;
  loadError: PopupLoadError | null;
  importing: boolean;
  onRetry: () => void;
  onClear: () => void;
  onImportAll: () => void;
  onImport: (source: DetectedSource) => void;
  onOpenSettings: () => void;
  onReloadPage: () => void;
}

interface StatePanelProps {
  state: Exclude<PopupViewState, "loading" | "empty" | "ready">;
  detail?: string;
  onRetry: () => void;
  onOpenSettings: () => void;
}

function PopupSkeleton() {
  const { t } = useTranslation();

  return (
    <div
      className="flex min-h-56 flex-col justify-center gap-4 px-4 py-6"
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">{t("popup.loadingTitle")}</span>
      {[0, 1, 2].map((item) => (
        <div
          key={item}
          aria-hidden="true"
          className="flex items-center gap-3 rounded-lg border border-border bg-surface-raised p-3 shadow-ambient"
        >
          <div className="size-9 shrink-0 animate-pulse rounded-md bg-surface-selected motion-reduce:animate-none" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3 w-3/5 animate-pulse rounded bg-surface-hover motion-reduce:animate-none" />
            <div className="h-2.5 w-2/5 animate-pulse rounded bg-surface-subtle motion-reduce:animate-none" />
          </div>
          <div className="h-7 w-16 animate-pulse rounded-md bg-surface-hover motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  );
}

function StatePanel({
  state,
  detail,
  onRetry,
  onOpenSettings,
}: StatePanelProps) {
  const { t } = useTranslation();
  const isLoadError = state === "load-error";
  const isSetup = state === "needs-setup";
  const Icon = isLoadError
    ? AlertCircle
    : isSetup
      ? SlidersHorizontal
      : WifiOff;
  const title = isLoadError
    ? t("popup.loadErrorTitle")
    : isSetup
      ? t("popup.setupTitle")
      : t("popup.connectionErrorTitle");
  const description = isLoadError
    ? t("popup.loadErrorHint")
    : isSetup
      ? t("popup.setupHint")
      : t("popup.connectionErrorHint");

  return (
    <div
      className="flex min-h-56 flex-col items-center justify-center px-8 py-7 text-center"
      role={state === "needs-setup" ? "status" : "alert"}
    >
      <div className="mb-4 grid size-11 place-items-center rounded-lg border border-primary/20 bg-surface-selected text-primary">
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <h2 className="text-sm font-semibold tracking-[-0.01em]">{title}</h2>
      <p className="mt-1.5 max-w-[280px] text-xs leading-5 text-muted-foreground">
        {description}
      </p>
      {detail ? (
        <p className="mt-2 max-w-[280px] break-words rounded-md bg-surface-subtle px-2.5 py-1.5 font-mono text-[10px] leading-4 text-foreground-secondary">
          {detail}
        </p>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant={isLoadError ? "outline" : "default"}
        className="mt-4"
        data-action={isLoadError ? "retry" : "open-settings"}
        onClick={isLoadError ? onRetry : onOpenSettings}
      >
        {isLoadError ? (
          <RefreshCw className="size-3.5" aria-hidden="true" />
        ) : (
          <Settings className="size-3.5" aria-hidden="true" />
        )}
        {isLoadError ? t("popup.retry") : t("popup.openConnectionSettings")}
      </Button>
    </div>
  );
}

export function PopupView({
  tab,
  sources,
  settings,
  serverStatus,
  loading,
  loadError,
  importing,
  onRetry,
  onClear,
  onImportAll,
  onImport,
  onOpenSettings,
  onReloadPage,
}: PopupViewProps) {
  const { t } = useTranslation();
  const needsSetup =
    settings?.mode === "docker-http" && !settings.serverUrl.trim();
  const connectionError =
    settings !== null &&
    settings.mode !== "desktop-schema" &&
    !needsSetup &&
    serverStatus?.ok === false;
  const viewState = derivePopupViewState({
    loading,
    loadError: loadError !== null,
    needsSetup,
    connectionError,
    sourceCount: sources.length,
  });
  const inspectingSources = sources.some(
    (source) => source.mediaInfo?.status === "inspecting",
  );
  const importDisabled = isPopupImportDisabled({
    importing,
    inspecting: inspectingSources,
    viewState,
    sourceCount: sources.length,
  });
  const isBusy = loading || importing;
  const statusDetail =
    viewState === "load-error"
      ? renderLocalized(t, loadError ?? undefined)
      : viewState === "connection-error"
        ? renderLocalized(t, serverStatus?.message)
        : undefined;

  return (
    <div
      className="flex h-[560px] max-h-[inherit] flex-col overflow-hidden bg-background text-foreground"
      data-popup-state={viewState}
      data-importing={importing ? "true" : undefined}
      aria-busy={isBusy || undefined}
    >
      <header className="relative isolate flex shrink-0 items-center justify-between gap-3 overflow-hidden bg-action px-4 py-3 text-white">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-white/20 bg-white/95 shadow-sm">
            <img
              src="/public/icons/mediago-32.png"
              alt=""
              width={20}
              height={20}
            />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold tracking-[-0.015em]">
              {t("popup.header")}
            </p>
            <p className="text-[10px] font-medium tracking-[0.08em] text-white uppercase">
              {t("popup.workspaceLabel")}
            </p>
          </div>
        </div>
        <StatusBadge
          status={serverStatus}
          settings={settings}
          loading={viewState === "loading"}
          inverted
        />
      </header>

      <section
        className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4 py-2.5"
        aria-label={t("popup.pageContext")}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground">
            {tab?.title || t("popup.untitledPage")}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
            {tab?.url || t("popup.noPageUrl")}
          </p>
        </div>
        <span className="shrink-0 rounded-md border border-border-strong bg-surface-raised px-2 py-1 text-[10px] font-medium text-foreground-secondary">
          {t("popup.detectedCount", { count: sources.length })}
        </span>
      </section>

      <main className="min-h-0 flex-1 overflow-y-auto bg-background">
        {viewState === "loading" ? <PopupSkeleton /> : null}
        {viewState === "load-error" ||
        viewState === "needs-setup" ||
        viewState === "connection-error" ? (
          <StatePanel
            state={viewState}
            detail={statusDetail}
            onRetry={onRetry}
            onOpenSettings={onOpenSettings}
          />
        ) : null}
        {viewState === "empty" ? (
          <EmptyState
            actionLabel={t("empty.reloadPage")}
            actionName="reload-page"
            onAction={onReloadPage}
          />
        ) : null}
        {viewState === "ready" ? (
          <ul
            className="flex flex-col gap-2 p-3"
            aria-label={t("popup.resourceList")}
          >
            {sources.map((source) => (
              <SourceItem
                key={source.id}
                source={source}
                disabled={importing}
                onImport={onImport}
              />
            ))}
          </ul>
        ) : null}
      </main>

      <footer className="flex shrink-0 items-center gap-2 border-t border-border bg-surface-raised px-3 py-2.5 shadow-[0_-4px_14px_rgb(23_32_43_/_0.04)]">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={sources.length === 0 || loading || importing}
          onClick={onClear}
          title={t("popup.clearLabel")}
          aria-label={t("popup.clearLabel")}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          className="flex-1"
          size="sm"
          disabled={importDisabled}
          onClick={onImportAll}
          aria-busy={importing || undefined}
        >
          {importing ? (
            <LoaderCircle
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <DownloadCloud className="size-3.5" aria-hidden="true" />
          )}
          {importing
            ? t("popup.importing")
            : sources.length > 0
              ? t("popup.importAllWithCount", { count: sources.length })
              : t("popup.importAll")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={t("popup.settings")}
          aria-label={t("popup.settings")}
          onClick={onOpenSettings}
        >
          <Settings className="size-4" aria-hidden="true" />
        </Button>
      </footer>
    </div>
  );
}
