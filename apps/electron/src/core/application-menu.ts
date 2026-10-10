import {
  app,
  type BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
} from "electron";
import { i18n } from "./i18n";

const separator = (): MenuItemConstructorOptions => ({ type: "separator" });

export interface ApplicationMenuActions {
  reloadVisibleBrowser?: (ignoreCache: boolean) => boolean;
}

const topLevelLabel = (label: string, accessKey: string, isMac: boolean) =>
  isMac ? label : `${label}(&${accessKey})`;

export const createApplicationMenuTemplate = (
  applicationName = app.name,
  platform = process.platform,
  actions: ApplicationMenuActions = {},
): MenuItemConstructorOptions[] => {
  const isMac = platform === "darwin";
  const template: MenuItemConstructorOptions[] = [];
  const label = (key: string) =>
    i18n.t(`applicationMenu.${key}`, { applicationName });

  if (isMac) {
    template.push({
      label: applicationName,
      submenu: [
        { label: label("about"), role: "about" },
        separator(),
        { label: label("services"), role: "services" },
        separator(),
        { label: label("hide"), role: "hide" },
        { label: label("hideOthers"), role: "hideOthers" },
        { label: label("showAll"), role: "unhide" },
        separator(),
        { label: label("quit"), role: "quit" },
      ],
    });
  }

  template.push(
    {
      label: topLevelLabel(label("file"), "F", isMac),
      submenu: isMac
        ? [{ label: label("closeWindow"), role: "close" }]
        : [{ label: label("quit"), role: "quit" }],
    },
    {
      label: topLevelLabel(label("edit"), "E", isMac),
      submenu: [
        { label: label("undo"), role: "undo" },
        { label: label("redo"), role: "redo" },
        separator(),
        { label: label("cut"), role: "cut" },
        { label: label("copy"), role: "copy" },
        { label: label("paste"), role: "paste" },
        ...(isMac
          ? [
              {
                label: label("pasteAndMatchStyle"),
                role: "pasteAndMatchStyle" as const,
              },
            ]
          : []),
        { label: label("delete"), role: "delete" },
        separator(),
        { label: label("selectAll"), role: "selectAll" },
        ...(isMac
          ? [
              separator(),
              {
                label: label("speech"),
                submenu: [
                  {
                    label: label("startSpeaking"),
                    role: "startSpeaking" as const,
                  },
                  {
                    label: label("stopSpeaking"),
                    role: "stopSpeaking" as const,
                  },
                ],
              },
            ]
          : []),
      ],
    },
    {
      label: topLevelLabel(label("view"), "V", isMac),
      submenu: [
        actions.reloadVisibleBrowser
          ? {
              accelerator: "CmdOrCtrl+R",
              label: label("reload"),
              click: (_item, browserWindow) => {
                if (actions.reloadVisibleBrowser?.(false) || !browserWindow)
                  return;
                if ("webContents" in browserWindow) {
                  (browserWindow as BrowserWindow).webContents.reload();
                }
              },
            }
          : { label: label("reload"), role: "reload" },
        actions.reloadVisibleBrowser
          ? {
              accelerator: "CmdOrCtrl+Shift+R",
              label: label("forceReload"),
              click: (_item, browserWindow) => {
                if (actions.reloadVisibleBrowser?.(true) || !browserWindow)
                  return;
                if ("webContents" in browserWindow) {
                  (
                    browserWindow as BrowserWindow
                  ).webContents.reloadIgnoringCache();
                }
              },
            }
          : { label: label("forceReload"), role: "forceReload" },
        { label: label("toggleDeveloperTools"), role: "toggleDevTools" },
        separator(),
        { label: label("resetZoom"), role: "resetZoom" },
        { label: label("zoomIn"), role: "zoomIn" },
        { label: label("zoomOut"), role: "zoomOut" },
        separator(),
        { label: label("toggleFullScreen"), role: "togglefullscreen" },
      ],
    },
    {
      label: topLevelLabel(label("window"), "W", isMac),
      submenu: isMac
        ? [
            { label: label("minimize"), role: "minimize" },
            { label: label("zoom"), role: "zoom" },
            separator(),
            { label: label("bringAllToFront"), role: "front" },
            separator(),
            { label: label("window"), role: "window" },
          ]
        : [
            { label: label("minimize"), role: "minimize" },
            { label: label("zoom"), role: "zoom" },
            { label: label("closeWindow"), role: "close" },
          ],
    },
    {
      label: topLevelLabel(label("help"), "H", isMac),
      role: "help",
      submenu: [{ label: label("about"), role: "about" }],
    },
  );

  return template;
};

export const installApplicationMenu = (
  actions: ApplicationMenuActions = {},
): void => {
  const menu = Menu.buildFromTemplate(
    createApplicationMenuTemplate(app.name, process.platform, actions),
  );
  Menu.setApplicationMenu(menu);
};
