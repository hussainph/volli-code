import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

// Set by scripts/dev.mjs so a production `vp pack` NEVER launches Electron —
// only the watch-mode dev loop opts in.
const shouldLaunchElectronAfterPack = process.env.VOLLI_DESKTOP_DEV === "1";

// Bundle workspace TS source (`@volli/shared` exports raw .ts) into the CJS
// main/preload artifacts instead of leaving a runtime require() behind.
const bundleWorkspacePackages = (id: string): boolean => id.startsWith("@volli/");

export default defineConfig({
  // Renderer (React) app build. `root` points Vite at the renderer's index.html.
  root: "src/renderer",
  // CRITICAL: assets must be referenced relatively so the built index.html works
  // under file:// in the packaged app. Plain Vite defaults to "/" which 404s.
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@renderer": fileURLToPath(new URL("./src/renderer/src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    // Absolute — `outDir` otherwise resolves relative to `root` (src/renderer).
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
  },

  // Electron main + preload are packed as CJS with tsdown. Two configs share the
  // `dist-electron` outDir; object entries key the output filenames (main.cjs,
  // preload.cjs).
  pack: [
    {
      entry: { main: "src/main/index.ts" },
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      // Clean ONLY here — both configs write to the same dir, so cleaning on
      // both would delete each other's output during watch-mode rebuilds.
      clean: true,
      deps: {
        alwaysBundle: bundleWorkspacePackages,
      },
      ...(shouldLaunchElectronAfterPack ? { onSuccess: "node scripts/dev-electron.mjs" } : {}),
    },
    {
      entry: { preload: "src/preload/index.ts" },
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      deps: {
        alwaysBundle: bundleWorkspacePackages,
      },
    },
  ],

  run: {
    tasks: {
      dev: { command: "node scripts/dev.mjs", cache: false },
      build: { command: "vp build && vp pack", cache: false },
    },
  },
});
