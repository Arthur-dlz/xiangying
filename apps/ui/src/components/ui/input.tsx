import * as React from "react";

import { cn } from "@/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-md border border-input/80 bg-surface-raised px-3 text-base outline-none transition-[border-color,box-shadow,background-color] selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground hover:border-foreground/25 read-only:bg-surface-subtle disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-muted-foreground disabled:opacity-100 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/15",
        "aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/15",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
