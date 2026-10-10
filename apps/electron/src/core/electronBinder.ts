import { type ControllerHandlerBinder } from "./registerControllerHandlers";
import { error, success } from "../utils/ipcResponse";
import type ElectronLogger from "../vendor/ElectronLogger";
import {
  bindRemotePayloadToTab,
  getIpcTrust,
  isAllowedRemoteBrowserChannel,
  type IpcEventLike,
} from "./trust-policy";

export type IpcMainHandlers = {
  handle: (channel: string, listener: (...args: unknown[]) => unknown) => void;
  on: (channel: string, listener: (...args: unknown[]) => unknown) => void;
};

type LoggerLike = Pick<ElectronLogger, "error">;

type Registration = Parameters<ControllerHandlerBinder>[0];

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown>)?.then === "function";
}

export function createElectronControllerBinder(
  ipc: IpcMainHandlers,
  logger: LoggerLike,
): ControllerHandlerBinder {
  return ({ controller, handler, event, method }: Registration) => {
    if (method !== "on" && method !== "handle") return;

    ipc[method](event, async (...args: unknown[]) => {
      try {
        const ipcEvent = args[0];
        if (!ipcEvent || typeof ipcEvent !== "object") {
          return error("Untrusted IPC sender");
        }
        const trust = getIpcTrust(
          ipcEvent as IpcEventLike,
          process.env.NODE_ENV === "development",
        );
        if (!trust.trusted) return error("Untrusted IPC sender");
        if (
          trust.kind === "remote-browser" &&
          (!trust.canSubmitCandidates || !isAllowedRemoteBrowserChannel(event))
        ) {
          return error("Remote browser IPC channel is not allowed");
        }
        const handlerArgs = [...args];
        if (trust.kind === "remote-browser") {
          const safePayload = bindRemotePayloadToTab(
            event,
            handlerArgs[1],
            trust.tabId,
          );
          if (safePayload === null) {
            return error("Invalid remote browser download candidates");
          }
          handlerArgs[1] = safePayload;
        }
        let result = handler.call(controller, ...handlerArgs);
        if (isPromiseLike(result)) {
          result = await result;
        }
        return success(result as Record<string, any>);
      } catch (e: unknown) {
        logger.error(`process ipc [${event}] failed: `, e);
        if (e instanceof Error) {
          return error(e.message);
        }
        return error(String(e));
      }
    });
  };
}
