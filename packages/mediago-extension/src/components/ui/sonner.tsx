import {
  CircleCheck,
  CircleX,
  Info,
  Loader2,
  TriangleAlert,
  X,
} from "lucide-react";
import * as React from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const toastIcons: NonNullable<ToasterProps["icons"]> = {
  success: <CircleCheck className="size-4 text-current" />,
  info: <Info className="size-4 text-current" />,
  warning: <TriangleAlert className="size-4 text-current" />,
  error: <CircleX className="size-4 text-current" />,
  loading: <Loader2 className="size-4 animate-spin text-current" />,
  close: <X className="size-4 text-current" />,
};

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = React.useMemo<ToasterProps["theme"]>(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    ) {
      return "dark";
    }
    return "light";
  }, []);

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={toastIcons}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:rounded-lg group-[.toaster]:bg-popover group-[.toaster]:text-popover-foreground group-[.toaster]:border group-[.toaster]:border-border group-[.toaster]:shadow-elevated",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:rounded-md group-[.toast]:bg-action group-[.toast]:text-primary-foreground group-[.toast]:hover:bg-action-hover",
          cancelButton:
            "group-[.toast]:rounded-md group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
          success: "group-[.toast]:!text-success",
          error: "group-[.toast]:!text-destructive",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
