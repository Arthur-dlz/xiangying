import { defineConfig } from "tsdown";

const sharedConfig = {
  exports: true,
  platform: "browser" as const,
  outDir: "build",
  outputOptions: {
    codeSplitting: false,
  },
  deps: {
    alwaysBundle: [/.*/],
    dts: {
      neverBundle: ["@mediago/common"],
    },
    onlyBundle: false,
  },
  minify: true,
  sourcemap: true,
};

export default defineConfig([
  {
    ...sharedConfig,
    entry: { index: "src/index.ts" },
  },
  {
    ...sharedConfig,
    entry: { "site-adapters": "src/site-adapters/index.ts" },
  },
  {
    ...sharedConfig,
    entry: {
      "site-adapter-matches": "src/site-adapters/adapter-matches.ts",
    },
  },
]);
