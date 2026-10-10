import { CircleAlert, Globe2, LoaderCircle, Plus, X } from "lucide-react";
import { type KeyboardEvent, memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useMemoizedFn } from "ahooks";
import { Button } from "@/components/ui/button";
import { useBrowserActions } from "@/hooks/use-browser-actions";
import {
  browserTabsSelector,
  type BrowserTabState,
  useBrowserStore,
} from "@/store/browser";
import { cn } from "@/utils";
import {
  activeTabElementId,
  formatSourceBadge,
  getCloseFallbackId,
  nextTabId,
  resolveTabLabel,
} from "./browser-tab-strip-logic";

interface BrowserTabButtonProps {
  active: boolean;
  focused: boolean;
  newTabLabel: string;
  tab: BrowserTabState;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onFocusTab: (tabId: string) => void;
  onMoveFocus: (tabId: string, direction: 1 | -1) => void;
}

const BrowserTabButton = memo(function BrowserTabButton({
  active,
  focused,
  newTabLabel,
  tab,
  onActivate,
  onClose,
  onFocusTab,
  onMoveFocus,
}: BrowserTabButtonProps) {
  const { t } = useTranslation();
  const label = resolveTabLabel(tab, newTabLabel);
  const badge = formatSourceBadge(tab.sources.length);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      onMoveFocus(tab.id, event.key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate(tab.id);
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      onClose(tab.id);
    }
  };

  return (
    <div
      id={activeTabElementId(tab.id)}
      role="tab"
      aria-controls={`browser-panel-${tab.id}`}
      aria-selected={active}
      aria-label={`${label} · ${t("sniffedResourceCount", { count: badge.count })}`}
      tabIndex={focused ? 0 : -1}
      title={label}
      className={cn(
        "group relative flex h-8 min-w-24 max-w-[220px] flex-[1_1_160px] cursor-pointer select-none items-center gap-1.5 rounded-t-md border border-transparent px-2 text-[13px] outline-none transition-[background-color,border-color,color,box-shadow] focus-visible:z-10 focus-visible:ring-[3px] focus-visible:ring-ring/25",
        active
          ? "border-border border-b-surface bg-surface text-foreground shadow-xs"
          : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
      )}
      onClick={() => onActivate(tab.id)}
      onFocus={() => onFocusTab(tab.id)}
      onKeyDown={onKeyDown}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          onClose(tab.id);
        }
      }}
    >
      {tab.status === "loading" ? (
        <LoaderCircle
          className="size-3.5 shrink-0 animate-spin"
          aria-label={t("tabLoading")}
        />
      ) : tab.status === "failed" ? (
        <CircleAlert
          className="size-3.5 shrink-0 text-destructive"
          aria-label={t("tabFailed")}
        />
      ) : tab.favicon ? (
        <img className="size-3.5 shrink-0" src={tab.favicon} alt="" />
      ) : (
        <Globe2 className="size-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge.count > 0 ? (
        <span
          className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-secondary px-1 text-[11px] leading-none tabular-nums text-secondary-foreground"
          aria-hidden="true"
        >
          {badge.text}
        </span>
      ) : null}
      <button
        type="button"
        className={cn(
          "-mr-1 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-none transition-[background-color,color,opacity,box-shadow] hover:bg-secondary hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/25",
          active && "opacity-70",
          "group-hover:opacity-70",
        )}
        aria-label={t("closeTab", { title: label })}
        title={t("closeTab", { title: label })}
        onClick={(event) => {
          event.stopPropagation();
          onClose(tab.id);
        }}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
});

export function BrowserTabStrip() {
  const { tabs, activeTabId } = useBrowserStore(
    useShallow(browserTabsSelector),
  );
  const { activateTab, closeTab, createTab } = useBrowserActions();
  const { t } = useTranslation();
  const [focusedTabId, setFocusedTabId] = useState(activeTabId);
  const tabIds = tabs.map((tab) => tab.id);

  useEffect(() => {
    setFocusedTabId(activeTabId);
    const activeElement = document.getElementById(
      activeTabElementId(activeTabId),
    );
    activeElement?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [activeTabId]);

  const handleActivate = useMemoizedFn((tabId: string) => {
    void activateTab(tabId);
  });

  const handleClose = useMemoizedFn((tabId: string) => {
    const fallback = getCloseFallbackId(tabIds, tabId);
    if (focusedTabId === tabId && fallback) setFocusedTabId(fallback);
    void closeTab(tabId);
  });

  const handleMoveFocus = useMemoizedFn((tabId: string, direction: 1 | -1) => {
    const nextId = nextTabId(tabIds, tabId, direction);
    if (!nextId) return;
    setFocusedTabId(nextId);
    document.getElementById(activeTabElementId(nextId))?.focus();
  });

  const handleCreate = useMemoizedFn(() => {
    void createTab();
  });

  return (
    <div className="flex h-9 shrink-0 items-end border-b bg-surface-subtle px-1 pt-1">
      <div
        role="tablist"
        aria-label={t("browserTabs")}
        className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab) => (
          <BrowserTabButton
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            focused={tab.id === focusedTabId}
            newTabLabel={t("newTab")}
            onActivate={handleActivate}
            onClose={handleClose}
            onFocusTab={setFocusedTabId}
            onMoveFocus={handleMoveFocus}
          />
        ))}
      </div>
      <div className="flex h-8 shrink-0 items-center border-l border-border/70 bg-surface-subtle pl-1">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t("newTab")}
          title={t("newTab")}
          onClick={handleCreate}
        >
          <Plus />
        </Button>
      </div>
    </div>
  );
}
