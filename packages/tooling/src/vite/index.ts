import type { Plugin } from "vite";

export interface MediaGoBuildMetadata {
  appName?: string;
  target?: string;
  telemetryId?: string;
  version?: string;
}

export type DependencyChunkGroups = Readonly<Record<string, readonly string[]>>;

export function mediaGoBuildMetadataPlugin(
  metadata: MediaGoBuildMetadata,
): Plugin {
  const define: Record<string, string | undefined> = {};
  const values = [
    ["appName", "APP_NAME"],
    ["target", "APP_TARGET"],
    ["telemetryId", "APP_TD_APPID"],
    ["version", "APP_VERSION"],
  ] as const;

  for (const [property, environmentName] of values) {
    if (Object.hasOwn(metadata, property)) {
      define[`import.meta.env.${environmentName}`] = JSON.stringify(
        metadata[property],
      );
    }
  }

  return {
    name: "mediago:build-metadata",
    config: () => ({ define }),
  };
}

export function createDependencyChunks(
  groups: DependencyChunkGroups,
): (id: string) => string | undefined {
  const entries = Object.entries(groups);

  return (id) => {
    for (const [chunkName, dependencies] of entries) {
      if (dependencies.some((dependency) => id.includes(dependency))) {
        return chunkName;
      }
    }
    return undefined;
  };
}
