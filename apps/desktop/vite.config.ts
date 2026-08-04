import "vite-plus/test/config";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import type { Plugin, ViteDevServer } from "vite";
import { defineConfig } from "vite-plus";

import { LAB_SESSION_RPC_PATH } from "./src/lab-session-rpc-path";
import { RENDERER_DEV_PORT } from "./scripts/dev-constants.mjs";

const labSessionRpcModule = fileURLToPath(
  new URL("./src/main/lab/session-rpc.ts", import.meta.url),
);

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

export default defineConfig(({ mode }) => ({
  // Renderer (React) app build. `root` points Vite at the renderer's index.html.
  root: "src/renderer",
  // THE LAB GETS ITS OWN DEP CACHE. Everything rooted at apps/desktop defaults
  // to node_modules/.vite — the app dev server (which `pnpm lab` is explicitly
  // built to run ALONGSIDE) and vitest included. Vite's optimizer publishes a
  // run by deleting `deps/` and renaming `deps_temp/` over it, so a second
  // process bundling deps swaps that directory out from under a live lab page.
  //
  // Statically imported deps survive it: they are already in the browser's
  // module registry and are never re-fetched. What does not survive is anything
  // fetched LAZILY. Streamdown's syntax highlighter is exactly that — a
  // dynamic-entry chunk (`highlighted-body-<hash>.js`) requested the first time
  // a fenced code block renders, which can be hours after the page loaded. It
  // comes back 504 `Outdated Optimize Dep` (the same code Vite uses when the
  // file is simply gone), the import rejects, and the throw lands in render.
  // A separate directory means no other process can invalidate the lab's deps.
  ...(mode === "lab"
    ? { cacheDir: fileURLToPath(new URL("./node_modules/.vite-lab", import.meta.url)) }
    : {}),
  // CRITICAL: assets stay relative so the built index and worker chunks resolve
  // beneath volli-app://bundle/ in packaged builds. Plain Vite defaults to "/".
  base: "./",
  plugins: [tailwindcss(), react(), ...(mode === "lab" ? [labSessionRpcPlugin()] : [])],
  resolve: {
    alias: {
      "@ai-elements": fileURLToPath(new URL("./src/components/ai-elements", import.meta.url)),
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
        "src/components/board/new-ticket/draft.ts",
        "src/components/board/new-ticket/submit.ts",
        "src/components/harness/trust-prompt-model.ts",
        "src/components/sidebar/active-session-listing.ts",
        "src/components/sidebar/listing.ts",
        "src/components/theme/editor-settings-model.ts",
        "src/components/theme/project-appearance-model.ts",
        "src/components/theme/terminal-settings-model.ts",
        "src/components/ticket/activity.ts",
        "src/components/ticket/session-history.ts",
        "src/lib/project-shortcut.ts",
        "src/lib/new-ticket-shortcut.ts",
        "src/lib/relative-time.ts",
        "src/lib/debounce.ts",
        "src/lib/escape-guard.ts",
        "src/editor/autosave-plan.ts",
        "src/editor/document-decorations.ts",
        "src/editor/document-identity.ts",
        "src/editor/document-mode.ts",
        "src/editor/document-registry.ts",
        "src/editor/emphasis-wrap.ts",
        "src/editor/file-refs.ts",
        "src/editor/link-open.ts",
        "src/editor/markdown-projection.ts",
        "src/editor/editor-theme-catalog.ts",
        "src/editor/monaco-runtime.ts",
        "src/editor/monaco-theme.ts",
        "src/editor/reveal.ts",
        "src/editor/shiki-langs.ts",
        "src/editor/shiki-monaco.ts",
        "src/editor/text-position.ts",
        "src/theme/apply.ts",
        "src/theme/canvas-paint.ts",
        "src/theme/scope-transition.ts",
        "src/terminal/css-color.ts",
        "src/terminal/appearance.ts",
        "src/terminal/engine.ts",
        "src/terminal/gpu-pressure-model.ts",
        "src/terminal/appearance-model.ts",
        "src/terminal/local-fonts.ts",
        "src/terminal/option-as-alt.ts",
        "src/terminal/session-lifecycle.ts",
        "**/src/main/ipc.ts",
        "**/src/main/ipc-registry.ts",
        "**/src/main/navigation.ts",
        "**/src/main/project-roots.ts",
        "**/src/main/pty.ts",
        "**/src/main/park.ts",
        "**/src/main/fs-deps.ts",
        "**/src/main/ghostty-config.ts",
        "**/src/main/harness-ipc.ts",
        "**/src/main/window-theme.ts",
        "**/src/main/theme-ipc.ts",
        "**/src/main/theme-overlay.ts",
        "**/src/main/db/export.ts",
        "**/src/main/db/theme-repo.ts",
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
    // STATIC ASSETS (established with the grain tile; PR 5's curated canvas
    // images inherit this). Every asset is imported through the module graph
    // from src/renderer/src/assets/ — NEVER a public/ directory: public assets
    // are referenced by a root-absolute /path, and this renderer is served
    // from volli-app://bundle/ with `base: "./"`, so a root-absolute URL is
    // exactly the class of thing that works in dev and 404s once packaged.
    // Module-graph imports get content-hashed, relative URLs instead.
    //
    // assetsInlineLimit 0 makes every asset a real emitted file rather than a
    // base64 data: URI. Vite would otherwise inline anything under 4 KB, which
    // (a) puts the boundary between "works packaged" and "silently bypasses
    // the app protocol" on the FILE SIZE, so the packaged path stops being
    // exercised by small assets, and (b) costs ~33% in base64 expansion inside
    // a JS chunk that is parsed on every boot.
    assetsInlineLimit: 0,
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
      dev: {
        command: "vp run --filter @volli/cli build && node scripts/dev.mjs",
        cache: false,
      },
      build: {
        command:
          "vp run --filter @volli/cli build && vp build && node scripts/verify-chat-css.mjs && vp pack && node scripts/copy-cli.mjs",
        cache: false,
      },
      // The UI lab (src/renderer/lab) — the renderer dev server alone, no
      // Electron, no main/preload watcher. Its own port so it can run
      // ALONGSIDE `pnpm dev`; `strictPort` above still applies, so a clash
      // fails loudly instead of silently landing somewhere else.
      lab: {
        command: "vp dev --mode lab --port 5174 --open /lab/",
        cache: false,
      },
    },
  },
}));

