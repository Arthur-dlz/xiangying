import { CheckCircle2, Loader2, Server, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";
import { renderLocalized } from "../../i18n/localized-message";
import { DESKTOP_HTTP_BASE } from "../../shared/constants";
import type { InvocationMode, ServerStatus } from "../../shared/types";
import type { ConnectionDraft } from "../settings-model";

export interface ServerCardProps {
  draft: ConnectionDraft;
  testing: boolean;
  saving: boolean;
  lastStatus: ServerStatus | null;
  onModeChange: (mode: InvocationMode) => void;
  onServerUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onTest: () => void;
  onSave: () => void;
}

export function ServerCard({
  draft,
  testing,
  saving,
  lastStatus,
  onModeChange,
  onServerUrlChange,
  onApiKeyChange,
  onTest,
  onSave,
}: ServerCardProps) {
  const { t } = useTranslation();
  const busy = testing || saving;
  const modeOptions: Array<{
    value: InvocationMode;
    title: string;
    description: string;
  }> = [
    {
      value: "desktop-schema",
      title: t("options.server.modeSchemaTitle"),
      description: t("options.server.modeSchemaDesc"),
    },
    {
      value: "desktop-http",
      title: t("options.server.modeDesktopHttpTitle"),
      description: t("options.server.modeDesktopHttpDesc", {
        base: DESKTOP_HTTP_BASE,
      }),
    },
    {
      value: "docker-http",
      title: t("options.server.modeDockerHttpTitle"),
      description: t("options.server.modeDockerHttpDesc"),
    },
  ];

  return (
    <Card data-card="connection" elevated aria-busy={busy || undefined}>
      <CardHeader className="border-b border-border pb-4">
        <div className="flex items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-primary/20 bg-surface-selected text-primary">
            <Server className="size-4.5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="mb-1 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-brand-foreground">
              {t("options.server.eyebrow")}
            </p>
            <CardTitle>{t("options.server.title")}</CardTitle>
            <CardDescription className="mt-1.5 max-w-2xl">
              {t("options.server.description")}
            </CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-5 pt-5">
        <fieldset disabled={busy} className="min-w-0">
          <legend className="sr-only">{t("options.server.modeLegend")}</legend>
          <RadioGroup<InvocationMode>
            value={draft.mode}
            onValueChange={onModeChange}
            name="mode"
            aria-label={t("options.server.modeLegend")}
          >
            {modeOptions.map((option) => (
              <RadioGroupItem
                key={option.value}
                value={option.value}
                title={option.title}
                description={option.description}
                disabled={busy}
              />
            ))}
          </RadioGroup>
        </fieldset>

        {draft.mode === "docker-http" ? (
          <div className="grid gap-4 rounded-lg border border-border bg-surface-subtle p-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="server-url">
                {t("options.server.serverUrlLabel")}
              </Label>
              <Input
                id="server-url"
                type="url"
                placeholder={t("options.server.serverUrlPlaceholder")}
                value={draft.serverUrl}
                onChange={(event) => onServerUrlChange(event.target.value)}
                disabled={busy}
                autoComplete="url"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="api-key">
                {t("options.server.apiKeyLabel")}{" "}
                <span className="font-normal text-muted-foreground">
                  {t("options.server.apiKeyOptional")}
                </span>
              </Label>
              <Input
                id="api-key"
                type="password"
                placeholder={t("options.server.apiKeyPlaceholder")}
                value={draft.apiKey}
                onChange={(event) => onApiKeyChange(event.target.value)}
                disabled={busy}
                autoComplete="off"
              />
            </div>
          </div>
        ) : null}

        {draft.mode === "desktop-schema" ? (
          <ModeNote>
            {t("options.server.schemaNoteLead")}{" "}
            <code className="rounded bg-surface-hover px-1.5 py-0.5 font-mono text-[11px] text-foreground">
              mediago-community://share?v=1&amp;url=...
            </code>{" "}
            {t("options.server.schemaNoteBody")}
            <span className="mt-2 block text-foreground-secondary">
              <strong className="font-medium text-foreground">
                {t("options.server.limitationLabel")}:{" "}
              </strong>
              {t("options.server.limitationBody")}
            </span>
          </ModeNote>
        ) : null}

        {draft.mode === "desktop-http" ? (
          <ModeNote>
            {t("options.server.desktopHttpNoteLead")}{" "}
            <code className="rounded bg-surface-hover px-1.5 py-0.5 font-mono text-[11px] text-foreground">
              {DESKTOP_HTTP_BASE}
            </code>
            {t("options.server.desktopHttpNoteTail")}
          </ModeNote>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={onTest}
            disabled={busy}
            data-action="test-connection"
          >
            {testing ? (
              <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
            ) : null}
            {testing ? t("common.testing") : t("common.testConnection")}
          </Button>
          <Button
            type="button"
            onClick={onSave}
            disabled={busy}
            data-action="save-connection"
          >
            {saving ? (
              <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
            ) : null}
            {saving ? t("common.saving") : t("common.save")}
          </Button>
          {lastStatus ? <StatusInline status={lastStatus} /> : null}
        </div>
      </CardContent>
    </Card>
  );
}

function ModeNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-border bg-surface-subtle px-4 py-3 text-[13px] leading-5 text-muted-foreground">
      {children}
    </p>
  );
}

function StatusInline({ status }: { status: ServerStatus }) {
  const { t } = useTranslation();
  const Icon = status.ok ? CheckCircle2 : XCircle;
  return (
    <Badge
      role="status"
      aria-live="polite"
      variant={status.ok ? "success" : "destructive"}
      className="min-h-6 min-w-0 max-w-full items-start gap-1 whitespace-normal break-words text-left leading-4 normal-case tracking-normal"
    >
      <Icon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 whitespace-normal break-words">
        {renderLocalized(t, status.message, "status.unavailable")}
      </span>
    </Badge>
  );
}
