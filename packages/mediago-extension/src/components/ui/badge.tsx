import { DownloadType } from "@mediago/common";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide transition-colors",
  {
    variants: {
      variant: {
        default: "border-primary/20 bg-primary/10 text-brand-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive:
          "border-destructive-badge-border bg-destructive-badge-background text-destructive-badge-foreground",
        outline: "border-border bg-transparent text-foreground-secondary",
        success:
          "border-success-badge-border bg-success-badge-background text-success-badge-foreground",
        warning:
          "border-warning-badge-border bg-warning-badge-background text-warning-badge-foreground",
        thinking: "border-primary/20 bg-primary/10 text-brand-foreground",
        grep: "border-primary/20 bg-primary/10 text-brand-foreground",
        read: "border-primary/20 bg-primary/10 text-brand-foreground",
        edit: "border-primary/20 bg-primary/10 text-brand-foreground",
        mediago: "border-primary/20 bg-primary/10 text-brand-foreground",
      },
      tone: {
        solid: "",
        soft: "opacity-90",
      },
    },
    defaultVariants: {
      variant: "default",
      tone: "solid",
    },
  },
);

export interface BadgeProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, tone, ...props }: BadgeProps) {
  return (
    <div
      className={cn(badgeVariants({ variant, tone }), className)}
      {...props}
    />
  );
}

export function variantForDownloadType(
  type: DownloadType | string,
): "thinking" | "grep" | "read" | "edit" | "mediago" | "secondary" {
  switch (type) {
    case DownloadType.bilibili:
      return "thinking";
    case DownloadType.direct:
      return "grep";
    case DownloadType.youtube:
    case DownloadType.xiaohongshu:
      return "read";
    case DownloadType.m3u8:
      return "edit";
    case DownloadType.mediago:
      return "mediago";
    default:
      return "secondary";
  }
}

export { Badge, badgeVariants };
