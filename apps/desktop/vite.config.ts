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
        "src/chat/activity.ts",
        "src/chat/client.ts",
        "src/chat/compaction-boundary.ts",
        "src/chat/composer-effort.ts",
        "src/chat/composer-picker.ts",
        "src/chat/interaction.ts",
        "src/chat/markdown-source.ts",
        "src/chat/message-projection.ts",
        "src/chat/registry.ts",
        "src/chat/rename.ts",
        "src/chat/session-model.ts",
        "src/chat/transcript.ts",
        "src/chat/wire.ts",
        "src/components/attachments/attachment-model.ts",
        // The drop/paste decision (VC-106) is a pure `.ts` beside the views
        // that spread it, for the same reason as tab-focus.ts: four surfaces
        // share it and its capture-phase subtleties are worth the gate.
        "src/components/attachments/file-drop.ts",
        "src/components/board/board-dnd.ts",
        "src/components/board/board-session-activity.ts",
        // What the board's header says now that it no longer says its own name
        // (VC-55): the count that qualifies itself under a filter, and the live
        // pair that deliberately does not.
        "src/components/board/board-summary.ts",
        "src/components/chat/chat-plane-model.ts",
        // Which drawing an empty chat may offer, per scope (VC-55). A pure
        // `.ts` beside the views precisely so the gate can reach it: the menu
        // a scope offers IS the identity signal, so a scope quietly gaining an
        // option it cannot fill is the failure worth a test.
        "src/components/chat/empty-visual.ts",
        "src/components/board/new-ticket/branch-picker.ts",
        "src/components/board/new-ticket/draft.ts",
        "src/components/board/new-ticket/submit.ts",
        "src/components/harness/trust-prompt-model.ts",
        // Home's tab resolution: which tab is in front AND what the persisted
        // record owes a tab that names nothing on screen (VC-54). The ticket's
        // highest correctness risk, so it is a pure module precisely so the
        // gate can reach it.
        "src/components/home/home-tabs.ts",
        // Home's rail pages and their persisted-value sanitizer (VC-55).
        "src/components/home/home-rail-model.ts",
        "src/components/pages/cli-status-model.ts",
        "src/components/pages/harness-catalog.ts",
        "src/components/pages/model-access-accounts-model.ts",
        "src/components/pages/web-access-model.ts",
        // What the user is TOLD about a launch-wide environment fault — the
        // same class of decision as cli-status-model, enrolled for the same
        // reason (VC-94).
        "src/components/session-environment-alert-model.ts",
        // And what it OFFERS instead, for the state that turned out not to be
        // a fault at all (VC-156): whether a workspace is offered an install,
        // and which command that offer would run.
        "src/components/workspace-dependencies-offer-model.ts",
        "src/components/sessions/terminal-tab-state.ts",
        "src/components/sidebar/active-session-listing.ts",
        "src/components/sidebar/edge-region.ts",
        "src/components/sidebar/listing.ts",
        "src/components/theme/project-appearance-model.ts",
        // Pure `.ts` beside canvas-editor.tsx, in the gate for the same reason
        // as tab-focus.ts: the squiggle's geometry is arithmetic the view
        // renders but never owns.
        "src/components/theme/slider-squiggle.ts",
        "src/components/theme/terminal-settings-model.ts",
        "src/components/ticket/activity.ts",
        "src/components/ticket/clamp-policy.ts",
        "src/components/ticket/label-picker-model.ts",
        "src/components/update/live-work-copy.ts",
        "src/components/ticket/session-history.ts",
        "src/components/ticket/ticket-chat-tab.ts",
        // Pure `.ts` beside a `ui/` primitive: `ui/**` .tsx stays outside the
        // report as view glue, but the roving-tabindex arithmetic left a
        // component file precisely so the gate could reach it.
        "src/components/ui/tab-focus.ts",
        // The mouse-wheel decision stays pure for the same reason: the
        // component installs the listener, but this module owns when it may
        // remap the gesture into horizontal travel.
        "src/components/ui/tab-scroll.ts",
        // Same shape: the wheel-detach decision for the conversation (VC-32)
        // is a pure `.ts` beside `ui/ai-elements/conversation.tsx` so the
        // gate can reach it; the `.tsx` glue that calls it stays outside.
        "src/components/ui/ai-elements/scroll-chaining.ts",
        "src/lib/boundary-timer.ts",
        // Where a chat-named path opens (VC-120): the raw-tool-path translation
        // both transcript surfaces trust before touching any store or IPC.
        "src/lib/chat-open-target.ts",
        "src/lib/project-shortcut.ts",
        "src/lib/new-session-shortcut.ts",
        "src/lib/new-ticket-shortcut.ts",
        // Which rail ⌥⌘B is talking about (VC-55) — the same chrome-predicate
        // shape as its two neighbours here, and gated for the same reason: it
        // decides whether a keystroke may write a PERSISTED preference.
        "src/lib/rail-toggle.ts",
        "src/lib/relative-time.ts",
        "src/lib/terminal-focus.ts",
        "src/lib/debounce.ts",
        "src/lib/escape-guard.ts",
        "src/lib/session-rpc-ipc-link.ts",
        "src/editor/autosave-plan.ts",
        "src/editor/document-decorations.ts",
        "src/editor/document-identity.ts",
        "src/editor/document-mode.ts",
        "src/editor/document-registry.ts",
        "src/editor/emphasis-wrap.ts",
        "src/editor/file-refs.ts",
        "src/editor/link-open.ts",
        "src/editor/markdown-projection.ts",
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
        "**/src/main/blob-attach.ts",
        "**/src/main/blob-collect.ts",
        "**/src/main/blob-protocol.ts",
        "**/src/main/turn-attachments.ts",
        "**/src/main/ipc.ts",
        "**/src/main/ipc-descriptors.ts",
        "**/src/main/ipc-registry.ts",
        "**/src/main/navigation.ts",
        "**/src/main/project-roots.ts",
        "**/src/main/prompt-templates.ts",
        "**/src/main/pty.ts",
        "**/src/main/park.ts",
        "**/src/main/quit-gate.ts",
        "**/src/main/update-ipc.ts",
        "**/src/main/shutdown-deadline.ts",
        "**/src/main/fs-deps.ts",
        "**/src/main/auto-update.ts",
        "**/src/main/ghostty-config.ts",
        "**/src/main/harness-ipc.ts",
        "**/src/main/session-runtime/boot-recovery.ts",
        "**/src/main/window-theme.ts",
        "**/src/main/theme-ipc.ts",
        "**/src/main/theme-overlay.ts",
        "**/src/main/db/export.ts",
        "**/src/main/db/theme-repo.ts",
        "**/src/main/session-rpc-ipc.ts",
        "**/src/main/session-runtime/sessions.ts",
        "**/src/main/session-control/activity-watch.ts",
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
      // `electron` lives in devDependencies (electron-builder refuses to
      // package otherwise), which tsdown would bundle by default — inlining
      // the npm package's binary-path shim over the runtime-provided module.
      // The real `electron` API only exists as a require() left for Electron
      // itself to resolve.
      //
      // jsdom is unbundleable: its computed-style helper, css-tree's data
      // module, and the sync-XHR worker all read files relative to their own
      // package layout at MODULE LOAD (`__dirname`-relative stylesheet,
      // `require("mdn-data/css/*.json")`, `require.resolve("./xhr-sync-
      // worker.js")` + that worker's own `require("../../../..")`). Bundled
      // into main.cjs every one of those resolves against dist-electron/ and
      // the app crashed at boot. It must stay a runtime require() of the real
      // package — the same treatment electron gets — which is why apps/desktop
      // declares it directly and electron-builder.yml whitelists its tree.
      neverBundle: ["electron", "jsdom"],
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
          "vp run --filter @volli/cli build && vp build && node scripts/verify-chat-css.mjs && vp pack && node scripts/copy-cli.mjs && node scripts/verify-packed-requires.mjs",
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
