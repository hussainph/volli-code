# Session UI migration readiness

Whether the lab chat surface is mature enough to become the app's real Session UI, and what stands between here and there.

The question this answers is *not* "have we reached OpenCode parity" — `opencode-surface-audit.md` owns that backlog and the answer there is deliberately no. This asks the narrower thing: are we mature enough in transport, session management, performance, UI cleanliness and build hygiene that further work belongs in the live app rather than in a prototype.

Audited 2026-08-04 against `497fd0c` across five parallel passes: transport, UI quality, live performance, session lifecycle, and quality gates. Every claim is cited to a file and line. Line numbers drift; the surrounding quote is the durable part.

## Verdict

**Migrate — but not on the current state. The prep is finite, well-bounded, and none of it is an architectural rewrite.**

All five passes returned READY-WITH-WORK independently. The reason to trust that convergence is what the deepest question turned up: **the terminal path and the structured path are already one Session identity in one ledger.** Migration 018 (`apps/desktop/src/main/db/migrations.ts:470-585`) replaced the terminal-shaped `sessions` row with an identity-only row plus `session_attachments` / `session_commands` / `session_events` / `session_command_receipts`. A chat Session is a second adapter on that identity, not a second notion of session.

That was the question that could have sunk this. It is already answered, and answered correctly. **Nothing in `@volli/session-engine`, `@volli/session-rpc`, or the SQLite schema has to change for the migration.**

What is missing is the *edge* — and the edge is small.

## Where the boundary actually sits

Built and production-shaped, shared by both paths today:

- The engine, the SQLite ledger, and the durable event log, against `<userData>/volli.db` (`db/migrations.ts:522-575`, appended at `sqlite-ledger.ts:225-232`). Only the *lab* is ephemeral — its db is a `mkdtemp` deleted on shutdown (`main/lab/session-rpc.ts:289`).
- Location resolution, already generic and multi-project (`session-runtime/location.ts:11-26`).
- Adapter process supervision: lazy deduped spawn, ephemeral loopback port, 32-byte Basic secret, sha256 re-verification before *every* launch, health retry, SSE reconnect with attention raise/clear.
- The tRPC router, and an IPC edge with a compile-time coverage assertion (`main/session-rpc-ipc.ts`), registered at `main/index.ts:407`.
- The app-side landing seam: `TICKET_RAIL_MODES` already carries `"session"` as a fifth mode gated on `activeTabKind: "session"`, with tests (`renderer/src/components/ticket/ticket-rail-model.ts:20`).
- Rehydration that is gap-safe by construction: `snapshot()` folds the log and reads artifacts, subscribe replays from cursor, `#enqueue` fills in strict order, `appendFrames` drops at or below the cursor.
- Command semantics that hold: intent persists before routing, replay is by commandId, rejected receipts are read and the words kept.

Not built:

- **Any renderer-side consumer of the IPC edge.** A repo-wide grep for the three channel strings returns 13 hits — all inside `main/session-rpc-ipc.ts`, its test, and the import at `main/index.ts:40`. Zero in `preload/` (759 lines), zero in `renderer/src/`. Seven procedures exposed, zero callers.
- **Any way to open an existing Session rather than create one.** Mounting the surface *is* creating a Session.
- **Any production route for the Runtime Catalog** — which is what makes the chat unable to send a message at all.

The lab runs entirely on a dev-only HTTP/SSE bridge, correctly dev-gated at `vite.config.ts:57`.

## Blockers

Ranked by whether the surface can function at all, then by whether the failure is silent.

### A — the surface cannot run in the app

**A1. The Runtime Catalog has no production route, so chat cannot send a message.** Four independent breaks on one path. It is off the IPC allow-list (`main/session-rpc-ipc.ts:25-33`); it is absent from the IPC caller context (`:118-122`, `:142-145`) so `requireRuntimeCatalog` throws (`packages/session-rpc/src/index.ts:473-476`); `createRuntimeCatalog` is constructed only at `main/lab/session-rpc.ts:342`, never in `main/index.ts`; and `useRuntimeCatalogClient()` returns null in the app (`renderer/src/lib/runtime-catalog-client.tsx:45`). The chain ends at `chat/session-controller.ts:478`, where `submit` returns false because `selection.modelId` is still `""`.

