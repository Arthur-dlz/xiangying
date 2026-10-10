import { Download, Loader2 } from "lucide-react";
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
import type { ExtensionSettings, InvocationMode } from "../../shared/types";
import { isDownloadNowAvailable } from "../settings-model";

export interface ImportBehaviourCardProps {
  settings: ExtensionSettings;
  mode: InvocationMode;
  saving: boolean;
  onDownloadNowChange: (checked: boolean) => void;
}

export function ImportBehaviourCard({
  settings,
  mode,
  saving,
  onDownloadNowChange,
}: ImportBehaviourCardProps) {
  const { t } = useTranslation();
  const available = isDownloadNowAvailable(mode);
  const description = available
    ? t("options.importBehaviour.httpDescription")
    : t("options.importBehaviour.schemaReviewOnly");

  return (
    <Card
      data-card="import-behaviour"
      data-download-now-available={String(available)}
      aria-busy={saving || undefined}
    >
      <CardHeader className="pb-4">
        <div className="flex items-start gap-3">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-selected text-primary">
            <Download className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <CardTitle>{t("options.importBehaviour.title")}</CardTitle>
            <CardDescription className="mt-1">{description}</CardDescription>
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
              htmlFor="download-now"
              className={
                available
                  ? "cursor-pointer"
                  : "cursor-not-allowed text-muted-foreground"
              }
            >
              {t("options.importBehaviour.downloadNowLabel")}
            </Label>
            <p
              id="download-now-description"
              className="text-[13px] leading-5 text-muted-foreground"
            >
              {available
                ? t("options.importBehaviour.downloadNowDesc")
                : t("options.importBehaviour.schemaDisabled")}
            </p>
          </div>
          <Switch
            id="download-now"
            checked={available && settings.downloadNow}
            onCheckedChange={onDownloadNowChange}
            disabled={!available}
            aria-describedby="download-now-description"
          />
        </div>
      </CardContent>
    </Card>
  );
}
