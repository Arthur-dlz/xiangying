import { useMemoizedFn } from "ahooks";
import { ExternalLink, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { HelpButton } from "@/components/help-button";
import { Button } from "@/components/ui/button";
import { usePlatform } from "@/hooks/use-platform";
import { SettingsPromoCard } from "@/pages/setting-page/settings-promo-card";
import { useAppStore } from "@/store/app";
import { useDownloadStore } from "@/store/download";
import { useSessionStore } from "@/store/session";
import { useShellStore } from "@/store/shell";
import { cn, isWeb } from "@/utils";
import { AppBrand } from "./app-brand";
import { useNavigationItems } from "./navigation";
import { ServerAccountMenu } from "./server-account-menu";
import {
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  resolveSidebarResize,
} from "./sidebar-sizing";

interface Props {
  className?: string;
}

const SIDEBAR_SNAP_ANIMATION_MS = 150;

interface SidebarResizeSession {
  latestExpandedWidth: number;
  pendingWidth: number;
  pointerId: number;
  previousBodyCursor: string;
  previousBodyUserSelect: string;
  resizeAnimationFrame: number | null;
  snapAnimationTimer: ReturnType<typeof setTimeout> | null;
  startWidth: number;
  startX: number;
}

export function AppSideBar({ className }: Props) {
  const { app } = usePlatform();
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const items = useNavigationItems();
  const count = useDownloadStore((state) => state.count);
  const clearCount = useDownloadStore((state) => state.clearCount);
  const updateAvailable = useSessionStore((state) => state.updateAvailable);
  const openInNewWindow = useAppStore((state) => state.openInNewWindow);
  const setAppStore = useAppStore((state) => state.setAppStore);
  const collapsed = useShellStore((state) => state.sidebarCollapsed);
  const sidebarWidth = useShellStore((state) => state.sidebarWidth);
  const toggleSidebar = useShellStore((state) => state.toggleSidebar);
  const previousOpenInNewWindow = useRef(openInNewWindow);
  const sidebarRef = useRef<HTMLElement>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);
  const resizeSessionRef = useRef<SidebarResizeSession | null>(null);
  const helpIconOnly = isWeb || collapsed;
  const sidebarToggleLabel = t(collapsed ? "expandSidebar" : "collapseSidebar");

  useEffect(() => {
    const wasOpenInNewWindow = previousOpenInNewWindow.current;
    previousOpenInNewWindow.current = openInNewWindow;
    if (
      wasOpenInNewWindow &&
      !openInNewWindow &&
      location.pathname !== "/source"
    ) {
      navigate("/source", { replace: true });
    }
  }, [location.pathname, navigate, openInNewWindow]);

  const handleExternalLink = useMemoizedFn(async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (openInNewWindow) {
      setAppStore({ openInNewWindow: false });
      await app.combineToHomePage();
      return;
    }
    setAppStore({ openInNewWindow: true });
    if (location.pathname === "/source") navigate("/", { replace: true });
    await app.showBrowserWindow();
  });

  const handleNavigation = useMemoizedFn(
    (event: React.MouseEvent<HTMLAnchorElement>, key: string) => {
      if (key === "home") clearCount();
      if (key !== "source" || !openInNewWindow) return;
      event.preventDefault();
      event.stopPropagation();
      void app.showBrowserWindow();
    },
  );

  const startSidebarSnapAnimation = useMemoizedFn(() => {
    const session = resizeSessionRef.current;
    const sidebar = sidebarRef.current;
    if (!session || !sidebar) return;

    if (session.snapAnimationTimer) {
      clearTimeout(session.snapAnimationTimer);
    }
    delete sidebar.dataset.resizing;
    sidebar.dataset.snapping = "true";
    session.snapAnimationTimer = setTimeout(() => {
      if (resizeSessionRef.current !== session) return;
      session.snapAnimationTimer = null;
      delete sidebar.dataset.snapping;
      sidebarRef.current?.setAttribute("data-resizing", "true");
    }, SIDEBAR_SNAP_ANIMATION_MS);
  });

  const finishSidebarResize = useMemoizedFn((pointerId?: number) => {
    const session = resizeSessionRef.current;
    if (
      !session ||
      (pointerId !== undefined && session.pointerId !== pointerId)
    )
      return;

    if (session.resizeAnimationFrame !== null) {
      cancelAnimationFrame(session.resizeAnimationFrame);
      session.resizeAnimationFrame = null;
      sidebarRef.current?.style.setProperty(
        "--sidebar-width",
        `${session.pendingWidth}px`,
      );
    }
    if (session.snapAnimationTimer) {
      clearTimeout(session.snapAnimationTimer);
    }
    resizeSessionRef.current = null;
    const state = useShellStore.getState();
    if (!state.sidebarCollapsed) {
      state.setSidebarExpandedWidth(session.latestExpandedWidth);
    }

    delete sidebarRef.current?.dataset.resizing;
    delete sidebarRef.current?.dataset.snapping;
    document.body.style.cursor = session.previousBodyCursor;
    document.body.style.userSelect = session.previousBodyUserSelect;

    const handle = resizeHandleRef.current;
    if (handle?.hasPointerCapture(session.pointerId)) {
      handle.releasePointerCapture(session.pointerId);
    }
  });

  useEffect(
    () => () => {
      const session = resizeSessionRef.current;
      if (!session) return;
      resizeSessionRef.current = null;
      if (session.resizeAnimationFrame !== null) {
        cancelAnimationFrame(session.resizeAnimationFrame);
      }
      if (session.snapAnimationTimer) {
        clearTimeout(session.snapAnimationTimer);
      }
      document.body.style.cursor = session.previousBodyCursor;
      document.body.style.userSelect = session.previousBodyUserSelect;
    },
    [],
  );

  const handleResizePointerDown = useMemoizedFn(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();

      const state = useShellStore.getState();
      const startWidth = state.sidebarCollapsed
        ? SIDEBAR_COLLAPSED_WIDTH
        : state.sidebarWidth;
      resizeSessionRef.current = {
        latestExpandedWidth: state.sidebarWidth,
        pendingWidth: startWidth,
        pointerId: event.pointerId,
        previousBodyCursor: document.body.style.cursor,
        previousBodyUserSelect: document.body.style.userSelect,
        resizeAnimationFrame: null,
        snapAnimationTimer: null,
        startWidth,
        startX: event.clientX,
      };

      sidebarRef.current?.setAttribute("data-resizing", "true");
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
  );

  const handleResizePointerMove = useMemoizedFn(
    (event: PointerEvent<HTMLDivElement>) => {
      const session = resizeSessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;

      const requestedWidth =
        session.startWidth + event.clientX - session.startX;
      const result = resolveSidebarResize(requestedWidth);
      const state = useShellStore.getState();
      if (result.collapsed !== state.sidebarCollapsed) {
        startSidebarSnapAnimation();
      }

      session.pendingWidth = result.width;
      if (session.resizeAnimationFrame === null) {
        session.resizeAnimationFrame = requestAnimationFrame(() => {
          if (resizeSessionRef.current !== session) return;
          session.resizeAnimationFrame = null;
          sidebarRef.current?.style.setProperty(
            "--sidebar-width",
            `${session.pendingWidth}px`,
          );
        });
      }

      if (result.collapsed) {
        if (!state.sidebarCollapsed) state.setSidebarCollapsed(true);
        return;
      }

      session.latestExpandedWidth = result.width;
      if (state.sidebarCollapsed) {
        state.setSidebarExpandedWidth(result.width);
      }
    },
  );

  const handleResizeKeyDown = useMemoizedFn(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const state = useShellStore.getState();
      let requestedWidth: number;

      switch (event.key) {
        case "ArrowLeft":
          requestedWidth = state.sidebarCollapsed
            ? SIDEBAR_COLLAPSED_WIDTH
            : state.sidebarWidth - 16;
          break;
        case "ArrowRight":
          requestedWidth = state.sidebarCollapsed
            ? SIDEBAR_MIN_WIDTH
            : state.sidebarWidth + 16;
          break;
        case "Home":
          requestedWidth = SIDEBAR_COLLAPSED_WIDTH;
          break;
        case "End":
          requestedWidth = SIDEBAR_MAX_WIDTH;
          break;
        default:
          return;
      }

      event.preventDefault();
      const result = resolveSidebarResize(requestedWidth);
      if (result.collapsed) {
        state.setSidebarCollapsed(true);
      } else {
        state.setSidebarExpandedWidth(result.width);
      }
    },
  );

  const compact = collapsed;
  const renderedSidebarWidth = compact ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth;

  return (
    <aside
      ref={sidebarRef}
      style={
        {
          "--sidebar-width": `${renderedSidebarWidth}px`,
        } as CSSProperties
      }
      className={cn(
        "relative my-3 ml-3 hidden w-[var(--sidebar-width)] shrink-0 flex-col overflow-visible rounded-lg border bg-sidebar transition-[width] duration-200 ease-out data-[resizing=true]:duration-0 data-[snapping=true]:duration-[150ms] motion-reduce:transition-none max-[1079px]:w-16 min-[720px]:flex",
        className,
      )}
    >
      <AppBrand
        collapsed={compact}
        className="max-[1079px]:justify-center max-[1079px]:px-2 max-[1079px]:[&>span]:hidden max-[1079px]:[&>img]:mr-0"
      />
      <nav className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-3 max-[1079px]:px-2">
        <div className="flex flex-col gap-2">
          {items.map(({ active, Icon, key, label, to }) => (
            <Link
              key={key}
              to={to}
              title={label}
              onClick={(event) => handleNavigation(event, key)}
              className={cn(
                "group relative flex h-9 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground max-[1079px]:justify-center max-[1079px]:px-0",
                compact && "justify-center px-0",
                active &&
                  "bg-primary text-primary-foreground hover:bg-brand-hover hover:text-primary-foreground",
              )}
            >
              <span className="relative shrink-0">
                <Icon className="size-5 stroke-[1.75]" />
                {key === "settings" && updateAvailable ? (
                  <span className="absolute -right-1 -top-0.5 size-1.5 rounded-full bg-destructive" />
                ) : null}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate max-[1079px]:hidden",
                  compact && "hidden",
                )}
              >
                {label}
              </span>
              {key === "home" && count > 0 ? (
                <span
                  className={cn(
                    "min-w-4 rounded-full bg-destructive px-1 text-center text-[10px] leading-4 text-destructive-foreground max-[1079px]:absolute max-[1079px]:right-0 max-[1079px]:top-0",
                    compact && "absolute right-0 top-0",
                  )}
                >
                  {count > 99 ? "99+" : count}
                </span>
              ) : null}
              {key === "source" && !compact ? (
                <button
                  type="button"
                  title={t(
                    openInNewWindow ? "openInMainWindow" : "openInNewWindow",
                  )}
                  aria-label={t(
                    openInNewWindow ? "openInMainWindow" : "openInNewWindow",
                  )}
                  className="cursor-pointer opacity-0 transition-opacity group-hover:opacity-100 max-[1079px]:hidden"
                  onClick={handleExternalLink}
                >
                  <ExternalLink
                    className={cn(
                      "size-4 stroke-[1.75]",
                      openInNewWindow && "rotate-180",
                    )}
                  />
                </button>
              ) : null}
            </Link>
          ))}
        </div>
      </nav>
      {!compact ? (
        <SettingsPromoCard
          placement="sidebar"
          className="max-[1079px]:hidden"
        />
      ) : null}
      <div
        className={cn(
          "flex shrink-0 items-center gap-1 border-t p-3 max-[1079px]:flex-col max-[1079px]:px-2",
          compact && "flex-col px-2",
        )}
      >
        {isWeb ? (
          <div className="min-w-0 flex-1 max-[1079px]:flex-none">
            <ServerAccountMenu compact={compact} />
          </div>
        ) : null}
        <HelpButton
          iconOnly={helpIconOnly}
          className={cn(
            "rounded-md text-muted-foreground",
            helpIconOnly
              ? "size-9 p-0"
              : "h-9 min-w-0 flex-1 justify-start px-3 text-sm font-normal max-[1079px]:size-9 max-[1079px]:flex-none max-[1079px]:justify-center max-[1079px]:gap-0 max-[1079px]:px-0 max-[1079px]:text-[0px]",
          )}
          iconClassName="size-5 stroke-[1.75]"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={sidebarToggleLabel}
          aria-label={sidebarToggleLabel}
          className="size-9 shrink-0 p-0 text-muted-foreground max-[1079px]:hidden"
          onClick={toggleSidebar}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-5" strokeWidth={1.75} />
          ) : (
            <PanelLeftClose className="size-5" strokeWidth={1.75} />
          )}
        </Button>
      </div>
      <div
        ref={resizeHandleRef}
        role="separator"
        aria-label={t("resizeSidebar")}
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_COLLAPSED_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={renderedSidebarWidth}
        aria-valuetext={
          compact
            ? t("sidebarCollapsed")
            : t("sidebarWidthPixels", { width: renderedSidebarWidth })
        }
        tabIndex={0}
        title={t("resizeSidebar")}
        className="absolute inset-y-0 -right-3 z-20 w-6 cursor-col-resize touch-none focus-visible:bg-ring/10 focus-visible:outline-none max-[1079px]:hidden"
        onKeyDown={handleResizeKeyDown}
        onLostPointerCapture={(event) => finishSidebarResize(event.pointerId)}
        onPointerCancel={(event) => finishSidebarResize(event.pointerId)}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={(event) => finishSidebarResize(event.pointerId)}
      />
    </aside>
  );
}
