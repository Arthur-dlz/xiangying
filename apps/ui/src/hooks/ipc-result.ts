export function unwrapIpcResult(result: unknown): unknown {
  if (result && typeof result === "object" && "code" in result) {
    const response = result as Record<string, unknown>;
    if (typeof response.code === "number" && response.code !== 0) {
      throw new Error(
        typeof response.message === "string"
          ? response.message
          : "操作失败，请重试",
      );
    }
    return response.data;
  }
  return result;
}
