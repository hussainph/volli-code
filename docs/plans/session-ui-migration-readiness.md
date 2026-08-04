# Session UI migration readiness

Whether the lab chat surface is mature enough to become the app's real Session UI, and what stands between here and there.

The question this answers is *not* "have we reached OpenCode parity" — `opencode-surface-audit.md` owns that backlog and the answer there is deliberately no. This asks the narrower thing: are we mature enough in transport, session management, performance, UI cleanliness and build hygiene that further work belongs in the live app rather than in a prototype.

Audited 2026-08-04 against `497fd0c` across five parallel passes: transport, UI quality, live performance, session lifecycle, and quality gates. Every claim is cited to a file and line. Line numbers drift; the surrounding quote is the durable part.

## Revalidation on the migration branch

Revalidated 2026-08-04 against `8a358df` by three independent read-only passes plus a root architecture audit, before any further implementation. The original audit found real blockers, but its headline was too optimistic and three proposed fixes crossed contracts that the plan said would remain untouched.

**Revised verdict: begin migration preparation, not the file move.** The durable Session foundation is ready. The production edge, renderer ownership model, recovery semantics, and streaming representation are not yet specified tightly enough to move the Lab surface into the app without baking prototype behavior into production.

The whole of this section supersedes conflicting text below — the eight corrections first, then what has since landed and what still gates the move. Where a blocker under **Blockers** contradicts any of it, the blocker is the older reading; the ones that have been overtaken are struck through in place.

1. **A1 needs project identity, not a singleton catalog.** `createRuntimeCatalog` is directory-bound, while every `runtimeCatalog.*` input and the current RPC context are adapter-only. `main/index.ts` therefore cannot safely “construct it per project” until the transport carries a project/session routing key or accepts a resolver. Deferring the catalog's single-directory behavior would make the production app probe the wrong checkout in a multi-project workspace.
2. **B2's proposed `native_resume` attach is invalid.** A client-issued attach supplies `native: null`; OpenCode requires a provider Session id for `native_resume`. Runtime rehydration already resumes an existing *open* attachment internally. A closed or failed provider attachment needs an explicit product contract: either a fresh provider conversation attached to the same durable Session and labelled honestly, or a deliberate native-reference resume capability.
3. **C3 necessarily touches the Session stream contract.** `HarnessObservation` currently carries a full `UIMessage`, the runtime persists it as a transcript artifact, and RPC publishes the resulting frame. Durable deltas require new engine/artifact/RPC semantics. A transient delta overlay with only final durable snapshots is a different durability choice. Neither is an adapter-only frame-shape edit.
4. **C4 named the wrong renderer.** The active path is Streamdown's Shiki integration; `ai-elements/code-block.tsx` has no consumer and cannot be the measured source of fence rebuilds. Delta transport alone also does not prevent a growing open fence from being re-highlighted. The migration gate needs a browser benchmark for an open code fence and a renderer policy such as highlight-on-close/stability.
5. **The app tab model is terminal-shaped.** `stores/sessions.ts` is not already a generic Session registry: a tab owns terminal split/pane geometry, exit codes, and launch facts, and `TicketSessionPlane` routes an active id to the terminal overlay. Structured Sessions need a discriminated tab model or a separate resident registry before controller state moves out of React.
6. **The legacy list fix is filtering, not fallback copy.** `SessionRecord` requires terminal-only fields and is reused by PTY/agent compatibility paths. Structured-only Sessions must be omitted from the legacy terminal endpoints until a discriminated listing DTO lands; changing the fabricated words would preserve the lie.
7. **A start failure was missing from the audit.** `adapter.attach` failures normally return rejected receipts. The Lab controller previously treated any resolved mutation as success and rendered Ready with no executor.
8. **Several measurements are useful leads, not reproducible gates.** The 81x stream amplification, exact bundle totals, and coverage statement/branch counts were not committed as replayable evidence. Re-measure them with checked-in probes before using them as acceptance thresholds. `contains-task-list` is generated GFM markup, not a Tailwind utility selector.

