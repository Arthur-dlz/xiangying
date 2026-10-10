import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: { name: "MediaGo" },
  Menu: {
    buildFromTemplate: vi.fn(),
    setApplicationMenu: vi.fn(),
  },
}));

const { i18n } = await import("./i18n");
const { createApplicationMenuTemplate } = await import("./application-menu");

type MenuEntry = {
  accelerator?: string;
  click?: (...args: any[]) => void;
  label?: string;
  role?: string;
  submenu?: MenuEntry[];
};

function labelsOf(entries: MenuEntry[]): string[] {
  return entries.flatMap((entry) => [
    ...(entry.label ? [entry.label] : []),
    ...(Array.isArray(entry.submenu) ? labelsOf(entry.submenu) : []),
  ]);
}

function findByLabel(
  entries: MenuEntry[],
  label: string,
): MenuEntry | undefined {
  for (const entry of entries) {
    if (entry.label === label) return entry;
    if (Array.isArray(entry.submenu)) {
      const nested = findByLabel(entry.submenu, label);
      if (nested) return nested;
    }
  }
  return undefined;
}

describe("application menu localization", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterAll(async () => {
    await i18n.changeLanguage("zh");
  });

  test("renders the Linux menu in English when the resolved system language is English", () => {
    const labels = labelsOf(
      createApplicationMenuTemplate("MediaGo", "linux") as MenuEntry[],
    );

    expect(labels).toEqual([
      "File(&F)",
      "Quit MediaGo",
      "Edit(&E)",
      "Undo",
      "Redo",
      "Cut",
      "Copy",
      "Paste",
      "Delete",
      "Select All",
      "View(&V)",
      "Reload",
      "Force Reload",
      "Toggle Developer Tools",
      "Reset Zoom",
      "Zoom In",
      "Zoom Out",
      "Toggle Full Screen",
      "Window(&W)",
      "Minimize",
      "Zoom",
      "Close Window",
      "Help(&H)",
      "About MediaGo",
    ]);
  });

  test("renders macOS-only menu entries in the active language", async () => {
    await i18n.changeLanguage("it");

    const labels = labelsOf(
      createApplicationMenuTemplate("MediaGo", "darwin") as MenuEntry[],
    );

    expect(labels).toContain("Informazioni su MediaGo");
    expect(labels).toContain("Servizi");
    expect(labels).toContain("Nascondi MediaGo");
    expect(labels).toContain("Incolla e mantieni lo stile");
    expect(labels).toContain("Avvia riproduzione vocale");
    expect(labels).toContain("Porta tutte le finestre in primo piano");
  });

  test("routes menu reload actions to a visible browser before the app window", () => {
    const reloadVisibleBrowser = vi.fn(() => true);
    const template = createApplicationMenuTemplate("MediaGo", "darwin", {
      reloadVisibleBrowser,
    }) as MenuEntry[];
    const reload = findByLabel(template, "Reload");
    const forceReload = findByLabel(template, "Force Reload");
    const browserWindow = {
      webContents: {
        reload: vi.fn(),
        reloadIgnoringCache: vi.fn(),
      },
    };

    reload?.click?.({}, browserWindow, {});
    forceReload?.click?.({}, browserWindow, {});

    expect(reload).toMatchObject({ accelerator: "CmdOrCtrl+R" });
    expect(forceReload).toMatchObject({
      accelerator: "CmdOrCtrl+Shift+R",
    });
    expect(reloadVisibleBrowser).toHaveBeenNthCalledWith(1, false);
    expect(reloadVisibleBrowser).toHaveBeenNthCalledWith(2, true);
    expect(browserWindow.webContents.reload).not.toHaveBeenCalled();
    expect(
      browserWindow.webContents.reloadIgnoringCache,
    ).not.toHaveBeenCalled();
  });

  test("falls back to reloading the app window outside the browser page", () => {
    const template = createApplicationMenuTemplate("MediaGo", "darwin", {
      reloadVisibleBrowser: () => false,
    }) as MenuEntry[];
    const reload = findByLabel(template, "Reload");
    const forceReload = findByLabel(template, "Force Reload");
    const browserWindow = {
      webContents: {
        reload: vi.fn(),
        reloadIgnoringCache: vi.fn(),
      },
    };

    reload?.click?.({}, browserWindow, {});
    forceReload?.click?.({}, browserWindow, {});

    expect(browserWindow.webContents.reload).toHaveBeenCalledOnce();
    expect(
      browserWindow.webContents.reloadIgnoringCache,
    ).toHaveBeenCalledOnce();
  });
});
