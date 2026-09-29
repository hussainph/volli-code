# What bound Pi contexts cost Electron main (VC-445)

VC-366 asked what one Session costs main and which of three options gets
Volli to 30+ concurrent Sessions: **Option 2**, stay in main and yield;
**Option 1**, one shared `utilityProcess` host for every Session; or
**Option 3**, hibernate idle contexts. It left one measurement open: main's
heap, GC, event-loop delay and renderer→main IPC latency against how many Pi
contexts are actually loaded in main, and how long their histories are. This
report closes that gap. It measures that and nothing else. It does not run the
Browser, terminal, watcher, soak or eviction matrix (VC-318). It does not time
turns, providers or tools (VC-441). It does not re-benchmark the budget reader
(VC-403).

> **Verdict.** Holding contexts costs main memory in proportion to history
> size and nothing else we could measure. **The data support Option 2** (stay
> in main). They support neither a utility-process host nor hibernation. The one
> loop cost is a single synchronous stall when a context is re-bound. It grows
> with sidecar size: about 30 ms p95 at 5 MB, and 175–295 ms at 47 MB (the
> size of the largest sidecar on the owner's profile). That is a narrow Option-2
> "yield" target, filed as a separate ticket. Nothing in this ticket changes
> topology, hibernation, concurrency or scheduling.

## Run facts

|  |  |
|---|---|
| Matrix command | `pnpm run build && pnpm bench:pi-context-scaling --repetitions 6 --output docs/research/perf/pi-context-scaling-vc445` |
| Large-sidecar command | `pnpm bench:pi-context-scaling --attached 1 --histories 4500,13500 --repetitions 6` (written to `/tmp`, then copied into `large-sidecars/`) |
| Source | matrix at `31100b3b`; large-sidecar run at `e7e6c138` (same measured path, plus the load-sensitivity and incremental-count commits). Clean tree at both starts. |
| Build | production bundle (`pnpm run build`, main bundle built 2026-09-29T15:01Z), launched unpackaged through Playwright |
| Machine | MacBookPro17,1 (Apple M1, 8 cores, 16 GiB), macOS 26.5.1 (25F80), Electron 44.0.0, Node 24.18.0 |
| Power | AC, battery 100% charged |
| Load | **Shared machine**: three other ticket Sessions (VC-441/442/444) were running throughout. 1-minute load at launch boundaries: p50 9.7, p95 29.8, max 77.0 on 8 cores. macOS memory-pressure level 1 and 2 both seen; ~12 GiB swap in use. |
| Matrix size | 17 arms × 6 repetitions = 102 measured launches, plus 1 discarded warm-up. 52 minutes. No failed launch. |
| Artifacts | [`aggregate.json`](pi-context-scaling-vc445/aggregate.json), [`tables.md`](pi-context-scaling-vc445/tables.md) (every table, generated), [`raw.json.gz`](pi-context-scaling-vc445/raw.json.gz) (every launch: every IPC sample, every 10 ms tick gap, every GC entry, both memory snapshots, host state before and after). The same three files for the [large-sidecar run](pi-context-scaling-vc445/large-sidecars/). |

Treat CPU and latency figures as **directional**, because the host was loaded.
Every latency figure is also recomputed from only the launches with 1-minute
load ≤ 12 (71 of 102). That section is at the end of `tables.md`, and it tells
the same story. Memory figures come from post-GC heap and are unaffected by
load: their spread across six launches is under 0.1 MiB.

## Method

**Topology first (VC-366 caveat 2).** Neither the attach path
(`session-runtime/`, `@volli/session-engine`, `agent-runtime/src/pi/runtime.ts`)
nor production source anywhere uses `utilityProcess`, `worker_threads`, `Worker`
or `child_process`. The bench also checks this at runtime. Before and after every
hydration it lists main's descendants **by parent pid** (caveat 1: never by
command line), and it records `app.getAppMetrics()`. Both counts stayed exactly
3 → 3 and 4 → 4 in all 102 launches, including 20 bound contexts. A bound Pi
context is heap and work inside Electron main. It is not a process.

**Fixture (disposable, synthetic, no network).**

1. The built app starts on a throwaway profile. The profile has its own
   `--user-data-dir`, `VOLLI_DB_PATH`, `HOME` and Pi agent dir, and its only
   credential is a fake `openai` API key.
2. The app creates 4 × 20 project Sessions through the product
   `sessions.create`/`sessions.attach` routes. Attaching creates each Session's
   Pi recovery sidecar.
