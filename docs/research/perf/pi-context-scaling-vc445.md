# What bound Pi contexts cost Electron main (VC-445)

VC-366 asked what one Session costs main and which of three options gets
Volli to 30+ concurrent Sessions:

- **Option 2**: stay in main and yield.
- **Option 1**: one shared `utilityProcess` host.
- **Option 3**: hibernate idle contexts.

It left one measurement open: main's heap, GC, event-loop delay and
renderer→main IPC latency, measured against how many Pi contexts are **actually
bound in main** and how long their histories are. This report closes that gap
and measures nothing else. It does not run the Browser, terminal, watcher, soak
or eviction matrix (VC-318). It does not time turns, providers or tools
(VC-441). It does not re-benchmark the budget reader (VC-403).

> **Verdict.** Holding bound contexts costs main memory in proportion to
> history size, and nothing else measurable. **The data support Option 2**
> (stay in main). They support neither a utility-process host nor hibernation.
>
> The one loop cost is a single synchronous stall when a context is re-bound.
> The stall grows with sidecar size: about 30 ms at 5 MB and about 190 ms at
> 47 MB. That is a narrow Option-2 yield target, filed as VC-462.
>
> Nothing in this ticket changes topology, hibernation, concurrency or
> scheduling. The verdict is about **Electron main as the host today**. It does
> not decide where the Agent Runtime might live later, and VC-462's fix belongs
> in `@volli/agent-runtime` or upstream Pi, not in Electron code.

## Run facts

| Item | Value |
|---|---|
| Matrix command | `pnpm run build && pnpm bench:pi-context-scaling --repetitions 6 --output docs/research/perf/pi-context-scaling-vc445` (the flag now named `--bound` defaulted to 1,5,10,20) |
| Large-sidecar command | `pnpm bench:pi-context-scaling --bound 1 --histories 4500,13500 --repetitions 6`, written to `/tmp`, then copied into `large-sidecars/` |
| Source | Matrix measured at `31100b3b`, from a clean tree. Large-sidecar run measured at `f249e023` (the final bench code), from a clean tree. Both runs' `aggregate.json` and `tables.md` were regenerated from their own raw samples with `reaggregate.mjs` at the final code. That added load sensitivity, idle-paired deltas, sub-20-sample p95 marking and failed-launch exclusion, and re-measured nothing. |
| Build | Production bundle (`pnpm run build`; main bundle built 2026-09-29T15:01Z), launched unpackaged through Playwright |
| Machine | MacBookPro17,1 (Apple M1, 8 cores, 16 GiB), macOS 26.5.1 (25F80), Electron 44.0.0, Node 24.18.0 |
| Power | AC, battery 100% and charged |
| Load | **Shared machine**: three other ticket Sessions (VC-441/442/444) were running. Matrix 1-minute load at launch boundaries: p50 9.7, p95 29.8, max 77.0 on 8 cores. Large run: p50 6.0, max 15.2. macOS memory-pressure levels 1 and 2 both seen, with about 12 GiB of swap in use. |
| Matrix | 17 arms × 6 repetitions = 102 measured launches, plus 1 discarded warm-up; 52 minutes; 0 failed launches. Large run: 3 arms × 6 repetitions, plus 1 warm-up; 0 failed. |
| Artifacts | [`aggregate.json`](pi-context-scaling-vc445/aggregate.json), [`tables.md`](pi-context-scaling-vc445/tables.md) (every table, generated) and [`raw.json.gz`](pi-context-scaling-vc445/raw.json.gz). The raw file holds every launch's IPC samples, 10 ms tick gaps, GC entries, both memory snapshots and host state. The same three files exist for the [large-sidecar run](pi-context-scaling-vc445/large-sidecars/), plus the plain-Node attach profiles [`profile-attach-1500.txt`](pi-context-scaling-vc445/profile-attach-1500.txt) and [`profile-attach-13500.txt`](pi-context-scaling-vc445/profile-attach-13500.txt). |

