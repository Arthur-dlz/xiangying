import { CircleAlert, WandSparkles } from "lucide-react";
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

interface M3u8ValidationDialogProps {
  onCancel: () => void;
  onUseSmartDownload: () => void;
  open: boolean;
}

export function M3u8ValidationDialog({
  onCancel,
  onUseSmartDownload,
  open,
}: M3u8ValidationDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <div className="mb-1 flex size-9 items-center justify-center rounded-full bg-destructive/10">
            <CircleAlert className="size-4 text-destructive" />
          </div>
          <DialogTitle>{t("m3u8ValidationFailed")}</DialogTitle>
          <DialogDescription>
            {t("m3u8ValidationFailedDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button type="button" onClick={onUseSmartDownload}>
            <WandSparkles className="size-4" />
            {t("useSmartDownload")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
