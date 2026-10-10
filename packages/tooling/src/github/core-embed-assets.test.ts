import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, test } from "vitest";
import {
  EMBEDDED_ASSET_PLACEHOLDER,
  replaceEmbeddedAssets,
} from "../core-build/embedded-assets.ts";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const placeholderContent = "MediaGo embedded assets placeholder.\n";

function createAssetLayout(): {
  sourceDirectory: string;
  targetDirectory: string;
} {
  const root = mkdtempSync(join(tmpdir(), "mediago-embedded-assets-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const sourceDirectory = join(root, "source");
  const targetDirectory = join(root, "target");
  mkdirSync(sourceDirectory);
  mkdirSync(targetDirectory);
  writeFileSync(join(sourceDirectory, "index.html"), "player", "utf8");
  writeFileSync(join(targetDirectory, "stale.js"), "stale", "utf8");
  return { sourceDirectory, targetDirectory };
}

test("replaces embedded assets and writes the stable placeholder", () => {
  const { sourceDirectory, targetDirectory } = createAssetLayout();

  replaceEmbeddedAssets(sourceDirectory, targetDirectory);

  expect(EMBEDDED_ASSET_PLACEHOLDER).toBe(placeholderContent);
  expect(readFileSync(join(targetDirectory, "index.html"), "utf8")).toBe(
    "player",
  );
  expect(existsSync(join(targetDirectory, "stale.js"))).toBe(false);
  expect(readFileSync(join(targetDirectory, "placeholder.txt"), "utf8")).toBe(
    placeholderContent,
  );
});

test("restores the placeholder when copying player assets fails", () => {
  const { sourceDirectory, targetDirectory } = createAssetLayout();

  expect(() =>
    replaceEmbeddedAssets(sourceDirectory, targetDirectory, {
      copy: () => {
        throw new Error("copy failed");
      },
    }),
  ).toThrow("copy failed");
  expect(readFileSync(join(targetDirectory, "placeholder.txt"), "utf8")).toBe(
    placeholderContent,
  );
});

test("restores the placeholder when removing old assets fails", () => {
  const { sourceDirectory, targetDirectory } = createAssetLayout();

  expect(() =>
    replaceEmbeddedAssets(sourceDirectory, targetDirectory, {
      remove: () => {
        throw new Error("remove failed");
      },
    }),
  ).toThrow("remove failed");
  expect(readFileSync(join(targetDirectory, "placeholder.txt"), "utf8")).toBe(
    placeholderContent,
  );
});

test.each(["player", "web"])(
  "keeps only the placeholder visible from generated %s assets",
  (assetDirectory) => {
    const placeholderPath = `apps/core/assets/${assetDirectory}/placeholder.txt`;
    const ordinaryAssetPath = `apps/core/assets/${assetDirectory}/ordinary-file.js`;
    const placeholderIgnored = spawnSync(
      "git",
      ["check-ignore", "--no-index", "--quiet", "--", placeholderPath],
      { cwd: repositoryRoot },
    );
    const ordinaryAssetIgnored = spawnSync(
      "git",
      ["check-ignore", "--no-index", "--quiet", "--", ordinaryAssetPath],
      { cwd: repositoryRoot },
    );

    expect(existsSync(join(repositoryRoot, placeholderPath))).toBe(true);
    expect(placeholderIgnored.status).toBe(1);
    expect(ordinaryAssetIgnored.status).toBe(0);
    expect(readFileSync(join(repositoryRoot, placeholderPath), "utf8")).toBe(
      placeholderContent,
    );
  },
);
