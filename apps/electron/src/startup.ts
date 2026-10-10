export type StartupStage = "readiness" | "provider" | "init";
export type StartupFailureCategory = "app-startup-failed";

type Startup = (setStage: (stage: StartupStage) => void) => Promise<void>;

export async function runStartup(
  start: Startup,
  reportFailure: (
    category: StartupFailureCategory,
    stage: StartupStage,
  ) => void,
  quit: () => void,
): Promise<void> {
  let stage: StartupStage = "readiness";
  try {
    await start((nextStage) => {
      stage = nextStage;
    });
  } catch {
    try {
      reportFailure("app-startup-failed", stage);
    } catch {
      // Failure reporting must not leave a rejected startup running.
    } finally {
      quit();
    }
  }
}
