import { defineConfig } from "tsdown";

export default defineConfig({
  clean: process.env.NODE_ENV === "production",
  fixedExtension: false,
  // ...config options
});
