import * as React from "react";

import { cn } from "@/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full resize-y rounded-md border border-input/80 bg-surface-raised px-3 py-2 text-base outline-none transition-[border-color,box-shadow,background-color] placeholder:text-muted-foreground hover:border-foreground/25 read-only:bg-surface-subtle read-only:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/15 disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-muted-foreground disabled:opacity-100 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/15 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
