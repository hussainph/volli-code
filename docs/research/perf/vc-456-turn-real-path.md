# Agent turn critical path on the real Session path (VC-456)

VC-441 found no runtime-layer bottleneck, but its fixture could not have found
one. It ran scripted turns straight against VC-119's instrumentation, so no
Session runtime, input queue, agent loop, authority gate or ledger was on the
path. This ticket runs the same kind of turn through all of them, in one Node
process with no Electron, and it finds two bottlenecks.

> **1. Durable transcript-artifact publication is the largest cost on a turn,
> and it queues across the whole device.** Every transcript message is
> published with two full syncs (`F_FULLFSYNC` on macOS) before the turn can go
> on. There are 7 messages in the scripted turn. At 1 turn in flight that is
> half of first message → completion: 277 ms against 138 ms with the store
> swapped for an in-memory one. At 20 in flight it is three quarters: 1,385 ms
> against 339 ms. Meanwhile the event loop is idle more than half the time.
> Filed as **VC-465**.
>
> **2. Above eight Sessions streaming at once, the Session runtime re-reads the
> ledger on almost every transcript delta.** Its live-overlay cache holds eight
> entries with no exemption. For unwatched Sessions the eight-entry fold cache
> behind it misses too. At 256 deltas per reply, going from 8 to 9 Sessions in
> flight takes ledger transactions per turn from 24 to 499 when every Session
> is watched, and to 1,558 when none is. First message → completion goes from
> 208 to 610 ms (unwatched). Filed as **VC-466**.

The real path also proves several things VC-441 could not. These held in all
6,240 measured turns:

- VC-119 envelopes and Session ledger events agree on order.
- The real `queuedMs` is about 1 ms before artifact durability is added.
- The per-Session admission queue and the ledger's own transaction queue are
  not bottlenecks.
