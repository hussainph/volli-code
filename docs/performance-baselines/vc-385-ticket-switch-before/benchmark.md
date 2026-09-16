# Desktop performance baseline

> Performance numbers are comparable only on the same machine, in the same power/thermal state, with the same load arm.

Generated: 2026-09-16T11:49:17.774Z
Git: `13312a744fed03728575e2fdd2a70c9cc1e04557` (dirty working tree)
Device: MacBookPro17,1 — Apple M1, 8 logical cores, 16.0 GiB
macOS: 26.5.1 (25F80)
Fixture: `real`, seed `353259855`, 1,198 Sessions / 259,855 Session Events / 392 Tickets
Sampling: 20 repetitions per interaction and arm; arms: idle.
Each arm discards 1 warm-up iteration(s) first, so the arms differ by load rather than by which met a cold cache.
Loaded-arm contract: 2 busy cores for a fixed 3,600 seconds.
Interactions measured: `ticket_switch` — a narrowed run (`--interactions`); every other interaction was skipped and is absent from the table below.

## Results

| Load | Interaction | latency p50 | latency p95 | variance | frame p95 | dropped p95 | long tasks p95 | RSS p95 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| idle | Switch between ticket workspaces | 707.5 ms | 846 ms | 4451.141 ms² | 17.6 ms | 2 | 1 | 362.875 MB |
| idle | ↳ open palette | 33 ms | 45.4 ms | 50.172 ms² | — | — | — | — |
| idle | ↳ find row | 566.3 ms | 662.7 ms | 2785.19 ms² | — | — | — | — |
| idle | ↳ rebuild workspace | 1.1 ms | 1.3 ms | 0.014 ms² | — | — | — | — |
| idle | ↳ description editor | 28.9 ms | 35 ms | 7.786 ms² | — | — | — | — |
| idle | ↳ settle | 81.8 ms | 105.1 ms | 192.316 ms² | — | — | — | — |
| idle | ↳ (of which sessions.list) | 470.3 ms | 542.1 ms | 1394.323 ms² | — | — | — | — |

### Provenance of this pair

Both reports in the idle pair are stamped `13312a74` with a dirty working tree,
so the SHA alone cannot tell the "before" from the "after". That is what the
dirty flag means here, and it is deliberate rather than an accident:

- **before** — the tree at `13312a74` carrying only this branch's phase-mark
  instrumentation, with the palette fix NOT applied.
- **after** — the same tree with the palette fix applied.

The pair therefore differs by the fix and by nothing else, which is the point.
It also means neither report is reproducible from its SHA alone; the fix landed
in `2f0f55c2`, and the write-up at `docs/research/perf/ticket-switch-vc385.md`
is the record of what each arm ran.

## Method

- The app measurements launch the production Vite/Electron build against a fresh APFS-cloned copy of the deterministic, file-backed migrated fixture for every repetition.
- `interactive` means all 392 board cards and the New ticket control are present after two animation frames. Long-chat first paint is the first visible transcript turn; interactive additionally requires a responsive transcript scroller.
- Frame loss uses a per-sample refresh interval (25th percentile of ordinary rAF deltas), not a hard-coded 60 Hz budget. Long tasks are Chromium `PerformanceObserver` `longtask` entries.
- Streaming uses the existing real-`ChatPlane` Electron bench with the preset's long-transcript message count. It grows one assistant message under the production `turnActive` lifecycle at 30 tokens/s, traverses prose → a roughly 4 KB TypeScript fence → 96 more growing snapshots → a closed fence → prose, and moves the transcript scroller inside the live row on both paint frames per stream step. This keeps the growing fence visible rather than letting Streamdown defer it as offscreen content. The concurrent window ends before the final settle-time highlight; raw samples report that cost separately.
- The loaded arm is named `N-busy-core-for-3600s`: N Node worker threads run one fixed integer-mixing loop against a shared monotonic deadline. A full arm fails if measurement reaches that deadline. What happens otherwise depends on the run, and the "Loaded-arm ending" line above states which of these this one did: a full arm holds the load until the configured exposure is complete (`fixed-duration-complete`), a quick stream-only smoke stops early (`quick-smoke-early-stop`), and a run narrowed with `--interactions` stops as soon as its measurements are done (`narrowed-interactions-early-stop`) — that last exposure is sized to the measurements, so it is comparable to another narrowed run but not to a full matrix.
- Ticket switching first makes both workspaces usable, returns to the first, then times selection and focus-readiness of the already-open second workspace.
- RSS is Electron `app.getAppMetrics()` renderer working-set size. RPC is the native tRPC `session.projection` request through the preload IPC bridge.

Raw samples and complete host/fixture metadata are in benchmark.json; benchmark.summary.json is the compact, committable aggregate artifact.
