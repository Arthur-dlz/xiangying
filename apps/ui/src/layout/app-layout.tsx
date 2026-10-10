import { Plus } from "lucide-react";
import { type FC, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation } from "react-router-dom";
import { GlobalDownloadForm } from "@/components/global-download-form";
import { ShareIntentConsumer } from "@/components/share-intent-consumer";
import { CHANGE_PAGE } from "@/const";
import { useDownloadDialogStore } from "@/store/download-dialog";
import { tdApp } from "@/utils";
import { AppBottomNav } from "./app-bottom-nav";
import { AppBrand } from "./app-brand";
import { AppSideBar } from "./app-side-bar";

function PageAnalytics() {
  const location = useLocation();

  useEffect(() => {
    tdApp.onEvent(CHANGE_PAGE, { page: location.pathname });
  }, [location.pathname]);

  return null;
}

const App: FC = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const openNew = useDownloadDialogStore((state) => state.openNew);
  const showNewDownload =
    location.pathname === "/downloads" || location.pathname === "/done";

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-canvas min-[720px]:flex-row">
      <ShareIntentConsumer />
      <PageAnalytics />
      <AppBrand className="min-[720px]:hidden" />
      <AppSideBar />
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
      <AppBottomNav />
      {showNewDownload ? (
        <button
          type="button"
          title={t("newDownload")}
          aria-label={t("newDownload")}
          onClick={() => openNew()}
          className="fixed bottom-20 right-4 z-20 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 active:scale-95 min-[720px]:hidden"
        >
          <Plus className="size-5 stroke-2" />
        </button>
      ) : null}
      <GlobalDownloadForm />
    </div>
  );
};

export default App;
