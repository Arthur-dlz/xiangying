import { cn } from "@/utils";

interface AppBrandProps {
  className?: string;
  collapsed?: boolean;
}

export function AppBrand({ className, collapsed = false }: AppBrandProps) {
  return (
    <div
      className={cn(
        "flex h-14 shrink-0 select-none items-center border-b px-3",
        collapsed && "justify-center px-2",
        className,
      )}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md bg-teal-700 text-sm font-bold text-white",
          !collapsed && "mr-2",
        )}
        aria-hidden="true"
      >
        乡
      </span>
      {!collapsed ? (
        <span className="flex min-w-0 flex-col justify-center gap-0.5">
          <span className="whitespace-nowrap text-base font-semibold leading-5 tracking-[0.08em]">
            乡映
          </span>
          <span className="whitespace-nowrap text-[10px] font-medium leading-3 text-muted-foreground">
            本地影音片库
          </span>
        </span>
      ) : null}
    </div>
  );
}
