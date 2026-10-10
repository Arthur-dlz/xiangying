import type { Page } from "@playwright/test";
import { MediaGoClient } from "../../../packages/core-sdk/src/index.ts";

// Exercise the real trusted renderer HTTP path without reading the main-process credential.
export function trustedCoreClient(page: Page, baseURL: string): MediaGoClient {
  const client = new MediaGoClient({ baseURL });
  client.api.defaults.adapter = async (config) => {
    const result = await page.evaluate(
      async (request) => {
        const response = await fetch(request.url, {
          method: request.method,
          headers: { "Content-Type": "application/json" },
          body: request.body,
          credentials: "omit",
        });
        return { status: response.status, data: await response.json() };
      },
      {
        url: new URL(config.url ?? "", baseURL).href,
        method: (config.method ?? "get").toUpperCase(),
        body: typeof config.data === "string" ? config.data : undefined,
      },
    );
    if (result.status < 200 || result.status >= 300)
      throw new Error(`Trusted Core request returned HTTP ${result.status}`);
    return { ...result, statusText: "", headers: {}, config };
  };
  return client;
}
