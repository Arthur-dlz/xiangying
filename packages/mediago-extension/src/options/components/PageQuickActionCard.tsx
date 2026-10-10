import { Loader2, MousePointerClick } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Label } from "../../components/ui/label";
import { Switch } from "../../components/ui/switch";

export interface PageQuickActionCardProps {
  enabled: boolean;
  saving: boolean;
  onEnabledChange: (checked: boolean) => void;
}

export function PageQuickActionCard({
  enabled,
  saving,
  onEnabledChange,
}: PageQuickActionCardProps) {
  const { t } = useTranslation();

  return (
    <Card data-card="page-quick-action" aria-busy={saving || undefined}>
      <CardHeader className="pb-4">
        <div className="flex items-start gap-3">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-selected text-primary">
            <MousePointerClick className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <CardTitle>{t("options.pageQuickAction.title")}</CardTitle>
            <CardDescription className="mt-1">
              {t("options.pageQuickAction.description")}
            </CardDescription>
          </div>
          {saving ? (
            <Loader2
              className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
              aria-label={t("common.saving")}
            />
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-surface-subtle p-3.5">
          <div className="min-w-0 flex-1 space-y-1">
            <Label
              htmlFor="page-quick-action-enabled"
              className={
                saving
                  ? "cursor-not-allowed text-muted-foreground"
                  : "cursor-pointer"
              }
            >
              {t("options.pageQuickAction.enabledLabel")}
            </Label>
            <p
              id="page-quick-action-description"
              className="text-[13px] leading-5 text-muted-foreground"
            >
              {t("options.pageQuickAction.enabledDescription")}
            </p>
          </div>
          <Switch
            id="page-quick-action-enabled"
            checked={enabled}
            disabled={saving}
            onCheckedChange={onEnabledChange}
            aria-describedby="page-quick-action-description"
          />
        </div>
      </CardContent>
    </Card>
  );
}
