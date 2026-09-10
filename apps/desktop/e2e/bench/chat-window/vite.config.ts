/**
 * The chat-window bench's own build (VC-338).
 *
 * Separate from the app's config for one reason: the app's build has a single
 * input — `src/renderer/index.html` — and that is deliberate, because it is what
 * keeps the lab and anything else beside it out of `dist/` and out of the
 * packaged bundle. The bench needs to be BUILT to be loaded in Electron, so it
 * gets its own root and its own output, and the app's input list stays untouched.
 *
 * Plain `vite`, not `vite-plus`: nothing here is tested or packed, and the
 * toolchain's pack/test plumbing has no business in a measurement harness.
 */
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // Assets stay relative: the runner serves `dist/` from the filesystem root of
  // a throwaway static server, not from a domain root.
  base: "./",
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      "@renderer": fileURLToPath(new URL("../../../src/renderer/src", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    // The measurement is about the renderer's own cost, so the bundle is built
    // the way the app ships: minified, production React, no dev warnings in the
    // frame budget.
    minify: true,
    sourcemap: false,
  },
});
