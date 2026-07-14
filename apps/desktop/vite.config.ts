import "vite-plus/test/config";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

import { RENDERER_DEV_PORT } from "./scripts/dev-constants.mjs";

// Launch Electron after a pack only when BOTH hold:
//  1. dev.mjs opted in by injecting VOLLI_DESKTOP_DEV=1 into the pack child's
//     env (it is never exported globally), AND
//  2. this config is being evaluated by `vp pack --watch`: vp's pack-bin.js
//     parses process.argv in the same process that loads this config, so the
//     watch flag is visible here (verified against vite-plus 0.2.4).
// Requiring the watch flag makes the opt-in impossible to satisfy from ambient
// shell env alone — an exported VOLLI_DESKTOP_DEV can no longer make a
// production `vp build && vp pack` attach onSuccess and hang waiting for a
// renderer dev server that isn't running.
const isWatchMode = process.argv.some(
  (arg) => arg === "--watch" || arg === "-w" || arg.startsWith("--watch="),
);
const shouldLaunchElectronAfterPack = process.env.VOLLI_DESKTOP_DEV === "1" && isWatchMode;

// Bundle workspace TS source (`@volli/shared` exports raw .ts) into the CJS
// main/preload artifacts instead of leaving a runtime require() behind.
const bundleWorkspacePackages = (id: string): boolean => id.startsWith("@volli/");

export default defineConfig({
  // Renderer (React) app build. `root` points Vite at the renderer's index.html.
  root: "src/renderer",
  // CRITICAL: assets must be referenced relatively so the built index.html works
  // under file:// in the packaged app. Plain Vite defaults to "/" which 404s.
  base: "./",
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      "@renderer": fileURLToPath(new URL("./src/renderer/src", import.meta.url)),
    },
  },
  server: {
    port: RENDERER_DEV_PORT,
    strictPort: true,
  },
  test: {
    projects: [
      // Inherits root src/renderer, plugins, @renderer alias — existing store
      // tests keep working under the default include.
      { extends: true, test: { name: "renderer" } },
      // NOT extends: main tests need no plugins/alias; fresh entry avoids
      // inheriting root src/renderer. @volli/shared resolves via workspace link.
      {
        root: fileURLToPath(new URL(".", import.meta.url)),
        test: { name: "main", environment: "node", include: ["src/main/**/*.test.ts"] },
      },
    ],
    coverage: {
      // Coverage is global across both test projects; patterns resolve
      // against the top-level root (src/renderer). Main-process sources sit
      // OUTSIDE that root — hence allowExternal and the **/src glob (a
      // literal ../main/ipc.ts pattern silently matches nothing).
      allowExternal: true,
      // The gate covers the logic layer only: stores and extracted pure
      // modules, plus the security-adjacent IPC handlers. View glue (.tsx,
      // hooks, ui/**) is deliberately outside the report — it's exercised by
      // agent-driven UI runs, not unit tests. src/main/index.ts is Electron
      // lifecycle bootstrap: excluded on purpose, never add ../main/**.
      include: [
        "src/stores/**",
        "src/components/board/board-dnd.ts",
        "src/components/sidebar/listing.ts",
        "src/components/ticket/activity.ts",
        "src/lib/project-shortcut.ts",
        "src/lib/new-ticket-shortcut.ts",
        "src/lib/relative-time.ts",
        "src/lib/debounce.ts",
        "src/lib/escape-guard.ts",
        "src/terminal/css-color.ts",
        "src/terminal/appearance-model.ts",
        "src/terminal/option-as-alt.ts",
        "src/terminal/session-lifecycle.ts",
        "**/src/main/ipc.ts",
        "**/src/main/navigation.ts",
        "**/src/main/project-roots.ts",
        "**/src/main/pty.ts",
        "**/src/main/ghostty-config.ts",
      ],
      // Global bar only — vitest applies global thresholds to every included
      // file even when per-glob entries exist, so partial carve-outs can't
      // rescue a global 100; keep everything genuinely at 100 instead.
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
  build: {
    // Absolute — `outDir` otherwise resolves relative to `root` (src/renderer).
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
  },

  // Electron main + preload are packed as CJS with tsdown. ONE config with two
  // entries: object entry keys become the output filenames (main.cjs,
  // preload.cjs), and the single watcher covers both module graphs, so a
  // preload edit re-runs onSuccess (relaunching Electron) just like a main
  // edit. tsdown aborts (tree-kills) the previous onSuccess run before
  // re-running it after every successful rebuild.
  // CAUTION: the preload runs sandboxed (Electron ≥20 default) and cannot
  // require() sibling chunk files — keep the two entries dependency-disjoint
  // so rolldown never splits a shared chunk out of preload.cjs.
  pack: {
    entry: { main: "src/main/index.ts", preload: "src/preload/index.ts" },
    format: "cjs",
    outDir: "dist-electron",
    sourcemap: true,
    outExtensions: () => ({ js: ".cjs" }),
    clean: true,
    deps: {
      alwaysBundle: bundleWorkspacePackages,
    },
    ...(shouldLaunchElectronAfterPack ? { onSuccess: "node scripts/dev-electron.mjs" } : {}),
  },

  run: {
    tasks: {
      dev: { command: "node scripts/dev.mjs", cache: false },
      build: { command: "vp build && vp pack", cache: false },
    },
  },
});
