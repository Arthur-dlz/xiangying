import {
  CircleCheck,
  CircleX,
  ExternalLink,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "../../components/ui/badge";
import { DESKTOP_HTTP_BASE } from "../../shared/constants";
import type { ExtensionSettings, ServerStatus } from "../../shared/types";

function shortHost(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

interface Props {
  status: ServerStatus | null;
  settings: ExtensionSettings | null;
  loading: boolean;
  inverted?: boolean;
}

export function StatusBadge({
  status,
  settings,
  loading,
  inverted = false,
}: Props) {
  const { t } = useTranslation();
  const invertedClass = inverted
    ? "max-w-[154px] overflow-hidden border-white/30 bg-black/35 text-ellipsis whitespace-nowrap text-white shadow-none"
    : undefined;

  if (loading) {
    return (
      <Badge
        variant="outline"
        className={`gap-1 normal-case tracking-normal ${invertedClass ?? ""}`}
        data-status="detecting"
      >
        <Loader2
          className="size-3 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        {t("status.detecting")}
      </Badge>
    );
  }

  if (status === null || settings === null) {
    return (
      <Badge
        variant={inverted ? "outline" : "secondary"}
        className={`gap-1 normal-case tracking-normal ${invertedClass ?? ""}`}
        data-status="unavailable"
      >
        <CircleX className="size-3 shrink-0" aria-hidden="true" />
        {t("status.unavailable")}
      </Badge>
    );
  }

  if (settings.mode === "desktop-schema") {
    return (
      <Badge
        variant={inverted ? "outline" : "edit"}
        className={`gap-1 normal-case tracking-normal ${invertedClass ?? ""}`}
        data-status="schema"
      >
        <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
        {t("status.schemaMode")}
      </Badge>
    );
  }

  if (settings.mode === "docker-http" && !settings.serverUrl) {
    return (
      <Badge
        variant={inverted ? "outline" : "warning"}
        className={`gap-1 normal-case tracking-normal ${invertedClass ?? ""}`}
        data-status="not-configured"
      >
        <TriangleAlert className="size-3 shrink-0" aria-hidden="true" />
        {t("status.notConfigured")}
      </Badge>
    );
  }

  if (status.ok) {
    const host =
      settings.mode === "desktop-http"
        ? shortHost(DESKTOP_HTTP_BASE)
        : shortHost(settings.serverUrl);
    return (
      <Badge
        variant={inverted ? "outline" : "success"}
        className={`gap-1 font-mono normal-case tracking-normal ${invertedClass ?? ""}`}
        data-status="connected"
      >
        <CircleCheck className="size-3 shrink-0" aria-hidden="true" />
        {host}
      </Badge>
    );
  }

  return (
    <Badge
      variant={inverted ? "outline" : "destructive"}
      className={`gap-1 normal-case tracking-normal ${invertedClass ?? ""}`}
      data-status="connection-failed"
    >
      <CircleX className="size-3 shrink-0" aria-hidden="true" />
      {t("status.connectionFailed")}
    </Badge>
  );
}