3. The app quits.
4. [`sidecar-history.ts`](../../../packages/agent-runtime/bench/context-scaling/sidecar-history.ts)
   re-attaches the **real** Pi runtime to each sidecar in plain Node. It runs
   real turns with real `read` tool calls against generated TypeScript files.
   pi-ai's `fauxProvider` answers every request, wearing the Session's own
   catalog model (`openai/gpt-5-mini`). Every marker and entry comes from the
   production runtime. Prose comes from a fixed vocabulary.

`network-tripwire.cjs` is loaded into Electron main (with `-r`) and into the
runner. It refuses and records every non-loopback socket and every non-loopback
Chromium request. **Zero attempts were recorded in all 122 measured and warm-up
launches, in both prepare launches, and in generation.** No real user text was read. The owner's profile was consulted for
one thing only: the byte sizes of its Pi sidecar files (`stat`; no file opened).

| history arm | entries per sidecar | messages | turns | sidecar bytes (min–max) |
|---:|---:|---:|---:|---:|
| 10 | 11–12 | 2–3 | 1–2 | 15 KB–46 KB |
| 100 | 100–105 | 26–32 | 6–10 | 0.30–0.37 MB |
| 500 | 500–505 | 140–151 | 35–44 | 1.5–1.9 MB |
| 1,500 | 1,500–1,505 | 424–446 | 110–124 | 5.0–5.4 MB |
| 4,500 (large run) | 4,501 | 1,317 | 341 | 16.2 MB |
| 13,500 (large run) | 13,501 | 3,924 | 1,040 | 47.3 MB |

For scale, the owner's 1,884 real sidecars are p50 0.96 MB, p90 3.5 MB,
p95 5.3 MB, p99 13.0 MB and max 48.6 MB. That puts the 1,500-entry arm at about
the real p95. The large run's two sizes bracket the real p99 and the real max.

**Launch protocol.** Every launch starts from an APFS clone of the frozen
profile, so all absolute paths stay identical. One Electron main process then
runs these steps:

1. Settle for 6 s.
2. **Census.**
3. Warm IPC with 100 echo and RPC round trips.
4. **Idle window** (6 s).
5. Two forced full GCs, each timed, then the **pre** snapshot.
6. **Hydration window.**
7. **Census.**
8. **Steady window** (6 s).
9. Two forced full GCs, then the **post** snapshot.

The tripwire is read at the end. Arms run in a seeded shuffle within each
repetition. The control arm binds nothing and gives the noise floor of every
delta.

- **Binding proof, independent of the ledger.** Before hydration, all 80
  fixture Sessions are durably open, yet `live` = 0. `durableOpen` comes from
  `session.projection`'s `liveExecutor`, which despite its name is folded from
  the ledger. `live` is the listing row's flag, which main computes from
  `SessionRuntime.openNativeBindings()`, the runtime's in-memory binding map.
  After hydration, `live` = exactly the N requested Session ids, and none
  other. Every launch passed this check. During prepare, a fresh attach read
  `live` = 80 as the positive control. So the ledger said "open" for all 80
  Sessions in every launch while the process held 0, 1, 5, 10 or 20 bindings,
  which confirms VC-366's clarification that durable rows are not bindings.
- **Hydration** is `model.select` re-selecting each Session's own model, one
  Session at a time, through `window.api.sessionRpc`. That is a real composer
  command. It makes the Session runtime rehydrate the binding from the sidecar
  (`#bindingForCommand` → `#rehydrateBinding` → Pi `attachSession`), exactly as
  the first message after a relaunch would, but without starting a turn.
- **Loop delay (main):** `monitorEventLoopDelay({ resolution: 1 })`, whose
  values include the 1 ms period. Also a 10 ms `setInterval` whose raw gaps are
  kept, following VC-369's `eventLoopLagDuring` pattern; a gap includes the
  10 ms period.
- **IPC (renderer, concurrent):** a closed-loop echo through
  `window.api.window.isFullScreen()`, a preload invoke whose main handler does
  no I/O, every 5 ms. Alongside it, a Session RPC `modelAccess.defaults`
  round trip every 25 ms, following the `session-rpc-round-trip.mjs` pattern.
  Correlation is the Pearson r between per-100 ms-bin maxima of main tick gaps
  and echo latency.
- **Memory:** `process.memoryUsage()` and `v8.getHeapStatistics()` in main.
  Also `app.getAppMetrics()` working set per process, which separates the main
  (Browser) and renderer (Tab) processes. And macOS `footprint -p` for main and
  the renderer.
