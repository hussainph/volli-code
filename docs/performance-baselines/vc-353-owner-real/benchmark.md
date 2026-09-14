# Desktop performance baseline

> Performance numbers are comparable only on the same machine, in the same power/thermal state, with the same load arm.

Generated: 2026-09-13T15:33:18.936Z
Git: `b0e8c9ff14d6c0acda3c93ff24f6ec95d68ab497`
Device: MacBookPro17,1 — Apple M1, 8 logical cores, 16.0 GiB
macOS: 26.5.1 (25F80)
Fixture: `real`, seed `353259855`, 1,198 Sessions / 259,855 Session Events / 392 Tickets
Sampling: 20 repetitions per interaction and arm; arms: idle, 2-busy-core.

## Results

| Load | Interaction | latency p50 | latency p95 | variance | frame p95 | dropped p95 | long tasks p95 | RSS p95 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| idle | Cold launch to interactive | 17232.48 ms | 25042.5 ms | 14841887.696 ms² | — ms | — | 4 | 254.719 MB |
| idle | ↳ first paint | 280 ms | 484 ms | 8224.76 ms² | — | — | — | — |
| idle | Long-chat first paint and interactive | 2312.8 ms | 4523.8 ms | 1337431.427 ms² | 17.7 ms | 60 | 3 | 338.188 MB |
| idle | ↳ first paint | 2288.8 ms | 4340.5 ms | 1231895.555 ms² | — | — | — | — |
| idle | Simultaneous streaming and scrolling | 2154.3 ms | 2156 ms | 0.64 ms² | 18.5 ms | 0 | 0 | 112 MB |
| idle | + Chat to usable composer | 352.9 ms | 951.7 ms | 64877.532 ms² | 17.7 ms | 34 | 0 | 354.281 MB |
| idle | New terminal session | 3652.3 ms | 5561.7 ms | 707295.339 ms² | 17.7 ms | 11 | 2 | 351.813 MB |
| idle | Sidebar open/close frame times | 717.4 ms | 1390.2 ms | 56554.826 ms² | 17.7 ms | 41 | 0 | 311.75 MB |
| idle | ↳ close / open | 361.9 / 347.2 ms | 850.5 / 483.9 ms | — | — | — | — | — |
| idle | Switch between ticket workspaces | 2954.4 ms | 5234.6 ms | 1066120.949 ms² | 18.5 ms | 98 | 4 | 867.016 MB |
| idle | Board render | 431.7 ms | 1632.6 ms | 151443.237 ms² | 116.7 ms | 79 | 3 | 921.078 MB |
| idle | Session RPC projection round trip | 0.6 ms | 12.3 ms | 24.616 ms² | 17.7 ms | 0 | 0 | 866.828 MB |
| 2-busy-core | Cold launch to interactive | 20892.222 ms | 24961.477 ms | 7514862.867 ms² | — ms | — | 3 | 230.938 MB |
| 2-busy-core | ↳ first paint | 352 ms | 472 ms | 6331.64 ms² | — | — | — | — |
| 2-busy-core | Long-chat first paint and interactive | 4151.5 ms | 5396.1 ms | 1430622.861 ms² | 17.6 ms | 72 | 3 | 312.469 MB |
| 2-busy-core | ↳ first paint | 4111.9 ms | 5365.5 ms | 1447291.066 ms² | — | — | — | — |
| 2-busy-core | Simultaneous streaming and scrolling | 2153.9 ms | 2154.7 ms | 0.37 ms² | 17.6 ms | 0 | 0 | 143 MB |
| 2-busy-core | + Chat to usable composer | 541.7 ms | 942 ms | 82927.011 ms² | 17.5 ms | 0 | 0 | 326.703 MB |
| 2-busy-core | New terminal session | 5348.6 ms | 8456.8 ms | 2542106.113 ms² | 17.6 ms | 14 | 3 | 320.531 MB |
| 2-busy-core | Sidebar open/close frame times | 821.7 ms | 1379.3 ms | 40025.213 ms² | 17.6 ms | 37 | 0 | 277.984 MB |
| 2-busy-core | ↳ close / open | 418.5 / 373.5 ms | 897.8 / 543.9 ms | — | — | — | — | — |
| 2-busy-core | Switch between ticket workspaces | 4628.9 ms | 7596.9 ms | 2555947.035 ms² | 17.6 ms | 76 | 4 | 839.828 MB |
| 2-busy-core | Board render | 518.3 ms | 701.6 ms | 11260.062 ms² | 116.7 ms | 22 | 4 | 830.875 MB |
| 2-busy-core | Session RPC projection round trip | 0.9 ms | 4.6 ms | 1.769 ms² | 17.5 ms | 0 | 0 | 826.891 MB |

## Background-load gap (idle → 2-busy-core)

| Interaction | p50 delta | p50 ratio | p95 delta | p95 ratio |
|---|---:|---:|---:|---:|
| Cold launch to interactive | 3659.742 ms | 1.212× | -81.023 ms | 0.997× |
| Long-chat first paint and interactive | 1838.7 ms | 1.795× | 872.3 ms | 1.193× |
| Simultaneous streaming and scrolling | -0.4 ms | 1× | -1.3 ms | 0.999× |
| + Chat to usable composer | 188.8 ms | 1.535× | -9.7 ms | 0.99× |
| New terminal session | 1696.3 ms | 1.464× | 2895.1 ms | 1.521× |
| Sidebar open/close frame times | 104.3 ms | 1.145× | -10.9 ms | 0.992× |
| Switch between ticket workspaces | 1674.5 ms | 1.567× | 2362.3 ms | 1.451× |
| Board render | 86.6 ms | 1.201× | -931 ms | 0.43× |
| Session RPC projection round trip | 0.3 ms | 1.5× | -7.7 ms | 0.374× |

## Method

- The app measurements launch the production Vite/Electron build against a fresh APFS-cloned copy of the deterministic, file-backed migrated fixture for every repetition.
- `interactive` means all 392 board cards and the New ticket control are present after two animation frames. Long-chat first paint is the first visible transcript turn; interactive additionally requires a responsive transcript scroller.
- Frame loss uses a per-sample refresh interval (25th percentile of ordinary rAF deltas), not a hard-coded 60 Hz budget. Long tasks are Chromium `PerformanceObserver` `longtask` entries.
- Streaming uses the existing real-`ChatPlane` Electron bench with the preset's long-transcript message count. It grows one assistant message under the production working/live lifecycle at 30 tokens/s, traverses prose → an incrementally growing open TypeScript fence → a closed fence → prose, and moves the transcript scroller every animation frame in the same loop.
- The loaded arm is named `N-busy-core`: N Node worker threads run the fixed integer-mixing loop in `busy-worker.mjs` continuously from before Electron launch through the last sample; actual arm duration and worker checksums are recorded in JSON.
- RSS is Electron `app.getAppMetrics()` renderer working-set size. RPC is the native tRPC `session.projection` request through the preload IPC bridge.
