# VC-355 — Session RPC, push, SQLite, and projection checkpoints

Measured 2026-09-14 on an Apple M1 (8 cores), 16 GB RAM, macOS 26.5.1,
Node 24.18.0, Electron 44.0.0, better-sqlite3 13.0.3, at `4f5dbae1` plus the
review-response changes described below.

**Read every table with this caveat.** Other Volli agent sessions were running
throughout, so absolute timings here are the pessimistic end of this machine's
range and are NOT comparable to the earlier 2026-09-13 run in this ticket's
history. Every claim below is instead a comparison of **arms measured back to
back inside one command**, which is what contention cannot forge: both arms pay
the same tax.

The input was a consistent copy of the owner's profile, taken with the SQLite
backup API and never read from the live file:

| table/shape | count |
|---|---:|
| Sessions | 1,350 |
| `session_events` | 291,617 |
| Session commands | 9,403 |
| busiest Session | 2,796 events |
| serialized payload + provenance in the joined event scan | 162.06 MB |

No profile contents are included in the scripts or results.

## Reusable measurements

The following commands print a human summary and a sentinel-wrapped JSON
artifact. They are intentionally outside the normal test suite.

```sh
# Electron transport, payload curve, and push burst
node apps/desktop/e2e/session-rpc-bench.mjs --repetitions 300 --frames 20000

# Add the blocking SQLite arm against a disposable, consistent DB copy. The
# renderer reports animation-frame gaps AND the latency of one ordinary round
# trip issued while main is inside the synchronous scan.
node apps/desktop/e2e/session-rpc-bench.mjs \
  --database /path/to/a/disposable/volli.db.copy --frames 20000

# The real renderer tRPC link and its pre-ack buffer. This runs two arms: the
# observer-free arm is the published throughput; the observer-enabled arm
# measures the cost of optional JSON byte accounting.
node apps/desktop/e2e/session-rpc-link-bench.mjs --frames 20000

# SQLite, router, checkpoint, listing, and real transcript payload
node --expose-gc apps/desktop/e2e/session-rpc-sqlite-bench.mjs \
  --database /path/to/a/consistent/volli.db.copy \
  --transcripts /path/to/that/profiles/session-transcripts

# Five real UI interaction counts. This profile is modified by app boot, so
# each arm needs its own fresh copy or the second arm inherits the first arm's
# restored workspace (see "Routine interaction call counts").
cd apps/desktop && vp run build
node e2e/session-rpc-interaction-bench.mjs \
  --label before --profile /path/to/a/disposable/profile --ticket-query VC-358 \
  | tee /tmp/vc355-interactions-before.log
node e2e/session-rpc-interaction-bench.mjs \
  --label after --profile /path/to/another/fresh/copy --ticket-query VC-358 \
  | tee /tmp/vc355-interactions-after.log
```

For a harness that already drives the app, install
`globalThis.__VOLLI_SESSION_RPC_PERFORMANCE__` with an init script before the
renderer modules load. Its `record(sample)` receives payload-free samples from
`session-rpc-ipc-link.ts`: procedure, outcome, elapsed time, request/response
byte counts, push-handler cost, disposition, `awaitingAck`, and buffered-frame
count. `createSessionRpcClient` also accepts the same observer explicitly.
`RegisterSessionRpcIpcOptions.performanceObserver` reports the main-side tRPC +
Zod + handler interval. Both edges read their clock and isolate observer
failures through one shared rule (`@volli/shared`'s
`readOptionalPerformanceClock` / `isolatePerformanceObserver`): if either clock
endpoint fails, the sample is dropped rather than published as a
plausible-looking zero, and a throwing observer never changes the path it
measures. Ordinary windows have no benchmark global and no observer work.

## One round trip, by stage

The transport script uses an equal-size echo. Renderer and main clocks are not
reliably aligned below one millisecond, so the inbound/outbound clone legs are
reported as equal halves of the non-handler `ipcRenderer.invoke` interval. The
preload/contextBridge legs were below the renderer's 0.1 ms clock resolution.
The router and database stages were measured independently in the same run and
must not be treated as cycle-accurate nesting.

