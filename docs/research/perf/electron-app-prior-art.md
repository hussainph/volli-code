# Electron app performance prior art — research notes

Read-only research for Volli Code (Electron + React 19 + TS + Zustand 5; main hosts
better-sqlite3 WAL, node-pty, agent runtime; typed contextBridge preload; tRPC Session
RPC over `ipcMain.handle`). Nothing here was implemented; verdicts on current Volli
state were checked with `rg` against `apps/desktop/src` on 2026-09-13.

Two fetches failed and are **not** cited for content (see "Unread" under Sources):
`slack.engineering` direct (fetch policy refused its resolved address — archive.org
copies were read instead) and the VS Code process-sandboxing blog
(`code.visualstudio.com` timed out).

---

## Top findings

Each item: technique · who published it · URL · claimed effect · Volli verdict.

### Startup / cold launch

1. **Bundle each process into one file; `require()` is the #1 startup bottleneck.**
   `require()` is synchronous, recursive, and blocks main *and* renderer before first
   paint. Atom's startup was "deadlocked in node.js execution before the initial paint
   … ever fired" (Sam Saccone, Google, on `atom/atom#9720`); the fix direction was one
   bundled file per process.
   https://palette.dev/blog/improving-performance-of-electron-apps ·
   https://www.electronjs.org/docs/latest/tutorial/performance (§7 "Bundle your code")
   Claimed: bundling saved VS Code ~400 ms of load; consultant reports 10 s → 3 s
   startups from route-splitting work.
   **Verdict: VOLLI ALREADY DOES IT** — main + preload are single-file vite bundles
   (`apps/desktop/vite.config.ts`, `outputOptions: { codeSplitting: false }`,
   `dist-electron/main.cjs`); renderer is a vite bundle.

