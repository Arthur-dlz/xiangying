import { useTranslation } from "react-i18next";

export function browserLoadingHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.trim();
  }
}

interface BrowserLoadingOverlayProps {
  url: string;
}

export function BrowserLoadingOverlay({ url }: BrowserLoadingOverlayProps) {
  const { t } = useTranslation();
  const host = browserLoadingHost(url);

  return (
    <div
      role="status"
      aria-label={host ? `${t("loading")} · ${host}` : t("loading")}
      aria-live="polite"
      className="absolute inset-0 z-10 flex items-center justify-center overflow-hidden bg-background/75 backdrop-blur-[1px]"
    >
      <div
        className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-primary/10"
        aria-hidden="true"
      >
        <div className="browser-loading-progress h-full w-2/5 rounded-full bg-linear-to-r from-primary/30 via-primary to-primary/30" />
      </div>

      <div className="flex flex-col items-center text-center">
        <p className="text-sm font-medium tracking-tight text-foreground">
          {t("loading")}
        </p>
        {host ? (
          <p className="mt-1 max-w-72 truncate text-xs text-muted-foreground">
            {host}
          </p>
        ) : null}
        <div className="mt-3 flex items-center gap-1" aria-hidden="true">
          <span className="size-1 rounded-full bg-primary/35 motion-safe:animate-pulse" />
          <span className="size-1 rounded-full bg-primary/60 motion-safe:animate-pulse [animation-delay:160ms]" />
          <span className="size-1 rounded-full bg-primary motion-safe:animate-pulse [animation-delay:320ms]" />
        </div>
      </div>
    </div>
  );
}
