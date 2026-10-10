import { crx } from "@crxjs/vite-plugin";
import { mediaGoBuildMetadataPlugin } from "@mediago/tooling/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import manifest from "./manifest.config.ts";

export default defineConfig(({ mode }) => {
  // MediaGo stores brand-level config (APP_NAME, APP_ID, …) in the repo
  // root `.env`. Vite only auto-loads `.env` from the current package
  // dir, so pull the root file explicitly and re-inject the one field
  // the extension needs. Same pattern as apps/electron/tsdown.config.ts
  // (which does `process.env.APP_NAME = ...`) so the custom protocol
  // scheme stays consistent between the Desktop build and the extension.
  const rootEnv = loadEnv(mode, resolve(import.meta.dirname, "../.."), "");

  return {
    resolve: {
      alias: {
        "@": resolve(import.meta.dirname, "src"),
        "@mediago/browser-extension/site-adapter-matches": resolve(
          import.meta.dirname,
          "../browser-extension/src/site-adapters/adapter-matches.ts",
        ),
        "@mediago/browser-extension/site-adapters": resolve(
          import.meta.dirname,
          "../browser-extension/src/site-adapters/index.ts",
        ),
      },
    },
    // Order matters: react first to transform JSX, tailwindcss second to
    // scan the transformed output, crx last so it bundles the result into
    // the extension shape (manifest + web_accessible_resources + SW).
    plugins: [
      mediaGoBuildMetadataPlugin({
        appName: rootEnv.APP_NAME ?? "mediago-community",
      }),
      react(),
      tailwindcss(),
      crx({ manifest }),
    ],
    build: {
      outDir: "dist",
      sourcemap: true,
    },
  };
});
