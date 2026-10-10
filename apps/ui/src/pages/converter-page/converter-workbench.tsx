import type { DragEvent } from "react";
import { Trash2, UploadCloud, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils";
import type { StagedMediaFile } from "./converter-page-logic";

interface ConversionFilePickerProps {
  files: StagedMediaFile[];
  isDragging: boolean;
  disabled?: boolean;
  onBrowse: () => void;
  onDrop: (event: DragEvent<HTMLButtonElement>) => void;
  onDragOver: (event: DragEvent<HTMLButtonElement>) => void;
  onDragLeave: (event: DragEvent<HTMLButtonElement>) => void;
  onRemove: (path: string) => void;
  onClear: () => void;
}

export function ConversionFilePicker({
  files,
  isDragging,
  disabled = false,
  onBrowse,
  onDrop,
  onDragOver,
  onDragLeave,
  onRemove,
  onClear,
}: ConversionFilePickerProps) {
  const { t } = useTranslation();
  const hasFiles = files.length > 0;

  return (
    <div className="grid gap-4">
      <button
        type="button"
        className={cn(
          "group flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-border-strong bg-surface px-4 py-4 text-center transition-[border-color,background-color,box-shadow] hover:border-brand/60 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-60",
          isDragging &&
            "border-brand bg-surface-selected shadow-[inset_0_0_0_1px_var(--brand)]",
        )}
        disabled={disabled}
        onClick={onBrowse}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        aria-label={t("selectMediaFiles")}
      >
        <span className="mb-2 flex size-10 items-center justify-center rounded-full bg-surface-selected text-brand transition-transform group-hover:-translate-y-0.5">
          <UploadCloud className="size-5 stroke-[1.75]" />
        </span>
        <span className="text-sm font-semibold text-foreground">
          {isDragging ? t("releaseToAddFiles") : t("dropMediaHere")}
        </span>
        <span className="mt-2 text-xs font-medium text-brand">
          {t("selectMediaFiles")}
        </span>
      </button>

      <div className="grid gap-2">
        <div className="flex min-h-8 items-center justify-between gap-3 px-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-sm font-semibold text-foreground">
              {t("currentConversionBatch")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("selectedFileCount", { count: files.length })}
            </span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!hasFiles || disabled}
            onClick={onClear}
          >
            <Trash2 className="size-3.5" />
            {t("clearSelectedFiles")}
          </Button>
        </div>

        <div className="max-h-36 overflow-y-auto rounded-md border">
          {hasFiles ? (
            <div className="divide-y">
              {files.map((file) => (
                <div
                  key={file.path}
                  className="grid min-h-9 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 px-3 py-1.5 transition-colors hover:bg-surface-hover"
                >
                  <div
                    className="min-w-0 truncate text-sm text-foreground"
                    title={file.name}
                  >
                    {file.name}
                  </div>
                  <span className="rounded-sm bg-surface-subtle px-1.5 py-0.5 text-[11px] font-medium uppercase text-muted-foreground">
                    {file.extension}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    disabled={disabled}
                    onClick={() => onRemove(file.path)}
                    aria-label={t("removeSelectedFile", { name: file.name })}
                    title={t("removeSelectedFile", { name: file.name })}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex min-h-16 items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {t("noSelectedMedia")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
