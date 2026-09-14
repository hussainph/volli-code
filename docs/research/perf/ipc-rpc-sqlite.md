# IPC, Session RPC, and SQLite read performance — research

Scope: renderer↔main round trips and local-database reads in Volli Code
(Electron + React + TS, better-sqlite3/WAL owned by main, tRPC Session RPC over
`ipcRenderer.invoke` / `webContents.send`). Real-world scale this must serve:
1,198 sessions, 259,855 rows in `session_events` (173 MB of a 373 MB db),
392 tickets, 8,541 session commands; busiest single session 1,668 events;
`session_event_sequence` (29 MB) and `session_event_sequence_match` (18 MB)
also large.

Method: web_search + web_fetch for published numbers (every URL below was
actually read; fetch failures: none), `rg` to verify each "Volli already does
it" claim, plus one local probe run on this machine (Apple Silicon,
Node 24.18.0, better-sqlite3 13.0.3, synthetic `session_events`-shaped table,
~700 B rows) for the questions no published source answers at our exact shape.
Read-only on source; this document is the only new file.

## Top findings

| # | Technique | Source | Measured effect | Volli already does it? |
|---|-----------|--------|-----------------|------------------------|
| 1 | `MessagePort` / `utilityProcess` channel instead of `invoke` for hot paths | electron-bench (Aug-2026 run, Electron 43.2.0) | Small-call latency floor is ~identical (`invoke` p50 0.4 ms / p99 1.6 ms vs `MessagePort` 0.5/1.0 ms) — **latency is not the win; main-thread CPU is**: 1,672 ms (`invoke`) vs 375 ms (`MessagePort`) vs 140 ms (`utilityProcess`) on the same schedule, >10x less main work. Second study: `MessagePort` ~40% faster than `ipcRenderer` for large binary, >2x faster for 500 KB JSON; one-way backend→renderer ~50% faster | **No** — `rg` for `MessagePort\|MessageChannel\|utilityProcess` across `apps/desktop/src/{main,preload}`, renderer lib, `packages/session-rpc/src` returns zero production hits (one unrelated comment). All Session RPC is `invoke` + one `webContents.send` push channel |
| 2 | Serialization, not the hop, dominates past ~64 KB | electron-bench payload table; Electron PR #52923 (upstream IPC rewrite, merged Aug 2026) | 1 KB JSON 0.2 ms → 64 KB 1.5 ms → **1 MB JSON 21.5 ms p50 / 24.1 p99** on the same route ("payload size swamps transport choice: ~100x from 1 KB to 1 MB"). Root cause per upstream: payloads above mojo's 64 KB inline limit cost **three fresh multi-MB buffers per hop**, both main threads spending 30–40% of time in page faults. Upstream fix (serialize straight into the send buffer) cut 1 MB `invoke` round trip 4.2→2.8 ms, main→renderer 1 MB 2.7→1.6 ms, 4 MB RT 14.2→9.2 ms. Object-heavy small-record arrays are the worst shape: 1 MB renderer→main ~10.2 ms, 4 MB ~39.9 ms even after the fix | **Partially.** The `snapshot`/`projection` split (cheap state vs full transcript replay) already exists because "shipping [frames] anyway costs an artifact read per transcript event and a structured clone of the whole transcript, per read" (`packages/session-rpc/src/index.ts`, `session.snapshot` vs `session.projection`). But `snapshot()` still clones **all** frames + decoded artifacts in one reply, and anything that walks the whole event table (export, digest, retention) pays the per-hop multi-buffer cost on top of the query |
| 3 | Transfer, don't copy, binary; `SharedArrayBuffer` for true shared memory | electron-bench; electron-direct-ipc README | 1 MB `ArrayBuffer`: copied 4.1 ms p50 vs **transferred 3.2 ms**, gap widening with size. SAB gives both processes read/write on the same memory + atomics, but requires COOP/COEP headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`) | **No, and mostly rightly so.** `rg` for `transfer\|SharedArrayBuffer` is clean, and `docs/BOUNDARIES.md` rule 3 + `SessionRouterJsonSafety` deliberately keep RPC payloads JSON-safe for a future HTTP transport. SAB/transfer would violate that boundary. Only legitimate carve-out would be a non-RPC bulk path (e.g. DB export bytes), not the Session edge |
| 4 | Batch many small calls into one envelope | tRPC `httpBatchLink` docs | `Promise.all([q1, q2, q3])` → **exactly one request** via a dataLoader; `maxItems` / `maxURLLength` split oversized batches; server-side `maxBatchSize` caps | **No.** The custom terminating link (`apps/desktop/src/renderer/src/lib/session-rpc-ipc-link.ts`) issues **one `bridge.request` (one `invoke`) per operation** — no batching link in the chain. Hand-batching exists only ad hoc (preload: "one batched read backing the sidebar", `apps/desktop/src/preload/index.ts:552-555`). Boot/hydrate fan-out (projection + snapshot + model access + board reads) pays one ~0.4 ms floor + one main-thread wakeup per call |
| 5 | Per-call Zod validation is µs-scale per call; it bites on big payloads and hot loops, not on shape | LogRocket "Why is Zod so slow?" (quoting typescript-runtime-type-benchmarks: Zod v4 ~6.7 M ops/s vs AOT Typia ~76 M, Zod v3 <1 M; one gateway's CPU 80%→20% after fixing *how* Zod was used) | At ~150 ns/op-scale, validating one small command input per user gesture is noise next to a 400 µs IPC floor. The risk is validating **large** values per call: `modelAccess.inspect` re-parses the whole provider+model catalog (~1000 entries, `modelAccessSnapshotSchema.parse`) on every call, and `commandRequestSchema` + interaction schemas run on every command | **Present but unpriced.** Zod v4 (`packages/session-rpc/package.json:21`), `.parse` on every modelAccess route, input schemas on every mutation. No superjson/devalue transformer anywhere (`rg` clean) — so no transformer overhead to remove, either |
| 6 | better-sqlite3 is synchronous: a 250k-row walk blocks main for ~0.5 s; move big reads off the main thread | Local probe (below) + "Your SQLite Queries Deserve Their Own Workers" (200 ms query = 200 ms frozen server; worker-pool + queue pattern, one connection per worker) | **Measured here:** full scan of 120k ~700 B rows via `.all()`: **290 ms wall, +109 MB heap** (4.7→113.7 MB heap, RSS 66→227 MB). Linear extrapolation to 260k rows: **~630 ms, ~235 MB transient heap** — ~38 dropped frames if run on main. Indexed single-session read of 1,714 rows: **1.98 ms** — the per-session hot path is *not* the problem. `COUNT(*)` over 120k: 2.1 ms | **No.** Every query runs on main (`apps/desktop/src/main/db/index.ts` opens the one handle; no `worker_threads`, no `utilityProcess` — `rg` clean). better-sqlite3 advertises "worker thread support (for large/slow queries)"; Volli doesn't use it |
| 7 | `.all()` materializes the heap spike; `.iterate()` + row-at-a-time decode is flat at the same speed | Local probe; better-sqlite3 issue #406 (memory guarantee of `iterate()` explicitly undocumented — open question, no maintainer answer on the page) | Same 120k scan via `.iterate()` + 2× `JSON.parse` per row (mimics `decodeEvent`): **318 ms, heap flat at ~6 MB**. I.e. decode cost ≈ scan cost, and streaming removes the entire ~109 MB spike for +~10% time | **No.** `listEvents` (`sqlite-ledger.ts:455+`) accumulates `decoded` via `.all()` pages and `snapshot()` (`session-runtime.ts:1828-1844`) materializes **all** frames + **all** decoded transcript artifacts before replying. The `EVENT_PAGE_SIZE = 500` paging (`session-runtime.ts:624,2895-2913`) bounds rows *per round trip to SQLite*, not memory held |
| 8 | The PRAGMA set production better-sqlite3 apps converge on is bigger than Volli's | sqg.dev driver benchmark config (Jan 2026, i9-12900K); "Scaling SQLite with Node worker threads" (read-path pragmas); better-sqlite3 `performance.md`; get-bb #1438 (pins `cache_size`/`synchronous=1`/`mmap_size`/`busy_timeout`/WAL in a test) | Converged read-tuned set: `journal_mode=WAL` + `synchronous=NORMAL` (better-sqlite3 ships `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`, so WAL already defaults to NORMAL) + `cache_size=-64000` (64 MB) + `temp_store=MEMORY` + `mmap_size=256 MB` (+ `ANALYZE`/`PRAGMA optimize` after bulk changes). better-sqlite3's own doc adds the one operational must: watch `-wal` size, `wal_checkpoint(RESTART)` when it grows (checkpoint starvation under concurrent readers) | **Partial.** `openVolliDb` sets exactly `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL` (`apps/desktop/src/main/db/index.ts:15-18`) — and nothing else. No `cache_size` (default is 2 MB page cache — small against a 373 MB db), no `mmap_size`, no `temp_store`, no `wal_autocheckpoint`/`journal_size_limit` tuning, no `ANALYZE`/`PRAGMA optimize` anywhere (`rg` clean). Local probe: tuned cache+mmap cut a cold-ish full payload scan 100→71 ms on 120k rows |
| 9 | Prepared-statement caching removes per-call parse/plan | better-sqlite3 docs pattern; Volli's own `prepared.ts` header ("every `db.prepare(sql)` re-parses and re-plans") | No published Volli-side number, but the cost is per-call overhead on every hot statement, and plan instability across calls | **Half-done — this is a live gap.** The cache exists (`apps/desktop/src/main/db/prepared.ts`, WeakMap per handle) and repos use it — but **`sqlite-ledger.ts` bypasses it**: `getSession`, `listSessions`, `listEvents`, `getCommand`, `appendReceipt`, etc. all call `this.db.prepare(...)` inline (e.g. `sqlite-ledger.ts:95-99`, `:465-473`), re-parsing the hottest Session statements on every call |
| 10 | Covering indexes + `ANALYZE` + "metadata first, payloads late" for log-shaped reads | SQLite optimizer docs pattern (covering index serves the query from the index alone); Linear "Rebuilding the delta sync read path" (two-stage pipeline: metadata scan → access/subscription filter → fetch full payloads **only for survivors**; old path "could read and decode large JSON payloads for candidate sync actions that were later rejected") | Linear's numbers are server-side (largest workspaces ~1 M sync actions/day, catch-up of hundreds of thousands of actions, 20 TB+ log; posting-list index flattened p95/p99 where Postgres tail latency grew with candidate range), but the *shape* lesson transfers: Volli's `listEvents` selects 9 columns incl. `payload` + `LEFT JOIN session_provenances` for **every** row, while `session_events_session_sequence(session_id, sequence)` only covers 2 of them — every row pays a table lookup + JSON decode even when the caller only needs ordering/cursors | **No.** No covering index for the event read path; no `ANALYZE`; no late-enrichment split (payload + provenance decoded for all rows up front in `decodeEvent`, `sqlite-ledger.ts:801-827`) |
| 11 | Event-sourcing read cost is controlled by checkpoints/snapshots + precomputed read models, not by faster replay | Actual Budget (James Long, "Using CRDTs in the Wild"): **dual-write** — every change applies to normal query tables *and* appends to the `messages_crdt` log, so reads never replay; HLC timestamps for order; Merkle tree to find the catch-up range; **epoch squeeze** ("Reset Sync" compacts the ever-growing log into current state). Linear: checkpoint-based delta (client sends last-applied ID, server returns only what changed) + shadow-mode verification of a new read path | Actual's lesson stated explicitly: "I can still use a normal, real sqlite database… for high performance queries" *because* the log is not the read path. Volli replays: `#history` refolds **all** of a session's events from the base row on cold read, and `snapshot()` additionally does **one artifact read per transcript event** (code comment, `session-runtime.ts:350-352`) | **Partial.** Volli has the incremental half: `#histories` fold cache (8 sessions, `session-runtime.ts:626-650`), delta-only refold via `afterSequence`, 500-row paging, and an `AFTER INSERT` trigger maintaining `session_event_sequence` (migration 044, `migrations.ts:1958+`). It lacks the checkpoint half: **no snapshot/projection persistence** (every cold read refolds from event 1; busiest session = 1,668 JSON decodes + folds), no materialized read model beside the log, no log compaction/epoch |
| 12 | Push channels need coalescing (lossy, latest-wins) + backpressure; request/response needs neither | electron-direct-ipc README (throttled = "only the last value is sent on next microtask", with explicit use-when/never-use lists); Electron MessagePorts tutorial (reply-stream pattern, close event, worker-process-via-hidden-window); Volli's own pty pipeline (`pty/output.ts`: `BATCH_WINDOW_MS=8`, ack-based flow control pausing at 100k unacked chars) | Published shape guidance, not a single number: coalesce replaceable state per microtask/frame; keep guaranteed delivery for discrete events; apply backpressure at the producer (pause) rather than queueing unbounded IPC | **Split.** The **pty** path already does this right (8 ms batch window + ack watermarks). The **Session RPC push** path does not: `pumpSubscription` (`session-rpc-ipc.ts:232-256`) sends **every frame immediately** with no coalescing window, and backpressure is fail-fast — `AsyncQueue` (cap 4,096, `packages/session-rpc/src/index.ts`) closes and converts overflow into a terminal `TOO_MANY_REQUESTS` error rather than shedding load. Overlay/delta bursts during a fast turn are the most likely trigger. Coalescing exists one layer away (`session-wake.ts` 60 ms, `activity-watch.ts` default 60 ms) but not on the RPC push channel itself |

Additional notes:

- **tRPC's own overhead is unpriced in public.** I found no credible published
  micro-benchmark of tRPC server dispatch (middleware chain + `createCaller` +
  observable link) versus a hand-rolled switch. The repo's main-side dispatch
  (`callProcedure`, `session-rpc-ipc.ts:300-345`) is already a hand-rolled
  switch over `router.createCaller`, so the framework layers on the hot path
  are: one Zod input parse, one middleware (diagnostics `record`), and the
  client-side observable/link chain. Expectation (not a measurement): single-digit
  microseconds next to the ~400 µs IPC floor — measure, don't assume (see plan
  item 2). The observable/link chain's real cost is indirection for debugging,
  not latency.