- **GC:** `PerformanceObserver` `gc` entries per window, with the bench's own
  forced GCs excluded by V8's forced flag. Each forced `gc()` is also timed; a
  forced full collection is non-incremental, so its wall time is a
  stop-the-world mark-compact of the live heap.
- **Why ELU is missing:** `performance.eventLoopUtilization()` read 0.000 in
  every window. Electron's main loop is not driven by libuv, so ELU is
  unavailable there. It was removed from the probe after this run, and the raw
  file still carries the zero field.

## Results

### Heap grows linearly with history, at about the sidecar's size

This table shows the post-GC delta in main. Values are the median across 6
launches; ranges are in `tables.md`. heapUsed ranges are within ±0.1 MiB.

| entries | heapUsed Δ at N = 20 | **heapUsed per bound context** (slope over N = 0/1/5/10/20, r²) | heapTotal Δ at N = 20 | footprint Δ at N = 20 | footprint per context (slope, r²) |
|---:|---:|---:|---:|---:|---:|
| 10 | 2.8 MiB | **0.13 MiB** (0.95) | 23.0 MiB | 30.5 MiB | 1.5 MiB (0.66) |
| 100 | 8.6 MiB | **0.42 MiB** (0.99) | 26.5 MiB | 37.5 MiB | 1.9 MiB (0.74) |
| 500 | 33.6 MiB | **1.66 MiB** (1.00) | 50.9 MiB | 73.0 MiB | 3.5 MiB (0.89) |
| 1,500 | 98.5 MiB | **4.91 MiB** (1.00) | 94.9 MiB | 138 MiB | 6.4 MiB (0.98) |
| 4,500, N = 1 (large run) | — | **15.8 MiB** | — | 29.5 MiB | — |
| 13,500, N = 1 (large run) | — | **44.1 MiB** | — | 68.5 MiB | — |

- **Per-context heap ≈ 0.10 MiB + 0.93 × sidecar MiB.** This is a least-squares
  fit over the four arms; the 16 MB and 47 MB runs land on the same line. The
  context is the recovered conversation that Pi keeps in memory, so it costs
  about what its sidecar weighs on disk.
- The control's heapUsed Δ is 0.04 MiB, and its footprint Δ is +1 MiB
  (range −5 to +2).
- **Footprint** also includes a one-time step of about 20–25 MiB once a few
  contexts bind: heapTotal jumps at N ≥ 5 even with 10-entry histories, which
  looks like V8 growing its young generation under hydration's allocation
  burst. After that step, footprint grows by about 1.2 × sidecar bytes per
  context.
- **Extrapolation to the owner's sizes:** 30 contexts at the real p95 (5.3 MB)
  ≈ 145 MiB of heap. 30 at the real p50 (0.96 MB) ≈ 30 MiB. The main heap limit
  here is 4.09 GiB (`heap_size_limit`), so even the 30 × p95 case is about 3.5%
  of it.

**Renderer vs main.** The renderer's footprint moved +2.5 to +19.5 MiB
(control +3) against a pre-hydration value of about 81 MiB. That growth tracks
the census reads and model-select frames. It is not a Pi context: the contexts
are in main, as the main-heap deltas show.

`app.getAppMetrics()` working set gives main about 260 MiB and the renderer
about 150 MiB before hydration. Its deltas are **not usable** at this precision
on this host. Main's delta ranged from −186 to +182 MiB across launches, and
from −186 to +113 MiB within a single arm (20 × 500). The renderer's ranged
from −75 to +63 MiB. That happens because macOS compresses and purges
resident pages under the memory pressure it reported. The working-set figures
are published anyway, as the ticket asked, but decisions should rest on heap
and footprint.

### GC: nothing while contexts are held; small, proportional work while binding

- **Steady window:** the median is 0 organic GCs per launch in 14 of 16 bound
  arms and 1 in the other two, with a maximum of 3. Holding 20 × 1,500-entry
  contexts triggered no collection at all in any 6 s window.
- **Hydration window:** GC work scales with how much is loaded. Binding 20 ×
  1,500 entries costs a median of 20 GCs and 53 ms of GC per launch, with pauses
  p50/p95/max 2.3/8.1/14.3 ms (114 pauses). The 47 MB single bind costs 8 GCs,
  22 ms, max pause 11.5 ms.
