# Desktop performance baseline

> Performance numbers are comparable only on the same machine, in the same power/thermal state, with the same load arm.

Generated: 2026-09-14T16:53:33.589Z
Git: `e3c936ed21b22d83ebd250754e260ecf3927f240`
Device: MacBookPro17,1 — Apple M1, 8 logical cores, 16.0 GiB
macOS: 26.5.1 (25F80)
Fixture: `real`, seed `353259855`, 1,198 Sessions / 259,855 Session Events / 392 Tickets
Sampling: 20 repetitions per interaction and arm; arms: idle, 2-busy-core-for-3600s.
Each arm discards 1 warm-up iteration(s) first, so the arms differ by load rather than by which met a cold cache.
Loaded-arm contract: 2 busy cores for a fixed 3,600 seconds.
Fixture file: 373,002,240 bytes total — 256,671,744 live, 116,330,496 free pages, 175,083,520 in `session_events`; largest `app_state` row 508 bytes.
Health: 0 renderer console errors and `firstTurn.reached: true` in every iteration of both arms; the run publishes nothing otherwise.

## The event mix has changed since this run (VC-368)

This run generated **no `context.reasoning_dropped` events**. The kind was held
out of `apps/desktop/e2e/bench/performance/event-mix.mjs` while the renderer
could not read its scrubbed shape, and every benchmark run would otherwise have
failed the harness's zero-renderer-error gate. VC-368 fixed the codec and put
the family back at weight 10 per 1,000 allocated units, taken back from
`observation.token-batch`.

So the distribution behind the numbers below differs from today's by **10 events
per 1,000** — roughly 2,600 of this fixture's 259,855 events are a reasoning-drop
payload now where they were a token batch then. Both are small single-event
families, so the effect on fixture mass is well under the run-to-run spread this
file already warns about, and the numbers stay usable as a rough comparison
point. They are no longer a byte-exact match for a fresh run's fixture: a
like-for-like comparison wants a re-take on the owner's machine.

## Host conditions when this was taken — read before comparing

The host was **not exclusively idle**. System load was sampled every 30s throughout:

| Arm window | mean 1-min load average | mean system-wide CPU (of 800%) |
|---|---:|---:|
| idle arm | 7.66 | 306% |
| 2-busy-core arm | 12.17 | 506% |

That figure includes the app under measurement, but also the owner's own running
Volli Code and this agent session. The consequences are worth stating plainly:

- Absolute numbers here are **pessimistic**. A quiet machine will read lower.
- The idle → loaded gap is **understated**, because the "idle" arm was already
  contended; the true effect of 2 busy cores on a quiet machine is larger than
  the deltas below.
- These numbers are still a valid record of this machine in this state, which is
  all a baseline ever is — the warning at the top is not boilerplate. Compare
  against this only from the same machine in the same state, and prefer taking
  your own before/after pair over comparing to this file.

## Results

