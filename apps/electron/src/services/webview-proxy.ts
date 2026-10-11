interface ProxySession {
  setProxy(options: { proxyRules: string }): unknown;
}

interface ProxyLogger {
  info(...args: unknown[]): unknown;
  error(...args: unknown[]): unknown;
}

export function enableSessionProxy(
  session: ProxySession,
  logger: ProxyLogger,
  proxy: string,
): void {
  if (!proxy) {
    logger.error("[Proxy] proxy address is empty");
    return;
  }

  const proxyRules = /^(https?|socks5):\/\//i.test(proxy)
    ? proxy
    : `http://${proxy}`;

  const result = session.setProxy({ proxyRules }) as
    | Promise<unknown>
    | undefined;
  if (result && typeof result.then === "function") {
    // Electron's session.setProxy is async: only report success once it
    // actually resolves, and log failures instead of swallowing them.
    void result.then(
      () => logger.info("[Proxy] proxy enabled"),
      (error) => logger.error("[Proxy] failed to enable proxy", error),
    );
    return;
  }

  logger.info("[Proxy] proxy enabled");
}
