import { session, type OnBeforeSendHeadersListenerDetails } from "electron";
import isDev from "electron-is-dev";
import type { Session } from "electron";
import { shouldInjectCoreCredential } from "./trust-policy";

type RequestHeaders = Record<string, string>;
type BeforeSendCallback = (response: {
  requestHeaders: Record<string, string | string[]>;
}) => void;

export function applyCoreAuthorization(
  requestHeaders: RequestHeaders,
  token: string,
  authorized: boolean,
): RequestHeaders {
  const headers = { ...requestHeaders };
  const authKeys = Object.keys(headers).filter(
    (key) => key.toLowerCase() === "authorization",
  );
  if (authorized) {
    for (const key of authKeys) delete headers[key];
    headers.Authorization = `Bearer ${token}`;
  } else {
    for (const key of authKeys) {
      if (headers[key] === `Bearer ${token}`) delete headers[key];
    }
  }
  return headers;
}

export class CoreCredentialService {
  private coreOrigin = "";
  private token = "";
  private listening = false;

  constructor(
    private readonly targetSession: Pick<
      Session,
      "webRequest"
    > = session.defaultSession,
    private readonly isDevRuntime = isDev,
  ) {}

  start(coreOrigin: string, token: string): void {
    if (!token) throw new Error("Core API credential is required");
    const parsedOrigin = new URL(coreOrigin);
    if (
      parsedOrigin.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(parsedOrigin.hostname) ||
      parsedOrigin.origin !== coreOrigin
    ) {
      throw new Error("Core API origin must be an exact loopback HTTP origin");
    }
    if (this.listening) this.stop();
    this.coreOrigin = parsedOrigin.origin;
    this.token = token;
    this.targetSession.webRequest.onBeforeSendHeaders(
      { urls: ["http://*/*", "https://*/*"] },
      this.handleBeforeSendHeaders,
    );
    this.listening = true;
  }

  stop(): void {
    if (this.listening) {
      this.targetSession.webRequest.onBeforeSendHeaders(null);
    }
    this.listening = false;
    this.coreOrigin = "";
    this.token = "";
  }

  private readonly handleBeforeSendHeaders = (
    details: OnBeforeSendHeadersListenerDetails,
    callback: BeforeSendCallback,
  ) => {
    const authorized = shouldInjectCoreCredential(
      details,
      this.coreOrigin,
      this.isDevRuntime,
    );
    callback({
      requestHeaders: applyCoreAuthorization(
        details.requestHeaders,
        this.token,
        authorized,
      ),
    });
  };
}