function labSessionRpcPlugin(): Plugin {
  return {
    name: "volli:lab-session-rpc",
    configureServer(server: ViteDevServer) {
      let lab: Promise<
        InstanceType<typeof import("./src/main/lab/session-rpc").LabSessionRpcServer>
      > | null = null;
      let labInstance: InstanceType<
        typeof import("./src/main/lab/session-rpc").LabSessionRpcServer
      > | null = null;
      const getLab = (): Promise<
        InstanceType<typeof import("./src/main/lab/session-rpc").LabSessionRpcServer>
      > => {
        let pending = lab;
        if (pending === null) {
          pending = server.ssrLoadModule(labSessionRpcModule).then(({ LabSessionRpcServer }) => {
            const instance = new LabSessionRpcServer();
            labInstance = instance;
            return instance;
          });
          lab = pending;
        }
        return pending;
      };
      server.middlewares.use(LAB_SESSION_RPC_PATH, (req, res) => {
        void getLab().then(
          (instance) => instance.handle(req, res),
          (error: unknown) => {
            res.statusCode = 500;
            res.end(error instanceof Error ? error.message : "Lab Session RPC failed to load");
          },
        );
      });
      const terminationSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
      const terminationHandlers = new Map<NodeJS.Signals, () => void>();
      const close = () => {
        for (const [signal, handler] of terminationHandlers) process.off(signal, handler);
        // Vite does not await an HTTP `close` listener. Reap the already-loaded
        // backend synchronously before its process can finish handling SIGINT.
        if (labInstance) {
          labInstance.emergencyClose();
        } else if (lab) {
          void lab.then(
            (instance) => instance.emergencyClose(),
            () => undefined,
          );
        }
      };
      const terminate = (signal: NodeJS.Signals) => {
        close();
        process.kill(process.pid, signal);
      };
      for (const signal of terminationSignals) {
        const handler = () => terminate(signal);
        terminationHandlers.set(signal, handler);
        process.once(signal, handler);
      }
      server.httpServer?.once("close", close);
    },
  };
}
