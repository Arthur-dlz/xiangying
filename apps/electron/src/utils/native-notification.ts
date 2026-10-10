import { Notification, type NotificationConstructorOptions } from "electron";

interface NativeNotificationInstance {
  once(event: "close" | "show", listener: () => void): unknown;
  once(
    event: "failed",
    listener: (event: unknown, error: string) => void,
  ): unknown;
  show(): void;
}

export interface NativeNotificationDependencies {
  create(options: NotificationConstructorOptions): NativeNotificationInstance;
  isSupported(): boolean;
  retain(notification: NativeNotificationInstance): () => void;
}

export interface NativeNotificationRetainer {
  activeCount(): number;
  retain(notification: NativeNotificationInstance): () => void;
}

interface NativeNotificationLogger {
  error(...args: unknown[]): unknown;
  info(...args: unknown[]): unknown;
  warn(...args: unknown[]): unknown;
}

const DEFAULT_NOTIFICATION_RETENTION_MS = 60_000;

export function createNativeNotificationRetainer(
  retentionMs = DEFAULT_NOTIFICATION_RETENTION_MS,
): NativeNotificationRetainer {
  const activeNotifications = new Set<NativeNotificationInstance>();

  return {
    activeCount: () => activeNotifications.size,
    retain: (notification) => {
      activeNotifications.add(notification);

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        clearTimeout(retentionTimer);
        activeNotifications.delete(notification);
      };
      const retentionTimer = setTimeout(release, retentionMs);
      retentionTimer.unref();

      return release;
    },
  };
}

const nativeNotificationRetainer = createNativeNotificationRetainer();

const electronDependencies: NativeNotificationDependencies = {
  create: (options) => new Notification(options),
  isSupported: () => Notification.isSupported(),
  retain: nativeNotificationRetainer.retain,
};

export function showNativeNotification(
  options: NotificationConstructorOptions,
  logger: NativeNotificationLogger,
  dependencies: NativeNotificationDependencies = electronDependencies,
): void {
  if (!dependencies.isSupported()) {
    logger.warn("[Notification] Native notifications are not supported");
    return;
  }

  try {
    const notification = dependencies.create(options);
    const release = dependencies.retain(notification);
    notification.once("close", release);
    notification.once("show", () => {
      logger.info("[Notification] Native notification shown");
    });
    notification.once("failed", (_event, error) => {
      release();
      logger.error("[Notification] Native notification failed", error);
    });
    try {
      notification.show();
    } catch (error) {
      release();
      throw error;
    }
  } catch (error) {
    logger.error("[Notification] Failed to show native notification", error);
  }
}
