# VC-355 — Session RPC, push, SQLite, and projection checkpoints

Measured 2026-09-13 on an Apple M1 (8 cores), 16 GB RAM, macOS 26.5.1,
Node 24.18.0, Electron 44.0.0, better-sqlite3 13.0.3. The checkout was at
`463f2a9f` plus the instrumentation described below. Other Volli worktrees were
active, so only back-to-back arms in the same command should be compared.

The input was a consistent copy of the owner's profile, never the live file:

| table/shape | count |
|---|---:|
| Sessions | 1,218 |
| `session_events` | 261,741 |
| Session commands | 8,640 |
| busiest Session | 1,668 events |
| serialized payload + provenance in the joined event scan | 146.52 MB |

No profile contents are included in the scripts or results.

## Reusable measurements

The following commands print a human summary and a sentinel-wrapped JSON
artifact. They are intentionally outside the normal test suite.

```sh
# Electron transport, payload curve, and push burst
node apps/desktop/e2e/session-rpc-bench.mjs --repetitions 300 --frames 20000

# The real renderer tRPC link and its pre-ack buffer, without Electron
node apps/desktop/e2e/session-rpc-link-bench.mjs --frames 20000

# SQLite, router, checkpoint, listing, and real transcript payload
node --expose-gc apps/desktop/e2e/session-rpc-sqlite-bench.mjs \
  --database /path/to/a/consistent/volli.db.copy \
  --transcripts /path/to/that/profiles/session-transcripts

# Five real UI interaction counts. This profile is modified by app boot.
cd apps/desktop && vp run build
node e2e/session-rpc-interaction-bench.mjs \
  --profile /path/to/a/disposable/profile --ticket-query VC-293
```

For a harness that already drives the app, install
`globalThis.__VOLLI_SESSION_RPC_PERFORMANCE__` with an init script before the
renderer modules load. Its `record(sample)` receives payload-free samples from
`session-rpc-ipc-link.ts`: procedure, outcome, elapsed time, request/response
byte counts, push-handler cost, disposition, `awaitingAck`, and buffered-frame
count. `createSessionRpcClient` also accepts the same observer explicitly.
`RegisterSessionRpcIpcOptions.performanceObserver` reports the main-side tRPC +
Zod + handler interval. Observer failures are isolated from the RPC result.

## One round trip, by stage

The transport script uses an equal-size echo. Renderer and main clocks are not
reliably aligned below one millisecond, so inbound/outbound clone legs are
reported as equal halves of the non-handler `ipcRenderer.invoke` interval. The
preload/contextBridge legs were below the renderer's 0.1 ms clock resolution.
The router and database stages were measured independently in the same run and
must not be treated as cycle-accurate nesting.

| stage | warmed p50 | p95 | interpretation |
|---|---:|---:|---|
| renderer → preload | <0.1 ms | <0.1 ms | below timer resolution |
| invoke + structured clone in, empty echo (inferred) | 0.050 ms | 0.100 ms | half of symmetric invoke interval |
| tRPC dispatch + actual Zod parse, excluding warm handler | 0.021 ms | 0.130 ms | `SessionRouterJsonSafety` is erased TypeScript, not runtime work |
| warm `session.projection` handler | 0.022 ms | 0.047 ms | live runtime cache, no new event |
| metadata-only latest-sequence SQLite query | 0.0027 ms | 0.0185 ms | prepared indexed `MAX(sequence)` |
| invoke + structured clone out, empty echo (inferred) | 0.050 ms | 0.100 ms | half of symmetric invoke interval |
| preload → renderer | <0.1 ms | <0.1 ms | below timer resolution |

A warmed small call is therefore roughly 0.14 ms of measured component time.
The handler/database or the response size, not tRPC or preload, determines the
cost of real calls.

### Payload curve

| equal payload each direction | round-trip p50 | p95 |
|---:|---:|---:|
| 0 B | 0.100 ms | 0.200 ms |
| 1 KiB | 0.100 ms | 0.100 ms |
| 16 KiB | 0.100 ms | 0.200 ms |
| 256 KiB | 0.200 ms | 0.300 ms |
| 1 MiB | 0.700 ms | 1.000 ms |

The real 1,668-event `session.snapshot` response was 4,242,412 bytes and cost
269 ms p50 / 1,236 ms p95 before Electron clone. A linear reading of the curve
puts its one-way clone at only a few milliseconds. Snapshot time is transcript
artifact I/O, event decoding, and response construction; changing the Session
transport would not fix it. `session.projection` is the metadata/state path and
now resumes from a checkpoint. The legacy snapshot still deliberately loads all
frames for callers that request transcript history; pagination or a
metadata-first/frame-late snapshot is the next change if this path remains a
visible symptom.

## Routine interaction call counts

These were captured from a built app using a disposable copy of the real
profile. The long-chat sample had 1,178 events. The backend optimization did not
change renderer call sites, so the pre-change count from the unchanged call
graph and the instrumented post-change count are identical.

| interaction | before | after | procedures after |
|---|---:|---:|---|
| app boot with a restored chat | 6 | 6 | picker view, snapshot, subscribe, hidden models, defaults, inspect |
| open a ticket | 0 | 0 | — |
| open a previously closed long chat | 6 | 6 | picker view, snapshot, subscribe, hidden models, defaults, inspect |
| switch from ticket tab back to connected chat | 4 | 4 | picker view, hidden models, defaults, inspect |
| open sidebar | 0 | 0 | — |

There is no one-call-per-Session RPC fan-out over 1,218 Sessions. The count
finding is the four parallel Model Access reads on chat activation. They are
small relative to the transcript snapshot and are not batched in this ticket:
batching them would couple independent settings and catalog lifetimes, while
the measured fixed RPC floor is about 0.1 ms.

