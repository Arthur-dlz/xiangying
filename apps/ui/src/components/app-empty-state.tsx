import type { ReactNode } from "react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/utils";

interface AppEmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  illustration?: string;
  media?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
  className?: string;
}

export function AppEmptyState({
  title,
  description,
  illustration,
  media,
  actions,
  compact = false,
  className,
}: AppEmptyStateProps) {
  return (
    <Empty
      className={cn(
        "gap-4 border-0 p-6 md:p-8",
        compact && "gap-3 p-4 md:p-6",
        className,
      )}
    >
      {illustration ? (
        <EmptyMedia className="mb-0 h-36 w-44 md:h-40 md:w-52">
          <img
            src={illustration}
            alt=""
            aria-hidden="true"
            className="size-full object-contain"
          />
        </EmptyMedia>
      ) : media ? (
        <EmptyMedia variant="icon" className="mb-0">
          {media}
        </EmptyMedia>
      ) : null}

      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? (
          <EmptyDescription>{description}</EmptyDescription>
        ) : null}
      </EmptyHeader>

      {actions ? (
        <EmptyContent className="flex-row justify-center gap-2">
          {actions}
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