The raw samples are committed gzipped (2.3 MB and 0.4 MB) because the ticket
requires them to be published. `docs/performance-benchmark.md` keeps the VC-353
baseline JSON out of git, but these are one-off research artifacts under
`docs/research/perf/`, where committed JSON already has precedent.

CPU and latency figures are **directional** because the host was loaded. Every
latency figure is also recomputed from only the launches whose 1-minute load
was ≤ 12, which kept 71 of 102 (the last table of `tables.md`). Memory figures
are post-GC heap and are unaffected by load: their spread across six launches
is under 0.1 MiB.

## Method

### Topology first (VC-366 caveat 2)

Nothing in the attach path uses `utilityProcess`, `worker_threads`, `Worker` or
`child_process`. That path is `session-runtime/`, `@volli/session-engine` and
`agent-runtime/src/pi/runtime.ts`. Other main-process code does spawn children
(for example `git`), but not the code that binds a context.

The bench also checks this at runtime. Before and after every hydration, it
lists main's descendants **by parent pid**, never by command line (caveat 1),
and it records `app.getAppMetrics()`. Both counts stayed exactly the same, 3 → 3
and 4 → 4, in every launch, including launches with 20 bound contexts. **A bound
Pi context is heap and work inside Electron main. It is not a process.**

### Fixture (disposable, synthetic, no network)

1. The built app starts on a throwaway profile. The profile has its own
   `--user-data-dir`, `VOLLI_DB_PATH`, `HOME` and Pi agent dir, and its only
   credential is a fake `openai` API key.
2. The app creates 4 × 20 project Sessions through the product
   `sessions.create` and `sessions.attach` routes. Each attach creates that
   Session's Pi recovery sidecar.
3. The app quits.
4. [`sidecar-history.ts`](../../../packages/agent-runtime/bench/context-scaling/sidecar-history.ts)
   re-attaches the **real** Pi runtime to each sidecar in plain Node. It runs
   real turns with real `read` tool calls against generated TypeScript files,
   and pi-ai's `fauxProvider` answers every request. The faux provider wears the
   Session's own catalog model, `openai/gpt-5-mini`.

Every marker and entry is written by the production runtime. Prose comes from a
fixed vocabulary, and no real user text is read. The owner's profile was
consulted only for the byte sizes of its Pi sidecars:

```sh
find "~/Library/Application Support/Volli Code/pi-sessions" -name '*.jsonl' -print0 | xargs -0 stat -f %z
```

No file was opened. This figure can only be repeated on the owner's machine.

The history arms are **targets**. The generator stops at the first whole turn
that reaches the target, so the "10" arm lands at 11–12 entries:

| History arm | Entries per sidecar | Messages | Turns | Sidecar bytes (min–max) |
|---:|---:|---:|---:|---:|
| 10 | 11–12 | 2–3 | 1–2 | 15 KB–46 KB |
| 100 | 100–105 | 26–32 | 6–10 | 0.30–0.37 MB |
| 500 | 500–505 | 140–151 | 35–44 | 1.5–1.9 MB |
| 1,500 | 1,500–1,505 | 424–446 | 110–124 | 5.0–5.4 MB |
| 4,500 (large run) | 4,501 | 1,317 | 341 | 16.2 MB |
| 13,500 (large run) | 13,501 | 3,924 | 1,040 | 47.3 MB |

For scale, the owner's 1,884 real sidecars measure p50 0.96 MB, p90 3.5 MB,
p95 5.3 MB, p99 13.0 MB and max 48.6 MB. The 1,500-entry arm sits at about the
real p95, and the large run brackets the real p99 and the real maximum.

### No network (enforced, and proven live)

`network-tripwire.cjs` is loaded into Electron main with `-r` and into the
runner. It refuses and records every non-loopback socket and every non-loopback
Chromium request. Its loopback test matches by address, not by prefix.

- **Enforced.** A launch that recorded any refusal fails and is excluded from
  the tables.