**This bug already ships.** `RuntimeCatalogSettings` renders nothing in the live app today for the same reason (`runtime-catalog-settings.tsx:36`, mounted at `settings-page.tsx:192`). It is a present-tense defect, not only a migration blocker.

**A2. The coverage assertion structurally cannot catch A1.** `SessionRouterProcedure` (`main/session-rpc-ipc.ts:15-18`) is typed `` session.${...} `` only, so `runtimeCatalog.*` and `labDiagnostics.*` are invisible to `SessionRpcIpcCoverage` at `:51-53`. The guard that exists to make an unlisted procedure a compile error has a blind spot exactly where the blocker lives. Widen it before adding routes, or the next router will go missing the same way.

**A3. No preload bridge and no IPC transport link.** The controller is written against `httpSubscriptionLink` (`lab/session-rpc-client.ts:31`). It needs an equivalent link over `SESSION_RPC_IPC_CHANNEL`.

**A4. `opencode` will not resolve in a packaged app.** `packages/opencode-adapter/src/index.ts:2891-2903` walks `process.env.PATH`; `binaryPath` defaults to bare `"opencode"` (`:180`). `main/login-path.ts` exists for exactly this problem but is threaded only into the terminal and harness paths (`main/index.ts:643,736`). **The lab structurally cannot catch this** — Vite inherits a terminal PATH. Verify against a packaged launch, never against `pnpm dev`.

### B — the surface cannot be instantiated more than once

**B1. Mounting the surface creates a Session.** `useLabSessionController(scenarioId)` takes no `sessionId` (`chat/session-controller.ts:186`); its only entry is `start()`, which always issues `session.create` (`:435-473`) behind a per-instance `started` ref (`:635-640`). N mounts means N new Sessions, and a tab or sidebar row for an existing Session has no code path at all.

**B2. `recover()` forks a new Session when the executor is gone.** `liveAttachmentId ? reconcile() : start()` (`:625-628`). After a harness crash `liveExecutor` is null, so the error row's one Retry abandons the durable history it was supposed to recover. The comment at `:616-624` reasons only about the live-stream case.

**B3. Session state is component-resident, and the app's own precedent is the opposite.** `projection` / `transcript` / `lifecycle` / `selection` are `useState` (`:190-200`), with subscription teardown and client-null on unmount (`:231-235`, `:323-328`). The composer **queue** — undelivered user intent — is `useState` in `ChatPlane` (`scratches/chat-session.tsx:298`) and never persisted, so selecting another card destroys typed messages. This violates the CLAUDE.md invariant that session state is model-resident and views lazy. The terminal path already solved it: engines live in a module-level `Map` outside React (`renderer/src/terminal/registry.ts:20`), and hosts only toggle `display` (`ticket-terminal-host.tsx:167-185`). Main is already fine — `#bindings` keeps the turn running (`session-runtime.ts:293`).

**B4. A structured Session immediately lies in the sidebar.** `terminalSessionRecord` falls back to `harnessId: "claude-code"`, `launchKind: "unknown"`, `cwd: ""`, `endedAt: null` for any projection with no `adapterId === "terminal"` attachment (`main/session-control/terminal-attachment.ts:67-93`). That function *is* `volli:session-list` (`main/data-ipc.ts:475-491`), which is the second source of the "Needs you" / "Active" tiers (`sidebar/active-sessions.tsx:259-267`). Same ledger and same list means a chat Session renders as a never-ending claude-code terminal. This is the direct cost of the shared identity being right — the list has to learn to say "not a terminal session".

### C — it ships broken, with green gates

Both of these pass every gate we have. That is what makes them the dangerous ones.

**C1. Tailwind does not scan `src/components/ai-elements`.** Measured against the built `apps/desktop/dist/assets/index-DjqajpAI.css`: ai-elements-only utilities (`list-disc`, `list-outside`, `size-full`, `overflow-y-hidden`, `contains-task-list`, `bg-muted/80`) return **zero hits each**. The two `@source` directives the chat depends on exist only in `lab/lab.css:29-30`; `renderer/src/globals.css` has none at all. The chat would ship visually broken with no error and no failing test.