| Load | Interaction | latency p50 | latency p95 | variance | frame p95 | dropped p95 | long tasks p95 | RSS p95 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| idle | Cold launch to interactive | 10052.247 ms | 11367.876 ms | 683813.333 ms² | — ms | — | 2 | 281.453 MB |
| idle | ↳ first paint | 236 ms | 268 ms | 975.8 ms² | — | — | — | — |
| idle | Long-chat first paint and interactive | 383.2 ms | 585.6 ms | 9596.272 ms² | 98.8 ms | 13 | 2 | 359.563 MB |
| idle | ↳ first paint | 349.4 ms | 550.7 ms | 9724.653 ms² | — | — | — | — |
| idle | Simultaneous streaming and scrolling | 3999.3 ms | 4000.7 ms | 1.031 ms² | 18.2 ms | 0 | 0 | 294 MB |
| idle | + Chat to usable composer | 240.8 ms | 329.4 ms | 1657.303 ms² | 18.5 ms | 1 | 0 | 378.594 MB |
| idle | New terminal session | 1462.5 ms | 1607.2 ms | 11127.245 ms² | 18.5 ms | 5 | 1 | 396.109 MB |
| idle | Sidebar open/close frame times | 690 ms | 996.3 ms | 21863.147 ms² | 18.2 ms | 20 | 0 | 391.813 MB |
| idle | ↳ close / open | 345.6 / 345 ms | 357.9 / 357.2 ms | — | — | — | — | — |
| idle | Switch between ticket workspaces | 953.8 ms | 1303.3 ms | 35735.513 ms² | 18.6 ms | 6 | 2 | 885.813 MB |
| idle | Board render | 347.5 ms | 390.8 ms | 48022.701 ms² | 100.9 ms | 13 | 2 | 887.422 MB |
| idle | Session RPC projection round trip | 0.8 ms | 5.9 ms | 4.775 ms² | 17.8 ms | 0 | 0 | 890.531 MB |
| 2-busy-core-for-3600s | Cold launch to interactive | 10205.405 ms | 10976.765 ms | 424012.89 ms² | — ms | — | 2 | 300.844 MB |
| 2-busy-core-for-3600s | ↳ first paint | 236 ms | 284 ms | 864.16 ms² | — | — | — | — |
| 2-busy-core-for-3600s | Long-chat first paint and interactive | 658 ms | 1441 ms | 82166.163 ms² | 68.1 ms | 22 | 3 | 370.234 MB |
| 2-busy-core-for-3600s | ↳ first paint | 614.9 ms | 1404.6 ms | 81873.151 ms² | — | — | — | — |
| 2-busy-core-for-3600s | Simultaneous streaming and scrolling | 3999.1 ms | 4000.8 ms | 57.456 ms² | 18.6 ms | 0 | 0 | 281 MB |
| 2-busy-core-for-3600s | + Chat to usable composer | 264 ms | 363.2 ms | 2591.812 ms² | 18.6 ms | 1 | 0 | 387.078 MB |
| 2-busy-core-for-3600s | New terminal session | 1586.3 ms | 2042.3 ms | 42272.568 ms² | 18.6 ms | 4 | 2 | 394 MB |
| 2-busy-core-for-3600s | Sidebar open/close frame times | 693.4 ms | 1115.2 ms | 20799.979 ms² | 18.6 ms | 25 | 1 | 879.141 MB |
| 2-busy-core-for-3600s | ↳ close / open | 345.5 / 346.6 ms | 462.4 / 533.4 ms | — | — | — | — | — |
| 2-busy-core-for-3600s | Switch between ticket workspaces | 1156.8 ms | 1628.5 ms | 53981.953 ms² | 18.6 ms | 6 | 2 | 860.344 MB |
| 2-busy-core-for-3600s | Board render | 366.9 ms | 600 ms | 72487.322 ms² | 116.6 ms | 14 | 2 | 867.609 MB |
| 2-busy-core-for-3600s | Session RPC projection round trip | 1.1 ms | 2.8 ms | 0.909 ms² | 18.6 ms | 0 | 0 | 860.375 MB |

## Background-load gap (idle → 2-busy-core-for-3600s)

| Interaction | p50 delta | p50 ratio | p95 delta | p95 ratio |
|---|---:|---:|---:|---:|
| Cold launch to interactive | 153.158 ms | 1.015× | -391.111 ms | 0.966× |
| Long-chat first paint and interactive | 274.8 ms | 1.717× | 855.4 ms | 2.461× |
| Simultaneous streaming and scrolling | -0.2 ms | 1× | 0.1 ms | 1× |
| + Chat to usable composer | 23.2 ms | 1.096× | 33.8 ms | 1.103× |
| New terminal session | 123.8 ms | 1.085× | 435.1 ms | 1.271× |
| Sidebar open/close frame times | 3.4 ms | 1.005× | 118.9 ms | 1.119× |
| Switch between ticket workspaces | 203 ms | 1.213× | 325.2 ms | 1.25× |
| Board render | 19.4 ms | 1.056× | 209.2 ms | 1.535× |
| Session RPC projection round trip | 0.3 ms | 1.375× | -3.1 ms | 0.475× |

## Method

- The app measurements launch the production Vite/Electron build against a fresh APFS-cloned copy of the deterministic, file-backed migrated fixture for every repetition.
- `interactive` means all 392 board cards and the New ticket control are present after two animation frames. Long-chat first paint is the first visible transcript turn; interactive additionally requires a responsive transcript scroller.
- Frame loss uses a per-sample refresh interval (25th percentile of ordinary rAF deltas), not a hard-coded 60 Hz budget. Long tasks are Chromium `PerformanceObserver` `longtask` entries.
- Streaming uses the existing real-`ChatPlane` Electron bench with the preset's long-transcript message count. It grows one assistant message under the production `turnActive` lifecycle at 30 tokens/s, traverses prose → a roughly 4 KB TypeScript fence → 96 more growing snapshots → a closed fence → prose, and moves the transcript scroller inside the live row on both paint frames per stream step. This keeps the growing fence visible rather than letting Streamdown defer it as offscreen content. The concurrent window ends before the final settle-time highlight; raw samples report that cost separately.
- The loaded arm is named `N-busy-core-for-3600s`: N Node worker threads run one fixed integer-mixing loop against a shared monotonic deadline. A full arm fails if measurement reaches that deadline and otherwise holds the load until the configured exposure is complete; quick stream-only smoke runs stop early and say so in JSON.
- Ticket switching first makes both workspaces usable, returns to the first, then times selection and focus-readiness of the already-open second workspace.
- RSS is Electron `app.getAppMetrics()` renderer working-set size. RPC is the native tRPC `session.projection` request through the preload IPC bridge.

Raw samples and complete host/fixture metadata are in benchmark.json; benchmark.summary.json is the compact, committable aggregate artifact.
