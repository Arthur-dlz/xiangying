import { DownloadType, IPC } from "@mediago/common";
import type { OnBeforeSendHeadersListenerDetails } from "electron";

const DEV_UI_PORT = "8500";
const remoteBrowserTabs = new Map<
  number,
  { tabId: string; canSubmitCandidates: boolean }
>();
const trustedAppContents = new Set<number>();

export interface IpcSenderLike {
  id: number;
  isDestroyed(): boolean;
  mainFrame?: { url: string } | null;
  getURL(): string;
}

export interface IpcEventLike {
  sender: IpcSenderLike;
  senderFrame?: { url: string } | null;
}

export type IpcTrust =
  | { trusted: true; kind: "app" }
  | {
      trusted: true;
      kind: "remote-browser";
      tabId: string;
      canSubmitCandidates: boolean;
    }
  | { trusted: false };

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

export function isTrustedAppURL(value: string, isDev: boolean): boolean {
  try {
    const url = new URL(value);
    if (isDev) {
      return (
        url.protocol === "http:" &&
        isLoopback(url.hostname) &&
        url.port === DEV_UI_PORT &&
        url.username === "" &&
        url.password === ""
      );
    }
    return (
      Boolean(process.env.APP_NAME) &&
      url.protocol === `${process.env.APP_NAME}:` &&
      url.hostname === "index.html" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function registerRemoteBrowserContents(
  webContentsId: number,
  tabId: string,
  canSubmitCandidates: boolean,
): void {
  remoteBrowserTabs.set(webContentsId, { tabId, canSubmitCandidates });
}

export function unregisterRemoteBrowserContents(webContentsId: number): void {
  remoteBrowserTabs.delete(webContentsId);
}

export function registerTrustedAppContents(webContentsId: number): void {
  trustedAppContents.add(webContentsId);
}

export function unregisterTrustedAppContents(webContentsId: number): void {
  trustedAppContents.delete(webContentsId);
}

export function shouldInjectCoreCredential(
  details: OnBeforeSendHeadersListenerDetails,
  coreOrigin: string,
  isDev: boolean,
): boolean {
  if (
    !details.webContentsId ||
    !trustedAppContents.has(details.webContentsId)
  ) {
    return false;
  }
  const { frame, webContents } = details;
  if (!frame || !webContents || frame !== webContents.mainFrame) return false;
  if (!isTrustedAppURL(frame.url, isDev)) return false;

  try {
    const requestURL = new URL(details.url);
    const expectedOrigin = new URL(coreOrigin);
    const isLoopback = (hostname: string) =>
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]";
    return (
      requestURL.origin === expectedOrigin.origin &&
      expectedOrigin.protocol === "http:" &&
      isLoopback(expectedOrigin.hostname)
    );
  } catch {
    return false;
  }
}

export function getIpcTrust(event: IpcEventLike, isDev: boolean): IpcTrust {
  const { sender, senderFrame } = event;
  if (sender.isDestroyed() || !senderFrame || !sender.mainFrame) {
    return { trusted: false };
  }
  if (senderFrame !== sender.mainFrame || senderFrame.url !== sender.getURL()) {
    return { trusted: false };
  }
  const remoteContents = remoteBrowserTabs.get(sender.id);
  // A browser tab stays untrusted even if it navigates to an app-looking URL.
  if (remoteContents) {
    try {
      if (/^https?:$/.test(new URL(senderFrame.url).protocol)) {
        return {
          trusted: true,
          kind: "remote-browser",
          ...remoteContents,
        };
      }
    } catch {
      return { trusted: false };
    }
    return { trusted: false };
  }
  if (
    trustedAppContents.has(sender.id) &&
    isTrustedAppURL(senderFrame.url, isDev)
  ) {
    return { trusted: true, kind: "app" };
  }
  return { trusted: false };
}

export function isAllowedRemoteBrowserChannel(channel: string): boolean {
  return channel === IPC.browser.showDownloadDialog;
}

export function bindRemotePayloadToTab(
  channel: string,
  payload: unknown,
  tabId: string,
): unknown {
  if (channel !== IPC.browser.showDownloadDialog) return payload;
  const data = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && "data" in payload
      ? (payload as { data: unknown }).data
      : null;
  if (!Array.isArray(data) || data.length === 0 || data.length > 20) {
    return null;
  }
  const allowedTypes = new Set<string>(Object.values(DownloadType));
  const safeCandidates: { name: string; url: string; type: DownloadType }[] =
    [];
  for (const candidate of data) {
    if (!candidate || typeof candidate !== "object") return null;
    const keys = Object.keys(candidate);
    if (keys.some((key) => !["name", "url", "type"].includes(key))) {
      return null;
    }
    const { name, url, type } = candidate as Record<string, unknown>;
    if (
      typeof name !== "string" ||
      name.trim().length === 0 ||
      name.length > 300 ||
      typeof url !== "string" ||
      url.length > 8192 ||
      typeof type !== "string" ||
      !allowedTypes.has(type)
    ) {
      return null;
    }
    try {
      const parsedURL = new URL(url);
      if (
        !["http:", "https:"].includes(parsedURL.protocol) ||
        parsedURL.username !== "" ||
        parsedURL.password !== ""
      ) {
        return null;
      }
    } catch {
      return null;
    }
    safeCandidates.push({ name: name.trim(), url, type: type as DownloadType });
  }
  return { tabId, data: safeCandidates };
}
