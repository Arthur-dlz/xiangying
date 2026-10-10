import { DownloadType } from "@mediago/common";
import { ArrowUpRight, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import type { DetectedSource } from "../../shared/types";

interface Props {
  source: DetectedSource;
  onImport: (source: DetectedSource) => void;
  disabled: boolean;
}

export function SourceItem({ source, onImport, disabled }: Props) {
  const { t } = useTranslation();
  const inspecting = source.mediaInfo?.status === "inspecting";
  const typeLabel =
    source.type === DownloadType.m3u8
      ? "HLS"
      : source.type === DownloadType.xiaohongshu
        ? "XHS"
        : source.type === DownloadType.direct
          ? "FILE"
          : source.type.slice(0, 4).toUpperCase();

  return (
    <li className="group relative flex items-center gap-3 rounded-lg border border-border bg-surface-raised p-3 shadow-ambient transition-[border-color,background-color] duration-150 hover:border-border-strong hover:bg-surface motion-reduce:transition-none">
      <div
        className="grid size-9 shrink-0 place-items-center rounded-md border border-action bg-action font-mono text-[10px] font-semibold tracking-[0.04em] text-white"
        aria-hidden="true"
      >
        {typeLabel}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="truncate text-[13px] font-medium tracking-[-0.01em]">
          {source.name || t("source.unnamed")}
        </p>
        {source.mediaInfo ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {source.mediaInfo.status === "inspecting" ? (
              <Badge variant="secondary" className="gap-1 normal-case">
                <LoaderCircle
                  className="size-3 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                {t("source.inspecting")}
              </Badge>
            ) : null}
            {source.mediaInfo.status !== "inspecting" &&
            source.mediaInfo.playlistType === "master" ? (
              <Badge variant="secondary" className="normal-case">
                {t("source.autoBest")}
              </Badge>
            ) : null}
            {source.mediaInfo.status !== "inspecting" ? (
              <Badge variant="outline" className="normal-case">
                {source.mediaInfo.maxQuality || t("source.qualityUnknown")}
              </Badge>
            ) : null}
          </div>
        ) : null}
      </div>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={disabled || inspecting}
        onClick={() => onImport(source)}
        data-action="import-source"
        aria-label={t("source.importNamed", {
          name: source.name || t("source.unnamed"),
        })}
      >
        {inspecting ? (
          <LoaderCircle
            className="size-3.5 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <ArrowUpRight className="size-3.5" aria-hidden="true" />
        )}
        {t("source.import")}
      </Button>
    </li>
  );
}
