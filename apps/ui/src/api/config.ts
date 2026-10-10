import { http } from "@/utils";
import type { AppStore, MCPServerStatus } from "@mediago/common";

export interface GoEnvPath {
  configDir: string;
  binDir: string;
  platform: string;
  playerUrl: string;
}

export const getConfigKey = "/api/config";
export const getConfig = (options?: {
  suppressAuthRedirect?: boolean;
  timeoutMs?: number;
}): Promise<AppStore> =>
  http.get(getConfigKey, {
    suppressAuthRedirect: options?.suppressAuthRedirect,
    timeout: options?.timeoutMs,
  });

export const setConfigValue = <K extends keyof AppStore>(
  key: K,
  value: AppStore[K],
): Promise<void> => http.put(`/api/config/${String(key)}`, { value });

export const setConfigValues = (values: Partial<AppStore>): Promise<void> =>
  http.post(getConfigKey, values);

export const getEnvPathKey = "/api/env";
export const getEnvPath = (): Promise<GoEnvPath> => http.get(getEnvPathKey);

export const getMCPStatusKey = "/api/mcp/status";
export const getMCPStatus = (): Promise<MCPServerStatus> =>
  http.get(getMCPStatusKey);
