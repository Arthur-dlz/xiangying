import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dependencyExecutablePath,
  platformKeyFor,
  resolveDepsRoot,
} from "@mediago/tooling/runtime-deps";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface FakeBilibiliDependencyLeaf {
  depsDirectory: string;
  bbdownArgumentsPath: string;
}

export interface FakeBilibiliDependencyOptions {
  provisionedAria2Path?: string;
}

export function fakeBBDownExecutableSource(
  bbdownArgumentsPath: string,
): string {
  return [
    "#!/usr/bin/env node",
    'const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");',
    'const path = require("node:path");',
    "const args = process.argv.slice(2);",
    `appendFileSync(${JSON.stringify(bbdownArgumentsPath)}, JSON.stringify(args) + "\\n", { encoding: "utf8" });`,
    "const valueAfter = (flag) => {",
    "  const index = args.indexOf(flag);",
    "  return index >= 0 ? args[index + 1] : undefined;",
    "};",
    'const workDirectory = valueAfter("--work-dir");',
    'const filePattern = valueAfter("--file-pattern");',
    "if (workDirectory && filePattern) {",
    "  mkdirSync(workDirectory, { recursive: true });",
    '  writeFileSync(path.join(workDirectory, `${filePattern}.mp4`), "mediago fake bbdown output\\n", { encoding: "utf8" });',
    "}",
    "",
  ].join("\n");
}

/**
 * Create an isolated Core dependency leaf for the extension E2E.
 *
 * aria2c is copied from the pinned E2E provisioner output. BBDown is a local
 * recorder, so the test proves the Core invokes the correct binary and argv
 * without contacting Bilibili or executing the real downloader.
 */
export async function createFakeBilibiliDependencyLeaf(
  runtimeRoot: string,
  options: FakeBilibiliDependencyOptions = {},
): Promise<FakeBilibiliDependencyLeaf> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      `Fake Bilibili E2E dependencies support only linux-x64; received ${process.platform}-${process.arch}`,
    );
  }

  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const depsDirectory = path.join(resolvedRuntimeRoot, "deps");
  const bbdownArgumentsPath = path.join(
    resolvedRuntimeRoot,
    "bbdown-argv.jsonl",
  );
  const platformKey = platformKeyFor(process.platform, process.arch);
  const provisionedAria2 = path.resolve(
    options.provisionedAria2Path ??
      dependencyExecutablePath(
        resolveDepsRoot(REPOSITORY_ROOT),
        platformKey,
        "aria2",
      ),
  );

  await mkdir(depsDirectory, { recursive: true });
  const isolatedAria2 = path.join(depsDirectory, "aria2c");
  await copyFile(provisionedAria2, isolatedAria2);
  await writeFile(
    path.join(depsDirectory, "BBDown"),
    fakeBBDownExecutableSource(bbdownArgumentsPath),
    { encoding: "utf8", mode: 0o755 },
  );
  await Promise.all([
    // copyFile inherits the source mode on some platforms but not as a
    // portable contract, so set both executable modes explicitly.
    chmod(isolatedAria2, 0o755),
    chmod(path.join(depsDirectory, "BBDown"), 0o755),
  ]);

  return { depsDirectory, bbdownArgumentsPath };
}