**C2. A dead IPC stream reads as ready forever.** `SessionRpcIpcEvent` (`main/session-rpc-ipc.ts:62-66`) has one arm. `pumpSubscription` (`:161-187`) records a diagnostic and calls `stop()` on error, and merely breaks on done — **nothing reaches the renderer either way.** So the controller's `onError` → `setConnectionError` → `recover()` path (`session-controller.ts:314-316`) is unreachable over IPC. Related: `httpSubscriptionLink` gave the lab `Last-Event-ID` resume for free and the router already accepts the cursor (`packages/session-rpc/src/index.ts:259-263`); the IPC bridge never uses it.

**C3. Every transcript frame carries a full message snapshot.** `session-controller.ts:66-72` says so in its own words: *"a streamed reply commits a transcript snapshot per chunk, several per animation frame."* Measured live: **1.46 MB of SSE for 18 KB rendered — 81× amplification** over one 143-second answer. The renderer already fixed the O(n²) *CPU* cost by folding frames forward, which is why the batcher measures clean. The *wire* cost is upstream, in what the adapter emits, and is untouched. It scales with the square of answer length, and structured-clone over IPC is a less forgiving carrier than SSE.

**C4. Fenced code is re-highlighted from scratch on every delta — the visible consequence of C3.** ~300 final lines of code produced **78,861 `childList` mutations** on Shiki line spans, each open block rebuilt ~260×. That is the whole of a **15,087 ms long-task budget — 10.5% of stream wall-clock** — and all 119 hitches. It flickers: span counts collapsed 248→45 and 604→143 at exactly the moments a new fence opened, because `code-block.tsx:160` emits raw unhighlighted tokens and highlights async, so a re-parse drops *every* block to raw. Fix C3 and this largely goes with it.

### D — hygiene the move calls in

**D1. `chat-session.tsx` is a scratch, not a component tree.** Of 1,211 lines, ~180 are lab scaffolding (`:65-98` scratch contract, `AppShell` / `SettingsPage` / scenario-picker; `:240-286` hardcoded LAB-14 fixture prose) and ~280 are pure logic exported solely so `chat-session.test.ts` can reach it. `scratches/chat-performance.tsx:69` imports `ChatTurn` / `holdList` / `sameMessages` **from another scratch**. Nothing here is importable by the app without dragging the lab shell.

**D2. De-labbing the controller is smaller than it looks.** Three lab imports (`session-controller.ts:17-19`), a hardcoded `"LAB-14 · OpenCode chat prototype"` title (`:448-451`), a scenario branch (`:459`), and the `labDiagnostics` effect (`:223-230`). Hardcoded identity has exactly **one** renderer consumer (`:448-449`) — it is two props, not a rewrite.

**D3. One true silent swallow.** `activity-ui.tsx:507` — `void navigator.clipboard.writeText(...)`. A denied clipboard permission fails with zero feedback. Lab-exempt today; not after.

**D4. Bundle weight, A/B measured.** Chunks 156 → 557; raw 22.18 → 37.04 MiB; **gzip 4.70 → 7.70 MiB (+64%)**; eager boot chunk **+192 KiB gzip**. Dominant terms: **mermaid** (89 lazy chunks, 3.29 MiB, via `@streamdown/mermaid`) and a **second full Shiki grammar and theme set** — 82 chunk names now exist in two copies, including grammars the app deliberately curated *out* at `renderer/src/editor/shiki-langs.ts:13`. Streamdown's plugins are opt-in.

**D5. Coverage will not auto-enroll, and that is the risk.** `apps/desktop/vite.config.ts:105-158` is an explicit **65-file allowlist** rooted at `src/renderer` — verified: `coverage-final.json` has exactly 65 keys, zero `.tsx`, zero lab. Moving `lab/chat/*` into `renderer/src/` lands it in **no threshold glob**, so the gate stays green and the chat ships ungated. Enrolled per repo convention (pure `.ts` only), the debt is **5 files / 296 statements / 266 branches**, of which `session-controller.ts` alone is 244 — its test file is 5.5 KB against 32.6 KB of source.

## Not blockers

Recorded so they are not re-filed as news.

