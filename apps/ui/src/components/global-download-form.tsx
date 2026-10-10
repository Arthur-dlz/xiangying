import { useMemo } from "react";
import { useSWRConfig } from "swr";
import { useConfigStore } from "@/store/config";
import { useDownloadDialogStore } from "@/store/download-dialog";
import DownloadForm from "./download-form";

export function GlobalDownloadForm() {
  const { mutate } = useSWRConfig();
  const mode = useDownloadDialogStore((state) => state.mode);
  const open = useDownloadDialogStore((state) => state.open);
  const requestId = useDownloadDialogStore((state) => state.requestId);
  const values = useDownloadDialogStore((state) => state.values);
  const close = useDownloadDialogStore((state) => state.close);

  const initialValues = useMemo(() => {
    if (mode === "edit") return values;
    const { lastIsBatch, lastDownloadTypes } = useConfigStore.getState();
    return {
      batch: lastIsBatch,
      type: lastDownloadTypes,
      ...values,
    };
  }, [mode, values]);

  const refreshTasks = () =>
    mutate(
      (key) =>
        typeof key === "object" &&
        key !== null &&
        "key" in key &&
        typeof key.key === "string" &&
        key.key.startsWith("api/tasks/"),
    );

  return (
    <DownloadForm
      key={requestId}
      id="global-download-form"
      initialValues={initialValues}
      isEdit={mode === "edit"}
      open={open}
      onConfirm={() => {
        void refreshTasks();
      }}
      onOpenChange={(visible) => {
        if (!visible) close();
      }}
    />
  );
}