- **The Linear "Scaling the Sync Engine" talk page is video-only** (no numbers
  on the page); its value here is orientation: Linear's API was *shaped by*
  sync-scaling pain (checkpoints, subscriptions, bootstrapping), which is the
  same direction as findings 10–12.
- **Boundary constraint on findings 3–4.** `docs/BOUNDARIES.md` rules 3 (JSON-safe
  payloads for a future HTTP host) and 5 (IPC as dumb transport, command→event→
  projection shape) rule out SAB/transferables on the Session edge and any
  RPC-shape change that a daemon host couldn't serve. Batching (4) survives the
  boundary if framed as a transport envelope; MessagePort/utilityProcess (1)
  survives it only as a hosting detail behind the same procedure surface.

## Directly applicable

Concrete, ordered by expected effort/impact. All line numbers verified 2026-09-13.

**A. SQLite reads (biggest measured headroom)**

1. **Tune the four missing PRAGMAs and verify with a before/after.**
   `apps/desktop/src/main/db/index.ts:15-18` sets WAL/NORMAL/busy_timeout only.
   Add `cache_size = -64000`, `mmap_size = 268435456`, `temp_store = MEMORY`
   (the sqg.dev/dev.to converged set), then A/B the cold-start and
   full-session-snapshot timings from the measurement plan. Also consider
   `wal_autocheckpoint` / `journal_size_limit` bounds: with 173 MB of events
   plus 47 MB of sidecar, an unbounded `-wal` is the failure mode
   better-sqlite3's own `performance.md` warns about; the codebase already
   checkpoints-then-backs-up before migrations (`migrations.ts` runner) but has
   no steady-state WAL-size watchdog.
