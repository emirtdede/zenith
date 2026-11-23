/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri drives the dev server on a fixed port and expects it to fail loudly if
// the port is taken, rather than silently moving to another one.
export default defineConfig({
  plugins: [react()],
  // The reducer is pure, so it needs no DOM; render tests opt into jsdom with a
  // `@vitest-environment jsdom` docblock. `node` stays the default so the
  // reducer suite keeps its speed.
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**"] },
  },
  build: {
    target: "chrome110",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