- **Virtualization.** There is none (`conversation.tsx:26` is a plain flex column; no `react-window` / `react-virtual` / `virtuoso` anywhere). Measured clean to 500 turns — 60 fps, zero frames over 50 ms. At 1,000: scroll p95 72 ms, 11 dropped frames. At 3,000: an 8.1 s mount freeze, 13 fps, 96,637 nodes. A realistic all-day session is fine. Sessions are durable and resumable, so this is a "when", not an "if" — but it is not this migration.
- **Composer latency** — p50 0.1 ms, p95 0.2, max 0.2 under full token flood *with* live highlighting. The thing users feel most is a non-issue.
- **Subscription fan-out is already correct.** `session-controller.ts:305` coalesces every frame in one paint into one `setState`; `movesProjection` (`:750`) suppresses the `transcript.referenced` flood. Measured SSE gap p50 1,462 ms — the batcher is never stressed. Throughput is not the problem; per-delta cost is.
- **Zero lint or type debt.** There is no `lab/**` exemption anywhere — no eslint config files, no lab entry in `vite.config.ts:6-16` ignorePatterns. Lab is already fully linted and typechecked.
- **Deps need no promotion.** `streamdown`, `@streamdown/*`, `ai`, `use-stick-to-bottom`, `shiki`, `motion`, `nanoid` are all already in `dependencies`. The `@ai-elements/*` alias is present in `vite.config.ts:66` and `tsconfig.web.json:9`.
- **twMerge is correct.** All four custom font-size tokens are registered (`utils.ts:14`) and the chat uses exactly those four.
- **Tokens and copy are clean.** One hex in the whole surface, and it is a dead `var()` fallback (`ai-elements/shimmer.tsx:75`). No `text-[Npx]` anywhere. `ContentColumn` on all four Tier-A surfaces. No helper text, no descriptions, no tutorial tooltips.
- **The one-way lab rule holds** — zero imports of `renderer/lab` from `renderer/src` or `preload`.
- **Accessibility is careful**, not accidental: `activity-ui.tsx:212-236` deliberately avoids nested controls, `interaction-ui.tsx:233-236` skips Escape during IME composition. Two small gaps only (`interaction-ui.tsx:475` unlabeled textarea, `chat-session.tsx:907-912` `title`-only detail).
- **The session runtime is not feature-flagged.** `main/index.ts:397-405` is null only on DB-open failure; handlers are live in every healthy run.
- **`reportError` is not a silent swallow.** See corrections below.

Deferred and genuinely post-migration: `ai-elements/code-block.tsx` (522 lines, zero consumers — confirmed) and ~1,500 further lines of unreferenced vendored exports; `lucide-react` drift (already ships via `select.tsx`, `command.tsx`, `spinner.tsx`); a shared segmented-pill primitive (`composer-ui.tsx:317-349` and `:353-388` hand-roll it twice); duration tokens (`globals.css:251` ships `--ease-swift` but no duration scale); a crashed `opencode serve` stranding live bindings (`opencode-adapter:309-311`, `:904-921`); `PROJECTION_CACHE_LIMIT = 8` thrashing past 8 live sessions; the Runtime Catalog being single-directory (`main/runtime-catalog.ts:26-30`); `#emitStreamSnapshot` losing a *final* snapshot silently.

## The plan

Three workstreams. **1 and 2 are independent and can run in parallel; 3 gates the visible quality of the result and is independent of both.** Nothing here touches the engine, the RPC contract, or the schema.

**Workstream 1 — the transport edge.** Widen `SessionRouterProcedure` so non-`session.*` routers are visible to the coverage assertion (A2), then add the Runtime Catalog to the allow-list and the caller context, construct it per project in `main/index.ts`, and mount `RuntimeCatalogProvider` in the app root (A1). Add the preload bridge and a tRPC link over IPC (A3). Give the subscription protocol done and error frames, and resume from `throughSequence` (C2). Resolve the binary through `loginShellPath()` and **verify against a packaged launch** (A4). Roughly 465 lines across eight steps, most of it mechanical.

