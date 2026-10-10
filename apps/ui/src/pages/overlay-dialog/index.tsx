import { type DownloadTask, DownloadType, IpcEvent } from "@mediago/common";
import { useEffect, useId, useState } from "react";
import DownloadForm, {
  type DownloadFormItem,
} from "@/components/download-form";
import { usePlatform } from "@/hooks/use-platform";

import "./index.css";

const downloadTypes = new Set<unknown>(Object.values(DownloadType));

function isOverlayDownloadTask(
  value: unknown,
): value is Omit<DownloadTask, "id"> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const task = value as Record<string, unknown>;
  return (
    downloadTypes.has(task.type) &&
    typeof task.name === "string" &&
    typeof task.url === "string" &&
    (task.headers === undefined || typeof task.headers === "string")
  );
}

interface OverlayDialogState {
  open: boolean;
  requestId: number;
  values: DownloadFormItem;
}

export default function OverlayDialog() {
  const { on, off, browser } = usePlatform();
  const dialogId = useId();
  const [dialog, setDialog] = useState<OverlayDialogState>({
    open: false,
    requestId: 0,
    values: {},
  });

  useEffect(() => {
    const onShowOverlayDialog = (...args: unknown[]) => {
      const data = args[1];
      if (!Array.isArray(data) || !isOverlayDownloadTask(data[0])) {
        return;
      }
      const item = data[0];
      setDialog((current) => ({
        open: true,
        requestId: current.requestId + 1,
        values: {
          batch: false,
          type: item.type,
          url: item.url,
          name: item.name,
          headers: item.headers,
        },
      }));
    };

    on(IpcEvent.browser.showOverlayDialog, onShowOverlayDialog);

    return () => {
      off(IpcEvent.browser.showOverlayDialog, onShowOverlayDialog);
    };
  }, [on, off]);

  const handleOpenChange = (open: boolean) => {
    if (open) return;
    setDialog((current) => ({ ...current, open: false }));
    browser.dismissOverlayDialog();
  };

  return (
    <DownloadForm
      key={dialog.requestId}
      id={dialogId}
      initialValues={dialog.values}
      isEdit
      open={dialog.open}
      onOpenChange={handleOpenChange}
    />
  );
}