## Push channel

A 20,000-frame burst (256-byte body, four multiplexed Sessions) through real
Electron IPC completed at 261,438 frames/s. Main consumed 65.1 ms CPU over
65.3 ms wall time, its event-loop-delay maximum was 1.83 ms, and the renderer's
payload-free callback averaged 0.00015 ms. With `backgroundThrottling` disabled,
the renderer recorded zero dropped animation frames; its largest frame gap was
16.7 ms.

The real tRPC link alone processed 20,000 live frames at 647,820 frames/s; its
measured synchronous handler averaged 0.00039 ms. A deliberately adversarial
400-frame-before-ack burst reached `maxPreAckBacklog = 400`, then drained all
400 in order and consumed all 20,400 total frames. Real routine interactions
recorded a maximum backlog of zero. The pre-ack map can hold a meaningful burst
when one is intentionally created, but the production acknowledgement window
did not do so in these runs.

Verdict: the one multiplexed push channel is not the bottleneck at Session
streaming rates. Do not add a `MessagePort` or coalescing that would weaken
ordered frames/receipts. The observer remains available so a future stream +
scroll harness can re-check renderer work with the real chat handler rather
than this payload-free consumer.

## SQLite and main-thread jank

### Cheap wins

A warmed 1,668-row indexed Session read was effectively unchanged at p50
(0.861 ms default versus 0.856 ms tuned); p95 moved from 1.086 ms to 0.983 ms.
That is expected: cache/mmap/temp PRAGMAs are ceilings, not a fix for an already
indexed query. Prepared statement reuse did matter for a tiny metadata query:

| latest-sequence query | p50 | p95 | mean |
|---|---:|---:|---:|
| prepare each call | 0.0131 ms | 0.1273 ms | 0.0400 ms |
| cached statement | 0.0024 ms | 0.0076 ms | 0.0046 ms |

The desktop now applies a 64 MiB cache ceiling, 256 MiB mmap ceiling, in-memory
temp storage, a 400-page WAL autocheckpoint, bounded planner analysis after
migrations, and routes the Session ledger through the existing per-handle
prepared cache.

### Whole-log materialization

The following arms used the same joined, JSON-decoding scan back to back:

| 261,741-row scan | elapsed | heap delta | event-loop max |
|---|---:|---:|---:|
| `.all()` raw rows, then decode | 1,848 ms | +498.5 MB | 1,850 ms |
| `.iterate()`, decode while accumulating results | 1,414 ms | +309.6 MB | 1,424 ms |

`iterate()` removed about 189 MB (38%) of peak heap and 434 ms (23%) here, but
it did **not** make a whole-log operation safe on main: synchronous work still
blocked its event loop for 1.4 seconds. Conversely, the indexed single-Session
query stayed around one millisecond. “better-sqlite3 on main” is not itself the
problem; unbounded materialization is.

Recommendation, costed by the measurements:

1. Keep indexed/checkpoint reads on main: moving a 0.86 ms query adds process
   complexity for no user-visible gain.
2. Keep whole-log maintenance off interactive paths. If one is unavoidable,
   run the scan and aggregation in a worker/utility process and return only its
   small result. End-to-end compute will still be about 1.4 seconds, but main's
   1.4-second event-loop stall is removed.
3. Do not send the decoded 146.5 MB log back from that worker. The retained
   result already costs about 310 MB, and the payload curve predicts tens of
   milliseconds of additional cloning. Aggregate or stream there.
4. Indexes cannot accelerate an intentional whole-log walk. The shipped
   metadata-only event head prevents the runtime from decoding pages just to
   learn the latest sequence.

## Projection checkpoints

Migration 047 adds `session_projection_checkpoints` with schema version,
through-sequence, checkpoint JSON, SHA-256 digest, and update time. The reducer
checkpoint contains the complete public projection plus hidden pending
executor-start state and usage accumulators. It is written after a full fold,
a tail advance, attachment close/failure, and runtime shutdown.

Reads validate version, Session id, digest, sequence, and durable-history bound.
Missing, malformed, corrupt, unsupported, or ahead checkpoints are cache misses
and fall back to the immutable event log. Repair-time updates/deletes of a
canonical Session/event/provenance prefix invalidate the derived row with
migration triggers, so a checkpoint cannot hide corruption or an out-of-band
repair. Writes are monotonic. SQLite and in-memory transactions both roll
checkpoint changes back with their facts.

| real-profile operation | before checkpoint | after checkpoint | change |
|---|---:|---:|---:|
| cold projection, 1,668-event Session p50 | 14.14 ms | 0.824 ms | 17.2× faster |
| cold projection p95 | 19.60 ms | 1.674 ms | 11.7× faster |
| list/project all 1,218 Sessions | 1,993 ms | 73.89 ms p50 | 27.0× faster |

The 1,218 checkpoint rows used 11,293,377 bytes of JSON (largest 94,918 bytes),
about 10.8 MiB. `SessionEngine.getSession` and `listSessions`, not only the
runtime LRU, resume from these rows, which removes the former listing refold.
A checkpoint hit fetches and folds only events after `throughSequence`.

## Architectural verdict

- Preserve the existing tRPC/Electron Session edge and JSON-safe type proof.
  Actual tRPC + Zod overhead is about 0.02 ms p50; `SessionRouterJsonSafety`
  itself has no runtime traversal.
- Preserve synchronous better-sqlite3 for bounded indexed work. It is below one
  millisecond on the largest Session in this profile.
- Treat whole-log materialization and legacy full snapshots as the expensive
  shapes. `iterate()` bounds duplicate raw-row memory, checkpoints remove
  repeated projection folds, and metadata queries avoid payload decode.
- Do not replace the edge with `MessagePort`; measured latency and throughput do
  not justify a second transport.
