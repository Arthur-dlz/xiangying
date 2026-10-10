import { ScanSearch } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "../../components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";

const RULES = [
  { type: "m3u8", labelKey: "options.rules.m3u8Label", detail: "*.m3u8" },
  {
    type: "direct",
    labelKey: "options.rules.directLabel",
    detail: "*.mp4 / .flv / .mov / .avi / .mkv / .wmv / .m4a / .ogg",
  },
  {
    type: "bilibili",
    labelKey: "options.rules.bilibiliLabel",
    detail: "bilibili.com/video/*",
  },
  {
    type: "youtube",
    labelKey: "options.rules.youtubeLabel",
    detail: "youtube.com, youtu.be",
  },
] as const;

export function RuleListCard() {
  const { t } = useTranslation();
  return (
    <Card data-card="rules">
      <CardHeader className="pb-4">
        <div className="flex items-start gap-3">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-selected text-primary">
            <ScanSearch className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <CardTitle>{t("options.rules.title")}</CardTitle>
            <CardDescription className="mt-1">
              {t("options.rules.description")}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface-subtle">
          {RULES.map((rule) => (
            <li key={rule.type} className="flex items-start gap-3 px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium leading-5">
                  {t(rule.labelKey)}
                </p>
                <p className="mt-0.5 break-words font-mono text-[10px] leading-4 text-muted-foreground">
                  {rule.detail}
                </p>
              </div>
              <Badge variant="outline">{rule.type}</Badge>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