Safe preparation landed in this branch after the revalidation:

- The IPC subscription protocol now carries explicit `data`, `done`, and sanitized `error` frames, with cancellation still silent to the cancelling renderer.
- A first adapter attachment that fails — refused *or* thrown — keeps the durable Session id visible and returns an error lifecycle instead of Ready. Only `session.create` still throws out of the start path, and correctly: there is no id yet to lose.
- `terminalSessionRecord` returns `SessionRecord | null` and every caller filters by construction, so the fabricated `claude-code` / `"unknown"` / empty-`cwd` record is gone from both renderer listings, the CLI socket, the PTY paths and the db test support alike.
- Production Tailwind scanning includes AI Elements and Streamdown, and the desktop build asserts four selectors in the emitted stylesheet — each one verified to vanish when its own `@source` is pulled, so the gate can no longer pass on a utility some other source re-emits.
- The IPC coverage guard's two exemption buckets are pinned to procedures the router actually publishes, so a renamed or deleted procedure is a compile error rather than a stale excuse the guard was written to catch and could not see.
- Clipboard success and failure are both covered, and Streamdown math is gone from the message and reasoning renderers *and* from `apps/desktop/package.json`, while code and Mermaid remain.
- Native OpenCode lookup resolves lazily and handles both forms it can be given: a configured path is verified executable and canonicalized directly, a bare name walks the login-shell PATH, and both routes converge on one `realpath` before the adapter fingerprints and spawns. The option is `command` and the hook is `resolveCommand`.

Still gating the file move:

- project-aware Runtime Catalog routing and the production preload/tRPC link;
- a resident structured-Session tab/store model and controller lifecycle tests;
- a discriminated Session listing DTO — a structured Session is now honestly *absent* from the legacy terminal endpoints rather than lying in them, and absent is not the same as visible;
- an explicit post-provider-failure continuity contract;
- a durable-versus-transient streaming decision plus reproducible wire and fenced-code browser benchmarks;
- resume from a cursor over IPC, which is **deliberately not built and is not a bug to re-file.** The protocol carries `eventId` on every data frame and the router already folds `afterSequence` / `lastEventId`, so the cursor is reachable. What supplies it is a *reconnecting client*, and A3 has not built one — there is no renderer consumer of this edge at all. Building the resume now would mean a resume path with nothing to resume, proven only against a fake. It lands with the preload link or not at all;
- a packaged-launch proof of the `opencode serve` child's environment. Binary resolution is no longer the open question; `#startServer` spawns through a port that passes `{ ...process.env, ...env }`, so under a Finder or Dock launch the child inherits launchd's PATH however correctly we resolved the executable handed to it;
- coverage enrollment and a packaged Session-chat smoke alongside the move.

Post-change proof on the combined tree: workspace typecheck passed, `vp run -r test:coverage` passed at 100% across 3,236 tests (the Unix-socket tests need rerunning outside the sandbox), `vp check` passed, and the production desktop build passed the emitted-CSS assertion against the revised four-selector set. A real Chrome smoke loaded `#chat-session` and the scripted single-question scenario with one assistant turn, its interaction controls, and no page exception; the existing favicon 404 remains unrelated. **That smoke predates the later fixes and has not been rerun** — and it was a functional smoke to begin with, not the missing fenced-code performance benchmark and not the packaged OpenCode launch proof.

## Original verdict (superseded by the revalidation above)

**Original call: migrate after finite preparation.** The revalidation above narrows that to migration preparation because several missing contracts are architectural decisions, not mechanical edge wiring.

All five passes returned READY-WITH-WORK independently. The reason to trust that convergence is what the deepest question turned up: **the terminal path and the structured path are already one Session identity in one ledger.** Migration 018 (`apps/desktop/src/main/db/migrations.ts:470-585`) replaced the terminal-shaped `sessions` row with an identity-only row plus `session_attachments` / `session_commands` / `session_events` / `session_command_receipts`. A chat Session is a second adapter on that identity, not a second notion of session.

