import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyArtifactGraphs } from "./verify-build-artifacts-core.ts";

const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
  "packages/mediago-extension",
);
const distRoot = resolve(packageRoot, "dist");

function fail(message: string): never {
  throw new Error(`Extension build artifact check failed: ${message}`);
}

function read(relativePath: string): string {
  const file = resolve(distRoot, relativePath);
  if (!existsSync(file)) fail(`missing ${relativePath}`);
  return readFileSync(file, "utf8");
}

function firstMatch(
  source: string,
  pattern: RegExp,
  description: string,
): string {
  const match = source.match(pattern)?.[1];
  if (!match) fail(`could not resolve ${description}`);
  return match;
}

function readAssetGraph(entryPath: string): string {
  const pending = [entryPath];
  const visited = new Set<string>();
  const sources: string[] = [];

  while (pending.length > 0) {
    const relativePath = pending.pop();
    if (!relativePath || visited.has(relativePath)) continue;
    visited.add(relativePath);
    const source = read(relativePath);
    sources.push(source);

    const specifiers = new Set<string>();
    for (const pattern of [
      /\b(?:import|export)[^"']*?\bfrom\s*["']\.\/([^"']+)["']/g,
      /\bimport\s*["']\.\/([^"']+)["']/g,
    ]) {
      for (const match of source.matchAll(pattern)) {
        if (match[1]) specifiers.add(match[1]);
      }
    }
    for (const specifier of specifiers) {
      pending.push(normalize(join(dirname(relativePath), specifier)));
    }
  }

  return sources.join("\n");
}

const manifest = JSON.parse(read("manifest.json"));
const workerLoaderPath = manifest.background?.service_worker;
if (typeof workerLoaderPath !== "string") {
  fail("manifest background.service_worker is missing");
}
const contentLoaderPath = manifest.content_scripts?.[0]?.js?.[0];
if (typeof contentLoaderPath !== "string") {
  fail("manifest content script loader is missing");
}

const workerLoader = read(workerLoaderPath);
const workerAssetPath = firstMatch(
  workerLoader,
  /import\s+["']\.\/(assets\/[^"']+)["']/,
  "service worker asset import",
);
const contentLoader = read(contentLoaderPath);
const contentAssetPath = firstMatch(
  contentLoader,
  /chrome\.runtime\.getURL\(["'](assets\/[^"']+)["']\)/,
  "content script asset import",
);

if (workerAssetPath === contentAssetPath) {
  fail(`service worker and content script both load ${workerAssetPath}`);
}

const workerAsset = readAssetGraph(workerAssetPath);
const contentAsset = readAssetGraph(contentAssetPath);
verifyArtifactGraphs({
  workerAssetPath,
  contentAssetPath,
  workerAsset,
  contentAsset,
});

process.stdout.write(
  `Verified extension entry artifacts: worker=${workerAssetPath}, content=${contentAssetPath}\n`,
);
