import { DownloadFilter } from "@mediago/common";
import { useMemoizedFn } from "ahooks";
import { FolderOpen, QrCodeIcon } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type { FC } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { HomeDownloadButton } from "@/components/home-download-button";
import PageContainer from "@/components/page-container";
import { Button } from "@/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { PaginationControl } from "@/components/ui/pagination";
import { CLICK_DOWNLOAD } from "@/const";
import { useEnvPath } from "@/hooks/use-config";
import { usePlatform } from "@/hooks/use-platform";
import { useTasks } from "@/hooks/use-tasks";
import { appStoreSelector, useAppStore } from "@/store/app";
import { useDownloadDialogStore } from "@/store/download-dialog";
import { isWeb, tdApp } from "@/utils";
import { DownloadList } from "./components/download-list";

interface Props {
  filter?: DownloadFilter;
}

const HomePage: FC<Props> = ({ filter = DownloadFilter.list }) => {
  const { shell } = usePlatform();
  const appStore = useAppStore(useShallow(appStoreSelector));
  const { t } = useTranslation();
  const openNew = useDownloadDialogStore((state) => state.openNew);
  const {
    data,
    error,
    isLoading,
    pagination,
    total,
    mutate,
    setPage,
    setPageSize,
  } = useTasks(filter);
  const { envPath } = useEnvPath();

  const handleOpenForm = useMemoizedFn(() => {
    tdApp.onEvent(CLICK_DOWNLOAD);
    openNew();
  });

  return (
    <PageContainer
      title={
        filter === DownloadFilter.list
          ? t("downloadList")
          : t("downloadComplete")
      }
      rightExtra={
        <div className="flex flex-row gap-2">
          {!isWeb ? (
            <Button
              variant="outline"
              onClick={() => shell.open(appStore.local)}
            >
              <FolderOpen />
              {t("openFolder")}
            </Button>
          ) : null}
          {filter === DownloadFilter.done &&
          !isWeb &&
          appStore.enableMobilePlayer ? (
            <HoverCard openDelay={100} closeDelay={100}>
              <HoverCardTrigger asChild>
                <Button variant="outline">
                  <QrCodeIcon />
                  {t("playOnMobile")}
                </Button>
              </HoverCardTrigger>
              <HoverCardContent align="end" className="w-auto">
                <div className="bg-white p-3">
                  <QRCodeSVG value={envPath?.playerUrl || ""} size={136} />
                </div>
                <div className="mt-2 text-xs">{t("scanToWatch")}</div>
              </HoverCardContent>
            </HoverCard>
          ) : null}
          {filter === DownloadFilter.list ? (
            <HomeDownloadButton onClick={handleOpenForm} />
          ) : null}
        </div>
      }
      className="flex h-full min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3 max-[719px]:p-2"
    >
      <nav aria-label="下载状态" className="flex shrink-0 gap-2">
        <Button
          asChild
          variant={filter === DownloadFilter.list ? "default" : "outline"}
        >
          <Link
            to="/downloads"
            aria-current={filter === DownloadFilter.list ? "page" : undefined}
          >
            待完成
          </Link>
        </Button>
        <Button
          asChild
          variant={filter === DownloadFilter.done ? "default" : "outline"}
        >
          <Link
            to="/done"
            aria-current={filter === DownloadFilter.done ? "page" : undefined}
          >
            已完成
          </Link>
        </Button>
      </nav>
      <DownloadList
        key={filter + ":" + pagination.page + ":" + pagination.pageSize}
        filter={filter}
        data={data}
        error={error}
        isLoading={isLoading}
        mutate={mutate}
      />

      <PaginationControl
        className="flex justify-end max-[719px]:pr-16"
        page={pagination.page}
        pageSize={pagination.pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        total={total}
        isLoading={isLoading}
      />
    </PageContainer>
  );
};

export default HomePage;
