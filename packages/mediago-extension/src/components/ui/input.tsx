import * as React from "react";

import { cn } from "../../lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-8 w-full rounded-md border border-control-border bg-surface-raised px-3 py-1 text-[13px] text-foreground transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground focus-visible:border-focus-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:opacity-50 motion-reduce:transition-none",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
