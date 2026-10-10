import { describe, expect, test, vi } from "vitest";
import { runStartup, type StartupStage } from "./startup";

describe("startup failure classification contract", () => {
  test("classifies a rejected startup at its fixed stage and quits once", async () => {
    const reportFailure =
      vi.fn<(category: "app-startup-failed", stage: StartupStage) => void>();
    const quit = vi.fn();

    await runStartup(
      async (setStage) => {
        setStage("provider");
        const error = new Error("private path and token");
        error.name = "PrivateError";
        Object.assign(error, {
          code: "PRIVATE_CODE",
          url: "https://private.invalid",
        });
        throw error;
      },
      reportFailure,
      quit,
    );

    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledWith(
      "app-startup-failed",
      "provider",
    );
    expect(quit).toHaveBeenCalledOnce();
    expect(JSON.stringify(reportFailure.mock.calls)).not.toContain("private");
    expect(JSON.stringify(reportFailure.mock.calls)).not.toContain(
      "PRIVATE_CODE",
    );
    expect(JSON.stringify(reportFailure.mock.calls)).not.toContain(
      "private.invalid",
    );
  });

  test("keeps a fulfilled startup on the normal path", async () => {
    const reportFailure =
      vi.fn<(category: "app-startup-failed", stage: StartupStage) => void>();
    const quit = vi.fn();
    const start = vi.fn(async () => undefined);

    await runStartup(start, reportFailure, quit);

    expect(start).toHaveBeenCalledOnce();
    expect(reportFailure).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  test("labels a rejection before any later phase as readiness", async () => {
    const reportFailure =
      vi.fn<(category: "app-startup-failed", stage: StartupStage) => void>();
    const quit = vi.fn();

    await runStartup(
      async () => {
        throw new Error("private readiness details");
      },
      reportFailure,
      quit,
    );

    expect(reportFailure).toHaveBeenCalledWith(
      "app-startup-failed",
      "readiness",
    );
    expect(quit).toHaveBeenCalledOnce();
  });

  test("classifies a rejected app initialization without exposing the error", async () => {
    const reportFailure =
      vi.fn<(category: "app-startup-failed", stage: StartupStage) => void>();
    const quit = vi.fn();

    await runStartup(
      async (setStage) => {
        setStage("init");
        throw new Error("private initialization details");
      },
      reportFailure,
      quit,
    );

    expect(reportFailure).toHaveBeenCalledWith("app-startup-failed", "init");
    expect(quit).toHaveBeenCalledOnce();
  });

  test("keeps the single-instance early-quit path successful", async () => {
    const reportFailure =
      vi.fn<(category: "app-startup-failed", stage: StartupStage) => void>();
    const quit = vi.fn();

    await runStartup(async () => quit(), reportFailure, quit);

    expect(quit).toHaveBeenCalledOnce();
    expect(reportFailure).not.toHaveBeenCalled();
  });

  test("quits if fixed failure reporting itself throws", async () => {
    const reportFailure = vi.fn(() => {
      throw new Error("private logger failure");
    });
    const quit = vi.fn();

    await expect(
      runStartup(
        async () => Promise.reject(new Error("private startup failure")),
        reportFailure,
        quit,
      ),
    ).resolves.toBeUndefined();

    expect(reportFailure).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });
});
