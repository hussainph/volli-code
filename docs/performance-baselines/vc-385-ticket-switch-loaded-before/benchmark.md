# Desktop performance baseline

> Performance numbers are comparable only on the same machine, in the same power/thermal state, with the same load arm.

Generated: 2026-09-16T13:08:51.148Z
Git: `2f0f55c23cbfbc64da2f2678e3a6caf2ed9d763a` (dirty working tree)
Device: MacBookPro17,1 — Apple M1, 8 logical cores, 16.0 GiB
macOS: 26.5.1 (25F80)
Fixture: `real`, seed `353259855`, 1,198 Sessions / 259,855 Session Events / 392 Tickets
Sampling: 20 repetitions per interaction and arm; arms: 2-busy-core-for-3600s.
Each arm discards 1 warm-up iteration(s) first, so the arms differ by load rather than by which met a cold cache.
Loaded-arm contract: 2 busy cores for a fixed 3,600 seconds.

## Results

| Load | Interaction | latency p50 | latency p95 | variance | frame p95 | dropped p95 | long tasks p95 | RSS p95 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 2-busy-core-for-3600s | Switch between ticket workspaces | 771.9 ms | 1185.2 ms | 35415.45 ms² | 17.8 ms | 2 | 1 | 363.797 MB |
| 2-busy-core-for-3600s | ↳ open palette | 37.3 ms | 51.7 ms | 72.361 ms² | — | — | — | — |
| 2-busy-core-for-3600s | ↳ find row | 615.3 ms | 941.5 ms | 25140.272 ms² | — | — | — | — |
| 2-busy-core-for-3600s | ↳ rebuild workspace | 1.1 ms | 1.4 ms | 0.027 ms² | — | — | — | — |
| 2-busy-core-for-3600s | ↳ description editor | 30.1 ms | 37.8 ms | 21.146 ms² | — | — | — | — |
| 2-busy-core-for-3600s | ↳ settle | 103.4 ms | 157.6 ms | 794.011 ms² | — | — | — | — |
| 2-busy-core-for-3600s | ↳ (of which sessions.list) | 496.8 ms | 760.6 ms | 19283.658 ms² | — | — | — | — |

## Method

- The app measurements launch the production Vite/Electron build against a fresh APFS-cloned copy of the deterministic, file-backed migrated fixture for every repetition.
- `interactive` means all 392 board cards and the New ticket control are present after two animation frames. Long-chat first paint is the first visible transcript turn; interactive additionally requires a responsive transcript scroller.
- Frame loss uses a per-sample refresh interval (25th percentile of ordinary rAF deltas), not a hard-coded 60 Hz budget. Long tasks are Chromium `PerformanceObserver` `longtask` entries.
- Streaming uses the existing real-`ChatPlane` Electron bench with the preset's long-transcript message count. It grows one assistant message under the production `turnActive` lifecycle at 30 tokens/s, traverses prose → a roughly 4 KB TypeScript fence → 96 more growing snapshots → a closed fence → prose, and moves the transcript scroller inside the live row on both paint frames per stream step. This keeps the growing fence visible rather than letting Streamdown defer it as offscreen content. The concurrent window ends before the final settle-time highlight; raw samples report that cost separately.
- The loaded arm is named `N-busy-core-for-3600s`: N Node worker threads run one fixed integer-mixing loop against a shared monotonic deadline. A full arm fails if measurement reaches that deadline and otherwise holds the load until the configured exposure is complete; quick stream-only smoke runs stop early and say so in JSON.
- Ticket switching first makes both workspaces usable, returns to the first, then times selection and focus-readiness of the already-open second workspace.
- RSS is Electron `app.getAppMetrics()` renderer working-set size. RPC is the native tRPC `session.projection` request through the preload IPC bridge.

Raw samples and complete host/fixture metadata are in benchmark.json; benchmark.summary.json is the compact, committable aggregate artifact.
