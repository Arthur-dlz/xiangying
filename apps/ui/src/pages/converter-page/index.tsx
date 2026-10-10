import { useMemoizedFn } from "ahooks";
import { type DragEvent, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  addConversion as addConversionApi,
  deleteConversion as deleteConversionApi,
  getConversions,
  startConversion as startConversionApi,
  stopConversion as stopConversionApi,
} from "@/api/conversion";
import PageContainer from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { ADD_CONVERT_TASK, DELETE_CONVERT, START_CONVERT } from "@/const";
import { useConversions } from "@/hooks/use-conversions";
import { usePlatform } from "@/hooks/use-platform";
import { tdApp } from "@/utils";
import {
  appendStagedMediaFiles,
  MEDIA_DIALOG_FILTERS,
  OUTPUT_FORMATS,
  type ConversionOutputType,
  type StagedMediaFile,
} from "./converter-page-logic";
import {
  runConversionBulkAction,
  type ConversionBulkAction,
} from "./conversion-queue-actions";
import { ConversionSettingsDialog } from "./conversion-settings-dialog";
import { ConversionTaskList } from "./conversion-task-list";

const Converter = () => {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [stagedFiles, setStagedFiles] = useState<StagedMediaFile[]>([]);
  const [outputType, setOutputType] = useState<ConversionOutputType>("video");
  const [outputFormat, setOutputFormat] = useState("mp4");
  const [quality, setQuality] = useState("medium");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isBulkActionRunning = useRef(false);
  const [isBulkActionPending, setIsBulkActionPending] = useState(false);
  const {
    data,
    error,
    isLoading,
    mutate,
    deleteConversion,
    startConversion,
    stopConversion,
  } = useConversions({ current: page, pageSize });
  const { app, dialog, shell } = usePlatform();

  const addPathsToWorkbench = useMemoizedFn((paths: string[]) => {
    const result = appendStagedMediaFiles(stagedFiles, paths);
    setStagedFiles(result.files);

    if (result.rejected > 0) {
      toast.warning(t("unsupportedMediaFiles", { count: result.rejected }));
    }
    if (result.duplicates > 0) {
      toast.info(t("duplicateMediaFilesSkipped", { count: result.duplicates }));
    }
  });

  const handleBrowseFiles = useMemoizedFn(async () => {
    try {
      const paths = await dialog.open({
        type: "file",
        multiple: true,
        filters: MEDIA_DIALOG_FILTERS,
      });
      if (paths?.length) addPathsToWorkbench(paths);
    } catch (exception: unknown) {
      toast.error((exception as Error).message);
    }
  });

  const handleDrop = useMemoizedFn(
    async (event: DragEvent<HTMLButtonElement>) => {
      event.preventDefault();
      setIsDragging(false);

      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) return;

      try {
        const paths = (
          await Promise.all(files.map((file) => app.getPathForFile(file)))
        ).filter(Boolean);

        if (paths.length === 0) {
          toast.warning(t("fileDropUnavailable"));
          return;
        }
        addPathsToWorkbench(paths);
      } catch (exception: unknown) {
        toast.error((exception as Error).message);
      }
    },
  );

  const handleDragOver = useMemoizedFn(
    (event: DragEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setIsDragging(true);
    },
  );

  const handleDragLeave = useMemoizedFn(
    (event: DragEvent<HTMLButtonElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
        return;
      }
      setIsDragging(false);
    },
  );

  const handleOutputTypeChange = useMemoizedFn((type: ConversionOutputType) => {
    setOutputType(type);
    setOutputFormat(OUTPUT_FORMATS[type][0]);
  });

  const handleSubmitBatch = useMemoizedFn(async (startImmediately: boolean) => {
    if (stagedFiles.length === 0 || isSubmitting) return;

    const files = [...stagedFiles];
    setIsSubmitting(true);
    try {
      const results = await Promise.allSettled(
        files.map(async (file) => {
          const conversion = await addConversionApi({
            name: file.name,
            path: file.path,
            outputFormat,
            quality,
          });

          let startFailed = false;
          if (startImmediately && conversion.id) {
            try {
              await startConversionApi(conversion.id);
            } catch {
              startFailed = true;
            }
          }

          return { file, startFailed };
        }),
      );

      const failedFiles = results.flatMap((result, index) =>
        result.status === "rejected" ? [files[index]] : [],
      );
      const createdCount = results.length - failedFiles.length;
      const startFailedCount = results.filter(
        (result) => result.status === "fulfilled" && result.value.startFailed,
      ).length;

      setStagedFiles(failedFiles);
      if (createdCount > 0) {
        tdApp.onEvent(ADD_CONVERT_TASK);
        if (startImmediately) tdApp.onEvent(START_CONVERT);
        toast.success(
          t(
            startImmediately
              ? "conversionBatchStarted"
              : "conversionBatchQueued",
            { count: createdCount },
          ),
        );
        setIsSettingsOpen(false);
      }
      if (failedFiles.length > 0) {
        toast.error(
          t("conversionBatchCreateFailed", { count: failedFiles.length }),
        );
      }
      if (startFailedCount > 0) {
        toast.warning(
          t("conversionBatchStartFailed", { count: startFailedCount }),
        );
      }

      setPage(1);
      await mutate();
    } finally {
      setIsSubmitting(false);
    }
  });

  const handleStart = useMemoizedFn(async (id: number) => {
    tdApp.onEvent(START_CONVERT);
    try {
      await startConversion(id);
    } catch (exception: unknown) {
      toast.error((exception as Error).message);
    }
  });

  const handleStop = useMemoizedFn(async (id: number) => {
    try {
      await stopConversion(id);
    } catch (exception: unknown) {
      toast.error((exception as Error).message);
    }
  });

  const handleDelete = useMemoizedFn(async (id: number) => {
    tdApp.onEvent(DELETE_CONVERT);
    try {
      await deleteConversion(id);
    } catch (exception: unknown) {
      toast.error((exception as Error).message);
    }
  });

  const handleOpenFolder = useMemoizedFn(async (targetPath: string) => {
    try {
      const separatorIndex = Math.max(
        targetPath.lastIndexOf("/"),
        targetPath.lastIndexOf("\\"),
      );
      const directory =
        separatorIndex > 0 ? targetPath.slice(0, separatorIndex) : targetPath;
      await shell.open(directory);
    } catch (exception: unknown) {
      toast.error((exception as Error).message);
    }
  });

  const runQueueAction = useMemoizedFn(
    async (
      bulkAction: ConversionBulkAction,
      action: (id: number) => Promise<void>,
      onStart?: () => void,
    ) => {
      if (isBulkActionRunning.current) return;
      isBulkActionRunning.current = true;
      setIsBulkActionPending(true);
      let ownsBulkActionGate = true;
      try {
        const failedCount = await runConversionBulkAction(
          getConversions,
          pageSize,
          bulkAction,
          action,
          onStart,
        );
        isBulkActionRunning.current = false;
        ownsBulkActionGate = false;
        setIsBulkActionPending(false);
        await mutate();
        if (failedCount > 0) {
          toast.error(t("conversionBulkActionFailed", { count: failedCount }));
        }
      } catch {
        toast.error(t("loadFailed"));
      } finally {
        if (ownsBulkActionGate) {
          isBulkActionRunning.current = false;
          setIsBulkActionPending(false);
        }
      }
    },
  );

  const handleConvertAll = useMemoizedFn(async () => {
    await runQueueAction("start", startConversionApi, () =>
      tdApp.onEvent(START_CONVERT),
    );
  });

  const handleStopAll = useMemoizedFn(async () => {
    await runQueueAction("stop", stopConversionApi);
  });

  const handleClearCompleted = useMemoizedFn(async () => {
    await runQueueAction("clearCompleted", deleteConversionApi, () =>
      tdApp.onEvent(DELETE_CONVERT),
    );
  });

  return (
    <PageContainer
      title={t("converter")}
      titleExtra={
        <span className="hidden text-xs text-muted-foreground min-[860px]:inline">
          {t("converterSubtitle")}
        </span>
      }
      rightExtra={
        <Button type="button" size="sm" onClick={() => setIsSettingsOpen(true)}>
          <Plus className="size-4" />
          {t("createConversionTask")}
        </Button>
      }
      className="flex min-h-0 flex-1 flex-col overflow-hidden p-3"
    >
      <ConversionSettingsDialog
        open={isSettingsOpen}
        files={stagedFiles}
        isDragging={isDragging}
        outputType={outputType}
        outputFormat={outputFormat}
        quality={quality}
        isSubmitting={isSubmitting}
        onOpenChange={(open) => {
          setIsSettingsOpen(open);
          if (!open) setIsDragging(false);
        }}
        onBrowse={() => void handleBrowseFiles()}
        onDrop={(event) => void handleDrop(event)}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onRemove={(path) =>
          setStagedFiles((current) =>
            current.filter((file) => file.path !== path),
          )
        }
        onClear={() => setStagedFiles([])}
        onOutputTypeChange={handleOutputTypeChange}
        onOutputFormatChange={setOutputFormat}
        onQualityChange={setQuality}
        onSubmit={(startImmediately) =>
          void handleSubmitBatch(startImmediately)
        }
      />

      <ConversionTaskList
        data={data}
        error={error}
        isLoading={isLoading}
        isBulkActionRunning={isBulkActionPending}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPage(1);
          setPageSize(size);
        }}
        onRefresh={() => void mutate()}
        onStart={(id) => void handleStart(id)}
        onStop={(id) => void handleStop(id)}
        onDelete={(id) => void handleDelete(id)}
        onOpenFolder={(path) => void handleOpenFolder(path)}
        onConvertAll={() => void handleConvertAll()}
        onStopAll={() => void handleStopAll()}
        onClearCompleted={() => void handleClearCompleted()}
      />
    </PageContainer>
  );
};

export default Converter;
