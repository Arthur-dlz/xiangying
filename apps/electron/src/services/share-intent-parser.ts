import {
  ELECTRON_SHARE_PROTOCOLS,
  normalizeShareIntent,
  type ShareIntent,
} from "@mediago/common";

export interface ParsedProtocolInvocation {
  handled: boolean;
  intent?: ShareIntent;
}

export function parseShareIntentProtocolUrl(
  rawUrl: string,
  scheme: string,
): ParsedProtocolInvocation {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { handled: false };
  }

  if (parsed.protocol.toLowerCase() !== `${scheme.toLowerCase()}:`) {
    return { handled: false };
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "open") return { handled: true };

  if (host === "share") {
    const version = parsed.searchParams.get("v");
    if (version && version !== "1") return { handled: true };
    return {
      handled: true,
      intent: intentFromParams(parsed.searchParams, false),
    };
  }

  if (host === "index.html") {
    if (!parsed.searchParams.has("n")) return { handled: true };
    return {
      handled: true,
      intent: intentFromParams(parsed.searchParams, true),
    };
  }

  return { handled: false };
}

function intentFromParams(
  params: URLSearchParams,
  legacy: boolean,
): ShareIntent | undefined {
  const requestedAutomaticAction =
    legacy && (params.has("silent") || params.has("downloadNow"));
  return (
    normalizeShareIntent(
      {
        source: legacy ? "legacy-electron" : "electron",
        url: params.get("encodedURL") || params.get("url"),
        name: params.get("name"),
        type: params.get("type"),
        warning: requestedAutomaticAction
          ? "legacy-auto-action-disabled"
          : undefined,
      },
      { allowedProtocols: ELECTRON_SHARE_PROTOCOLS },
    ) ?? undefined
  );
}