- **Proven live.** Before measuring, the final bench makes one deliberate Node
  connect and one deliberate Chromium fetch to 192.0.2.1 (TEST-NET-1, never
  routed). Both must be refused and recorded, or the launch fails.
- **Scope.** The guard does not cover processes that main spawns (none were
  spawned: see Topology), direct `dns.lookup` calls, or Chromium service
  traffic that does not pass through a `Session`.

Results:

- **Large run:** the self-test passed in all 19 launches, and 0 requests were
  refused.
- **Matrix:** this run predates the self-test. The tripwire reported
  `loaded: true` in all 103 launches and refused 0 requests, and the same held
  in both prepare launches and in generation. The final code's policy is the
  same, with loopback matching tightened. The fake key means a provider call
  could not have authenticated anyway.

### Launch protocol

Every launch starts from an APFS clone of the frozen profile, so every absolute
path stays identical. Then, in one Electron main process:

1. Settle for 6 s.
2. **Census.**
3. Warm up with 100 IPC echo and RPC round trips.
4. **Idle window** (6 s).
5. Run two forced full GCs, each timed, then take the **pre** snapshot.
6. **Hydration window.**
7. **Census.**
8. **Steady window** (6 s).
9. Run two forced full GCs, then take the **post** snapshot.

Arms run in a seeded shuffle within each repetition. The control arm binds
nothing and gives the noise floor for every delta.

#### Binding proof, independent of the ledger

- `durableOpen` comes from `session.projection.liveExecutor`, which despite its
  name is folded from the ledger. Before hydration, all 80 fixture Sessions
  were durably open.
- `live` is the listing row's flag, which main computes from
  `SessionRuntime.openNativeBindings()`, the runtime's in-memory binding map.
  Before hydration it was 0. After hydration it was exactly the N requested
  Session ids and no others.
- Every launch passed this check. During prepare, a fresh attach read
  `live` = 80, which is the positive control.

So the ledger said "open" for all 80 Sessions while the process held 0, 1, 5,
10 or 20 bindings. That confirms VC-366's clarification.

#### Hydration

Each Session is bound by `model.select`, which re-selects the Session's own
model. The bench issues these one Session at a time through
`window.api.sessionRpc`. `model.select` is a real composer command, and it
takes the rehydration path the first command after a relaunch takes:
`#bindingForCommand` → `#rehydrateBinding` → Pi `attachSession`. The binding is
rebuilt from the sidecar.

It is not identical to a first message:

- It starts no turn and makes no provider request.
- It still writes a `model.select` command and its receipt to the ledger.
- Pi re-applies the selection (an availability check and a context-projector
  reset) after binding.

Those extras are constant per Session, and the bound-state census is taken
after them.

#### Instruments

- **Loop delay (main):** two instruments run side by side.
  - `monitorEventLoopDelay({ resolution: 1 })`. Its values include the 1 ms
    period, and the tables show its sample count.
  - A 10 ms `setInterval` whose raw gaps are kept, following the
    `eventLoopLagDuring` pattern from VC-369. Each gap includes the 10 ms
    period.

  The correlation uses the tick gaps, because a histogram has no timestamps to
  bin by.
- **IPC (renderer, concurrent):** two closed loops run during every window.
  - An echo through `window.api.window.isFullScreen()`, a preload invoke whose
    main handler does no I/O, every 5 ms.
  - A Session RPC `modelAccess.defaults` round trip every 25 ms, following the
    `session-rpc-round-trip.mjs` pattern.

  Correlation is the Pearson r between the per-100 ms-bin maxima of the tick
  gaps and of the echo latency.
- **Memory:**
  - `process.memoryUsage()` and `v8.getHeapStatistics()` in main.
  - `app.getAppMetrics()` working set per process: main (Browser) and renderer
    (Tab) separately.
  - macOS `footprint -p` for main and for the renderer.
- **GC:** `PerformanceObserver` `gc` entries per window, excluding the bench's
  own forced GCs by V8's forced flag. Each forced `gc()` is also timed; it is a
  non-incremental, stop-the-world mark-compact of the live heap.