That was the question that could have sunk this. It is already answered, and answered correctly. The schema does not need to change. The revalidation refutes the stronger original claim about `@volli/session-engine` and `@volli/session-rpc`: a durable delta representation would change both contracts.

The original audit treated the remainder as a small edge. The revalidation above records where that was too narrow.

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

- **Any renderer-side consumer of the IPC edge.** A repo-wide grep for the three channel constants returns 16 hits — every one inside `main/session-rpc-ipc.ts` or its test; `main/index.ts:40` imports the registrar and nothing else. Zero in `preload/` (759 lines), zero in `renderer/src/`. Seven procedures exposed, zero callers.
- **Any way to open an existing Session rather than create one.** Mounting the surface *is* creating a Session.
- **Any production route for the Runtime Catalog** — which is what makes the chat unable to send a message at all.

The lab runs entirely on a dev-only HTTP/SSE bridge, correctly dev-gated at `vite.config.ts:57`.

## Blockers

Ranked by whether the surface can function at all, then by whether the failure is silent.

### A — the surface cannot run in the app

**A1. The Runtime Catalog has no production route, so chat cannot send a message.** Four independent breaks on one path. It is off the IPC allow-list (`main/session-rpc-ipc.ts:25-33`); it is absent from the IPC caller context (`:118-122`, `:142-145`) so `requireRuntimeCatalog` throws (`packages/session-rpc/src/index.ts:473-476`); `createRuntimeCatalog` is constructed only at `main/lab/session-rpc.ts:342`, never in `main/index.ts`; and `useRuntimeCatalogClient()` returns null in the app (`renderer/src/lib/runtime-catalog-client.tsx:45`). The chain ends at `chat/session-controller.ts:478`, where `submit` returns false because `selection.modelId` is still `""`.

**This bug already ships.** `RuntimeCatalogSettings` renders nothing in the live app today for the same reason (`runtime-catalog-settings.tsx:36`, mounted at `settings-page.tsx:192`). It is a present-tense defect, not only a migration blocker.

**A2. ~~The coverage assertion structurally cannot catch A1.~~ Landed.** `SessionRouterProcedure` was typed `` session.${...} `` only, so `runtimeCatalog.*` and `labDiagnostics.*` were invisible to `SessionRpcIpcCoverage` — the guard that makes an unlisted procedure a compile error had a blind spot exactly where the blocker lives. It now maps every namespace the router publishes, and each one is spoken for: routed, `DeliberatelyMainOnlyProcedure` (labDiagnostics, which stays on the dev HTTP bridge), or `UnroutedProcedure`. `runtimeCatalog.*` sits in the last bucket, so A1 is now a named compile-time fact rather than an absence. Routing it empties that type; delete the bucket when it does.

**A3. No preload bridge and no IPC transport link.** The controller is written against `httpSubscriptionLink` (`lab/session-rpc-client.ts:31`). It needs an equivalent link over `SESSION_RPC_IPC_CHANNEL`.

**A4. ~~`opencode` will not resolve in a packaged app.~~ Half landed — resolution is fixed, the launch environment is not.** The adapter walked `process.env.PATH` and its binary option defaulted to bare `"opencode"`, while `main/login-path.ts` existed for exactly this problem and was threaded only into the terminal and harness paths (`main/index.ts:652`, `:745`). Desktop now passes `resolveCommand: resolveOpenCodeBinary` (`main/index.ts:398-404`), resolved at first attach rather than at boot so no launch waits on an interactive shell for an adapter it never uses. That resolver also splits what a single PATH walk used to conflate: `join(directory, executable)` turned a configured `/opt/custom/opencode` into `/usr/bin/opt/custom/opencode` and then reported it missing. A value that is absolute or contains a separator is now verified executable and taken at its word; only a bare name walks the login-shell PATH; both converge on one `realpath`, so the hash and the spawn name the same file (`main/opencode-binary.ts:48-59`). The adapter option is `command` and the hook is `resolveCommand` — `binaryPath`, `resolveBinary` and `OpenCodeProcessPort.resolveBinary` no longer exist.

