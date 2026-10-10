import { describe, expect, test, vi } from "vitest";
import {
  type CoreBuildCommand,
  type CoreBuildOperations,
  runCoreBuildCommand,
} from "./cli";

function createOperations(): CoreBuildOperations {
  return {
    dev: vi.fn(async () => undefined),
    devBuild: vi.fn(async () => undefined),
    productionBuild: vi.fn(async () => undefined),
    releaseBuild: vi.fn(async () => undefined),
    releasePackageFull: vi.fn(async () => undefined),
  };
}

describe("runCoreBuildCommand", () => {
  test.each<{
    command: CoreBuildCommand;
    operation: keyof CoreBuildOperations;
  }>([
    { command: "dev", operation: "dev" },
    { command: "build", operation: "devBuild" },
    { command: "build:production", operation: "productionBuild" },
    { command: "release:build", operation: "releaseBuild" },
    { command: "release", operation: "releasePackageFull" },
  ])("maps $command to $operation", async ({ command, operation }) => {
    const operations = createOperations();

    await runCoreBuildCommand(command, operations);

    for (const [name, handler] of Object.entries(operations)) {
      expect(handler).toHaveBeenCalledTimes(name === operation ? 1 : 0);
    }
  });

  test.each([undefined, "unknown"])(
    "rejects unsupported command %s",
    async (command) => {
      const operations = createOperations();

      await expect(runCoreBuildCommand(command, operations)).rejects.toThrow(
        "Unknown Core build command",
      );
      for (const handler of Object.values(operations)) {
        expect(handler).not.toHaveBeenCalled();
      }
    },
  );
});
