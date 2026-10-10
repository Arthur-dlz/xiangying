import { describe, expect, it } from "vitest";
import { unwrapElectronIpcResult } from "./electron-ipc.ts";

describe("unwrapElectronIpcResult", () => {
  it("returns data from a successful Electron IPC envelope", async () => {
    await expect(
      unwrapElectronIpcResult<{ activeTabId: string }>(
        Promise.resolve({
          code: 0,
          data: { activeTabId: "tab-a" },
          message: "success",
        }),
      ),
    ).resolves.toEqual({ activeTabId: "tab-a" });
  });

  it("preserves an unwrapped result", async () => {
    await expect(
      unwrapElectronIpcResult<string>(Promise.resolve("ready")),
    ).resolves.toBe("ready");
  });

  it("rejects an unsuccessful Electron IPC envelope", async () => {
    await expect(
      unwrapElectronIpcResult<never>(
        Promise.resolve({ code: -1, data: null, message: "tab not found" }),
      ),
    ).rejects.toThrow("tab not found");
  });
});
