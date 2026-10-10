import { ExternalLink, SearchX } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

interface StreamDiscoveryFallbackDialogProps {
  canOpenSourceExtract: boolean;
  onClose: () => void;
  onOpenSourceExtract: () => void;
  open: boolean;
}

export function StreamDiscoveryFallbackDialog({
  canOpenSourceExtract,
  onClose,
  onOpenSourceExtract,
  open,
}: StreamDiscoveryFallbackDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent>
        <DialogHeader>
          <div className="mb-1 flex size-9 items-center justify-center rounded-full bg-surface-subtle">
            <SearchX className="size-4 text-muted-foreground" />
          </div>
          <DialogTitle>{t("streamDiscoveryNoSources")}</DialogTitle>
          <DialogDescription>
            {canOpenSourceExtract
              ? t("streamDiscoveryOpenSourceExtractHint")
              : t("streamDiscoveryWebUnavailableHint")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("close")}
          </Button>
          {canOpenSourceExtract ? (
            <Button type="button" onClick={onOpenSourceExtract}>
              <ExternalLink className="size-4" />
              {t("openSourceExtract")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
