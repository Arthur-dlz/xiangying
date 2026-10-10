import { ArrowUpRight, X } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { usePlatform } from "@/hooks/use-platform";
import {
  isSettingsPromoEligible,
  loadSettingsPromoManifest,
  selectSettingsPromoContent,
  SETTINGS_PROMO_URL,
} from "@/services/settings-promo";
import {
  resolveSettingsPromoPlacement,
  type SettingsPromoPlacement,
  useSettingsPromoPlacementStore,
} from "@/store/settings-promo";
import { useShellStore } from "@/store/shell";
import { cn, isWeb } from "@/utils";

interface SettingsPromoCardProps {
  className?: string;
  placement: SettingsPromoPlacement;
}

const PROMO_EXIT_DURATION_MS = 180;
const SIDEBAR_TITLE_OVERLAY =
  "bg-linear-to-b from-sidebar via-sidebar/60 to-transparent";
const SETTINGS_PROMO_OVERLAY =
  "bg-linear-to-t from-sidebar via-sidebar/80 to-transparent";

interface PreloadedPromoImage {
  fallbackUrl?: string;
  primaryUrl: string;
  resolvedUrl: string;
}

function preloadPromoImage(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    const handleLoad = () => {
      image.removeEventListener("error", handleError);
      if (typeof image.decode !== "function") {
        resolve();
        return;
      }
      void image.decode().then(resolve, resolve);
    };
    const handleError = () => {
      image.removeEventListener("load", handleLoad);
      reject(new Error(`Failed to preload ${url}`));
    };
    image.addEventListener("load", handleLoad, { once: true });
    image.addEventListener("error", handleError, { once: true });
    image.src = url;
  });
}

function preloadFirstAvailablePromoImage(
  candidates: string[],
): Promise<string | null> {
  const [candidate, ...remainingCandidates] = candidates;
  if (!candidate) return Promise.resolve(null);
  return preloadPromoImage(candidate)
    .then(() => candidate)
    .catch(() => preloadFirstAvailablePromoImage(remainingCandidates));
}