- **Absolute and deltas.** Memory is reported pre, post and as the paired
  delta. Loop delay and IPC are reported as absolute values and as deltas
  against **the same launch's idle window**. Pairing within a launch removes
  most of the shared host's variance.
- **p95 and small samples.** A p95 marked † had fewer than 20 samples, so it is
  the maximum. A fit needs at least three arms.
- **ELU:** `performance.eventLoopUtilization()` read 0.000 in every window of
  the matrix, because Electron's main loop is not driven by libuv, so ELU is
  unavailable there. It was removed from the probe after the matrix run; the
  matrix's raw file still carries the zero field.

## Results

### Heap grows linearly with history, at about the sidecar's size

Post-GC deltas in main, median across 6 launches. heapUsed ranges are within
±0.1 MiB; the other ranges are in `tables.md`.

| Entries | heapUsed Δ at N = 20 | **heapUsed per bound context** (slope over N = 0/1/5/10/20, r²) | heapTotal Δ at N = 20 | Footprint Δ at N = 20 | Footprint per context (slope, r²) |
|---:|---:|---:|---:|---:|---:|
| 10 | 2.8 MiB | **0.13 MiB** (0.95) | 23.0 MiB | 30.5 MiB | 1.5 MiB (0.66) |
| 100 | 8.6 MiB | **0.42 MiB** (0.99) | 26.5 MiB | 37.5 MiB | 1.9 MiB (0.74) |
| 500 | 33.6 MiB | **1.66 MiB** (1.00) | 50.9 MiB | 73.0 MiB | 3.5 MiB (0.89) |
| 1,500 | 98.5 MiB | **4.91 MiB** (1.00) | 94.9 MiB | 138 MiB | 6.4 MiB (0.98) |
| 4,500 (16 MB), N = 1 | — | **15.8 MiB** (single arm) | — | 30.5 MiB | — |
| 13,500 (47 MB), N = 1 | — | **44.1 MiB** (single arm) | — | 57 MiB | — |

- **Per-context heap ≈ 0.10 MiB + 0.93 × sidecar MiB**, a least-squares fit over
  the four matrix arms. The 16 MB and 47 MB contexts land on the same line. The
  context is the recovered conversation Pi keeps in memory, so it costs about
  what its sidecar weighs on disk. The control's Δ is 0.04 MiB.
- **Footprint** has a one-time step of about 20–25 MiB once a few contexts bind:
  heapTotal jumps at N ≥ 5 even at 10 entries, consistent with V8 growing its
  young generation under hydration's allocation burst. After that step,
  footprint grows by about 1.2 × sidecar bytes per context. The control's
  footprint Δ is +1 MiB, ranging from −5 to +2.
- **Extrapolation to the owner's sizes:**
  - 30 contexts at the real p95 (5.3 MB) ≈ 145 MiB of heap, about 3.5% of
    main's 4.09 GiB `heap_size_limit`.
  - 30 contexts at the real p50 (0.96 MB) ≈ 30 MiB.

**Renderer vs main.** The renderer's footprint moved +2.5 to +19.5 MiB
(control +3) from about 81 MiB before hydration. That growth tracks the census
reads and model-select frames. It is not the context, which lives in main.

**Working set.** `app.getAppMetrics()` reports main at about 260 MiB and the
renderer at about 150 MiB before hydration, but its deltas are **not usable** at
this precision on this host:

- Main's working-set delta ranged from −186 to +182 MiB across launches, and
  from −186 to +113 MiB within a single arm (20 × 500).
- The renderer's delta ranged from −75 to +63 MiB.

macOS compresses and purges resident pages under the memory pressure it
reported. The working-set figures are published as the ticket asked, but
conclusions rest on heap and footprint.

### GC: nothing while contexts are held; small, proportional work while binding

