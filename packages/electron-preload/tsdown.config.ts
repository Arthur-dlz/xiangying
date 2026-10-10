import { defineConfig } from "tsdown";

export default defineConfig({
  exports: true,
  platform: "browser",
  define: {
    "process.env.NODE_ENV": JSON.stringify(
      process.env.NODE_ENV || "production",
    ),
    // The Xiangying build keeps this scheme even when invoked outside Task.
    "process.env.APP_NAME": JSON.stringify(process.env.APP_NAME || "xiangying"),
  },
  outDir: "build",
  format: "cjs",
  deps: {
    alwaysBundle: [/.*/],
    onlyBundle: false,
    neverBundle: ["electron"],
  },
  minify: true,
  sourcemap: true,
});
