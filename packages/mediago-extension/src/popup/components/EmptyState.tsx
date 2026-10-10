import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import emptyResources from "../../assets/images/empty-resources.png";
import { Button } from "../../components/ui/button";

interface EmptyStateProps {
  actionLabel: string;
  actionName: string;
  onAction: () => void;
}

export function EmptyState({
  actionLabel,
  actionName,
  onAction,
}: EmptyStateProps) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-7 py-7 text-center">
      <img
        src={emptyResources}
        alt=""
        aria-hidden="true"
        data-empty-illustration="radar"
        className="h-24 w-28 object-contain"
      />
      <div className="mt-1">
        <h2 className="text-sm font-semibold tracking-[-0.01em]">
          {t("empty.title")}
        </h2>
        <p className="mx-auto mt-1 max-w-[270px] text-xs leading-5 text-muted-foreground">
          {t("empty.hint")}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mt-4"
        data-action={actionName}
        onClick={onAction}
      >
        <RefreshCw className="size-3.5" aria-hidden="true" />
        {actionLabel}
      </Button>
    </div>
  );
}
