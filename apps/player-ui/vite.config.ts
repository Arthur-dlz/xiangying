import path from "node:path";
import { createDependencyChunks } from "@mediago/tooling/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  clearScreen: false,
  server: {
    port: 8556,
    strictPort: true,
  },
  envDir: "../../",
  base: "/player/",
  build: {
    rollupOptions: {
      output: {
        manualChunks: createDependencyChunks({
          videojs: ["video.js"],
          vendor: ["react-dom", "react/"],
        }),
      },
    },
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