- The head-of-line blocking VC-441 predicted is real. It appears once
  bottleneck 1 is removed (see [below](#the-head-of-line-blocking-vc-441-predicted)).

## Reproduction

```sh
VC456_OUTPUT=$PWD/performance-results/vc-456-turn-real-path \
  pnpm -C apps/desktop bench:turn-real-path
```

- Without `VC456_OUTPUT`, the same command runs only the bench-lane tests: the
  cross-check units, a one-wave smoke in both watch postures, and the runner
  guards.
- The bench is not in any default test project or CI job.
- The full run took about six minutes.

The generated artifacts are beside this file in `vc-456-turn-real-path/`:

- `benchmark.md` has every table.
- `benchmark.json` has the aggregates, parameters, host load per arm and the
  fsync probe.
- `run-manifest.json`.

The run in this report:

- **Fixture:** `vc456-turn-real-path-v1`, commit `7c27285f` (clean tree).
- **Machine:** Node v24.18.0, macOS (darwin 25.5.0), Apple M1, 8 cores,
  16 GiB, `UV_THREADPOOL_SIZE` unset (4). The Session's own budget of 1 was
  removed so the pool matches the app's.
- **Load:** the machine was shared. VC-454 and VC-462 Sessions were running,
  and a Chromium benchmark ran beside the run. The 1-minute load average stayed
  at about 6–9 on 8 cores through the run, and reached 23 during an earlier
  discarded run. Every arm records its load before and after.
- **How to read the numbers:** prefer the p50s, the counts and the structure
  over absolute milliseconds.

## What runs

`apps/desktop/e2e/bench/turn-real-path/harness.ts` composes the desktop's own
modules:

- **Session runtime.** `createSessionRuntime`, composed port for port as
  `createDesktopSessionRuntime` composes it: the Session Engine over the
  desktop `SqliteSessionLedger`, the file transcript-artifact store, one
  checkpoint-failure reporter, `Date.now`, random ids, and one VC-119 sink
  shared with the Pi runtime.
  - The location resolver is the one port that differs, because the desktop's
    imports Electron. The stand-in answers a fixed directory, which is all the
    desktop's does for a ticketless Session.
  - `resolveRuntimeContext` is fixed.
- **Input queue.** Every message goes through `SessionRuntime.command`. That
  covers the per-Session admission tail, binding lookup and dispatch. The
  `turn-queue` envelope is the runtime's own (VC-455).
- **Agent loop.** The desktop Pi adapter (`createPiRuntimeHost`) over
  `createPiAgentRuntime`. That means Pi's `Agent`, stream supervision, VC-119's
  `instrumentStreamFn`, the real `read` and `bash` tools, and overflow
  compaction through Pi's own summarizer.
  - The provider is a local stand-in (`realPathProvider`, in
    `@volli/agent-runtime/bench/turn-to-completion`) with VC-441's attempt
    timings. It streams 8 text deltas per reply.
  - Nothing opens a socket. `fetch` is replaced with a counting refusal, and
    zero calls were made.
- **Authority gate.** `enforcement: "enforce"` with a one-refusal fallback. The
  shipped default is `observe`, which installs no gate.
  - A `read` outside the workspace is refused by `path.outside-workspace`,
    escalated, and parked on a Session interaction.
  - A stand-in person answers `once` through `interaction.resolve` after 12 ms,
    which is VC-441's authority wait.
- **Ledger.** A disposable profile holds `volli.db`, opened by the production
  `openVolliDb` (WAL, `synchronous = NORMAL`), plus transcripts and Pi
  sidecars. The profile is deleted when the run ends. No real profile or
  content is read.

A turn is:

1. A tool round: `read` inside the workspace, the escalated `read` outside it,
   and `bash printf`.
2. A provider overflow error.
3. Pi's local compaction.
4. The final reply.

The VC-119 shape matches VC-441's: 3 provider attempts, 1 tool round, 1
authority wait, 1 compaction, 1 retry and 1 `turn-queue`. Every turn is checked
against those counts by VC-441's own `analyzeTurn` and `checkEventOrder`, which
the bench imports rather than copies. "In flight" means N fresh Sessions that
each submit their first turn at the same moment, as one VC-441 wave did.

The run has two postures:

- **Watched:** each Session has a live subscriber, as a chat open in a tab
  does. The stand-in person answers from that stream.
- **Unwatched:** no subscriber, as for background work. The stand-in answers
  when `interaction.opened` commits.

## Bottleneck 1: durable artifact publication (VC-465)

Watched, p50:

| In flight | First message → completion (file) | Same, in-memory store | Artifact writes per turn | One write | Unaccounted runtime gap (file) | `queuedMs` (file / memory) | Authority wait (file / memory) | Loop busy (file) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 277 ms | 138 ms | 127 ms | 17.8 ms | 104 ms | 22 / 1 ms | 31 / 14 ms | 21% |
| 5 | 567 ms | 174 ms | 330 ms | 45.6 ms | 323 ms | 48 / 3 ms | 69 / 16 ms | 42% |
| 15 | 1,087 ms | 281 ms | 701 ms | 100.9 ms | 715 ms | 94 / 17 ms | 133 / 20 ms | 52% |
| 20 | 1,385 ms | 339 ms | 935 ms | 130.8 ms | 934 ms | 124 / 20 ms | 163 / 23 ms | 50% |

Unwatched is the same story, slightly faster, because no subscriber reads the
artifacts back: 231 / 465 / 1,067 / 1,293 ms. The evidence:

- **The control changes only the artifact store.** The SQLite ledger, Pi
  sidecars, tools, gate and subscribers are identical. The difference in
  first message → completion is 139 / 393 / 806 / 1,045 ms, which accounts for
  50% of the turn at 1 in flight and 75% at 20.
- **The artifact time is the unaccounted gap.** VC-441's unaccounted runtime
  gap is runtime turn minus provider, tool, authority and compaction spans.
  Here it grows from 104 to 934 ms, and the per-turn artifact write time grows
  from 127 to 935 ms alongside it. In the control the gap is 10.5 → 128 ms.
- **It waits rather than computes.** In the file arms the loop is busy 21–52%,
  and CPU per turn falls as concurrency rises (59 → 35 ms). The turns are
  queued on something that is not the CPU.
- **The queue is the device's sync queue.** For every new artifact,
  `FileTranscriptArtifactStore.publishCompressed` does gzip, a temp write,
  `FileHandle.sync()`, `link`, a directory `sync()`, and a verified read-back.
  - On macOS, libuv implements `sync()` with `F_FULLFSYNC`, which flushes the
    drive's cache and is serialized across the machine.
  - The run's probe on the profile's volume: one sync took 8.8 ms p50. Forty
    at once took 174 ms of wall time, about 230 syncs/s for the whole device.
  - The scripted turn writes 7 artifacts, so 14 syncs. That caps the app at
    roughly 16 such turns per second whatever the CPU does. At 20 in flight a
    wave needs 280 syncs, about 1.2 s at that rate.
- **It sits inside VC-455's new span.** The message's own artifact is written
  before its `command.recorded`, so it is inside the real `queuedMs` (22 → 124
  ms, against 1 → 20 ms in the control). `interaction.resolve` writes one too,
  so its round trip is 18 → 150 ms (control 1.4 → 1.0 ms). That is why a 12 ms
  answer produces a 31 → 163 ms authority wait.
- **The artifact is held to a stricter durability than the fact that points at
  it.** The ledger commits in WAL mode with `synchronous = NORMAL`, which syncs
  at checkpoints rather than on each commit.

The fix belongs in VC-465 and has to keep VC-327's crash guarantee: a ledger
fact must never reference an artifact that is missing or torn after a crash.

## Bottleneck 2: the overlay cache above eight streaming Sessions (VC-466)

This sweep runs on the in-memory store, so bottleneck 1 is out of the way.
20 waves per row, p50:

| Watched | Deltas per reply | In flight | Ledger reads per turn | Ledger txns per turn | Ledger CPU per turn | CPU per turn | First message → completion |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| all | 8 | 8 | 4 | 24 | 7.3 ms | 18 ms | 196 ms |
| all | 8 | 9 | 20 | 40 | 8.0 ms | 17 ms | 213 ms |
| all | 256 | 8 | 4 | 24 | 7.5 ms | 23 ms | 217 ms |
| all | 256 | 9 | 479 | 499 | 19.7 ms | 38 ms | 357 ms |
| all | 256 | 20 | 758 | 779 | 28.6 ms | 47 ms | 941 ms |
| none | 256 | 8 | 4 | 24 | 7.1 ms | 22 ms | 208 ms |
| none | 256 | 9 | 516 | 1,558 | 44.0 ms | 61 ms | 610 ms |
| none | 256 | 20 | 765 | 2,325 | 74.7 ms | 95 ms | 1,966 ms (p95 3,985) |

- **It is a cliff, and it sits exactly at nine.**
  - At eight Sessions in flight, 256 deltas per reply cost the ledger nothing
    more than 8 do: 24 transactions per turn either way.
  - At nine, the reads track the delta count.
  - These are counts, not times, so host load cannot produce them.
- **The mechanism is in `session-runtime.ts`.**
  - `#recordTranscriptDelta` calls `#overlay`. The overlay cache is
    `OVERLAY_CACHE_LIMIT = 8` with plain recency eviction, so with nine or more
    Sessions streaming, each Session's entry has usually been evicted before
    its next delta.
  - A miss re-seeds the entry through `#history`, which is at least one
    `listEvents` transaction.
  - For an unwatched Session, the fold behind it is evicted as well
    (`PROJECTION_CACHE_LIMIT = 8` bounds unwatched folds). Each delta then also
    pays `getBaseSession`, `getProjectionCheckpoint`, a tail read, a fold and a
    `saveProjectionCheckpoint` write. That is why the unwatched rows cost about
    three times the transactions.
- **The default matrix shows it too, at only 8 deltas per reply.** Ledger reads
  per turn are 4 at up to 5 in flight and 27–29 at 15 and 20.
- **Real providers make it worse.** They stream many more deltas per reply than
  8, so the cost of a turn above eight streaming Sessions scales with its
  length.
- **There may be a correctness cost as well.** According to its own comment,
  an evicted overlay costs "the tail of one in-flight message", and that now
  happens on almost every delta. A chat opened mid-stream would therefore get a
  partial overlay baseline. That is inferred from the code and was not
  measured here.

## What the real path proves that VC-441 couldn't

The run covered 6,240 turns: 3,280 in the matrix and 2,960 in the sweep. Every
one of them:

- had complete VC-119 accounting;
- had zero `checkEventOrder` violations;
- had one identical ledger shape;
- and matched on every check below.

- **VC-119 and the ledger agree on order.** Six facts are recorded on both
  sides:

  | Fact | VC-119 envelope | Ledger event |
  | --- | --- | --- |
  | Turn start | `turn-queue` | `turn.started` |
  | First attempt | first `provider-attempt` | first `usage.recorded` |
  | Authority answer | the wait-bearing `authority` | `interaction.resolved` |
  | Compaction | `compaction` | `context.compacted` |
  | Final attempt | last `provider-attempt` | last `usage.recorded` |
  | Turn end | `turn` | `turn.completed` |

  The sink's emission order and the ledger's sequence gave zero inversions.
- **Causality holds on one clock.** Each `turn-queue`, `compaction` and
  terminal `turn` envelope was recorded before its durable fact committed.
  Every authority wait ended after its question committed, and after the frame
  arrived when the Session was watched.
- **The durable record is complete.** The facts that engine calls committed
  were exactly the SQLite read-back for the turn. When watched, the live stream
  also matched the SQLite read-back.
- **`queuedMs` now measures Volli's queue.** VC-441's column was its own 2 ms
  timer; this one is the real admission path. On its own it costs about 1 ms
  p50 at 1 in flight. The file store adds the message's artifact write to it.
- **The per-Session admission queue and the ledger's transaction queue are not
  bottlenecks.**
  - A ledger transaction waited at most 0.03 ms p50 and under 0.8 ms p95
    behind others, at every concurrency.
  - Getting from the start of an authority wait to the question reaching the
    person took 0.3–0.6 ms p50 in every arm.
  - A committed `turn.completed` reached its subscriber in under 0.05 ms p95.
- **The ledger shape of a turn** is:

  ```text
  command.recorded > turn.started > usage.recorded > transcript.referenced ×2 >
  interaction.opened > command.recorded > interaction.resolved >
  command.receipt.recorded > transcript.referenced ×2 > usage.recorded ×2 >
  context.compacted > usage.recorded > transcript.referenced > turn.completed
  ```

  The summary request's usage is recorded, but it is not a VC-119 provider
  attempt, because Pi's summarizer calls `completeSimple` directly.

## The head-of-line blocking VC-441 predicted

VC-441 saw its authority timer fire late behind other turns' synchronous work:
+1.6 / 4.7 ms p50 / p95 at 20 turns, and it predicted real work would make that
worse. In the file arms it is hidden, because the loop is waiting on syncs.
Once bottleneck 1 is removed (the in-memory arms), it appears:

- The loop is 98–102% busy at 20 in flight.
- CPU per turn is about 18–20 ms. That is process-wide, including the thread
  pool.
- The stand-in's answer timer fires late by 7.4 / 22.6 ms p50 / p95 at 20 in
  flight (watched), against −0.2 / 0.8 ms at 1.
- The unaccounted runtime gap grows from 10.5 to 128 ms.
- About half the loop's CPU per turn is the SQLite ledger's synchronous
  transactions (7–11 ms per turn).

It is not named as a third bottleneck. The ticket allows two, and this one
ranks behind both. It is the next thing this bench will show once VC-465 and
VC-466 land.

## Limits

- **The provider is a stand-in.** It uses fixed local timers, so nothing here
  describes real inference time, provider queueing, quotas or network. The
  `read` and `bash` calls are tiny, and real tools will cost more.
- **Some ports are stand-ins.**
  - The authority policy is `enforce` with a one-refusal fallback, not the
    shipped `observe`.
  - The location resolver and runtime context are fixed.
  - The person is an auto-answerer.
  - No renderer, Electron main (VC-445) or resource accounting (VC-318) is
    involved.
- **The fsync cost depends on the machine.** The per-sync cost depends on the
  disk and on what else is syncing. VC-462's benchmark shared the device. What
  does not depend on the machine is the structure: 2 syncs per artifact, 7
  artifacts per turn, serialized for the whole device.
- **Clock resolution.** `queuedMs` and every VC-119 duration use the product's
  `Date.now` clocks, which have 1 ms resolution. Harness timestamps use
  `performance.now()`.
- **Statistics.** Turns in a wave share a host interval and are not
  independent. Percentiles are nearest-rank. Every arm is a fresh profile,
  with one warm-up wave discarded.
- **The control arms are not a proposal.** The in-memory store is a diagnostic
  only.