What remains is the *child's* environment, and it is worth naming exactly rather than as "verify against a packaged launch". `#startServer` (`packages/opencode-adapter/src/index.ts:341-351`) spawns `opencode serve` through a port whose Node implementation passes `{ ...process.env, ...env }` (`:2876`), so under a Finder or Dock launch that child inherits launchd's PATH no matter how correctly we resolved the executable we handed it — and anything `opencode serve` shells out to inherits it in turn. **The lab structurally cannot catch this** — Vite inherits a terminal PATH. Verify against a packaged launch, never against `pnpm dev`.

### B — the surface cannot be instantiated more than once

**B1. Mounting the surface creates a Session.** `useLabSessionController(scenarioId)` takes no `sessionId` (`chat/session-controller.ts:186`); its only entry is `start()`, which always issues `session.create` (`:435-473`) behind a per-instance `started` ref (`:635-640`). N mounts means N new Sessions, and a tab or sidebar row for an existing Session has no code path at all.

**B2. `recover()` forks a new Session when the executor is gone.** `liveAttachmentId ? reconcile() : start()` (`:625-628`). After a harness crash `liveExecutor` is null, so the error row's one Retry abandons the durable history it was supposed to recover. The comment at `:616-624` reasons only about the live-stream case.

**B3. Session state is component-resident, and the app's own precedent is the opposite.** `projection` / `transcript` / `lifecycle` / `selection` are `useState` (`:190-200`), with subscription teardown and client-null on unmount (`:231-235`, `:323-328`). The composer **queue** — undelivered user intent — is `useState` in `ChatPlane` (`scratches/chat-session.tsx:298`) and never persisted, so selecting another card destroys typed messages. This violates the CLAUDE.md invariant that session state is model-resident and views lazy. The terminal path already solved it: engines live in a module-level `Map` outside React (`renderer/src/terminal/registry.ts:20`), and hosts only toggle `display` (`ticket-terminal-host.tsx:167-185`). Main is already fine — `#bindings` keeps the turn running (`session-runtime.ts:293`).

**B4. ~~A structured Session immediately lies in the sidebar.~~ Landed.** `terminalSessionRecord` fabricated `harnessId: "claude-code"`, `launchKind: "unknown"`, `cwd: ""`, `endedAt: null` for any projection with no `adapterId === "terminal"` attachment, and that function *is* `volli:session-list`, the second source of the "Needs you" / "Active" tiers (`sidebar/active-sessions.tsx:259-267`) — so a chat Session rendered as a never-ending claude-code terminal.

It now returns `SessionRecord | null`, and null is exactly that case (`main/session-control/terminal-attachment.ts:76-99`). The rule lives with the attachments it is about rather than as a predicate each listing has to remember, which is the shape the bug argued for: the two renderer listings had remembered it and the CLI socket had not. Every caller filters by construction — `main/data-ipc.ts:485` and `:499`, the CLI snapshot behind `volli session list` / `identify` at `main/agent-commands.ts:919`, the PTY open path at `main/pty/manager.ts:753`, resume scope at `main/pty/scope.ts:129`, and the db test support at `main/session-control/test-support.ts:192`. `packages/shared/src/session.ts:18-28` records the trap where someone would read it before adding a field. The defaults survive only for a terminal attachment whose native detail is unreadable, which is honestly a terminal and is what `unknown` metadata has always meant.

What is left is why the omission is temporary rather than right: a structured Session is now absent from the legacy terminal endpoints instead of lying in them, so the sidebar still cannot see it. Teaching the list to say "not a terminal session" needs the discriminated listing DTO, which is Workstream 2's and not this.

