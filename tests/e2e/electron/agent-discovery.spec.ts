import type { BrowserTabsSnapshot, PlatformApi } from "@mediago/common";
import { electronTest as test, expect } from "../support/electron-app.ts";
import { unwrapElectronIpcResult } from "../support/electron-ipc.ts";

declare global {
  interface Window {
    electron: PlatformApi;
  }
}

test("runs Agent discovery in a hidden view without navigating the visible tab", async ({
  electronRuntime,
}) => {
  const { application, client, fixtures, page } = electronRuntime;
  const initialSnapshot = await unwrapElectronIpcResult<BrowserTabsSnapshot>(
    page.evaluate(() => window.electron.browser.getTabs()),
  );
  const visibleTabId = initialSnapshot.activeTabId;
  await unwrapElectronIpcResult<void>(
    page.evaluate(
      ({ tabId, url }) => window.electron.browser.loadURL(tabId, url),
      { tabId: visibleTabId, url: fixtures.tabA.url },
    ),
  );
  await expect(page.getByRole("tab", { name: /Fixture Tab A/ })).toBeVisible();

  const snapshotBefore = await unwrapElectronIpcResult<BrowserTabsSnapshot>(
    page.evaluate(() => window.electron.browser.getTabs()),
  );
  const visibleBefore = snapshotBefore.tabs.find(
    (tab) => tab.id === snapshotBefore.activeTabId,
  );
  expect(visibleBefore).toMatchObject({
    id: visibleTabId,
    url: fixtures.tabA.url,
  });

  const created = await client.createDiscovery({
    url: fixtures.agent.url,
    mode: "browser",
    timeoutMs: 8_000,
    useSessionCookies: false,
  });
  await expect
    .poll(
      async () => (await client.getDiscovery(created.data.id)).data.status,
      {
        timeout: 15_000,
      },
    )
    .toBe("completed");
  const completed = (await client.getDiscovery(created.data.id)).data;
  expect(completed.sources).toHaveLength(1);
  expect(completed.sources[0]).toMatchObject({
    type: "direct",
    pageUrl: fixtures.agent.url,
  });
  expect(completed.sources[0].url).toContain("fixture=agent");
  expect(JSON.stringify(completed)).not.toContain("headers");

  const snapshotAfter = await unwrapElectronIpcResult<BrowserTabsSnapshot>(
    page.evaluate(() => window.electron.browser.getTabs()),
  );
  const visibleAfter = {
    activeTabId: snapshotAfter.activeTabId,
    activeTab: snapshotAfter.tabs.find(
      (tab) => tab.id === snapshotAfter.activeTabId,
    ),
  };
  expect(visibleAfter).toMatchObject({
    activeTabId: visibleTabId,
    activeTab: { id: visibleTabId, url: fixtures.tabA.url },
  });
  await expect
    .poll(() =>
      application.evaluate(
        ({ webContents }, agentURL) =>
          webContents
            .getAllWebContents()
            .some((contents) => contents.getURL() === agentURL),
        fixtures.agent.url,
      ),
    )
    .toBe(false);

  const downloads = await client.createDiscoveryDownloads(completed.id, {
    sourceIds: [completed.sources[0].id],
    startDownload: false,
  });
  expect(downloads.data).toHaveLength(1);
  expect(downloads.data[0]).toMatchObject({
    type: "direct",
    url: completed.sources[0].url,
  });
});
