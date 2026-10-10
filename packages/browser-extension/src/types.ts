import type { PlatformApi } from "@mediago/common";

declare global {
  interface Window {
    electron: PlatformApi;
    TDAPP?: {
      onEvent: (
        eventId: string,
        label: "",
        mapKv: Record<string, string>,
      ) => void;
    };
    clarity?: (...args: unknown[]) => void;
  }
}
