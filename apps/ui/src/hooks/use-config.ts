import useSWR from "swr";
import {
  getConfig,
  getConfigKey,
  getEnvPath,
  getEnvPathKey,
  setConfigValue,
  type GoEnvPath,
} from "@/api/config";
import type { AppStore } from "@mediago/common";

export function useConfig() {
  const { data, isLoading, error, mutate } = useSWR(getConfigKey, getConfig);

  const setConfigKey = async <K extends keyof AppStore>(
    key: K,
    value: AppStore[K],
  ) => {
    await setConfigValue(key, value);
    await mutate();
  };

  return {
    config: data as AppStore | undefined,
    isLoading,
    error,
    setConfigKey,
    mutate,
  };
}

export function useEnvPath() {
  const { data, isLoading, error } = useSWR(getEnvPathKey, getEnvPath);
  return {
    envPath: data as GoEnvPath | undefined,
    isLoading,
    error,
  };
}