- **Steady window, matrix:** the median is 0 organic GCs per launch in 14 of 16
  bound arms and 1 in the other two, with a maximum of 3. Holding 20 ×
  1,500-entry contexts triggered no GC in any window.
- **Steady window, 47 MB context:** 1 GC per launch (range 1–3). This is the
  one arm where holding a context shows any GC, and its steady loop and IPC
  deltas against idle are still 0.
- **Hydration window:** GC work scales with how much is loaded.
  - Binding 20 × 1,500 entries: a median of 20 GCs and 53 ms of GC per launch;
    pauses p50 2.3, p95 8.1, max 14.3 ms (114 pauses).
  - One 47 MB bind: 8 GCs, 21 ms, max pause 11.8 ms.
- **Full-GC pause over the live heap** (forced, stop-the-world), medians:
  - Binding 20 × 1,500 (+98 MiB): 26 ms before → 40 ms after.
  - Control: 36 → 32 ms.

  Across all arms the spread under load is wide (17–353 ms), so the growth is
  about +14 ms per 100 MiB, not a cliff. The large run shows 23 → 24 ms for
  +44 MiB.

### Main loop and IPC: flat while held; one stall per re-bind

The table below covers N = 20 for each history length, plus the control and the
large runs.

- Pooled cells read `p50 / p95 / max (samples)` in ms.
- Δ cells are paired against the same launch's idle window: median
  [min–max] across launches.

| Arm | Steady: 10 ms tick gap | Steady: IPC echo | Steady ΔIPC echo p95 | Hydration: tick gap | Hydration: IPC echo | Hydration Δtick-gap p95 | Hydration ΔIPC echo p95 | r(loop, echo) |
|---|---|---|---|---|---|---|---|---:|
| Control | 10.4 / 12.6 / 34.6 (3451) | 0.3 / 3.2 / 27.7 (5592) | −1.0 [−5.9–3.4] | — | — | — | — | — |
| 20 × 10 | 10.4 / 11.4 / 59.6 (3500) | 0.3 / 1.6 / 43.9 (5835) | −0.1 [−1.2–1.2] | 10.0 / 14.4 / 33.1 (406) | 0.3 / 6.6 / 26.7 (548) | +1.6 [0.2–7.4] | +2.7 [1.6–13.3] | 0.66 |
| 20 × 100 | 10.3 / 11.1 / 41.5 (3509) | 0.3 / 1.2 / 36.6 (5877) | +0.1 [−0.4–1.2] | 10.0 / 13.2 / 43.5 (432) | 0.3 / 5.1 / 36.2 (614) | +0.9 [0.0–3.8] | +2.7 [1.7–5.1] | 0.70 |
| 20 × 500 | 10.4 / 13.8 / 252.4 (3342) | 0.3 / 3.1 / 227.4 (5441) | −0.9 [−3.6–14.2] | 10.2 / 19.9 / 139.3 (886) | 0.8 / 11.2 / 140.1 (1185) | +6.7 [−0.6–8.2] | +7.8 [0.9–12.5] | 0.91 |
| 20 × 1,500 | 10.4 / 11.1 / 41.9 (3481) | 0.2 / 1.2 / 29.6 (5807) | −0.6 [−1.5–5.5] | 10.2 / 30.9 / 127.2 (767) | 0.5 / 21.8 / 117.4 (1079) | +19.4 [16.9–22.9] | +19.7 [17.9–22.9] | 0.96 |
| 1 × 4,500 (16 MB) | 10.4 / 11.3 / 69.9 (3463) | 0.3 / 1.3 / 69.8 (5461) | −0.1 [−0.5–0.6] | 11.2 / 68.7 / 79.7 (49) | 2.1 / 61.9 / 70.3 (53) | +55.8 [50.6–68.7] | +61.0 [55.0–69.5] | 1.00 |
| 1 × 13,500 (47 MB) | 10.4 / 11.1 / 55.8 (3496) | 0.3 / 1.1 / 41.6 (5510) | 0.0 [−10.4–0.4] | 10.3 / 187.2 / 247.4 (73) | 0.7 / 167.6 / 241.5 (100) | +178.9 [163.8–236.2] | +180.9 [166.9–240.3] | 1.00 |