function usePreloadedPromoImage(
  primaryUrl?: string,
  fallbackUrl?: string,
): string | null {
  const [preloadedImage, setPreloadedImage] =
    useState<PreloadedPromoImage | null>(null);
  const resolvedImageUrl =
    preloadedImage !== null &&
    preloadedImage.primaryUrl === primaryUrl &&
    preloadedImage.fallbackUrl === fallbackUrl
      ? preloadedImage.resolvedUrl
      : null;

  useEffect(() => {
    if (!primaryUrl || resolvedImageUrl) return;
    let cancelled = false;
    const candidates =
      fallbackUrl && fallbackUrl !== primaryUrl
        ? [primaryUrl, fallbackUrl]
        : [primaryUrl];

    void preloadFirstAvailablePromoImage(candidates).then((resolvedUrl) => {
      if (!cancelled && resolvedUrl) {
        setPreloadedImage({
          fallbackUrl,
          primaryUrl,
          resolvedUrl,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fallbackUrl, primaryUrl, resolvedImageUrl]);

  return resolvedImageUrl;
}

function useSidebarPromotionAvailable(): boolean {
  const collapsed = useShellStore((state) => state.sidebarCollapsed);
  const [wideLayout, setWideLayout] = useState(true);

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mediaQuery = matchMedia("(min-width: 1080px)");
    const updateWideLayout = () => setWideLayout(mediaQuery.matches);
    updateWideLayout();
    mediaQuery.addEventListener("change", updateWideLayout);
    return () => mediaQuery.removeEventListener("change", updateWideLayout);
  }, []);

  return !collapsed && wideLayout;
}

export const SettingsPromoCard = memo(function SettingsPromoCard(
  props: SettingsPromoCardProps,
) {
  if (import.meta.env.APP_NAME === "xiangying") return null;
  return <SettingsPromoCardContent {...props} />;
});

const SettingsPromoCardContent = memo(function SettingsPromoCardContent({
  className,
  placement,
}: SettingsPromoCardProps) {
  const { i18n, t } = useTranslation();
  const { shell } = usePlatform();
  const sidebarAvailable = useSidebarPromotionAvailable();
  const [moving, setMoving] = useState(false);
  const storedCampaignId = useSettingsPromoPlacementStore(
    (state) => state.campaignId,
  );
  const storedPlacement = useSettingsPromoPlacementStore(
    (state) => state.placement,
  );
  const setPlacement = useSettingsPromoPlacementStore(
    (state) => state.setPlacement,
  );
  const { data: manifest } = useSWR(
    `settings-promo:${SETTINGS_PROMO_URL}`,
    () => loadSettingsPromoManifest(),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
    },
  );
  const destination = placement === "sidebar" ? "settings" : "sidebar";
  const campaignId = manifest?.campaignId ?? "";
  const sidebar = placement === "sidebar";

  let activePlacement = manifest
    ? resolveSettingsPromoPlacement(
        { campaignId: storedCampaignId, placement: storedPlacement },
        manifest.campaignId,
      )
    : null;
  if (activePlacement === "sidebar" && !sidebarAvailable) {
    activePlacement = "settings";
  }
  const eligible = manifest
    ? isSettingsPromoEligible(manifest, {
        appVersion: import.meta.env.APP_VERSION || "0.0.0",
        now: Date.now(),
        platform: isWeb ? "web" : "electron",
      })
    : false;
  const content =
    manifest && eligible && activePlacement === placement
      ? selectSettingsPromoContent(
          manifest,
          i18n.resolvedLanguage ?? i18n.language,
        )
      : null;
  const imageUrl = usePreloadedPromoImage(
    content
      ? sidebar
        ? content.sidebarImageUrl
        : content.imageUrl
      : undefined,
    content && sidebar ? content.imageUrl : undefined,
  );

  useEffect(() => {
    if (!moving || !campaignId) return;
    const timer = globalThis.setTimeout(() => {
      setMoving(false);
      setPlacement(campaignId, destination);
    }, PROMO_EXIT_DURATION_MS);
    return () => globalThis.clearTimeout(timer);
  }, [campaignId, destination, moving, setPlacement]);

  if (!manifest || !content || !imageUrl) return null;

  const openPromotion = () => void shell.open(manifest.actionUrl);
  const moveLabel = t(
    destination === "settings"
      ? "movePromotionToSettings"
      : "movePromotionToSidebar",
  );
  const foregroundClass = sidebar
    ? "text-muted-foreground dark:text-sidebar-foreground/90"
    : "text-muted-foreground dark:text-foreground/90";
  const movePromotion = () => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPlacement(manifest.campaignId, destination);
      return;
    }
    setMoving(true);
  };
  const conversionButton = (
    <Button
      type="button"
      size="lg"
      className="pointer-events-auto relative isolate h-9 shrink-0 overflow-hidden rounded-full px-4 shadow-lg"
      aria-label={`${content.buttonText}: ${content.title}`}
      onClick={openPromotion}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/2 bg-linear-to-r from-transparent via-white/65 to-transparent motion-safe:animate-[promo-cta-shimmer_2.8s_ease-in-out_infinite] motion-reduce:hidden"
      />
      <span className="relative z-10">{content.buttonText}</span>
      <ArrowUpRight className="relative z-10 size-4" />
    </Button>
  );
  const moveButton =
    destination !== "sidebar" || sidebarAvailable ? (
      <Button
        type="button"
        size="icon"
        variant="ghost"
        title={moveLabel}
        aria-label={moveLabel}
        className={cn(
          "z-20 shrink-0 rounded-full border-0 bg-transparent p-0 shadow-none hover:bg-transparent hover:opacity-75 active:bg-transparent",
          foregroundClass,
          sidebar
            ? "pointer-events-auto relative size-7"
            : "absolute right-3 top-3 size-8",
        )}
        onClick={movePromotion}
      >
        <X className="size-4" />
      </Button>
    ) : null;

  return (
    <div
      className={cn(
        "shrink-0",
        moving
          ? "promo-card-fade-out pointer-events-none"
          : "promo-card-fade-in",
      )}
      aria-hidden={moving || undefined}
      inert={moving || undefined}
    >
      <div className={cn("min-h-0 overflow-hidden", className)}>
        <Card
          aria-label={t("settingsPromotion")}
          className={cn(
            "relative gap-0 overflow-hidden border border-primary/20 bg-muted p-0 shadow-none",
            sidebar ? "rounded-none border-0" : "rounded-lg",
          )}
        >
          <button
            type="button"
            className="relative block w-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            aria-label={content.title}
            onClick={openPromotion}
          >
            <img
              src={imageUrl}
              alt={content.title}
              loading="eager"
              decoding="async"
              referrerPolicy="no-referrer"
              className={cn(
                "block w-full object-cover",
                sidebar ? "aspect-[4/3]" : "aspect-[16/9]",
              )}
            />
          </button>
          {!sidebar ? moveButton : null}
          {sidebar ? (
            <div
              className={cn(
                "pointer-events-none absolute inset-x-0 top-0 z-10 flex min-h-12 items-start justify-between gap-2 px-2 pt-1 pb-4",
                SIDEBAR_TITLE_OVERLAY,
              )}
            >
              <p
                className={cn(
                  "mt-1.5 min-w-0 flex-1 truncate text-left text-xs font-semibold leading-4",
                  foregroundClass,
                )}
              >
                {content.title}
              </p>
              {moveButton}
            </div>
          ) : (
            <div
              className={cn(
                "pointer-events-none absolute inset-x-0 bottom-0 z-10 flex min-h-32 items-end justify-between gap-3 p-4 pt-16",
                SETTINGS_PROMO_OVERLAY,
              )}
            >
              <p
                className={cn(
                  "mb-1 min-w-0 flex-1 truncate text-sm font-semibold leading-5",
                  foregroundClass,
                )}
              >
                {content.title}
              </p>
              {conversionButton}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
});
