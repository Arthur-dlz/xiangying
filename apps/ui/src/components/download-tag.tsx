import type React from "react";
import { cn } from "@/utils";

type DownloadTagVariant =
  | "brand"
  | "info"
  | "success"
  | "destructive"
  | "muted";

interface DownloadTagProps {
  icon?: React.ReactNode;
  text: string;
  variant?: DownloadTagVariant;
  className?: string;
}

export function DownloadTag({
  icon,
  text,
  variant = "muted",
  className,
}: DownloadTagProps) {
  return (
    <div
      className={cn(
        "flex shrink-0 cursor-default flex-row items-center gap-0.5 rounded-sm px-1.5 py-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:stroke-2",
        {
          "bg-brand/10 text-brand": variant === "brand",
          "bg-sky-500/10 text-sky-600 dark:text-sky-400": variant === "info",
          "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400":
            variant === "success",
          "bg-destructive/10 text-destructive": variant === "destructive",
          "bg-secondary text-muted-foreground": variant === "muted",
        },
        className,
      )}
    >
      {icon}
      <span className="text-xs">{text}</span>
    </div>
  );
}
