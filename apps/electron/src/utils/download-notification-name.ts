interface DownloadTaskNameResponse {
  data: {
    name: string;
  };
}

interface DownloadNotificationNameLogger {
  warn(...args: unknown[]): unknown;
}

export async function resolveDownloadNotificationName(
  id: number,
  getDownloadTask: (id: number) => Promise<DownloadTaskNameResponse>,
  logger: DownloadNotificationNameLogger,
): Promise<string> {
  try {
    const response = await getDownloadTask(id);
    const name = response.data.name.trim();
    return name || String(id);
  } catch (error) {
    logger.warn(
      `[Notification] Failed to resolve name for taskId: ${id}`,
      error,
    );
    return String(id);
  }
}