### C — it ships broken, with green gates

These passed every gate we had. That is what made them the dangerous ones. C1 and C2 have since landed, and C1's landing built the gate it was invisible to.

**C1. ~~Tailwind does not scan `src/components/ai-elements`.~~ Landed.** Measured against the built stylesheet, six ai-elements-only utilities (`list-disc`, `list-outside`, `size-full`, `overflow-y-hidden`, `contains-task-list`, `bg-muted/80`) returned **zero hits each**: the two `@source` directives the chat depends on existed only in `lab/lab.css:29-30` and `renderer/src/globals.css` had none at all, so the chat would have shipped visually broken with no error and no failing test. Both directives are now in `globals.css:21-22`, and `scripts/verify-chat-css.mjs` asserts against the emitted stylesheet on the production build path (`vite.config.ts:208`).

The gate's four selectors are not the six named above, and the difference is the point. Each was chosen by deleting the `@source` it is filed under and rebuilding: it has to actually vanish, or it is decoration. That removed `bg-muted/80`, emitted only by `ai-elements/code-block.tsx` — the file recorded twice in this document as having zero consumers, so the gate had been standing on dead code and would only have proved the build kept it. It also removed `list-disc` and `size-full`, which Streamdown's own markup re-emits and which therefore survived the ai-elements directive being pulled. What is left is `list-outside`, `overflow-y-hidden` and `max-w-[95%]` for the ai-elements directive and `wrap-anywhere`, which nothing this app owns emits, for Streamdown's. `contains-task-list` was never a Tailwind utility at all — see correction 8.

**C2. ~~A dead IPC stream reads as ready forever.~~ Landed.** `SessionRpcIpcEvent` had one arm; `pumpSubscription` recorded a diagnostic and called `stop()` on error, and merely broke on done — **nothing reached the renderer either way**, so the controller's `onError` → `setConnectionError` → `recover()` path was unreachable over IPC. The union now has three arms (`main/session-rpc-ipc.ts:120-135`), and `pumpSubscription` (`:230-265`) sends `done` and a sanitized `error` through `sendTerminalEvent` (`:267-287`), which stays silent only for a cancellation the renderer itself asked for — local teardown is not a connection state to recover from.

Resume from a cursor is a separate thing, and it is deliberately not built; see the gating list above. Every `data` frame already carries its `eventId` (`:242-247`) and the bridge passes subscription input through untouched (`:215`), so the router's `afterSequence` / `lastEventId` (`packages/session-rpc/src/index.ts:261-262`, folded at `:335`) is reachable the moment a client sends one. What does not exist is the client.

**C3. Every transcript frame carries a full message snapshot.** `session-controller.ts:66-72` says so in its own words: *"a streamed reply commits a transcript snapshot per chunk, several per animation frame."* Measured live: **1.46 MB of SSE for 18 KB rendered — 81× amplification** over one 143-second answer. The renderer already fixed the O(n²) *CPU* cost by folding frames forward, which is why the batcher measures clean. The *wire* cost is upstream, in what the adapter emits, and is untouched. It scales with the square of answer length, and structured-clone over IPC is a less forgiving carrier than SSE.

**C4. Fenced code is re-highlighted from scratch on every delta — the visible consequence of C3.** ~300 final lines of code produced **78,861 `childList` mutations** on Shiki line spans, each open block rebuilt ~260×. That is the whole of a **15,087 ms long-task budget — 10.5% of stream wall-clock** — and all 119 hitches. It flickers: span counts collapsed 248→45 and 604→143 at exactly the moments a new fence opened, because `code-block.tsx:160` emits raw unhighlighted tokens and highlights async, so a re-parse drops *every* block to raw. Fix C3 and this largely goes with it.

### D — hygiene the move calls in

