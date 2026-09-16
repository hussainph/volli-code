# Desktop performance baseline

> Performance numbers are comparable only on the same machine, in the same power/thermal state, with the same load arm.

Generated: 2026-09-16T13:17:36.433Z
Git: `2f0f55c23cbfbc64da2f2678e3a6caf2ed9d763a` (dirty working tree)
Device: MacBookPro17,1 — Apple M1, 8 logical cores, 16.0 GiB
macOS: 26.5.1 (25F80)
Fixture: `real`, seed `353259855`, 1,198 Sessions / 259,855 Session Events / 392 Tickets
Sampling: 20 repetitions per interaction and arm; arms: 2-busy-core-for-3600s.
Each arm discards 1 warm-up iteration(s) first, so the arms differ by load rather than by which met a cold cache.
Loaded-arm contract: 2 busy cores for a fixed 3,600 seconds.
Loaded-arm ending: narrowed-interactions-early-stop. `fixed-duration-complete` is the only one that met the contract above; every other value means the load stopped when its measurements did, so the exposure was sized to the run rather than to the configured duration.
Interactions measured: `ticket_switch` — a narrowed run (`--interactions`); every other interaction was skipped and is absent from the table below.

## Results

| Load | Interaction | latency p50 | latency p95 | variance | frame p95 | dropped p95 | long tasks p95 | RSS p95 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 2-busy-core-for-3600s | Switch between ticket workspaces | 287.8 ms | 351.3 ms | 1307.738 ms² | 33.1 ms | 2 | 1 | 387.859 MB |
| 2-busy-core-for-3600s | ↳ open palette | 39.3 ms | 53.5 ms | 58.785 ms² | — | — | — | — |
| 2-busy-core-for-3600s | ↳ find row | 120.9 ms | 146.9 ms | 124.329 ms² | — | — | — | — |
| 2-busy-core-for-3600s | ↳ rebuild workspace | 1 ms | 1.2 ms | 0.017 ms² | — | — | — | — |
| 2-busy-core-for-3600s | ↳ description editor | 27.1 ms | 30.9 ms | 3.052 ms² | — | — | — | — |
| 2-busy-core-for-3600s | ↳ settle | 88.5 ms | 140 ms | 526.373 ms² | — | — | — | — |
| 2-busy-core-for-3600s | ↳ (of which sessions.list) | 8.9 ms | 9.6 ms | 0.314 ms² | — | — | — | — |

### Provenance of this pair

Both reports in the loaded pair are stamped `2f0f55c2` with a dirty working
tree, so the SHA alone cannot tell the "before" from the "after" — and the SHA
is the fix commit itself, which would otherwise read as "both runs include the
fix". They do not. The same procedure as the idle pair was used, one commit
later:

- **before** — the tree at `2f0f55c2` with the palette fix reverted in the
  working tree (the pre-fix palette plus the same instrumentation), which is
  what the dirty flag records.
- **after** — `2f0f55c2` with the fix applied, i.e. the committed palette.

In both loaded runs the dirty flag also covers one uncommitted harness change
that later became `92e0643d`: the report validation that lets a narrowed loaded
arm end early. It changes what the harness will accept, never what the app
does, and it was identical across both runs.

The pair therefore differs by the fix and by nothing else. Neither report is
reproducible from its SHA alone; the write-up at
`docs/research/perf/ticket-switch-vc385.md` is the record of what each arm ran.

## Method

- The app measurements launch the production Vite/Electron build against a fresh APFS-cloned copy of the deterministic, file-backed migrated fixture for every repetition.
- `interactive` means all 392 board cards and the New ticket control are present after two animation frames. Long-chat first paint is the first visible transcript turn; interactive additionally requires a responsive transcript scroller.
- Frame loss uses a per-sample refresh interval (25th percentile of ordinary rAF deltas), not a hard-coded 60 Hz budget. Long tasks are Chromium `PerformanceObserver` `longtask` entries.
- Streaming uses the existing real-`ChatPlane` Electron bench with the preset's long-transcript message count. It grows one assistant message under the production `turnActive` lifecycle at 30 tokens/s, traverses prose → a roughly 4 KB TypeScript fence → 96 more growing snapshots → a closed fence → prose, and moves the transcript scroller inside the live row on both paint frames per stream step. This keeps the growing fence visible rather than letting Streamdown defer it as offscreen content. The concurrent window ends before the final settle-time highlight; raw samples report that cost separately.
- The loaded arm is named `N-busy-core-for-3600s`: N Node worker threads run one fixed integer-mixing loop against a shared monotonic deadline. A full arm fails if measurement reaches that deadline. What happens otherwise depends on the run, and the "Loaded-arm ending" line above states which of these this one did: a full arm holds the load until the configured exposure is complete (`fixed-duration-complete`), a quick stream-only smoke stops early (`quick-smoke-early-stop`), and a run narrowed with `--interactions` stops as soon as its measurements are done (`narrowed-interactions-early-stop`) — that last exposure is sized to the measurements, so it is comparable to another narrowed run but not to a full matrix.
- Ticket switching first makes both workspaces usable, returns to the first, then times selection and focus-readiness of the already-open second workspace.
- RSS is Electron `app.getAppMetrics()` renderer working-set size. RPC is the native tRPC `session.projection` request through the preload IPC bridge.

Raw samples and complete host/fixture metadata are in benchmark.json; benchmark.summary.json is the compact, committable aggregate artifact.