| stage | warmed p50 | p95 | interpretation |
|---|---:|---:|---|
| renderer → preload | <0.1 ms | <0.1 ms | below timer resolution |
| invoke + structured clone in, empty echo (inferred) | 0.050 ms | 0.100 ms | half of symmetric invoke interval |
| tRPC dispatch + actual Zod parse, excluding warm handler | 0.065 ms | 0.094 ms | `SessionRouterJsonSafety` is erased TypeScript, not runtime work |
| warm `session.projection` handler | 0.068 ms | 0.294 ms | live runtime cache, no new event |
| metadata-only latest-sequence SQLite query | 0.0026 ms | 0.0037 ms | prepared indexed `MAX(sequence)` |
| invoke + structured clone out, empty echo (inferred) | 0.050 ms | 0.100 ms | half of symmetric invoke interval |
| preload → renderer | <0.1 ms | <0.1 ms | below timer resolution |

A warmed small call is therefore roughly **0.23 ms** of measured component time
on a contended machine. **The split the Ticket asked for: transport is not the
cost.** Clone and preload together are about 0.1 ms and do not grow until the
payload does; what varies by three orders of magnitude between a warm
`session.projection` (0.068 ms) and a full `session.snapshot` (1,965 ms, below)
is the handler and its payload. This is a database and payload ticket wearing
an RPC hat.

### Payload curve

| equal payload each direction | round-trip p50 | p95 |
|---:|---:|---:|
| 0 B | 0.100 ms | 0.200 ms |
| 1 KiB | 0.100 ms | 0.200 ms |
| 16 KiB | 0.100 ms | 0.300 ms |
| 256 KiB | 0.300 ms | 0.700 ms |
| 1 MiB | 1.000 ms | 2.500 ms |

The curve is flat to 16 KiB and then linear in bytes: about **1 ms per MiB per
direction**. The real 2,796-event `session.snapshot` response was 10,611,439
bytes and cost 1,965 ms p50 / 4,540 ms p95 measured at the router, before
Electron clone. Reading the curve, its one-way clone is ≈10 ms — that is 0.5%
of the call. Snapshot cost is transcript artifact I/O, event decoding, and
response construction; **changing the Session transport would not fix it, and
neither would compression or a transferable.** Pagination or a
metadata-first/frame-late snapshot is the remaining lever, and it is the
largest single number in this document.

## Routine interaction call counts

Three dynamic runs of the same instrumented build. Arms 1 and 2 each started
from their own fresh copy of the same profile; arm 3 reused arm 1's profile
after it had been booted once, and is included precisely because it shows what
that does.

| interaction | before (fresh) | after (fresh) | after (warm workspace) |
|---|---:|---:|---:|
| app boot with a restored chat | 8 | 6 | 8 |
| open a ticket | 2 | 0 | 0 |
| open a previously closed long chat | 6 | 6 | 4 |
| switch from ticket tab back to connected chat | 4 | 4 | 4 |
| open sidebar | 0 | 0 | 0 |

**No round trip in any arm is per-Session.** The N+1 hunt the Ticket asked for
came back negative against 1,350 Sessions: the largest count anywhere is eight,
and the procedure lists contain no repeated per-Session call. This is the
finding, and it is why no batching was added here.

Read the differences between arms as harness resolution, not as an effect of
this change:

- The recurring shape is four Model Access reads on chat activation —
  `modelAccess.pickerView`, `modelAccess.hiddenModels`, `modelAccess.defaults`,
  `modelAccess.inspect` — plus `session.snapshot` + `session.subscribe` when a
  chat is actually opened. That accounts for every count in the table.
- `appBoot` moved 8 → 6 and `openTicket` 2 → 0 between two runs of the **same
  build**: the catalog reads are asynchronous and land in whichever fixed wait
  window the harness is in. Boot-window counts are therefore ±2 run to run,
  which is larger than any effect this change could have.