2. **V8 code cache for the loader/bundle (skip re-parse on warm start).**
   VS Code's AMD loader integrates V8 cached data; net effect cited in the
   CovalenceConf 2019 "The First Second" writeup: JS bundle load **1.5 s → 0.5 s**
   (~400 ms each from bundling, compression, and code cache). For most apps the
   writeup prescribes `import 'v8-compile-cache'` at the entry point.
   https://www.besthub.dev/articles/how-vs-code-achieves-lightning-fast-startup-front-end-performance-secrets-b2e0186619bf
   (secondary summary of the Johannes Rieken talk; primary video linked therein)
   **Verdict: NOT DONE** — `rg` finds no `v8-compile-cache`, `getCodeCachePath`, or
   snapshot-blob usage. Cheapest startup bet in this file (§"Probably applicable" #1).

3. **V8 startup snapshots (`mksnapshot` + pre-initialized heap).**
   Atom: "almost 50% faster" stock-install load, snapshots "a crucial tool";
   VS Code has snapshotted since 2017 (`build/lib/snapshotLoader.ts`); mechanics are
   `electron-link` → `mksnapshot` → `--snapshot-blob`. Constraints: no dynamic values
   (`Date.now`, `Math.random`), no I/O in snapshotted code; best for framework
   bootstrap. The open VS Code tracking issue scopes it as code-loading *plus*
   static-state init.
   https://palette.dev/blog/improving-performance-of-electron-apps (§4) ·
   https://github.com/microsoft/vscode/issues/28492 · https://v8.dev/blog/custom-startup-snapshots (linked, not re-read)
   Claimed: ~50% Atom load improvement.
   **Verdict: NOT DONE — deliberately deferred, see "Rejected" #1.**

4. **Lifecycle phases: render-first, `requestIdleCallback` for the rest.**
   VS Code splits startup into `Starting → Ready → Restored → Eventually` phases so
   explorer + editor paint before everything else, and pushes non-critical work to
   `requestIdleCallback` ("Idle Until Urgent"); perceived-performance tricks on top
   (tab switch on `mousedown` not `click` saves ~50 ms; render tab + breadcrumb first
   for big files).
   https://www.besthub.dev/articles/how-vs-code-achieves-lightning-fast-startup-front-end-performance-secrets-b2e0186619bf
   **Verdict: PARTIAL** — main already defers retention/autoReap/repack/workspace-scan
   to `did-finish-load` (`apps/desktop/src/main/index.ts` ~L2974–3030); renderer has
   dynamic shiki langs + `React.lazy` markdown boundary. But `rg` finds **zero**
   `requestIdleCallback` uses and no formal lifecycle phases. Applicable (#2).

5. **Pre-warmed startup: boot from the local DB, never the network.**
   Linear's Sync Engine keeps a local copy so repeat launch is instant (described via
   https://johnnyle.io/read/electron-performance, "pre-warmed startup" —
   IndexedDB/SQLite/electron-store; optimistic updates as the interaction twin).
   PowerSync's Electron writeup makes the same point: local SQLite kills the
   "Electron bloat" perception because data is already there.
   https://powersync.com/blog/speeding-up-electron-apps-with-powersync
   **Verdict: ALREADY DOES IT** — renderer boots from one full SQLite snapshot read
   through the preload (`api.*` bootstrap; `src/preload/index.ts:394`), and the
   light/dark first-paint hint is stamped via `additionalArguments` at window
   construction precisely to avoid an `invoke()` round trip before first frame
   (`src/main/index.ts:572-594`, `src/main/window-theme.ts`).

6. **Route-based code splitting; keep the boot core tiny.**
   Discord boots ~700 KB of JS/fonts/CSS ("about the size of Google's minimal
   homepage") and loads everything else per-route via webpack chunks, with a custom
   `makeLazy` loader that retries with backoff; 27 locales at ~30 KB each stay
   unloaded (~1 MB saved). 3perf's Notion teardown independently measured **39% of
   vendor / 61% of app unused after first render** — the canonical "you execute 1100
   modules to show a spinner" result.
   https://discord.com/blog/how-discord-maintains-performance-while-adding-features ·
   https://3perf.com/blog/notion/
   **Verdict: PARTIAL** — renderer lazy-loads shiki languages (`editor/shiki-langs.ts`
   dynamic imports), Streamdown highlighting (`React.lazy`, `markdown-boundary.tsx`),
   and monaco workers (`?worker` imports), but no route/view-level splitting was found.
   Applicable (#3).

7. **Audit bundle duplicates + drop polyfills; Electron owns its Chromium.**
   3perf found `core-js` bundled **3×** (two versions × two modes), `moment` with all
   locales (227 KB), and full `lodash` in Notion's vendor bundle; fixes:
   `moment-locales-webpack-plugin`/`date-fns`, `babel-plugin-lodash`,
   `resolve.alias` dedup, differential polyfill serving. Electron doc: pin TS/browsers
   to the shipped Chromium, never ship `regenerator-runtime`/jQuery-era shims.
   https://3perf.com/blog/notion/ ·
   https://www.electronjs.org/docs/latest/tutorial/performance (§5)
   **Verdict: LIKELY FINE, UNVERIFIED** — root `tsconfig.base.json` targets `ESNext`
   (no downlevel helpers from TS), but no duplicate-dependency audit
   (`source-map-explorer` / `yarn why core-js` equivalent) was found. Applicable (#4).

### Memory

8. **Consolidate processes instead of one full client per context.**
   Slack's legacy app ran a standalone web client in a separate Electron process *per
   workspace*; the rebuild put all workspaces in one process with one Redux store
   each (data + connectivity + websocket per store). Motivation data: one team cost
   **~130 MB (p10) – ~960 MB (p99)**.
   https://web.archive.org/web/20241225143945/https://slack.engineering/rebuilding-slack-on-the-desktop/
   **Verdict: ALREADY CONSOLIDATED** — single main window; the only second window is
   the session-cursor overlay on its own partition with a five-verb preload
   (`src/main/index.ts` ~L2749–2824), not a second app copy.

9. **Discard background views; a thin client keeps badges alive.**
   Slack's interim fix was a ~1200-line "tiny client" swapped in for backgrounded
   teams (unreads/badges/notifications only, server computes counts via a
   `has_unreads`/`mention_count` endpoint + `desktop_notification` websocket type),
   explicitly modeled on Chrome tab discarding; the follow-ups were incomplete models,
   subscription-based presence, and the shared-context rebuild.
   https://web.archive.org/web/20241231015146/https://slack.engineering/reducing-slacks-memory-footprint/
   **Verdict: ANALOGUE EXISTS** — Volli is single-window so there is nothing to
   discard, but the same instinct lives in `src/main/pty/park-controller.ts` (park
   idle PTYs) + `autoReap` + retention deferred past first paint. Applicable (#5)
   only if a second full window ever ships.

10. **Leave `backgroundThrottling` on; it exists for always-open apps.**
    Hidden/occluded windows get timer + compositing throttling by default; Volli
    disables it *only* for `VOLLI_QUIET_WINDOWS` smoke windows that must paint while
    covered.
    https://www.electronjs.org/docs/latest/tutorial/performance (background work) ·
    Volli: `src/main/quiet-windows.ts` (`backgroundThrottling: !enabled`)
    **Verdict: ALREADY DOES IT.**

11. **React leak hygiene for long-lived sessions: never hold DOM/Fiber across unmount.**
    Discord's 16.7→16.8 leak hunt (channel-switch mount/unmount cycles retaining Fiber
    nodes + detached DOM): don't put DOM nodes/React instances in props/state (use
    refs), fix even small leaks because Fiber `nextEffect` chains cascade them, wrap
    leaking `<video>` elements (Chromium bug 969049 at the time), and replace
    `react-async-component` with `React.lazy` (it re-rendered all nested children).
    https://discord.com/blog/investigating-discords-react-memory-leak
    **Verdict: PATTERN-LEVEL, NOT AUDITED** — no `React.lazy`-abuse found, but no
    evidence of a mount/unmount retention audit either (Volli sessions/terminals are
    deliberately never unmounted incidentally, which *hides* this class until a real
    teardown path runs). Applicable (#6).

### Main-thread contention

12. **Treat `async` as "yields on I/O", not "doesn't block": move CPU work off-thread.**
    Electron doc: worker threads → BrowserWindow → dedicated process, in that order;
    never sync IPC (`@electron/remote`); always async `fs`/`child_process` variants.
    Johnny Le's field version: `await` on a 1e9-loop still blocks; cleanup listeners/
    IPC/sockets/db handles because desktop apps never close ("imagine your app never
    closes"); `requestIdleCallback` + slow-down-when-unfocused for recurring tasks.
    https://www.electronjs.org/docs/latest/tutorial/performance (§3–§4) ·
    https://johnnyle.io/read/electron-performance
    **Verdict: MOSTLY DONE BY CONSTRUCTION** — main owns windows + SQLite + PTY hosts;
    heavy git/worktree exec is async child processes; but **better-sqlite3 calls are
    synchronous on main by design** (see #13). No `nodeIntegrationInWorker` /
    Web-Worker compute pool found.

13. **`utilityProcess` is the supported home for CPU-heavy / crash-prone Node work,
    with `MessagePort` channels to any renderer.**
    Electron's process-model doc positions `utilityProcess.fork` as the replacement
    for both `child_process.fork`-from-main and hidden-`BrowserWindow` workers, with
    `serviceName` (visible in `app.getAppMetrics` / `child-process-gone`), stdio pipe
    options, and per-process `session` partitions.
    https://www.electronjs.org/docs/latest/tutorial/process-model ·
    https://www.electronjs.org/docs/latest/api/utility-process
    **Verdict: NOT USED** — `rg` finds no `utilityProcess`, `MessagePortMain`, or
    `worker_threads` in `src/`. Top structural candidate for the agent-runtime /
    embeddings / bulk-git future (applicable #7).

14. **Keep the fast SQLite topology: native driver in main beats WASM-in-renderer.**
    PowerSync benchmarks `better-sqlite3`-in-Node vs `wa-sqlite`-in-Chromium on the
    same workloads: Node wins **1.2×–5.5×** (5.47× on 1000 INSERTs, 3.37× on
    delete+many-inserts) because SQLite (C, sync filesystem) fits Node and fights the
    browser's virtual FS. Their conclusion maps 1:1 onto Volli: main-process native
    SQLite + hand-rolled async IPC hooks is the performance-max choice; renderer-side
    WASM is the portability/simplicity choice.
    https://powersync.com/blog/speeding-up-electron-apps-with-powersync
    **Verdict: ALREADY THE FAST TOPOLOGY** — main-owned `better-sqlite3` WAL. The
    corollary debt: every query runs on the UI thread's process, so the budget rule
    is *short transactions, indexed reads* or move the heavy ones out (#13).

15. **Push hot paths to native/WASM; pair web UI with native code.**
    Palette cites the fleet: Notion → SQLite-to-WASM, Figma → full WASM, Signal →
    WASM crypto, 1Password → native Node modules for encryption. Rieseberg's general
    form: "the entire point of Electron is that you can pair your web app with any
    native code" (C++/Rust/ObjC), including native UI for hot surfaces; he also notes
    no published benchmark shows OS WebViews beating bundled Chromium, so the
    renderer budget is spent on *code*, not the engine swap.
    https://palette.dev/blog/improving-performance-of-electron-apps (§3) ·
    https://felixrieseberg.com/things-people-get-wrong-about-electron/
    **Verdict: ALREADY DOES IT where it counts** — `better-sqlite3` + `node-pty`
    native modules in main; `restty` (ghostty-derived **WebGPU** renderer) keeps
    terminal compositing on the GPU instead of the renderer main thread.

### IPC

16. **Measured IPC costs (electron-bench, Electron 43 / Chromium 150, 10k msgs):
    latency is flat (~1 ms everywhere), main-process CPU differs 20×+.**
    `invoke` p50 0.4 ms but **1672 ms** main CPU; `send` p50 0.7 ms / 1062 ms;
    `sendSync` p50 0.2 ms but **1281 ms** CPU *and it blocks the renderer*;
    main-relayed renderer↔renderer 2015 ms; direct `MessagePort` 375 ms;
    `utilityProcess` channel **140 ms**; `sandbox:true` + `contextBridge` costs only
    +0.1 ms vs unsandboxed preload (not a reason to disable the sandbox).
    https://github.com/ZacWalk/electron-bench ·
    https://github.com/ZacWalk/electron-bench/blob/master/best-practices.md
    **Verdict: SHAPE MATCHES VOLLI'S DESIGN** — no `sendSync` in IPC paths (the one
    mention is a preload comment explaining why it was *avoided*,
    `src/preload/index.ts:278`); control plane on `ipcMain.handle`
    (`src/main/session-rpc-ipc.ts:163`); sandbox+bridge already on
    (`src/main/index.ts:585-594`) at ~zero measured cost. The hot-path rule this
    implies: keep high-frequency traffic on `send`, never `invoke`/`sendSync`
    (applicable #8).

17. **Reply-stream pattern: one `MessageChannel` per subscription beats
    request-per-event through main.**
    Electron's MessagePorts doc shows the exact pattern — renderer creates a channel,
    posts one end with the request, main streams replies and `close()`s at end —
    plus main→main-world delivery for context-isolated pages and worker-window
    channels that bypass main after setup.
    https://www.electronjs.org/docs/latest/tutorial/message-ports ·
    https://www.electronjs.org/docs/latest/tutorial/ipc (Patterns 2–4; `sendSync` explicitly discouraged)
    **Verdict: NOT USED, DIRECTLY APPLICABLE** — `session.subscribe` currently pumps
    each event via `webContents.send` from `pumpSubscription`
    (`src/main/session-rpc-ipc.ts` ~L215–260). A per-subscription port is the
    documented lower-main-CPU shape (#8).

18. **Payload size swamps transport choice; shape matters too.**
    Same bench: 1 KB JSON 0.2 ms → 64 KB 1.5 ms → **1 MB 21.5 ms p50** on the same
    route (~100×); deeply-nested costs more than flat at equal bytes (structured
    clone walks the graph); 1 MB `ArrayBuffer` by transfer 3.2 ms vs 4.1 ms copied
    (gap widens with size). Rules: filter sender-side, compute on recipient,
    transfer — don't clone — binary.
    https://github.com/ZacWalk/electron-bench/blob/master/best-practices.md
    **Verdict: PARTIAL / WATCH ITEM** — `broadcast.ts` fans out **whole snapshots**
    (`broadcastDataChanged` re-hydrates every window from SQLite per mutation) and
    channels like `volli:venue-snapshot` move large payloads; the PTY path already
    coalesces. Applicable (#9).

19. **Batch, coalesce, and pace: one summary call beats N per-entity calls.**
    Slack replaced per-channel `channels.history` (N API calls + N channel-list
    redraws + layout thrash) with one `users.counts` call, a 42-message page, and
    frecency-ordered prefetch: **10% load improvement overall, 65% on stress teams**,
    major GC pushed from ~13 s to ~33 s. Electron-bench's twin rule: batch, and
    *pace* bursts — flooding the queue chokes it.
    https://web.archive.org/web/20250123224802/https://slack.engineering/making-slack-faster-by-being-lazy/
    **Verdict: DONE FOR PTY, OPEN FOR DATA** — `src/main/pty/output.ts` coalesces
    sub-KiB chunks into frame-window batches with ack-based flow control
    (`pause`/`resume`) — the highest-frequency channel is already engineered. But
    `broadcastDataChanged` fires per mutation with no coalescing window, and
    `broadcastSessionActivity` has the same shape. Applicable (#9).

### Background CPU with heavy children / never-closing apps

20. **Instrument production: perf marks per release + input latency + prod profiling.**
    VS Code ships a `Startup Performance` command, a perf-marks inventory, and
    per-release input-latency tracking; Slack compiles in a perf-utils surface
    (`timeToPageLoad`, `getCPUUsage`/`getMemoryUsage`/`getAppMetrics`, trace
    record); Notion (via Palette prod JS profiling) cut page-load 15–20 %, typing
    latency 15 %, root-caused 60% of regressions, and caught a lazy-load bundle
    regression ("a bunch of code that was supposed to be lazy loaded … stuck out
    like a sore thumb in the flamegraph").
    https://palette.dev/blog/improving-performance-of-electron-apps (§5–§6) ·
    https://www.electronjs.org/docs/latest/tutorial/performance ("Measure, Measure, Measure")
    **Verdict: NOT DONE** — `rg` finds no `performance.mark`, `contentTracing`,
    `app.getAppMetrics`, or input-latency tracking in `src/`; diagnostics exist
    (`labDiagnostics`, `RpcDiagnosticLog`) but no startup timeline or prod RUM.
    Applicable (#10).

21. **Defer plugin/package work to idle; measure per-package activation.**
    Obsidian (an Electron local-first app) loads all plugins before interactive and
    therefore tells authors: production builds, trivial `onload` (registrations
    only), view constructors that assume reopened workspaces, and
    `onLayoutReady`-gated event subscriptions; it ships a built-in per-plugin
    startup-time debugger (Settings → General → Advanced → stopwatch).
    https://github.com/obsidianmd/obsidian-developer-docs/blob/31946e5a/en/Plugins/Guides/Optimize%20plugin%20load%20time.md
    **Verdict: ANALOGY, MOSTLY TRANSFERABLE AS PROCESS** — Volli has no plugin
    system, but the equivalents (first-paint hint read, theme stamp, migration
    carry/drop/defer in `index.ts` ~L917–989) deserve the same per-stage timing the
    Obsidian stopwatch gives. Folds into #10.

---

## Probably applicable to Volli

Concrete, ordered by expected value. File pointers are starting points, not specs.

1. **Add `v8-compile-cache` (or Electron's code-cache path) at main + preload entry.**
   Finding #2; VS Code precedent ~400 ms. One-line-ish change, near-zero risk; measure
   cold vs warm start before/after. Touches `apps/desktop/vite.config.ts` bundle
   entries / `src/main/index.ts` top.
2. **Adopt `requestIdleCallback` (with timeout) for deferred renderer work.**
   Finding #4. Candidates: theme-token regeneration after canvas change, non-visible
   panel hydration, analytics/diagnostics flush. Zero usages today; the main-side
   `did-finish-load` deferral pattern (`src/main/index.ts` ~L2974–3030) is the model
   to mirror in the renderer.
3. **Route/view-level code splitting for heavy surfaces.**
   Finding #6. `React.lazy` precedent exists (`components/chat/markdown-boundary.tsx`);
   candidates are the monaco editor stack (`renderer/src/editor/monaco-runtime.ts`),
   session detail dialogs, and settings — measure what fraction of the boot bundle
   they are first (finding #7's audit covers this).
4. **One-off bundle audit: duplicates + weight.**
   Finding #7. Run a source-map/duplicate analysis on the renderer bundle and a
   `node --cpu-prof --heap-prof -e "require(...)"`-style load profile of the main
   bundle (Electron doc §1 recipe); dedupe via aliasing, cherry-pick `lodash`-style
   deep imports, confirm no polyfill payload against the shipped Chromium.
5. **Coalesce data broadcasts; consider deltas for the largest snapshots.**
   Findings #18–19. `src/main/broadcast.ts` (`broadcastDataChanged`,
   `broadcastSessionActivity`) fires per mutation and ships whole snapshots; add a
   frame-window coalescer like `src/main/pty/output.ts` already has, keep the
   `ticketId` scoping it already carries so renderers can skip unaffected
   re-hydration, and evaluate incremental vs full payloads for `venue-snapshot`-scale
   channels. Sender-side filtering per the bench rules.
6. **Move the subscription stream onto a per-subscription `MessagePort`.**
   Finding #17. `pumpSubscription` in `src/main/session-rpc-ipc.ts` is the textbook
   reply-stream case from the MessagePorts doc; main CPU per event should drop
   toward the bench's direct-channel row. Keeps the BOUNDARIES.md shape (command →
   event → projection; IPC stays dumb transport) — only the pipe changes.
7. **Prototype a `utilityProcess` host for the next heavy/crash-prone main resident.**
   Finding #13. Do not migrate SQLite (finding #14 says the sync native driver in
   main is the fast topology); candidates are model-access/embedding work
   (`agent-dispatch/app-verbs.ts` model snapshot), bulk worktree/git scans, or Pi
   accessory computation. Gives `serviceName` visibility in `app.getAppMetrics` for
   free.
8. **Keep `invoke` for control plane, `send` for hot paths — write it down.**
   Finding #16. Current split already matches the bench (batched `send` for PTY
   output, `handle` for RPC), but it is convention, not rule. A one-paragraph note
   in `docs/BOUNDARIES.md` ("high-frequency main→renderer traffic uses `send`/ports,
   never `invoke`/`sendSync`") prevents the regression the bench warns about.
9. **Short-transaction discipline for better-sqlite3 on main.**
   Finding #14. No evidence of a problem today, but every query blocks the process
   that owns every window. Worth a budget line in review: indexed reads, bounded
   transactions, and the #7 escape hatch named before it is needed.
10. **Startup timeline + input-latency telemetry (dev first, prod later).**
    Finding #20 (+#21). Add `performance.mark` milestones from `app.whenReady` to
    interactive (`src/main/index.ts`, `lib/boot.ts`), a `--prof-startup`-style smoke
    flag, and a dev-only timing view before any RUM. This is also the measurement
    precondition for #1–#5.

## Considered and rejected for Volli

- **V8 snapshots (`mksnapshot`/`electron-link`).** Rejected for now: build fragility
  (snapshot must contain no dynamic values/I/O; Electron upgrades can invalidate the
  pipeline) outweighs the gain while the cheaper code-cache step (#1) is untried.
  Revisit only if #1 + #3 leave a measured parse/init gap. (Finding #3.)
- **WASM SQLite in the renderer.** Rejected: 1.2–5.5× slower than the current
  main-side `better-sqlite3` (finding #14), and it would drag domain data across the
  host boundary that `docs/BOUNDARIES.md` deliberately keeps ("clients talk to
  hosts, never to databases").
- **Hidden-`BrowserWindow` background workers.** Rejected in favor of #7: Electron's
  own docs say `utilityProcess` measures on par without dragging a whole
  renderer/Chromium/Blink along (finding #13 + bench's 140 ms row).
- **Any `sendSync` in IPC paths.** Rejected with data: lowest latency, highest main
  CPU, blocks the renderer (finding #16). The codebase already avoids it.
- **Disabling `sandbox`/`contextIsolation` for speed.** Rejected with data: +0.1 ms
  per `invoke` in the bench (finding #16); not a performance lever, only a security
  cost.
- **`Menu.setApplicationMenu(null)` early-boot trick.** Not applicable: Volli builds
  a real custom menu (`src/main/menu.ts:169`); the Electron-doc tip only helps
  frameless/no-menu apps.
- **One process per ticket/workspace/session.** Rejected by Slack's precedent in both
  directions: they consolidated N processes → 1 (finding #8) and are still paying
  down per-context overhead inside that process. Volli's single-window + parked PTYs
  is already the consolidated shape; per-session isolation belongs in stores/ports,
  not processes.
- **OS WebView (leave bundled Chromium) for size/speed.** Rejected per Rieseberg:
  no published data shows system WebViews beating current Chromium on interactive
  apps, and it surrenders stability/security control of the engine (finding #15).
- **`nice`/priority-throttling PTY children to protect the UI.** No supporting prior
  art found: none of the surveyed teams publish lowering child priority; Volli's
  children *are* user work (compilers, sessions), where throttling changes semantics
  rather than just pace. The published answer to "heavy children + smooth UI" is
  batching + flow control + parking (findings #9, #19 — already built in
  `pty/output.ts`, `pty/park-controller.ts`), plus moving host-side work out of main
  (#7). Revisit only with a measured contention profile.
- **LocalStorage as a hot data path.** Moot: Volli already migrated UI state to
  SQLite and clears legacy `volli:*` keys after bootstrap (`lib/boot.ts`,
  decision #29) — consistent with Slack's published LocalStorage pitfalls and the
  pre-warmed-from-SQLite pattern (findings #5, Part-2 topic list).

## Sources

Every URL below was actually read via `web_fetch` for this note. Quotes/numbers are
from those reads; anything else is marked as search-context, not evidence.

- https://www.electronjs.org/docs/latest/tutorial/performance
- https://www.electronjs.org/docs/latest/tutorial/ipc
- https://www.electronjs.org/docs/latest/tutorial/process-model
- https://www.electronjs.org/docs/latest/tutorial/message-ports
- https://www.electronjs.org/docs/latest/tutorial/multithreading
- https://www.electronjs.org/docs/latest/api/utility-process
- https://github.com/ZacWalk/electron-bench
- https://github.com/ZacWalk/electron-bench/blob/master/best-practices.md
- https://discord.com/blog/how-discord-maintains-performance-while-adding-features
- https://discord.com/blog/investigating-discords-react-memory-leak
- https://web.archive.org/web/20241225143945/https://slack.engineering/rebuilding-slack-on-the-desktop/
- https://web.archive.org/web/20241231015146/https://slack.engineering/reducing-slacks-memory-footprint/
- https://web.archive.org/web/20250123224802/https://slack.engineering/making-slack-faster-by-being-lazy/
- https://palette.dev/blog/improving-performance-of-electron-apps
- https://3perf.com/blog/notion/
- https://powersync.com/blog/speeding-up-electron-apps-with-powersync
- https://johnnyle.io/read/electron-performance
- https://felixrieseberg.com/things-people-get-wrong-about-electron/
- https://github.com/obsidianmd/obsidian-developer-docs/blob/31946e5a/en/Plugins/Guides/Optimize%20plugin%20load%20time.md
- https://github.com/microsoft/vscode/issues/28492 (two-line issue body; cited only for scope)
- https://www.besthub.dev/articles/how-vs-code-achieves-lightning-fast-startup-front-end-performance-secrets-b2e0186619bf
  (secondary summary of the CovalenceConf 2019 "VS Code — The First Second" talk;
  the primary video was not watched)

Unread (attempted, failed — not cited): `https://slack.engineering/rebuilding-slack-on-the-desktop/`
and `/reducing-slacks-memory-footprint/` direct (fetch refused the resolved address;
archive.org copies above were read instead); `https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox`
(timed out — VS Code sandbox/extension-host claims in this note rest on Electron's
own process-model/utility-process docs, not that post).
