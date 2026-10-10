import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface EmbeddedAssetOperations {
  copy?: (sourceDirectory: string, targetDirectory: string) => void;
  remove?: (targetDirectory: string) => void;
}

export const EMBEDDED_ASSET_PLACEHOLDER =
  "MediaGo embedded assets placeholder.\n";

const defaultOperations: Required<EmbeddedAssetOperations> = {
  copy: (sourceDirectory, targetDirectory) =>
    cpSync(sourceDirectory, targetDirectory, { recursive: true }),
  remove: (targetDirectory) =>
    rmSync(targetDirectory, { recursive: true, force: true }),
};

export function replaceEmbeddedAssets(
  sourceDirectory: string,
  targetDirectory: string,
  operations: EmbeddedAssetOperations = {},
): void {
  try {
    (operations.remove ?? defaultOperations.remove)(targetDirectory);
    (operations.copy ?? defaultOperations.copy)(
      sourceDirectory,
      targetDirectory,
    );
  } finally {
    mkdirSync(targetDirectory, { recursive: true });
    writeFileSync(
      join(targetDirectory, "placeholder.txt"),
      EMBEDDED_ASSET_PLACEHOLDER,
      "utf8",
    );
  }
}
