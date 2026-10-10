import { Link } from "react-router-dom";
import { useDownloadStore } from "@/store/download";
import { useSessionStore } from "@/store/session";
import { cn } from "@/utils";
import { useNavigationItems } from "./navigation";

export function AppBottomNav() {
  const items = useNavigationItems();
  const downloadCount = useDownloadStore((state) => state.count);
  const clearDownloadCount = useDownloadStore((state) => state.clearCount);
  const updateAvailable = useSessionStore((state) => state.updateAvailable);

  return (
    <nav className="z-30 flex h-16 shrink-0 border-t bg-canvas px-1 min-[720px]:hidden">
      {items.map(({ active, Icon, key, label, to }) => (
        <Link
          key={key}
          to={to}
          onClick={key === "home" ? clearDownloadCount : undefined}
          className={cn(
            "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 text-[10px] font-medium text-muted-foreground transition-colors",
            active && "text-brand",
          )}
        >
          <span className="relative">
            <Icon className="size-5 stroke-[1.75]" />
            {key === "home" && downloadCount > 0 ? (
              <span className="absolute -right-2.5 -top-1 min-w-4 rounded-full bg-destructive px-1 text-center text-[9px] leading-4 text-destructive-foreground">
                {downloadCount > 99 ? "99+" : downloadCount}
              </span>
            ) : null}
            {key === "settings" && updateAvailable ? (
              <span className="absolute -right-1 -top-0.5 size-1.5 rounded-full bg-destructive" />
            ) : null}
          </span>
          <span className="max-w-full truncate">{label}</span>
        </Link>
      ))}
    </nav>
  );
}
