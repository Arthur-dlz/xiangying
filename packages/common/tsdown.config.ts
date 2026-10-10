import { defineConfig } from "tsdown";

export default defineConfig({
  clean: process.env.NODE_ENV === "production",
  exports: true,
  outDir: "build",
  platform: "neutral",
});