- **Full-GC pause over the live heap** (forced, stop-the-world): 26 ms before →
  40 ms after binding 20 × 1,500 (+98 MiB), medians. The control reads
  36 → 32 ms, and the spread under load is wide (17–353 ms across all arms), so
  the growth is about +14 ms per 100 MiB, not a cliff. The large run shows
  22 → 29 ms for +44 MiB.

### Main loop and IPC: flat while held; one stall per re-bind

The table below covers N = 20 for each history length, plus the control and the
large runs. Pooled samples are shown as `p50 / p95 / max (n)`, in ms.

| arm | steady: 10 ms tick gap | steady: IPC echo | hydration: tick gap | hydration: IPC echo | hydration r(loop, echo) |
|---|---|---|---|---|---:|
| control | 10.4 / 12.6 / 34.6 (3451) | 0.3 / 3.2 / 27.7 (5592) | — | — | — |
| 20 × 10 | 10.4 / 11.4 / 59.6 (3500) | 0.3 / 1.6 / 43.9 (5835) | 10.0 / 14.4 / 33.1 (406) | 0.3 / 6.6 / 26.7 (548) | 0.66 |
| 20 × 100 | 10.3 / 11.1 / 41.5 (3509) | 0.3 / 1.2 / 36.6 (5877) | 10.0 / 13.2 / 43.5 (432) | 0.3 / 5.1 / 36.2 (614) | 0.70 |
| 20 × 500 | 10.4 / 13.8 / 252.4 (3342) | 0.3 / 3.1 / 227.4 (5441) | 10.2 / 19.9 / 139.3 (886) | 0.8 / 11.2 / 140.1 (1185) | 0.91 |
| 20 × 1,500 | 10.4 / 11.1 / 41.9 (3481) | 0.2 / 1.2 / 29.6 (5807) | 10.2 / 30.9 / 127.2 (767) | 0.5 / 21.8 / 117.4 (1079) | 0.96 |
| 1 × 4,500 (16 MB) | 10.4 / 11.0 / 35.7 (3528) | 0.2 / 0.6 / 33.2 (5811) | 11.0 / 92.6 / 116.7 (51) | 1.0 / 80.9 / 109.1 (58) | 0.62 |
| 1 × 13,500 (47 MB) | 10.4 / 11.5 / 105.7 (3479) | 0.2 / 1.7 / 99.1 (5650) | 10.2 / 195.7 / 295.3 (90) | 0.9 / 172.5 / 285.3 (114) | 1.00 |

- **Held contexts cost the loop nothing measurable.** Steady-window tick gaps
  and IPC round trips do not move with N or history, across all 16 arms and
  both large runs. Every steady or idle gap over 100 ms (three in 102 launches,
  one of them before any binding) happened in a launch whose 1-minute load was
  12–43. That is the shared host, not the contexts.
- **Re-binding stalls main once per Session, and the stall grows with sidecar
  size.** The `monitorEventLoopDelay` max for a hydration window (median across
  launches) is:
  - about 27–30 ms at 5 MB for N ≤ 10 (74 ms for the 20-bind window);
  - 74 ms at 16 MB;
  - 211 ms at 47 MB, with individual stalls up to 295 ms.

  That works out to roughly 4–6 ms per MB of sidecar on this loaded M1.
- **A renderer→main request that lands during a stall waits the stall out.**
  Correlation is r = 0.96 at 20 × 1,500 and r = 0.999 at 47 MB, and the worst
  echo matches the worst gap: 285 ms against 295 ms. This is VC-355's finding
  again, at bind scale. It is caveat 3 measured, not assumed.
- **Bind wall time** (quiet launches only, load ≤ 8):
  - The first bind after boot takes 83–112 ms p50, mostly asynchronous one-time
    setup. With 10-entry histories its worst tick gap is 14 ms.
  - Later binds take 22 ms p50 at 10 and 100 entries, 34 ms at 500, and 55 ms
    at 1,500.
  - Under load, all of these stretch two to five times (`tables.md`, "Hydration").
- **Where the stall comes from.**
  [`profile-attach.mjs`](../../../apps/desktop/e2e/bench/pi-context-scaling/profile-attach.mjs)
  builds one sidecar with the same generator and CPU-profiles plain-Node Pi
  re-attaches, with no app and no ledger:
  - A 4.4 MB, 1,500-entry sidecar re-attaches in 21–27 ms.
  - A 40 MB, 13,500-entry sidecar re-attaches in 247–286 ms.
  - Nearly all of the self time is Pi's own sidecar load in
    `pi-agent-core/session/jsonl`: UTF-8 decoding (`string_decoder`), line
    splitting (`splitCompleteLines`), and JSON parsing (`parseJsonlTransaction`,
    or native `(program)` time at 40 MB). The whole file is decoded and parsed
    in one synchronous pass after an async read.
  - Volli's own recovery fold (`conversationPath`, `contextMessages`,
    `recoveredObservation`) is a few ms.

