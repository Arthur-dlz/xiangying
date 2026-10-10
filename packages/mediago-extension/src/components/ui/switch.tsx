import * as React from "react";

import { cn } from "../../lib/utils";

export interface SwitchProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "onChange"
> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ className, checked, onCheckedChange, disabled, ...props }, ref) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-state={checked ? "checked" : "unchecked"}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      ref={ref}
      className={cn(
        "peer inline-flex h-[1.125rem] w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent p-px transition-[background-color,box-shadow] duration-150 focus-visible:border-focus-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
        checked ? "bg-primary" : "bg-control-track",
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          "pointer-events-none block size-3.5 rounded-full bg-surface-raised shadow-sm transition-transform duration-150 motion-reduce:transition-none dark:bg-foreground",
          checked ? "translate-x-3.5" : "translate-x-0",
        )}
      />
    </button>
  ),
);
Switch.displayName = "Switch";
