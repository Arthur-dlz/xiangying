import { LoaderCircle, Radar } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SmartStreamSubmitPhase } from "./smart-stream-submit-logic";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

interface StreamDiscoveryProgressDialogProps {
  onCancel: () => void;
  open: boolean;
  phase: SmartStreamSubmitPhase;
  url?: string;
}

export function StreamDiscoveryProgressDialog({
  onCancel,
  open,
  phase,
  url,
}: StreamDiscoveryProgressDialogProps) {
  const { t } = useTranslation();
  const status =
    phase === "discovering"
      ? t("discoveringStreamSources")
      : t("probingStreamSource");

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onCancel()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Radar className="size-5" />
          </div>
          <DialogTitle>{t("streamDiscoveryInProgress")}</DialogTitle>
          <DialogDescription className="break-all" title={url}>
            {url}
          </DialogDescription>
        </DialogHeader>
        <div
          className="flex items-center gap-3 rounded-lg border bg-surface-subtle px-4 py-3 text-sm text-muted-foreground"
          role="status"
        >
          <LoaderCircle className="size-4 shrink-0 animate-spin" />
          {status}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
