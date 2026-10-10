import { describe, expect, it, vi } from "vitest";
import { resolveDownloadNotificationName } from "./download-notification-name";

describe("resolveDownloadNotificationName", () => {
  it("uses the persisted download task name", async () => {
    const logger = { warn: vi.fn() };
    const getDownloadTask = vi.fn(async () => ({
      data: { name: "  Example video title  " },
    }));

    await expect(
      resolveDownloadNotificationName(27, getDownloadTask, logger),
    ).resolves.toBe("Example video title");
    expect(getDownloadTask).toHaveBeenCalledWith(27);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("falls back to the task ID when the persisted name is blank", async () => {
    const logger = { warn: vi.fn() };

    await expect(
      resolveDownloadNotificationName(
        27,
        async () => ({ data: { name: "   " } }),
        logger,
      ),
    ).resolves.toBe("27");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("falls back to the task ID when the task lookup fails", async () => {
    const logger = { warn: vi.fn() };
    const lookupError = new Error("lookup failed");

    await expect(
      resolveDownloadNotificationName(
        27,
        async () => Promise.reject(lookupError),
        logger,
      ),
    ).resolves.toBe("27");
    expect(logger.warn).toHaveBeenCalledWith(
      "[Notification] Failed to resolve name for taskId: 27",
      lookupError,
    );
  });
});
