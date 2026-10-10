interface ElectronIpcEnvelope {
  code: number;
  data?: unknown;
  message?: unknown;
}

function isElectronIpcEnvelope(value: unknown): value is ElectronIpcEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "number"
  );
}

export function unwrapElectronIpcResponse<T>(response: unknown): T {
  if (!isElectronIpcEnvelope(response)) return response as T;
  if (response.code !== 0) {
    throw new Error(
      typeof response.message === "string"
        ? response.message
        : `Electron IPC failed with code ${response.code}`,
    );
  }
  return response.data as T;
}

export async function unwrapElectronIpcResult<T>(
  operation: PromiseLike<unknown>,
): Promise<T> {
  return unwrapElectronIpcResponse<T>(await operation);
}