2. **Route `sqlite-ledger.ts` through the statement cache.**
   `apps/desktop/src/main/db/prepared.ts` exists for exactly this, but every
   statement in `apps/desktop/src/main/session-control/sqlite-ledger.ts`
   (`getSession` ~:95, `listSessions` ~:103, `listEvents` ~:465, receipts,
   usage) calls `this.db.prepare(...)` inline. Mechanical change, zero
   behavior difference; measure per-call µs on the 1,668-event session read.
3. **Run `ANALYZE` (or `PRAGMA optimize`) after migrations and on a schedule.**
   No call site exists today. The planner currently chooses joins/plans for
   `session_events ⋈ session_provenances` and the wake/ranking window queries
   (`sqlite-ledger.ts:151-230`) with default statistics on a 260k-row table
   whose size distribution changed under it. Cheap, reversible, measurable via
   `EXPLAIN QUERY PLAN` before/after.
4. **Split the event read into metadata-first, payload-late (Linear's lesson).**
   `listEvents` selects `payload` + joins provenance for every row, then
   `decodeEvent` (`sqlite-ledger.ts:801-827`) parses both JSON blobs per row —
   the probe shows decode ≈ scan cost. Callers that only need cursors/ordering
   (`#listEventsPaged` advance, `#result`'s latest-sequence walk at
   `session-runtime.ts:2880-2893`, wake matching on the `kind` sidecar) should
   read `(sequence, id)` first and fetch payloads only for rows that survive
   filtering. The `session_event_sequence(session_id, kind, sequence)` match
   index (`migrations.ts:1968+`) already covers the wake filter — use it
   instead of decoding payloads to match kinds.
5. **Stream, don't materialize, full-log walks.** `listEvents`'s `.all()` +
   refill loop and `snapshot()`'s frames+transcript arrays hold the whole log
   decoded at once (probe: +109 MB heap per 120k rows). For export/digest/
   retention walks, expose an `iterate()`-backed cursor; for `snapshot()`,
   consider capping initial frames (window) + subscribe-from-cursor, since the
   subscriber path already supports `afterSequence` resume.

**B. Projection / event-sourcing reads**

6. **Persist checkpoints: a `session_projections` (or `session_snapshots`)
   table.** Today a cold `#history` (`session-runtime.ts:2956-2980`) refolds
   from event 1 plus one artifact read per transcript event
   (`#frame`, `:2866-2868`; `snapshot()`, `:1828-1844`). A checkpoint row
   `(session_id, through_sequence, projection_json, updated_at)` written when a
   session goes quiet (attachment close/release — the existing overlay drop
   points at `:633-650` give the hook) turns the 1,668-event worst case into
   "read one row + replay the tail". This is Actual's epoch squeeze applied
   per-session, and it composes with the existing LRU (`PROJECTION_CACHE_LIMIT
   = 8`, `:626-631`) rather than replacing it.
7. **Precompute the sidebar/board read models instead of folding per ticket.**
   Preload already hand-batches two sidebar reads (`preload/index.ts:552-555`);
   if those (or the "latest durable outcome per ticket") fold Session state,
   maintain them as `INSERT`-triggered rollups like `session_event_sequence`
   rather than recomputing per render. Same pattern as the existing trigger,
   new rollup table.

**C. IPC + RPC**

8. **Add envelope batching to the Session IPC link before reaching for
   MessagePort.** Per finding 1, small-call latency won't move with a transport
   swap; what batching buys is fewer main-thread wakeups during boot/hydrate
   fan-out. Shape: client-side dataLoader over `bridge.request` (same idea as
   tRPC's `httpBatchLink`: concurrent ops in one tick → one `invoke` with an
   array envelope; main fans out to `callProcedure` and returns an array).
   Stays inside BOUNDARIES rule 5 (dumb transport) and needs no procedure
   changes. Measure boot `invoke` count first (plan item 1) to size the prize.
9. **Skip per-call Zod on the hottest tiny routes only if measurement says so —
   but dedupe the catalog parse now.** `modelAccess.inspect` parses the entire
   ~1000-entry catalog (`modelAccessSnapshotSchema.parse`) per call; validate
   once at catalog-refresh time and serve the parsed snapshot, or validate the
   catalog incrementally. Leave per-command input schemas alone (cheap, and
   they're the security seam).
10. **Do not chase MessagePort/utilityProcess/SAB for the Session edge until
    8 + A-items land.** Finding 1 says the latency prize is ~0 for small calls
    and the CPU prize only matters if main is saturated *by IPC*; current
    evidence points at SQLite-on-main (finding 6) as the saturation source.
    The one exception: if a worker/utility process ever hosts reads (A-items),
    reach it over `MessagePort` (`webContents.postMessage` handoff per the
    Electron tutorial) rather than relaying through main's `ipcMain` handlers.

**D. Push channel**

11. **Coalesce overlay bursts on the push path; keep frames guaranteed.**
    Mirror the direct-ipc throttled/guaranteed split: durable frames keep
    exactly-once ordered delivery (existing `AsyncQueue` + resume-by-`lastEventId`
    contract in `session-rpc-ipc-link.ts`), while transient overlays
    (`part.append` bursts — the stream-cost probe shows 39 deltas → 41 overlays
    per turn) coalesce per microtask/frame before `owner.send`, the same way
    `pty/output.ts:12` batches at 8 ms. Overflow today is a terminal error by
    design (documented at `packages/session-rpc/src/index.ts`, `AsyncQueue`);
    coalescing moves the ceiling without weakening that contract.
12. **Add renderer-side frame-batch rendering to match.** The push side can only
    help if the chat store applies a burst of `onData` emissions in one React
    update; otherwise N frames = N renders regardless of transport. The
    `chat-window-bench.mjs` harness (10 sessions × 2000 turns) is the place to
    prove it.

## Measurement plan

Precedent to copy: `packages/session-engine/src/stream-cost.bench.test.ts`
(checks in numbers via `console.log` probe + pins behavior with assertions),
`apps/desktop/e2e/agent-cli-token-bench.mjs` (budget ceilings as contract),
`apps/desktop/e2e/chat-window-bench.mjs` + `e2e/bench/chat-window/` (real
Electron renderer, before/after arms via `git checkout`, "numbers from one
machine are comparable to each other and to nothing else — run both arms back
to back").

1. **IPC floor vs payload curve in *this* app.** Extend the
   `e2e/bench/chat-window/electron-main.cjs` harness (or add
   `e2e/bench/session-rpc/`) to time `sessionRpc` round trips at
   1 KB / 64 KB / 1 MB JSON plus a 1,668-frame synthetic snapshot reply.
   Compare against the electron-bench baselines (0.4 ms invoke p50; 21.5 ms
   for 1 MB JSON). This sizes findings 2 and 8: if the snapshot reply costs
   tens of ms of clone time, projection-first + subscribe (already built)
   should become the default open path everywhere.
2. **tRPC + Zod per-call cost.** A vitest bench (same style as
   `stream-cost.bench.test.ts`) over `router.createCaller` dispatch of
   `session.projection` + `commandRequestSchema.parse` of a small command +
   `modelAccessSnapshotSchema.parse` of a 1,000-model fixture. Expectation:
   single-digit µs for dispatch, measurable ms only for the catalog parse —
   which decides finding 9's second half. No published tRPC-vs-hand-rolled
   benchmark exists, so this repo has to mint its own number.
3. **SQLite A/B on a copy of the real profile.** Copy the 373 MB `volli.db`,
   open with `openVolliDb`, and time: (a) `listEvents` full read of the
   1,668-event session; (b) `snapshot()` wall time incl. artifact reads;
   (c) the wake/ranking queries at `sqlite-ledger.ts:151-230`;
   (d) `PRAGMA wal_checkpoint(TRUNCATE)` time and `-wal` size;
   (e) `EXPLAIN QUERY PLAN` on each before/after `ANALYZE`.
   Then flip `cache_size`/`mmap_size`/`temp_store` (finding A.1) and prepared-
   cache routing (A.2) and re-run — the chat-window-bench before/after ritual
   (`git checkout origin/main -- <paths>`, `--label before/after`) ports
   directly. My scratch probe (120k rows: 290 ms `.all()` + 109 MB heap;
   2 ms indexed 1,714-row read; 100→71 ms cold scan with tuned cache) is the
   template; it was deleted after use (was `.bench-tmp/`, better-sqlite3
   13.0.3, Node 24.18.0) and should be re-created against the real db shape.
4. **Projection fold cost in isolation.** Bench `foldHistory`/`projectSession`
   over the 1,668-event session's decoded events (in-memory, no SQLite, no
   artifacts) to split "replay CPU" from "read + decode". Decides whether
   finding B.6 (checkpoint table) or A.4 (late payloads) pays more: if fold
   dominates, checkpoint; if decode dominates, late-enrich.
5. **Push-channel headroom.** In a test, shrink `AsyncQueue` capacity
   (constructor arg, default 4,096) and replay a fast turn's emission mix from
   the stream-cost probe (39 deltas → 41 overlays + 3 durable) at N× speed to
   find the overflow threshold; then add overlay coalescing (D.11) and show the
   threshold moving. Assert bytes with the probe's existing amplification
   logging (`subscriber amplification (total / final)`).
6. **Boot `invoke` census.** Count Session RPC + raw IPC calls during a cold
   boot and a session open (log at `bridge.request` / `preload/index.ts`
   `invoke`). If boot issues dozens of small invokes, finding 8's batching
   envelope has a priced prize; if it's a handful of big ones, finding 2's
   payload work wins instead.

## Sources

Every URL below was read via web_fetch for this task. (Search-result snippets
that were never opened are not cited anywhere above.)

- https://github.com/ZacWalk/electron-bench — per-route p50/p99 + main-process CPU; MessagePort/utilityProcess vs invoke; payload-size table; transfer-vs-copy
- https://github.com/johnnyd710/electron-ipc-tests — MessagePort vs ipcRenderer latency/throughput, JSON vs binary, transferables
- https://github.com/electron/electron/pull/52923 — upstream IPC serialization rewrite: triple-buffer cost >64 KB, before/after ms, contextBridge per-value overhead
- https://electronjs.org/docs/latest/tutorial/message-ports — MessageChannelMain, port transfer via postMessage only, reply-stream + worker-process patterns
- https://github.com/jjeff/electron-direct-ipc/blob/main/README.md — throttled (lossy latest-only) vs guaranteed messaging, SAB + transferables, utility-process pattern
- https://trpc.io/docs/client/links/httpBatchLink — dataLoader batching, maxItems/maxURLLength, server maxBatchSize
- https://blog.logrocket.com/why-zod-slow/ — Zod interpreter-vs-AOT architecture, v4 ~6.7 M vs Typia ~76 M ops/s, production CPU anecdote
- https://github.com/WiseLibs/better-sqlite3/blob/HEAD/docs/performance.md — WAL guidance, NORMAL default under WAL, checkpoint-starvation watchdog
- https://github.com/WiseLibs/better-sqlite3/issues/406 — `iterate()` memory guarantee is undocumented (open question; complements the local probe)
- https://dev.to/lovestaco/scaling-sqlite-with-node-worker-threads-and-better-sqlite3-4189 — one connection per worker, read pragmas, PK-vs-secondary 155x, ANALYZE/`PRAGMA optimize`
- https://dev.to/lovestaco/your-sqlite-queries-deserve-their-own-workers-jd7 — sync-freeze framing, worker pool + queue implementation
- https://sqg.dev/blog/sqlite-driver-benchmark/ — better-sqlite3 vs node:sqlite vs libsql vs Turso numbers; converged PRAGMA set
- https://github.com/get-bb/bb/commit/d5175bdf515d8f9672f8984b0092326bee9c120d — production app pinning hot-path SQLite pragmas (cache/mmap/synchronous/busy_timeout/WAL) under test
- https://linear.app/now/rebuilding-delta-sync-read-path — checkpoint delta sync, metadata-scan → late enrichment, shadow verification, flat tail latency
- https://linear.app/now/scaling-the-linear-sync-engine — talk page (video only, no numbers); orientation that sync scale shaped Linear's API
- https://archive.jlongster.com/using-crdts-in-the-wild — Actual Budget: dual-write log + query tables, HLC order, Merkle catch-up, epoch squeeze
