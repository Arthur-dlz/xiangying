import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

export const CORE_BUILD_COMMANDS = [
  "dev",
  "build",
  "build:production",
  "release:build",
  "release",
] as const;

export type CoreBuildCommand = (typeof CORE_BUILD_COMMANDS)[number];

export interface CoreBuildOperations {
  dev(): Promise<void>;
  devBuild(): Promise<void>;
  productionBuild(): Promise<void>;
  releaseBuild(): Promise<void>;
  releasePackageFull(): Promise<void>;
}

async function loadDefaultOperations(): Promise<CoreBuildOperations> {
  const [development, release] = await Promise.all([
    import("./dev"),
    import("./release"),
  ]);

  return {
    dev: development.dev,
    devBuild: development.devBuild,
    productionBuild: development.productionBuild,
    releaseBuild: release.releaseBuild,
    releasePackageFull: release.releasePackageFull,
  };
}

export async function runCoreBuildCommand(
  command: string | undefined,
  providedOperations?: CoreBuildOperations,
): Promise<void> {
  if (
    command === undefined ||
    !CORE_BUILD_COMMANDS.some((candidate) => candidate === command)
  ) {
    throw new Error(
      `Unknown Core build command. Expected one of: ${CORE_BUILD_COMMANDS.join(", ")}`,
    );
  }

  const operations = providedOperations ?? (await loadDefaultOperations());

  switch (command) {
    case "dev":
      await operations.dev();
      return;
    case "build":
      await operations.devBuild();
      return;
    case "build:production":
      await operations.productionBuild();
      return;
    case "release:build":
      await operations.releaseBuild();
      return;
    case "release":
      await operations.releasePackageFull();
      return;
    default:
      throw new Error(`Unhandled Core build command: ${String(command)}`);
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) return false;
  // Compare resolved filesystem paths instead of raw file URLs: on Windows
  // process.argv[1] can differ from import.meta.url in drive-letter casing,
  // percent-encoding or symlink target, which made this check silently fail.
  const modulePath = fileURLToPath(import.meta.url);
  const entryPath = resolvePath(entrypoint);
  return process.platform === "win32"
    ? modulePath.toLowerCase() === entryPath.toLowerCase()
    : modulePath === entryPath;
}

if (isMainModule()) {
  runCoreBuildCommand(process.argv[2]).catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Core build failed";
    console.error(message);
    process.exitCode = 1;
  });
}
