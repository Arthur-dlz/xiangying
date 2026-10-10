import type {
  BrowserTabSnapshot,
  BrowserTabsSnapshot,
  PlatformApi,
} from "@mediago/common";
import { electronTest as test, expect } from "../support/electron-app.ts";
import { unwrapElectronIpcResult } from "../support/electron-ipc.ts";

declare global {
  interface Window {
    electron: PlatformApi;
  }
}

async function browserSnapshot(
  page: import("@playwright/test").Page,
): Promise<BrowserTabsSnapshot> {
  return unwrapElectronIpcResult<BrowserTabsSnapshot>(
    page.evaluate(() => window.electron.browser.getTabs()),
  );
}

test("preserves isolated sources and native page state across unlimited tabs", async ({
  electronRuntime,
}) => {
  const { application, fixtures, page } = electronRuntime;
  const initial = await browserSnapshot(page);
  const firstTabId = initial.activeTabId;
  await unwrapElectronIpcResult<void>(
    page.evaluate(
      ({ tabId, url }) => window.electron.browser.loadURL(tabId, url),
      { tabId: firstTabId, url: fixtures.tabA.url },
    ),
  );
  const second = await unwrapElectronIpcResult<BrowserTabSnapshot>(
    page.evaluate(() => window.electron.browser.createTab()),
  );
  await unwrapElectronIpcResult<void>(
    page.evaluate(
      ({ tabId, url }) => window.electron.browser.loadURL(tabId, url),
      { tabId: second.id, url: fixtures.tabB.url },
    ),
  );
  const loadedTabs = { firstTabId, secondTabId: second.id };

  const tabA = page.getByRole("tab", { name: /Fixture Tab A/ });
  const tabB = page.getByRole("tab", { name: /Fixture Tab B/ });
  await expect(tabA).toBeVisible();
  await expect(tabB).toBeVisible();
  await expect(tabA).toHaveAttribute("aria-label", /1 resources/);
  await expect(tabB).toHaveAttribute("aria-label", /1 resources/);
  await expect(tabB).toHaveAttribute("aria-selected", "true");

  await unwrapElectronIpcResult<BrowserTabsSnapshot>(
    page.evaluate(
      (tabId) => window.electron.browser.activateTab(tabId),
      loadedTabs.firstTabId,
    ),
  );
  await expect(tabA).toHaveAttribute("aria-selected", "true");
  await expect(tabB).toHaveAttribute("aria-selected", "false");

  await expect
    .poll(() =>
      application.evaluate(
        async ({ webContents }, fixtureURLs) => {
          const expectedURLs = new Set(fixtureURLs);
          const fixtureContents = webContents
            .getAllWebContents()
            .filter((contents) => expectedURLs.has(contents.getURL()));
          return Promise.all(
            fixtureContents.map(async (contents) => ({
              url: contents.getURL(),
              state: await contents.executeJavaScript(
                "({ execution: window.fixtureExecutionState, history: history.state })",
                true,
              ),
            })),
          );
        },
        [fixtures.tabA.url, fixtures.tabB.url],
      ),
    )
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: {
            execution: expect.objectContaining({ marker: "tab-a" }),
            history: { marker: "tab-a" },
          },
        }),
        expect.objectContaining({
          state: {
            execution: expect.objectContaining({ marker: "tab-b" }),
            history: { marker: "tab-b" },
          },
        }),
      ]),
    );

  const createdTabIds: string[] = [];
  for (let index = 0; index < 25; index += 1) {
    // oxlint-disable-next-line no-await-in-loop -- Sequential creation verifies manager ordering.
    const created = await unwrapElectronIpcResult<BrowserTabSnapshot>(
      page.evaluate(() => window.electron.browser.createTab()),
    );
    createdTabIds.push(created.id);
  }
  await expect(page.getByRole("tab")).toHaveCount(27);
  await expect(
    page.getByRole("button", { name: "New tab", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.getByRole("tablist").evaluate((tablist) => {
        const element = tablist as HTMLElement;
        return element.scrollWidth > element.clientWidth;
      }),
    )
    .toBe(true);

  const middleTabId = createdTabIds[12];
  await unwrapElectronIpcResult<BrowserTabsSnapshot>(
    page.evaluate(
      (tabId) => window.electron.browser.activateTab(tabId),
      middleTabId,
    ),
  );
  await expect
    .poll(async () => (await browserSnapshot(page)).activeTabId)
    .toBe(middleTabId);

  await unwrapElectronIpcResult<BrowserTabsSnapshot>(
    page.evaluate(
      (tabId) => window.electron.browser.closeTab(tabId),
      loadedTabs.firstTabId,
    ),
  );
  await unwrapElectronIpcResult<BrowserTabsSnapshot>(
    page.evaluate(
      (tabId) => window.electron.browser.closeTab(tabId),
      middleTabId,
    ),
  );
  await expect(page.getByRole("tab")).toHaveCount(25);

  let snapshot = await browserSnapshot(page);
  while (snapshot.tabs.length > 1) {
    // oxlint-disable-next-line no-await-in-loop -- Closing in order verifies every native view is released.
    snapshot = await unwrapElectronIpcResult<BrowserTabsSnapshot>(
      page.evaluate(
        (tabId) => window.electron.browser.closeTab(tabId),
        snapshot.tabs[0].id,
      ),
    );
  }
  await unwrapElectronIpcResult<BrowserTabsSnapshot>(
    page.evaluate(
      (tabId) => window.electron.browser.closeTab(tabId),
      snapshot.tabs[0].id,
    ),
  );
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.getByRole("tab")).toHaveAttribute("aria-label", /New tab/);
  const finalSnapshot = await browserSnapshot(page);
  expect(finalSnapshot.tabs).toHaveLength(1);
  expect(finalSnapshot.tabs[0]).toMatchObject({ mode: "home", sources: [] });
});
