import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";

export function AboutCard({ version }: { version: string }) {
  const { t } = useTranslation();
  return (
    <Card data-card="about">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-selected text-primary">
            <Info className="size-4" aria-hidden="true" />
          </div>
          <CardTitle>{t("options.about.title")}</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface-subtle px-3.5 py-3">
          <div>
            <p className="text-[13px] font-medium">
              {t("options.about.productName")}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("options.about.description")}
            </p>
          </div>
          <span className="shrink-0 rounded-md border border-border bg-surface-raised px-2 py-1 font-mono text-[10px] text-foreground-secondary">
            {t("options.about.version", { version })}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