**Workstream 2 — the controller reshape.** Change the hook to `useSessionController(sessionId: string)`, delete the `started` ref and the `start()` at `:635-640`, and make the boot effect `snapshot` + `subscribe` (B1). Move `session.create` + `adapter.attach` to a store action returning a sessionId — `stores/sessions.ts` `byOwner` already models the tab set and `sessionOwner` already routes id → owner. Make `recover()` re-attach with `continuity: "native_resume"` on the same sessionId (B2). Lift `transcript` / `queued` / `selection` into a per-sessionId store slice outside React, copying `terminal/registry.ts:20` (B3). Teach `terminalSessionRecord` to say "not a terminal session" (B4). Decompose `chat-session.tsx` and de-lab the controller (D1, D2).

**Workstream 3 — the two silent failures and the weight.** Start with the frame shape: change it from full snapshot to delta, the single highest-value item in this document, which removes the 81× wire amplification, the 15 s long-task budget and the highlighting flicker together (C3, C4). Prove the win on the lab before anything moves. Then add the `@source` directives to `renderer/src/globals.css` and confirm against a real built stylesheet, not a test (C1). Drop math from streamdown, keep mermaid, and dedupe the Shiki grammar set against `editor/shiki-langs.ts` — with mermaid retained, that dedupe is the main remaining lever (D4). Fix the clipboard swallow (D3).

**Then migrate.** The move itself is a file move plus wiring, once the above is true.

Two things must land *alongside* the move rather than after it, because they are wrong the moment a chat Session exists in the app: the preload link, and `terminalSessionRecord` honesty.

## Corrections applied

Struck from `opencode-surface-audit.md` as part of this audit, having been verified false:

- **`reportError` is not a silent swallow.** It is `console.error` at `session-controller.ts:790`, but it is a *logging* helper and both call sites pair it with an on-screen state setter — `:220` with `setDiagnosticsError`, `:366` with `setCatalogState("error")` and `setCatalogError`. The comment at `:212-217` records the fix deliberately. The audit's claim that "the diagnostics query and subscription fail invisibly" no longer holds.

Still true and left standing: `ai-elements/code-block.tsx` has no consumer, and `#emitStreamSnapshot` records nothing when it fails.

Stale claims in source comments, recorded rather than edited (this branch is audit-only):

- `lab/lab.css:5-12` asserts the lab tree is unscanned by the production Tailwind build. The built stylesheet contradicts it — lab-only utilities (`max-h-[32vh]`, `w-[34rem]`, `caret-foreground`) are all present in shipped CSS, because the scan base is the Vite root.
- `packages/shared/src/session.ts:1-9` still claims `SessionRecord` backs "the `sessions` table, migration 003". False since migration 018. `createSessionRecord` (`:151`) has zero production callers.

## Decisions

Settled 2026-08-04, so the later session does not reopen them.

1. **Coverage: enroll the pure `.ts` modules with the move.** Repo convention holds — `.tsx` stays excluded per `vite.config.ts:99-102`. That is 5 files, 296 statements, 266 branches, and it must be *added to the 65-file allowlist explicitly*, because nothing about the move enrolls it. `session-controller.ts` is 244 of the 296 and is where transport, lifecycle and delivery correctness live; it is the reason to do this rather than an unfortunate side effect of it.
2. **Mermaid stays; math goes.** Diagram rendering is worth its weight in a coding-session product. This leaves most of the measured growth standing, so **the Shiki duplicate is now the primary bundle lever, not a secondary one** — 82 chunk names in two copies, 6.69 MiB across them, including grammars `renderer/src/editor/shiki-langs.ts:13` deliberately curated out. Dedupe against that list rather than shipping a second full grammar and theme set. Re-measure after; the +192 KiB gzip on the eager boot chunk is the number that matters, not the lazy total.
3. **The frame shape lands inside migration prep**, not as a separate project. It stays in Workstream 3 and is that workstream's first item, since C4 is downstream of it. Expect it to move a good number of the adapter's exact-object part-mapping assertions — that churn is the cost of the change and is not evidence of a regression. Land it and prove the perf win on the lab *before* anything moves, so the migration PR stays a move-and-wire.

## Coverage note

`packages/shared`, `session-engine`, `session-rpc` and `opencode-adapter` hold 100% on `src/**`, and the adapter's part-mapping tests are exact-object assertions — Workstream 3's frame-shape change will move a good number of them. Thresholds only evaluate under `--coverage`, so run `vp run -r test:coverage` before pushing; a green `vp run -r test` says nothing about it.