**D1. `chat-session.tsx` is a scratch, not a component tree.** Of 1,211 lines, ~180 are lab scaffolding (`:65-98` scratch contract, `AppShell` / `SettingsPage` / scenario-picker; `:240-286` hardcoded LAB-14 fixture prose) and ~280 are pure logic exported solely so `chat-session.test.ts` can reach it. `scratches/chat-performance.tsx:69` imports `ChatTurn` / `holdList` / `sameMessages` **from another scratch**. Nothing here is importable by the app without dragging the lab shell.

**D2. De-labbing the controller is smaller than it looks.** Three lab imports (`session-controller.ts:17-19`), a hardcoded `"LAB-14 · OpenCode chat prototype"` title (`:448-451`), a scenario branch (`:459`), and the `labDiagnostics` effect (`:223-230`). Hardcoded identity has exactly **one** renderer consumer (`:448-449`) — it is two props, not a rewrite.

**D3. ~~One true silent swallow.~~ Landed.** `activity-ui.tsx` ran a bare `void navigator.clipboard.writeText(...)`, and that call rejects on denied permission, an insecure context, or an unfocused document — so failure looked exactly like success. The button now carries its own verdict for `COPY_FEEDBACK_MS` and returns to offering. A control that owes an answer, not a toast.

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

**Workstream 1 — the transport edge.** ~~Widen `SessionRouterProcedure` so non-`session.*` routers are visible to the coverage assertion (A2)~~ **done**, then add the Runtime Catalog to the allow-list and the caller context, construct it per project in `main/index.ts`, and mount `RuntimeCatalogProvider` in the app root (A1). Add the preload bridge and a tRPC link over IPC (A3). ~~Give the subscription protocol done and error frames~~ **done**; resume from `throughSequence` waits on that link, because a cursor without a reconnecting client is a resume path with nothing to resume (C2). ~~Resolve the binary through `loginShellPath()`~~ **done**, and **verify the spawned server's environment against a packaged launch** (A4). The line estimate predates all of that.

**Workstream 2 — the controller reshape.** Change the hook to `useSessionController(sessionId: string)`, delete the `started` ref and the `start()` at `:635-640`, and make the boot effect `snapshot` + `subscribe` (B1). Move `session.create` + `adapter.attach` to a store action returning a sessionId — `stores/sessions.ts` `byOwner` already models the tab set and `sessionOwner` already routes id → owner. Make `recover()` re-attach with `continuity: "native_resume"` on the same sessionId (B2). Lift `transcript` / `queued` / `selection` into a per-sessionId store slice outside React, copying `terminal/registry.ts:20` (B3). ~~Teach `terminalSessionRecord` to say "not a terminal session"~~ — it now says nothing at all, honestly, so what is left of B4 is the discriminated listing DTO that lets the sidebar show a structured Session rather than omit it. Decompose `chat-session.tsx` and de-lab the controller (D1, D2).

**Workstream 3 — the two silent failures and the weight.** Start with the frame shape: change it from full snapshot to delta, the single highest-value item in this document, which removes the 81× wire amplification, the 15 s long-task budget and the highlighting flicker together (C3, C4). Prove the win on the lab before anything moves. ~~Then add the `@source` directives to `renderer/src/globals.css` and confirm against a real built stylesheet, not a test (C1).~~ **Done.** ~~Drop math from streamdown~~ **done, dependency included**; keep mermaid, and dedupe the Shiki grammar set against `editor/shiki-langs.ts` — with mermaid retained, that dedupe is the whole remaining lever (D4). ~~Fix the clipboard swallow (D3).~~ **Done.**

**Then migrate.** The move itself is a file move plus wiring, once the above is true.

Two things must land *alongside* the move rather than after it, because they are wrong the moment a chat Session exists in the app: the preload link, and the discriminated Session listing. `terminalSessionRecord` honesty was the second of those and is done — but honesty there bought silence, not visibility, and a chat Session the sidebar cannot name is only a better failure than one it names wrongly.

## Corrections applied

Struck from `opencode-surface-audit.md` as part of this audit, having been verified false:

