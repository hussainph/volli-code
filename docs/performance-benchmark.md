# Desktop performance benchmark

VC-353 establishes the repeatable desktop performance matrix used by the performance program. It measures the product; it does not optimize product behavior.

> Numbers from different machines are not comparable. Compare runs only on the same machine, in the same power and thermal state, with the same fixture preset, build, repetition count, and load arm.

## Run the full matrix

From a clean checkout on macOS:

```sh
pnpm install
pnpm bench:desktop -- --preset real --output performance-results/my-real-run
```

The command builds the production Electron app and the real-`ChatPlane` renderer bench, creates and verifies a deterministic migrated fixture, runs the idle and `2-busy-core` arms, and writes:

- `benchmark.json`: host, macOS, Git SHA, fixture manifest and verification, load configuration, raw samples, p50/p95/variance summaries, RSS, frame times, dropped frames, and long tasks.
- `benchmark.md`: a compact table and the method needed to interpret it.

A full baseline uses 20 repetitions. That makes the nearest-rank p95 the second-largest sample instead of relabelling the maximum of a small sample. For a quick harness check:

```sh
pnpm bench:desktop -- --preset small --repetitions 2 --arms idle --stream-steps 30 --output /tmp/volli-perf-smoke
```

Use `--help` for all controls. When reusing `--fixture`, also pass the preset that generated it. `--skip-build` is only for repeated local probes after the relevant app and chat-bench bundles have already been built. Short smoke runs may finish while the scripted code fence is still open; the default 120-frame baseline reaches and closes it, and each raw sample records both phases.

## Fixture contract

The generator is `apps/desktop/e2e/bench/performance/fixture.mjs`. It creates a user-data directory containing `volli.db`, transcript artifacts, project/worktree directories, and `performance-fixture.json`. It always opens the file through production `openVolliDb(dbPath)` and the production migration runner; it never creates an in-memory schema or copies SQL.

| preset | Sessions | Session Events | Tickets | Ticket Events | Commands | Live worktrees | overlaps | busiest Session | transcript messages |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `small` | 120 | 26,040 | 40 | 547 | 856 | 8 | 3 | 1,200 | 220 |
| `real` | 1,198 | 259,855 | 392 | 5,361 | 8,541 | 50 | 17 | 1,668 | 1,600 |
| `2x` | 2,396 | 519,710 | 784 | 10,722 | 17,082 | 100 | 34 | 3,336 | 3,200 |

The default seed is `353259855`. A capped deterministic long-tail allocator preserves exact totals and puts the maximum on `perf-session-0001` (`PERF-1`). The `real` preset has 21 Sessions at or above 1,000 events (p50 149, p95 592, p99 1,164), while retaining exactly one 1,668-event maximum. Event and transcript payloads contain generated prose, fenced code, and tool results only. Fixture verification opens the DB through production code, checks schema/counts/distribution/foreign keys/worktree overlap, folds the long Session, decodes ledger events, and reads a content-addressed transcript artifact.

`fixture.test.mjs` pins the real allocation digest and regenerates the small database byte-for-byte at the same path. Absolute fixture paths are deliberately part of database bytes, so database digests are comparable only for the same output path; the event-allocation digest is path-independent.

## Matrix and timing boundaries

Each full-app repetition uses a fresh APFS clone of the verified fixture and a fixture-only Electron profile. The built renderer assertion rejects a dev-server run.

1. **Cold launch to interactive** — before Electron launch until all fixture board cards and the New ticket control exist and two animation frames settle. FCP, buffered long tasks, and renderer RSS are also recorded.
2. **Long chat** — click the fixture’s busiest Session (1,668 events in `real`) until the first transcript row paints; interactive additionally requires its real transcript scroller to respond across two animation frames.
3. **Streaming while scrolling** — the existing Electron `ChatPlane` bench seeds the preset’s long-transcript message count. One stable assistant message grows under the production `turnActive` lifecycle at 30 tokens/s while the transcript scroll position moves every animation frame. The deterministic stream traverses prose, roughly 4 KB of incrementally growing TypeScript across 44 open-fence snapshots, the closing fence, and more prose. The earlier 107-character fence reported zero dropped frames before VC-357 and could not measure that bug. Each raw sample records whether it streamed while a Turn was active and reached both fence phases. The stream renderer is isolated from SQLite intentionally: this interaction prices the production rendering path after the fixture-backed app measurement prices migration, replay, IPC, and artifact hydration. RSS is sampled directly after every stream.
4. **New chat** — `+ Chat` until the newly visible composer is enabled and accepts focus.
5. **New terminal** — terminal menu action until a visible real terminal canvas answers `stty size` through its PTY.
6. **Sidebar** — close and open separately, retaining rAF frame deltas through each complete transition.
7. **Ticket workspace switch** — direct command-palette switch from `PERF-1` to `PERF-2` until the target workspace tab is visible.
8. **Board render** — navigate back to Board until every fixture ticket slot is present.
9. **RPC round trip** — one native preload/session-RPC `session.projection` call timed wholly in the renderer.

Latency summaries report nearest-rank p50 and p95 plus population variance. Renderer memory is Electron’s renderer working-set reading from `app.getAppMetrics()`. Long-task counts are summarized per sample so runs with different repetition counts are not compared by a misleading raw sum.

### Frames and streaming

Frame intervals come from `requestAnimationFrame`. Every sample derives its refresh interval from the 25th percentile of ordinary positive sub-50 ms deltas, rather than assuming a 60 Hz display. A gap contributes `round(gap / refreshInterval) - 1` dropped frames. Chromium `PerformanceObserver` supplies long tasks.

The stream rate is wall-clock based. If a frame stalls, the next snapshot coalesces the tokens that would have arrived during that stall; it does not unrealistically slow the producer to match the renderer. Override the documented default only when the report records the same `--stream-token-rate` in every compared arm.

## Reproducible background load

The loaded arm is named `N-busy-core`. It starts N Node worker threads running the fixed integer-mixing loop in `apps/desktop/e2e/bench/performance/busy-worker.mjs` before measurements and stops them after the arm. The JSON records N, actual arm duration, worker iterations, and checksums. It is a scheduler/thermal pressure primitive, not a simulation of any particular compiler.

The default is two workers. Choose a different N explicitly and keep it fixed for all runs being compared:

```sh
pnpm bench:desktop -- --preset real --busy-cores 4 --output performance-results/real-4-busy-core
```

Do not run unrelated builds, tests, screen recording, or energy-mode changes during either arm. Keep the machine on power and let it reach a stable thermal state first.

## Regression-sensitivity proof

The renderer bench has an opt-in busy wait that is zero in all ordinary baselines. To prove the instrument moves without leaving a product slow path behind, run back-to-back stream-only controls against the same built code:

```sh
pnpm bench:desktop -- --preset real --stream-only --arms idle --repetitions 20 \
  --output /tmp/vc353-control
pnpm bench:desktop -- --preset real --stream-only --arms idle --repetitions 20 \
  --slowdown-ms 20 --output /tmp/vc353-deliberate-slowdown
```

The expected signal is higher stream frame-time and wall-time p50/p95 and more dropped frames in the second report. `--slowdown-ms` defaults to zero and the committed owner baseline must record zero. The committed proof alongside the baseline records the observed movement.

## Baseline use

The owner-machine `real` baseline is under `docs/performance-baselines/vc-353-owner-real/`. Before using it as a comparison point, check its SHA, dirty flag, device/macOS fields, preset/seed, load names, worker counts, and slowdown value. A later ticket should publish its own before/after pair on one machine rather than compare its machine to this owner baseline.
