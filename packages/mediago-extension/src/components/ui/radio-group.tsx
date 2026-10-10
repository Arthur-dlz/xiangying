import * as React from "react";

import { cn } from "../../lib/utils";

interface RadioGroupProps<Value extends string> extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "onChange"
> {
  value: Value;
  onValueChange: (value: Value) => void;
  name?: string;
}

export function RadioGroup<Value extends string>({
  className,
  value,
  onValueChange,
  name,
  children,
  ...props
}: RadioGroupProps<Value>) {
  const ctx = {
    value,
    onValueChange: onValueChange as (v: string) => void,
    name,
  };
  return (
    <RadioGroupContext.Provider value={ctx}>
      <div
        role="radiogroup"
        className={cn("flex flex-col gap-2", className)}
        {...props}
      >
        {children}
      </div>
    </RadioGroupContext.Provider>
  );
}

interface RadioGroupItemProps extends React.HTMLAttributes<HTMLLabelElement> {
  value: string;
  title: string;
  description?: string;
  disabled?: boolean;
  variant?: "card" | "segment" | "compact";
}

export function RadioGroupItem({
  className,
  value,
  title,
  description,
  disabled,
  variant = "card",
  ...rest
}: RadioGroupItemProps) {
  const ctx = React.useContext(RadioGroupContext);
  if (!ctx) throw new Error("RadioGroupItem must be inside RadioGroup");
  const checked = ctx.value === value;
  return (
    <label
      className={cn(
        "group flex cursor-pointer gap-3 border border-border bg-surface-raised transition-[border-color,background-color,box-shadow] duration-150 motion-reduce:transition-none",
        variant === "card" && "items-start rounded-lg p-3",
        variant === "segment" && "items-center rounded-md px-3 py-2",
        variant === "compact" && "items-center rounded-md px-2.5 py-2",
        checked
          ? "border-primary bg-surface-selected shadow-ambient"
          : "hover:border-border-strong hover:bg-surface-hover",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
      {...rest}
    >
      <input
        type="radio"
        name={ctx.name}
        value={value}
        checked={checked}
        onChange={() => ctx.onValueChange(value)}
        disabled={disabled}
        className={cn(
          "h-4 w-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
          variant === "card" && "mt-0.5",
          disabled ? "cursor-not-allowed" : "cursor-pointer",
        )}
      />
      <div className="flex flex-1 flex-col">
        <span className="text-sm font-medium leading-tight">{title}</span>
        {description && (
          <span className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            {description}
          </span>
        )}
      </div>
    </label>
  );
}

interface RadioGroupContextValue<Value extends string = string> {
  value: Value;
  onValueChange: (value: Value) => void;
  name?: string;
}

const RadioGroupContext = React.createContext<RadioGroupContextValue | null>(
  null,
);