- Arm 3's `openLongChat` is 4 rather than 6 because that chat was already
  restored and connected at boot, so its snapshot and subscribe were already
  counted under `appBoot`.

This branch edits no renderer call site, so the honest conclusion is the one
the numbers support: **the change adds no round trips**, and the four parallel
Model Access reads remain the only coalescing candidate. They are not batched
here — doing so would couple independent settings and catalog lifetimes for a
saving of roughly 0.2 ms per activation.

`openSidebar` issues **zero** Session RPC calls, independently confirming the
finding VC-359 reported from the other side.

## Push channel

A 20,000-frame burst (256-byte body, four multiplexed Sessions) through real
Electron IPC completed at 190,658 frames/s. Main consumed 87.0 ms CPU over
104.8 ms wall time, its event-loop-delay maximum was 4.15 ms, and the
renderer's payload-free callback averaged 0.0002 ms. The renderer recorded zero
dropped animation frames; its largest frame gap was 16.7 ms.

The real tRPC link, measured without Electron in two fresh, otherwise-identical
arms:

| link arm | 20,000 live frames | frames/s | handler mean |
|---|---:|---:|---:|
| observer-free (published throughput) | 9.84 ms | 2,033,433 | not measured |
| observer-enabled (instrumentation cost) | 37.13 ms | 538,640 | 0.00044 ms |

The observer costs **3.8× throughput**, because it stringifies every event for
byte accounting. That is the entire reason the two arms exist: quoting the
enabled arm as link throughput would understate the link by that factor.

Both arms ran a deliberately adversarial 400-frame-before-ack burst. Both
reached `maxPreAckBacklog = 400`, then drained in order and consumed all 20,400
frames. Every production interaction arm above reported `maxPreAckBacklog = 0`:
the buffer can hold a meaningful backlog when one is manufactured, but the real
acknowledgement window never produced one.

Verdict: **the one multiplexed push channel is not a bottleneck at Session
streaming rates**, by three orders of magnitude. Do not add a `MessagePort` or
coalescing that would weaken ordered frames or receipts.

## SQLite and main-thread jank

### Cheap wins

The desktop applies a 64 MiB cache ceiling, 256 MiB mmap ceiling, in-memory
temp storage, a 400-page WAL autocheckpoint, bounded planner analysis after
migrations, and routes the Session ledger through the existing per-handle
prepared cache. PRAGMA tuning is a ceiling, not a fix for an already-indexed
query; prepared-statement reuse is the part that showed up:

| latest-sequence query | p50 | p95 | mean |
|---|---:|---:|---:|
| cached statement | 0.0026 ms | 0.0037 ms | 0.0065 ms |

`internSessionEventProvenance` ran `db.prepare` directly on **every appended
event** and now goes through the same cache; it was found by a test that asserts
the whole write/read cycle re-prepares nothing, rather than by inspection.

### Metadata-first, payload-late

`listEvents` joins `session_provenances` and JSON-decodes one provenance per
row. A projection fold never reads that field — the reducer switches on
`payload.kind` — so `listProjectionEvents` returns the same rows, in the same
order, with the same payload decode and no provenance at all. Same Session
(2,796 events), the two reads back to back in one command:

| read of the busiest Session | p50 | p95 | mean |
|---|---:|---:|---:|
| `listEvents` (audit: joins + decodes provenance) | 42.03 ms | 134.14 ms | 54.26 ms |
| `listProjectionEvents` (fold: neither) | 17.00 ms | 64.38 ms | 26.95 ms |

**2.5× faster, 25 ms saved per cold read of one long Session**, purely by not
answering a question the caller did not ask. `SessionEngine.getSession` and
`listSessions` use the fold read, which is the path that folds every Session in
a listing. `SessionRuntime` deliberately keeps the audit read: its stream frames
carry `event.provenance` to the renderer, so for the runtime the field is not
waste.

### Whole-log materialization

The same joined, JSON-decoding scan, back to back:

| 291,617-row scan | elapsed | heap delta | event-loop max |
|---|---:|---:|---:|
| `.all()` raw rows, then decode | 6,155 ms | +549.7 MB | 6,161 ms |
| `.iterate()`, decode while accumulating | 4,167 ms | +325.1 MB | 4,169 ms |

`iterate()` removed 225 MB (41%) of peak heap and 1,989 ms (32%) here, but it
did **not** make a whole-log operation safe on main: the synchronous work still
blocked its event loop for 4.2 seconds. The indexed single-Session read stayed
at 4.17 ms p50. “better-sqlite3 on main” is not the problem; unbounded
materialization is.

### Does it jank the renderer? — the load-bearing answer

The transport benchmark runs the blocking scan in main while the renderer drives
`requestAnimationFrame` and, at the same time, issues one ordinary round trip.

| during a 3,249 ms blocking main-thread scan | measured |
|---|---:|
| renderer animation frames observed | 200 |
| renderer frames dropped | 1 |
| largest renderer frame gap | 31.4 ms |
| **one ordinary round trip issued during the scan** | **3,250.9 ms** |

(An independent earlier run of the same arm: 2,728 ms scan, 170 frames, **0**
dropped, 17.7 ms largest gap.)

**The renderer does not stop painting — it stops being answered.** Renderer
paint is a separate process with its own compositor, so a blocked main thread
costs roughly one frame. What it actually costs is every renderer→main round
trip for the *entire* duration: the probe waited 3,250.9 ms for a call whose
warm cost is 0.23 ms, a 14,000× stall. Framing this as "jank" understates it;
the symptom is an application that paints smoothly and answers nothing.

Recommendation, costed by the measurements:

1. **Keep indexed and checkpoint reads on main.** 4.17 ms p50 for the largest
   Session, 0.0026 ms for a metadata head. Moving these to a `utilityProcess`
   or worker buys nothing and adds a process boundary, serialization, and
   failure modes.
2. **Keep whole-log maintenance off interactive paths.** This is the real rule,
   and it is now enforceable: the expensive shapes are named and measured.
3. **If a whole-log walk is ever unavoidable, run it in a `utilityProcess` and
   return only its aggregate.** The cost is not the 4.2 s of compute — that is
   paid either way — but main's 4.2 s of unanswered IPC, which is what the
   worker removes. Do not send the decoded log back: it retains ≈325 MB and the
   payload curve prices the transfer at seconds.
4. **Indexes cannot help an intentional whole-log walk.** The two shipped levers
   are the metadata-only event head, and the fold read that skips provenance.

No such walk is on an interactive path today: `rebuildUsageProjection` is the
one whole-log operation in the Session ledger, it is explicit maintenance, and
it now streams in 512-row keyset pages instead of materializing every matching
row.

## Projection checkpoints

Migration 047 adds `session_projection_checkpoints` with schema version,
through-sequence, checkpoint JSON, SHA-256 digest, and update time. Migration
048 adds repair-invalidation triggers separately so profiles that opened during
the pre-release v47 lineage also converge. The checkpoint contains the complete
public projection plus hidden pending executor-start state and the **unrounded**
usage accumulator. It is written after a full fold, a tail advance, attachment
close/failure, and runtime shutdown.

Reads validate version, event-kind vocabulary, Session id, digest, sequence, and
durable-history bound. Missing, malformed, corrupt, unsupported, or ahead
checkpoints are cache misses that fall back to the immutable event log. Writes
are monotonic. SQLite and in-memory transactions both roll checkpoint changes
back with their facts, and both validate through one shared assertion so the two
adapters cannot drift.

Both fold arms below run with checkpoint persistence disabled, so the two
intervals compare the same work — a full fold is not charged for a cache write
that a checkpoint hit never performs. Persistence is its own arm.

