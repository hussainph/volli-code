# Desktop performance baseline

> Performance numbers are comparable only on the same machine, in the same power/thermal state, with the same load arm.

Generated: 2026-09-16T12:12:17.050Z
Git: `13312a744fed03728575e2fdd2a70c9cc1e04557` (dirty working tree)
Device: MacBookPro17,1 — Apple M1, 8 logical cores, 16.0 GiB
macOS: 26.5.1 (25F80)
Fixture: `real`, seed `353259855`, 1,198 Sessions / 259,855 Session Events / 392 Tickets
Sampling: 20 repetitions per interaction and arm; arms: idle.
Each arm discards 1 warm-up iteration(s) first, so the arms differ by load rather than by which met a cold cache.
Loaded-arm contract: 2 busy cores for a fixed 3,600 seconds.

## Results

| Load | Interaction | latency p50 | latency p95 | variance | frame p95 | dropped p95 | long tasks p95 | RSS p95 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| idle | Switch between ticket workspaces | 278.5 ms | 414.1 ms | 3801.461 ms² | 33.3 ms | 3 | 2 | 393.125 MB |
| idle | ↳ open palette | 37.6 ms | 46.1 ms | 21.709 ms² | — | — | — | — |
| idle | ↳ find row | 130.4 ms | 162.1 ms | 289.838 ms² | — | — | — | — |
| idle | ↳ rebuild workspace | 1 ms | 1.5 ms | 0.043 ms² | — | — | — | — |
| idle | ↳ description editor | 30.8 ms | 50 ms | 67.083 ms² | — | — | — | — |
| idle | ↳ settle | 85.1 ms | 190 ms | 1564.922 ms² | — | — | — | — |
| idle | ↳ (of which sessions.list) | 10.3 ms | 13.2 ms | 1.823 ms² | — | — | — | — |

## Method

- The app measurements launch the production Vite/Electron build against a fresh APFS-cloned copy of the deterministic, file-backed migrated fixture for every repetition.
- `interactive` means all 392 board cards and the New ticket control are present after two animation frames. Long-chat first paint is the first visible transcript turn; interactive additionally requires a responsive transcript scroller.
- Frame loss uses a per-sample refresh interval (25th percentile of ordinary rAF deltas), not a hard-coded 60 Hz budget. Long tasks are Chromium `PerformanceObserver` `longtask` entries.
- Streaming uses the existing real-`ChatPlane` Electron bench with the preset's long-transcript message count. It grows one assistant message under the production `turnActive` lifecycle at 30 tokens/s, traverses prose → a roughly 4 KB TypeScript fence → 96 more growing snapshots → a closed fence → prose, and moves the transcript scroller inside the live row on both paint frames per stream step. This keeps the growing fence visible rather than letting Streamdown defer it as offscreen content. The concurrent window ends before the final settle-time highlight; raw samples report that cost separately.
- The loaded arm is named `N-busy-core-for-3600s`: N Node worker threads run one fixed integer-mixing loop against a shared monotonic deadline. A full arm fails if measurement reaches that deadline and otherwise holds the load until the configured exposure is complete; quick stream-only smoke runs stop early and say so in JSON.
- Ticket switching first makes both workspaces usable, returns to the first, then times selection and focus-readiness of the already-open second workspace.
- RSS is Electron `app.getAppMetrics()` renderer working-set size. RPC is the native tRPC `session.projection` request through the preload IPC bridge.

Raw samples and complete host/fixture metadata are in benchmark.json; benchmark.summary.json is the compact, committable aggregate artifact.
