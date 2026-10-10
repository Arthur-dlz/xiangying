export type CurrentPlatformBuildMode = "development" | "production";

export function createCurrentPlatformBuildArgs(options: {
  commandPath: string;
  ldflags: string;
  mode: CurrentPlatformBuildMode;
  output: string;
}): string[] {
  return [
    "build",
    ...(options.mode === "development" ? ["-tags", "dev"] : []),
    "-trimpath",
    "-ldflags",
    options.ldflags,
    "-o",
    options.output,
    options.commandPath,
  ];
}
