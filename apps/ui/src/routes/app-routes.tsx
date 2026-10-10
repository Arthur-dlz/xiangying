import { DownloadFilter } from "@mediago/common";
import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import { AppBootScreen } from "../components/app-boot-screen";
import Loading from "../components/loading";

const AppLayout = lazy(() => import("../layout/app-layout"));
const HomePage = lazy(() => import("../pages/home-page"));
const LibraryPage = lazy(() => import("../pages/library-page"));
const SourceExtract = lazy(() => import("../pages/source-extract"));
const SettingPage = lazy(() => import("../pages/setting-page"));
const ConverterPage = lazy(() => import("../pages/converter-page"));
const SigninPage = lazy(() => import("../pages/signin-page"));
const OverlayDialog = lazy(() => import("../pages/overlay-dialog"));

export function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <Suspense fallback={<AppBootScreen />}>
            <AppLayout />
          </Suspense>
        }
      >
        <Route
          index
          element={
            <Suspense fallback={<Loading />}>
              <LibraryPage />
            </Suspense>
          }
        />
        <Route
          path="library"
          element={
            <Suspense fallback={<Loading />}>
              <LibraryPage />
            </Suspense>
          }
        />
        <Route
          path="downloads"
          element={
            <Suspense fallback={<Loading />}>
              <HomePage />
            </Suspense>
          }
        />
        <Route
          path="done"
          element={
            <Suspense fallback={<Loading />}>
              <HomePage filter={DownloadFilter.done} />
            </Suspense>
          }
        />
        <Route
          path="source"
          element={
            <Suspense fallback={<Loading />}>
              <SourceExtract />
            </Suspense>
          }
        />
        <Route
          path="settings"
          element={
            <Suspense fallback={<Loading />}>
              <SettingPage />
            </Suspense>
          }
        />
        <Route
          path="converter"
          element={
            <Suspense fallback={<Loading />}>
              <ConverterPage />
            </Suspense>
          }
        />
        <Route path="*" element={<div>404</div>} />
      </Route>
      <Route
        path="signin"
        element={
          <Suspense fallback={<Loading />}>
            <SigninPage />
          </Suspense>
        }
      />
      <Route
        path="/browser"
        element={
          <Suspense fallback={<Loading />}>
            <SourceExtract page />
          </Suspense>
        }
      />
      <Route
        path="/download-dialog"
        element={
          <Suspense fallback={<Loading />}>
            <OverlayDialog />
          </Suspense>
        }
      />
    </Routes>
  );
}