- **Held contexts cost the loop nothing measurable.** Steady-window tick gaps
  and IPC round trips do not move with N or history. The idle-paired steady
  deltas (median) stay within about ±3 ms in every arm of both runs, with no
  trend in N or history; the full table is in `tables.md`.
- **The largest idle and steady gaps came from host load.** Every idle or steady
  gap over 100 ms in the matrix (three of them in 102 launches, one of them
  *before* any binding) happened in a launch whose 1-minute load was 12–43. The
  large run's worst idle or steady gap was 70 ms.
- **Re-binding stalls main once per Session, in proportion to sidecar size.**
  The hydration window's `monitorEventLoopDelay` max (median across launches)
  was:
  - about 27–30 ms at 5 MB for N ≤ 10 (74 ms for the 20-bind window);
  - 62 ms at 16 MB, range 57–72;
  - 188 ms at 47 MB, range 174–242.

  That is roughly 4–6 ms per MB of sidecar on this M1. The idle-paired Δtick-gap
  p95 rises the same way: about +1–2 ms at 10 and 100 entries, +7 ms at 500,
  +19 ms at 1,500, +56 ms at 16 MB and +179 ms at 47 MB.
- **A renderer→main request that lands in the stall waits it out.** The
  correlation is r = 0.96 at 20 × 1,500 and r = 1.00 for the large single binds,
  where the IPC echo's p95 rises with the tick gap's, ms for ms. This is
  VC-355's finding at bind scale, and it measures caveat 3 rather than assuming
  it.
- **Bind wall time**, for the N = 20 rows, all launches (`tables.md`,
  "Hydration"):
  - Later binds p50: 23 ms at 10 entries, 27 ms at 100, 58 ms at 500 and 72 ms
    at 1,500.
  - The first bind after boot: 91–200 ms p50. It carries one-time, mostly
    asynchronous setup; at 10 entries its worst tick gap is 14 ms.

  Wall time includes asynchronous work and stretches under load, so the stall
  figures above, not wall time, are what blocks main.
- **Where the stall comes from.**
  [`profile-attach.mjs`](../../../apps/desktop/e2e/bench/pi-context-scaling/profile-attach.mjs)
  grows one sidecar with the same generator and CPU-profiles plain-Node Pi
  re-attaches, with no app and no ledger. Its outputs are committed beside the
  data.
  - A 4.4 MB, 1,500-entry sidecar re-attaches in 24–32 ms.
  - A 40 MB, 13,500-entry sidecar re-attaches in 225–340 ms.
  - Nearly all the self time is Pi's own sidecar load in
    `pi-agent-core/session/jsonl`: `parseJsonlTransaction`,
    `string_decoder`, and `splitCompleteLines`. The whole file is decoded and
    parsed in one synchronous pass after an async read.
  - Volli's own recovery fold (`conversationPath`, `contextMessages`,
    `recoveredObservation`) takes a few ms.

## What the curve supports

### Option 3, hibernate idle contexts: not supported

- The heap is linear and moderate, about 1× sidecar bytes per context. 30
  contexts at the real p95 size take about 3.5% of main's heap limit.
- Holding contexts adds no loop or IPC cost, and GC appears only at the largest
  context.
- The only loop cost measured *is* re-hydration. Hibernation would pay that
  stall again on every wake, which makes responsiveness worse in order to save
  memory that is not scarce.
- There is still no context-eviction path (`dispose` releases ports, not
  history), and nothing here argues for building one.

### Option 1, one shared utility-process host: not supported by this data

- It would move Pi's heap out of main, but main's heap is not under pressure.
- It would take the sidecar parse off main's loop, but that parse happens once
  per Session per launch and can be yielded in place (below).