## What the curve supports

- **Option 3, hibernate idle contexts — not supported.**
  - The heap is linear and moderate: about 1× sidecar bytes per context.
    30 contexts at the real p95 size come to about 3.6% of main's heap limit.
  - Holding contexts adds no GC or loop cost.
  - The only loop cost measured *is* re-hydration, so hibernating would re-pay
    that stall on every wake, making responsiveness worse to save memory that is
    not scarce.
  - There is still no context-eviction path (`dispose` releases ports, not
    history), and nothing here argues for building one.
- **Option 1, one shared utility-process host — not supported by this data.**
  - The host would move Pi's heap out of main, but main's heap is not under
    pressure.
  - It would take the sidecar parse off main's loop, but that parse is a one-shot
    per Session per launch, and it can be yielded in place (below).
  - A held context costs main's loop and IPC nothing.
  - Against that small benefit stand the costs VC-366 already listed: an
    ordered snapshot/update bridge, abort/interrupt, the parked-ask join, the
    network session, SIGTERM semantics, and `disclaim`.
  - Caveat: turn-time behaviour is VC-441's job. If VC-441 finds turns
    themselves blocking main, that question reopens on its evidence, not this
    ticket's.
- **Option 2, stay in main and yield — supported.**
  - Everything measured stays flat while held.
  - The single measured stall has one cause (synchronous parsing of the whole
    sidecar during re-bind) and a size-proportional, predictable magnitude. At
    the real p95 it is invisible in practice (about 30 ms). At the real p99 it
    is about 70–120 ms, and at the real max about 0.2–0.3 s.
  - That is the same class of fix as VC-369 (1,607 → 12 ms by yielding), at a
    smaller magnitude.

**Implementation ticket filed:** the Pi sidecar re-bind should not hold main's
loop in proportion to sidecar size. Chunk or yield the JSONL load, or otherwise
avoid parsing the whole file in one task, with this bench's large-sidecar arm
as the before/after. It is scoped as an Option-2 yield only: no topology,
hibernation, concurrency or scheduling change.

## Caveats

- **Shared, loaded host.** Latency and bind times are directional. The
  load-≤-12 subset (in `tables.md`) keeps 71 of 102 launches and preserves every
  conclusion. For example, at 20 × 1,500 in that subset:
  - hydration tick gap p95 30.9 ms, max 127 ms;
  - later binds p50 72 ms;
  - steady IPC echo p95 1.2 ms.
- **Working set is not a context measure on this host** (see above). Use the
  heap and footprint rows.
- **Synthetic mass.** Entries average about 3.4 KB, made up of tool results of
  1–16 KB, opaque reasoning signatures of 0.8–2.4 KB, and 0.3–1.5 KB answers.
  Real Sessions vary more. Heap and stall both scale with **bytes**, so read any
  real Session off its sidecar size using the fits above, not off its entry
  count.
- **Hydration is sequential.** The bench binds one Session at a time, the way a
  person re-opening Sessions would. A burst that binds many at once (for
  example, boot recovery of several mid-turn Sessions) is serialized by the same
  stalls, and was not measured concurrently.
- **Playwright's inspector is attached** to main, as in every desktop bench
  (VC-353). It applies equally to all arms.
- **Nothing here times a turn.** A bound-but-idle context is what VC-366's
  question needed. What a running turn costs main belongs to VC-441.

## Reproduce

```sh
pnpm install && pnpm run build
pnpm bench:pi-context-scaling --repetitions 6 --output /tmp/vc445      # ~55 min
pnpm bench:pi-context-scaling --attached 1 --histories 4500,13500 --repetitions 6 --output /tmp/vc445-large
node apps/desktop/e2e/bench/pi-context-scaling/reaggregate.mjs /tmp/vc445   # rebuild aggregate + tables from raw
node apps/desktop/e2e/bench/pi-context-scaling/profile-attach.mjs --entries 13500  # where one re-bind spends its time
pnpm test:performance-harness   # aggregation unit tests (bench lane, not the default lane)
```

The bench needs a display. It uses `VOLLI_QUIET_WINDOWS`, so it never takes
focus. It creates and removes its own `/tmp/vc445-*` profile, and never touches
a real profile, app or Session.
