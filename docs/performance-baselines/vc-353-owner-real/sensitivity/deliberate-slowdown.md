# Desktop performance baseline

> Performance numbers are comparable only on the same machine, in the same power/thermal state, with the same load arm.

Generated: 2026-09-13T15:18:22.544Z
Git: `c17dc86c9fa157857687062680cb5c0ae2408096`
Device: MacBookPro17,1 — Apple M1, 8 logical cores, 16.0 GiB
macOS: 26.5.1 (25F80)
Fixture: `real`, seed `353259855`, 1,198 Sessions / 259,855 Session Events / 392 Tickets
Sampling: 20 repetitions; arms: idle.

## Results

| Load | Interaction | latency p50 | latency p95 | variance | frame p95 | dropped p95 | long tasks p95 | RSS p95 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| idle | Simultaneous streaming and scrolling | 3022.7 ms | 3137.1 ms | 4791.248 ms² | 34.7 ms | 59 | 0 | 252 MB |

## Method

- The app measurements launch the production Vite/Electron build against a fresh APFS-cloned copy of the deterministic, file-backed migrated fixture for every repetition.
- `interactive` means all 392 board cards and the New ticket control are present after two animation frames. Long-chat first paint is the first visible transcript turn; interactive additionally requires a responsive transcript scroller.
- Frame loss uses a per-sample refresh interval (25th percentile of ordinary rAF deltas), not a hard-coded 60 Hz budget. Long tasks are Chromium `PerformanceObserver` `longtask` entries.
- Streaming uses the existing real-`ChatPlane` Electron bench with the preset's long-transcript message count. It grows one assistant message under the production working/live lifecycle at 30 tokens/s, traverses prose → an incrementally growing open TypeScript fence → a closed fence → prose, and moves the transcript scroller every animation frame in the same loop.
- The loaded arm is named `N-busy-core`: N Node worker threads run the fixed integer-mixing loop in `busy-worker.mjs` continuously from before Electron launch through the last sample; actual arm duration and worker checksums are recorded in JSON.
- RSS is Electron `app.getAppMetrics()` renderer working-set size. RPC is the native tRPC `session.projection` request through the preload IPC bridge.