- A held context costs main's loop and IPC nothing.
- Against those small gains stand the costs VC-366 already listed: an ordered
  snapshot/update bridge, abort and interrupt, the parked-ask join, the network
  session, SIGTERM semantics, and `disclaim`.
- Turn-time behaviour is VC-441's to measure. If VC-441 finds turns blocking
  main, the question reopens on that evidence.

### Option 2, stay in main and yield: supported

- Everything measured is flat while contexts are held.
- The single stall has one cause, the synchronous whole-sidecar parse at
  re-bind, and its size is predictable from sidecar bytes:
  - at the real p95: about 30 ms, invisible in practice;
  - at the real p99 (13 MB): about 50–60 ms;
  - at the real max: about 0.2 s.
- It is the same class of fix as VC-369 (1,607 → 12 ms by yielding), at a
  smaller size.
- The stall is already visible inside the ticket's own matrix, as +19 ms p95 and
  up to 141 ms max at 1,500 entries. The large run extends it to real sizes.

**Implementation ticket filed: VC-462.** The Pi sidecar re-bind should not hold
main's loop in proportion to sidecar size. The fix is to chunk or yield the
JSONL load, or otherwise avoid parsing the whole file in one task, and this
bench's large-sidecar arm is the before/after test. The ticket is scoped as an
Option-2 yield only: no topology, hibernation, concurrency or scheduling change.

**Done in VC-462** ([report](pi-sidecar-rebind-yield-vc462.md)). The
47 MB re-bind's loop-delay max fell from about 190 ms to about 23 ms, with
the IPC echo max following it.

## Caveats

- **Shared, loaded host.** Latency and bind times are directional. The
  load ≤ 12 subset in `tables.md` preserves every conclusion. For example, for
  20 × 1,500, where all 6 launches were kept:
  - hydration tick-gap p95 is 30.9 ms;
  - steady IPC echo p95 is 1.2 ms.

  For 10 × 1,500, where 4 of 6 launches were kept:
  - hydration tick-gap p95 is 29.4 ms against 32.7 ms over all launches;
  - steady echo p95 is 0.5 ms against 1.4 ms.
- **Working set is not a context measure on this host** (see above). Use heap
  and footprint.
- **Synthetic mass.** Entries average about 3.4 KB: tool results of 1–16 KB,
  opaque reasoning signatures of 0.8–2.4 KB, and answers of 0.3–1.5 KB. Real
  Sessions vary more. Heap and stall both scale with **bytes**, so estimate a
  real Session from its sidecar size using the fits above, not from its entry
  count.
- **Hydration is sequential.** The bench binds one Session at a time, as a
  person re-opening Sessions would. A burst that binds many at once, such as
  boot recovery of several mid-turn Sessions, is serialized behind the same
  stalls. It was not measured concurrently.
- **Few samples in short windows.** A hydration window lasts tens to hundreds of
  ms, so small-N hydration cells are marked † where their p95 is the maximum.
  The verdict does not rest on those cells.
- **Playwright's inspector** is attached to main, as in every desktop bench
  (VC-353), and it applies equally to all arms.
- **Nothing here times a turn.** What a running turn costs main belongs to
  VC-441.

## Reproduce

```sh
pnpm install && pnpm run build
pnpm bench:pi-context-scaling --repetitions 6 --output /tmp/vc445          # ~55 min
pnpm bench:pi-context-scaling --bound 1 --histories 4500,13500 --repetitions 6 --output /tmp/vc445-large
node apps/desktop/e2e/bench/pi-context-scaling/reaggregate.mjs /tmp/vc445  # rebuild aggregate + tables from raw
node apps/desktop/e2e/bench/pi-context-scaling/profile-attach.mjs --entries 13500
pnpm test:performance-harness   # bench lane: aggregation + tripwire tests (not the default lane)
```

The bench needs a display. It uses `VOLLI_QUIET_WINDOWS`, so it never takes
focus. It creates and removes its own marked `/tmp/vc445-*` root, refuses to
delete any `--root` it did not create, and never touches a real profile, app or
Session.
