import "reflect-metadata";
import { buildProviderModule } from "@inversifyjs/binding-decorators";
import { app, protocol } from "electron";
import { Container } from "inversify";
import ElectronApp from "./app";
import { registerGracefulQuit } from "./lifecycle";
import { defaultScheme, noop } from "./utils";
import path from "node:path";
import { workspace } from "./constants";
import { runStartup, type StartupStage } from "./startup";

app.setName("xiangying");
app.setPath("userData", workspace);

const container = new Container({
  defaultScope: "Singleton",
});

const gotTheLock = app.requestSingleInstanceLock();
let mediagoApp: ElectronApp | null = null;
let mediagoReady = false;
const pendingCommandLines: string[][] = [process.argv];
const pendingProtocolUrls: string[] = [];

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (mediagoApp) {
    mediagoApp.handleExternalUrl(url, mediagoReady);
  } else {
    pendingProtocolUrls.push(url);
  }
});

app.on("second-instance", (_event, commandLine) => {
  if (mediagoApp) {
    mediagoApp.handleSecondInstance(commandLine, mediagoReady);
  } else {
    pendingCommandLines.push(commandLine);
  }
});

registerGracefulQuit(
  app,
  async () => mediagoApp?.shutdown(),
  (error) => console.error("Electron shutdown failed", error),
);

// Isolated acceptance runs must not register a system URL handler.
if (process.env.MEDIAGO_RUNTIME_ROOT) {
  // The runtime override keeps tests and previews within their selected directory.
} else if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(defaultScheme, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient(defaultScheme);
}

const start = async (
  setStage: (stage: StartupStage) => void,
): Promise<void> => {
  if (!gotTheLock) {
    app.quit();
    return;
  }

  protocol.registerSchemesAsPrivileged([
    {
      scheme: defaultScheme,
      privileges: {
        secure: true,
        standard: true,
      },
    },
  ]);
  setStage("readiness");
  await app.whenReady();
  setStage("provider");
  await container.load(buildProviderModule());
  const initializedApp = container.get(ElectronApp);
  mediagoApp = initializedApp;
  pendingCommandLines
    .splice(0)
    .forEach((commandLine) =>
      initializedApp.handleExternalCommandLine(commandLine, false),
    );
  pendingProtocolUrls
    .splice(0)
    .forEach((url) => initializedApp.handleExternalUrl(url, false));
  setStage("init");
  await initializedApp.init();
  mediagoReady = true;
  initializedApp.presentPendingExternalInvocations();
  app.on("window-all-closed", noop);
};

void runStartup(
  start,
  (category, stage) =>
    console.error("Electron startup failed", { category, stage }),
  () => app.quit(),
);
