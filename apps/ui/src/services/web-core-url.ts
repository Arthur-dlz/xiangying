const DEVELOPMENT_CORE_PORT = "9900";

export function resolveWebCoreUrl(
  pageOrigin: string,
  isDevelopment: boolean,
): string {
  const coreUrl = new URL(pageOrigin);
  if (isDevelopment) coreUrl.port = DEVELOPMENT_CORE_PORT;
  return coreUrl.origin;
}
