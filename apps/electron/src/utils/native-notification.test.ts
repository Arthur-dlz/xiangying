import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNativeNotificationRetainer,
  showNativeNotification,
  type NativeNotificationDependencies,
} from "./native-notification";

afterEach(() => {
  vi.useRealTimers();
});

describe("createNativeNotificationRetainer", () => {
  it("keeps notifications alive until they are released", () => {
    vi.useFakeTimers();
    const retainer = createNativeNotificationRetainer();
    const notification = {
      once: vi.fn(),
      show: vi.fn(),
    };

    const release = retainer.retain(notification);

    expect(retainer.activeCount()).toBe(1);
    release();
    expect(retainer.activeCount()).toBe(0);
  });

  it("releases notifications after the retention timeout", () => {
    vi.useFakeTimers();
    const retainer = createNativeNotificationRetainer(60_000);
    const notification = {
      once: vi.fn(),
      show: vi.fn(),
    };

    retainer.retain(notification);
    vi.advanceTimersByTime(60_000);

    expect(retainer.activeCount()).toBe(0);
  });
});

describe("showNativeNotification", () => {
  it("logs and skips unsupported native notifications", () => {
    const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const dependencies: NativeNotificationDependencies = {
      create: vi.fn(),
      isSupported: () => false,
      retain: vi.fn(),
    };

    showNativeNotification(
      { title: "Download complete" },
      logger,
      dependencies,
    );

    expect(dependencies.create).not.toHaveBeenCalled();
    expect(dependencies.retain).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[Notification] Native notifications are not supported",
    );
  });

  it("retains native notifications until they close", () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const notification = {
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
        return notification;
      }),
      show: vi.fn(),
    };
    const release = vi.fn();
    const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const dependencies: NativeNotificationDependencies = {
      create: vi.fn(() => notification),
      isSupported: () => true,
      retain: vi.fn(() => release),
    };

    showNativeNotification(
      { title: "Download complete" },
      logger,
      dependencies,
    );

    expect(dependencies.retain).toHaveBeenCalledWith(notification);
    expect(notification.show).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();

    listeners.get("show")?.();
    expect(logger.info).toHaveBeenCalledWith(
      "[Notification] Native notification shown",
    );

    listeners.get("close")?.();
    expect(release).toHaveBeenCalledOnce();
  });

  it("logs the Electron failed event without exposing notification content", () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const notification = {
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
        return notification;
      }),
      show: vi.fn(),
    };
    const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const release = vi.fn();
    const dependencies: NativeNotificationDependencies = {
      create: vi.fn(() => notification),
      isSupported: () => true,
      retain: vi.fn(() => release),
    };

    showNativeNotification(
      { body: "private filename", title: "Download failed" },
      logger,
      dependencies,
    );
    listeners.get("failed")?.({}, "UNErrorDomain error 1");

    expect(notification.show).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      "[Notification] Native notification failed",
      "UNErrorDomain error 1",
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      "private filename",
    );
  });

  it("contains a synchronous show failure", () => {
    const notification = {
      once: vi.fn().mockReturnThis(),
      show: vi.fn(() => {
        throw new Error("show failed");
      }),
    };
    const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const release = vi.fn();
    const dependencies: NativeNotificationDependencies = {
      create: () => notification,
      isSupported: () => true,
      retain: () => release,
    };

    expect(() =>
      showNativeNotification(
        { title: "Download failed" },
        logger,
        dependencies,
      ),
    ).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      "[Notification] Failed to show native notification",
      expect.any(Error),
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
