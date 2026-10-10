"use strict";

const fs = require("node:fs");

const observerFile = process.env.XIANGYING_UPDATE_EGRESS_OBSERVER_FILE;
const corePort = Number(process.env.MEDIAGO_CORE_PORT || 39939);
const state = {
  version: 1,
  armed: false,
  networkArmed: false,
  updaterSinkArmed: false,
  setupError: null,
  ownerPid: process.pid,
  counters: {
    nodeHttp: 0,
    nodeHttpGet: 0,
    nodeHttps: 0,
    nodeHttpsGet: 0,
    nodeFetch: 0,
    electronNetRequest: 0,
    electronNetFetch: 0,
    autoUpdaterCheck: 0,
    autoUpdaterCheckAndNotify: 0,
    autoUpdaterDownload: 0,
    autoUpdaterInstall: 0,
    shellOpenExternal: 0,
    blockedExternal: 0,
  },
  attempts: [],
};

function persist() {
  if (!observerFile) return;
  fs.writeFileSync(observerFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function record(name, blockedExternal = false) {
  state.counters[name] += 1;
  if (blockedExternal) state.counters.blockedExternal += 1;
  state.attempts.push(name);
  persist();
}

function requestUrl(args, scheme) {
  const first = args[0];
  if (first instanceof URL) return first;
  if (typeof first === "string") return new URL(first);
  if (first && typeof first === "object") {
    if (typeof first.url === "string") return new URL(first.url);
    const protocol = first.protocol || scheme;
    const hostname = first.hostname;
    const host = hostname || first.host || "localhost";
    const port = hostname && first.port ? `:${first.port}` : "";
    const pathname = first.path || first.pathname || "/";
    return new URL(`${protocol}//${host}${port}${pathname}`);
  }
  return new URL(`${scheme}//invalid/`);
}

function isOwnedCoreRequest(url) {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname) &&
    url.port === String(corePort)
  );
}

function guardRequest(target, key, counter, scheme) {
  const original = target[key];
  if (typeof original !== "function") {
    throw new Error(`observer-missing-${counter}`);
  }
  target[key] = function (...args) {
    const url = requestUrl(args, scheme);
    if (isOwnedCoreRequest(url)) return original.apply(this, args);
    record(counter, true);
    throw new Error("external request blocked by Xiangying closure observer");
  };
}

if (process.versions.electron && process.type === "browser") {
  try {
    const http = require("node:http");
    const https = require("node:https");
    guardRequest(http, "request", "nodeHttp", "http:");
    guardRequest(http, "get", "nodeHttpGet", "http:");
    guardRequest(https, "request", "nodeHttps", "https:");
    guardRequest(https, "get", "nodeHttpsGet", "https:");

    const originalFetch = globalThis.fetch;
    if (typeof originalFetch !== "function") {
      throw new Error("observer-missing-nodeFetch");
    }
    globalThis.fetch = function (input, ...args) {
      const request =
        input && typeof input === "object" && "url" in input
          ? input.url
          : input;
      const url = requestUrl([request], "https:");
      if (isOwnedCoreRequest(url))
        return originalFetch.call(this, input, ...args);
      record("nodeFetch", true);
      return Promise.reject(
        new Error("external request blocked by Xiangying closure observer"),
      );
    };

    const electron = require("electron");
    guardRequest(electron.net, "request", "electronNetRequest", "https:");
    const originalNetFetch = electron.net.fetch;
    if (typeof originalNetFetch !== "function") {
      throw new Error("observer-missing-electronNetFetch");
    }
    electron.net.fetch = function (input, ...args) {
      const request =
        input && typeof input === "object" && "url" in input
          ? input.url
          : input;
      const url = requestUrl([request], "https:");
      if (isOwnedCoreRequest(url))
        return originalNetFetch.call(this, input, ...args);
      record("electronNetFetch", true);
      return Promise.reject(
        new Error("external request blocked by Xiangying closure observer"),
      );
    };

    const shell = electron.shell;
    const originalOpenExternal = shell.openExternal;
    if (typeof originalOpenExternal !== "function") {
      throw new Error("observer-missing-shellOpenExternal");
    }
    shell.openExternal = function () {
      record("shellOpenExternal", true);
      return Promise.reject(
        new Error("external action blocked by Xiangying closure observer"),
      );
    };

    state.networkArmed = true;
    globalThis.xiangyingUpdateEgressObserver = {
      armUpdater(target) {
        const methods = [
          ["checkForUpdates", "autoUpdaterCheck"],
          ["checkForUpdatesAndNotify", "autoUpdaterCheckAndNotify"],
          ["downloadUpdate", "autoUpdaterDownload"],
          ["quitAndInstall", "autoUpdaterInstall"],
        ];
        for (const [key, counter] of methods) {
          if (!target || typeof target[key] !== "function") return false;
          const replacement = function () {
            record(counter, true);
            if (key === "quitAndInstall") return undefined;
            return Promise.reject(
              new Error("updater action blocked by Xiangying closure observer"),
            );
          };
          try {
            target[key] = replacement;
          } catch {
            return false;
          }
          if (target[key] !== replacement) return false;
        }
        state.updaterSinkArmed = true;
        state.armed = true;
        persist();
        return true;
      },
      snapshot() {
        return JSON.parse(JSON.stringify(state));
      },
    };
  } catch {
    state.setupError = "observer-initialization-failed";
  }

  persist();
}