| real-profile operation | full fold | checkpoint | change |
|---|---:|---:|---:|
| cold projection, 2,796-event Session p50 | 47.20 ms | 0.512 ms | **92× faster** |
| cold projection p95 | 82.43 ms | 1.683 ms | 49× faster |
| list/project all 1,350 Sessions | 2,900 ms | 213.7 ms p50 | **13.6× faster** |
| writing one checkpoint (separate arm) | — | 3.39 ms p50 | cost of the write |

The 1,350 checkpoint rows used 13,325,577 bytes of JSON (largest 95,561 bytes),
about 12.7 MiB — 3.1% of the 421 MB profile, to remove 2.7 seconds from a full
listing.

`SessionEngine.getSession` and `listSessions`, not only the runtime LRU, resume
from these rows, which removes the former listing refold. A checkpoint hit
fetches and folds only events after `throughSequence`. Those read APIs do not
populate or advance the cache as a side effect; runtime durable boundaries and
the explicit checkpoint API own writes.

Three correctness properties are worth naming because each is a way a cache can
lie about money or identity:

- **Money.** The checkpoint stores the unrounded cost accumulator, not the
  rounded public summary. Adding rounded summaries at a split charges the same
  operation twice at display precision; three sub-micro-dollar events fold to
  the same total through every possible split point.
- **Identity.** A checkpoint hit projects the **live** Session row for
  row-backed fields while keeping event-projected fields (notably a retitle)
  authoritative. A host without SQLite's invalidation triggers therefore cannot
  serve a stale `ticketId` out of the cache.
- **Vocabulary.** The checkpoint records the exact event-kind vocabulary that
  produced it. A build that adds or retires a kind cannot reuse a fold made when
  a skipped kind was unknown, which is the case where a silently-dropped event
  would have become permanently invisible.

Failures are recovered **and reported**. Every checkpoint read, fold, and write
failure falls back to the immutable log, so none of them can fail a read — which
is exactly why they need a diagnostics seam
(`onProjectionCheckpointFailure`, wired to a throttled host reporter). A cache
that misses permanently is otherwise indistinguishable from one that is cold,
and the only symptom would be that opening a long chat never got faster.

## Is `json-safe` validation measurable?

`SessionRouterJsonSafety` is an **erased type alias**: it is a compile-time
proof that the router's payloads are JSON-representable and performs no runtime
traversal. The runtime cost at the boundary is tRPC dispatch plus Zod input
parsing, measured as the difference between the router caller and the runtime
handler in the same run:

| | p50 | p95 |
|---|---:|---:|
| router (tRPC dispatch + Zod) + handler | 0.133 ms | 0.388 ms |
| handler alone | 0.068 ms | 0.294 ms |
| **validation + dispatch overhead** | **0.065 ms** | **0.094 ms** |

**Recommendation: keep it exactly as it is.** The Ticket's trigger for a design
conversation was validation reaching ~40% of a *hot* call. It is ~49% of
`session.projection` — but that call's whole cost is 0.133 ms, so the share is
large only because the denominator is nearly free. Against the calls that
actually cost the user anything it is a rounding error: 0.003% of the 1,965 ms
snapshot. A fixed 0.065 ms is the right price for a correctness boundary that
keeps structured clone from admitting values JSON would silently drop, and
sampling it in production would trade a real guarantee for an unmeasurable
saving.

## Architectural verdict

- **Preserve the tRPC/Electron Session edge.** Transport is ~0.1 ms and flat to
  16 KiB; tRPC + Zod is 0.065 ms. Neither appears in any slow path.
- **Do not replace the edge with `MessagePort`.** Nothing measured here comes
  within three orders of magnitude of the frame rate that would justify it.
- **Preserve synchronous better-sqlite3 for bounded indexed work**, and keep
  whole-log materialization off interactive paths. The cost of getting that
  wrong is not dropped frames; it is every round trip stalling for the length of
  the scan.
- **The remaining largest number is the legacy full snapshot**: 10.6 MB and
  1,965 ms p50, of which the transport is ≈10 ms. A metadata-first/frame-late
  snapshot is the next change if that path stays a visible symptom, and it is a
  payload change, not a transport one.