- **`reportError` is not a silent swallow.** It is `console.error` at `session-controller.ts:836`, but it is a *logging* helper and both call sites pair it with an on-screen state setter — `:274` with `setDiagnosticsError`, `:420` with `setCatalogState("error")` and `setCatalogError`. The comment at `:265-271` records the fix deliberately. The audit's claim that "the diagnostics query and subscription fail invisibly" no longer holds. The one silent swallow that bullet still named after that, the bare clipboard write, is fixed too (D3).

Still true and left standing: `ai-elements/code-block.tsx` has no consumer, and `#emitStreamSnapshot` records nothing when it fails.

- **`packages/shared/src/session.ts` claimed `SessionRecord` backs "the `sessions` table, migration 003".** False since 018, which reduced the row to identity alone. The docblock now says what fills the rest of the fields — `terminalSessionRecord` — and records the B4 trap at the place someone would read it before adding a field.

Two claims that did **not** survive checking, recorded so they are not re-filed as fixes:

- **`lab/lab.css:5-12` is not stale.** It asserts the shipped stylesheet never grows a utility only a scratch asked for, and the audit initially read that as contradicted by the build. Re-measured against `dist/assets/index-DjqajpAI.css`, the evidence is mixed rather than contrary: `max-h-[32vh]`, `w-[34rem]` and `max-w-[22rem]` are all **absent**, while `caret-foreground` and `opacity-35` are present. Two lab-only arbitrary values missing and two named utilities present does not establish a bleed, and it is not enough to rewrite a comment over. C1 does not depend on this either way — the ai-elements gap is consistent across five utilities. If it matters later, settle it by scan base rather than by sampling class names.
- **`createSessionRecord` does not have zero callers.** `apps/desktop/src/main/db/test-helpers.ts:127` builds the shared `SessionRecord` fixture through it, and that helper is used across the db tests. It has no *production* caller, which is a different and much less actionable statement — removing it is a test-fixture refactor, not a dead-code deletion.

## Decisions

Settled 2026-08-04, so the later session does not reopen them.

1. **Coverage: enroll the pure `.ts` modules with the move.** Repo convention holds — `.tsx` stays excluded per `vite.config.ts:99-102`. That is 5 files, 296 statements, 266 branches, and it must be *added to the 65-file allowlist explicitly*, because nothing about the move enrolls it. `session-controller.ts` is 244 of the 296 and is where transport, lifecycle and delivery correctness live; it is the reason to do this rather than an unfortunate side effect of it.
2. **Mermaid stays; math goes.** Diagram rendering is worth its weight in a coding-session product. Math has gone — out of both renderers and out of `apps/desktop/package.json`, since the branch had dropped the importers and left `@streamdown/math` in the manifest. That leaves most of the measured growth standing, so **the Shiki duplicate is now the primary bundle lever, not a secondary one** — 82 chunk names in two copies, 6.69 MiB across them, including grammars `renderer/src/editor/shiki-langs.ts:13` deliberately curated out. Dedupe against that list rather than shipping a second full grammar and theme set. Re-measure after; the +192 KiB gzip on the eager boot chunk is the number that matters, not the lazy total.
3. **The frame shape lands inside migration prep**, not as a separate project. It stays in Workstream 3 and is that workstream's first item, since C4 is downstream of it. Expect it to move a good number of the adapter's exact-object part-mapping assertions — that churn is the cost of the change and is not evidence of a regression. Land it and prove the perf win on the lab *before* anything moves, so the migration PR stays a move-and-wire.

## Coverage note

`packages/shared`, `session-engine`, `session-rpc` and `opencode-adapter` hold 100% on `src/**`, and the adapter's part-mapping tests are exact-object assertions — Workstream 3's frame-shape change will move a good number of them. Thresholds only evaluate under `--coverage`, so run `vp run -r test:coverage` before pushing; a green `vp run -r test` says nothing about it.
