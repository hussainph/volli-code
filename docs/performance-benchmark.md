# Desktop performance benchmark

VC-353 establishes the repeatable desktop performance matrix used by the performance program. It measures the product; it does not optimize product behavior.

> Numbers from different machines are not comparable. Compare runs only on the same machine, in the same power and thermal state, with the same fixture preset, build, repetition count, and load arm.

## Run the full matrix

From a clean checkout on macOS:

```sh
pnpm install
pnpm bench:desktop -- --preset real --output performance-results/my-real-run
```

The command builds the production Electron app and the real-`ChatPlane` renderer bench, creates and verifies a deterministic migrated fixture, runs the idle and loaded arms, and writes three artifacts:

- `benchmark.json`: everything, including every raw sample and every frame delta. At baseline settings it is tens of thousands of lines.
- `benchmark.summary.json`: the same run with the raw arrays removed — device, macOS, Git SHA and dirty flag, fixture preset/seed/verification, load name, worker count and duration, repetition count, per-interaction aggregates for both arms, and the arm gap. Machine-readable, for anything that wants to diff two runs.
- `benchmark.md`: a compact table, the full run context, and the method needed to interpret it.

**None of the JSON is committed.** `performance-results/` is gitignored and so is every JSON under `docs/performance-baselines/`: a benchmark report is machine output, it is large, it changes wholesale on every run, and a repository is a poor place to keep it. What gets committed is the Markdown — which carries the numbers, the device, the macOS build, the commit SHA, the fixture preset and seed, and the load arm, so a published baseline is still self-describing. Keep the JSON next to the run that produced it, or attach it to the ticket.

A run fails, rather than publishes, if any renderer emitted a console error, any health check came back false, or any streaming sample reported itself not ok — in any iteration of any arm. A baseline whose renderer was broken is not a baseline, so the gate refuses to summarize one.

A full baseline uses 20 repetitions. That makes the nearest-rank p95 the second-largest sample instead of relabelling the maximum of a small sample.

Each arm discards one full iteration before it samples. Arms run in sequence, and without that the first arm pays for a cold page cache over a 373 MB fixture and a cold Electron code cache while the second inherits both warm — a confound larger than the effect being measured. The first run of this matrix reported the loaded arm faster than idle on every single interaction for exactly that reason. The warm-up is discarded, never summarized, and both artifacts record that it happened.

For a quick harness check:

```sh
pnpm bench:desktop -- --preset small --repetitions 2 --arms idle --stream-steps 30 --output /tmp/volli-perf-smoke
```

Use `--help` for all controls. When reusing `--fixture`, also pass the preset that generated it. `--skip-build` is only for repeated local probes after the relevant app and chat-bench bundles have already been built. Short smoke runs may finish while the scripted code fence is still open; the default 120-step baseline reaches and closes it, and each raw sample records both phases.

## The bench measures the build the app ships

The renderer bench builds its own page, and that build must be the production one. It was not, for a while: React's dual-build entry is a `require` behind `process.env.NODE_ENV`, and the runner reads its fixture through a Vite dev server, which sets `NODE_ENV=development` on the runner process and leaves it set — so the bench, spawned afterwards, inherited `development` and built itself with dev React, its profiling instrumentation running inside every frame the bench times.

Three things now hold that shut: the fixture restores `NODE_ENV` around its dev server, the bench and the runner each state `production` explicitly, and `chat-window-bench.mjs` refuses to measure at all if the emitted bundle still contains react-dom's development string literals or development JSX calls. The last one matters most, because this failure mode produces a plausible-looking number rather than a crash.

## Fixture contract

The generator is `apps/desktop/e2e/bench/performance/fixture.mjs`. It creates a user-data directory containing `volli.db`, transcript artifacts, project/worktree directories, and `performance-fixture.json`. It always opens the file through production `openVolliDb(dbPath)` and the production migration runner; it never creates an in-memory schema or copies SQL.

| preset | Sessions | Session Events | Tickets | Ticket Events | Commands | Live worktrees | overlaps | busiest Session | transcript messages | file bytes | `session_events` bytes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `small` | 120 | 26,040 | 40 | 547 | 856 | 8 | 3 | 1,200 | 220 | 37.3 MB | 17.3 MB |
| `real` | 1,198 | 259,855 | 392 | 5,361 | 8,541 | 50 | 17 | 1,668 | 1,600 | 373 MB | 173 MB |
| `2x` | 2,396 | 519,710 | 784 | 10,722 | 17,082 | 100 | 34 | 3,336 | 3,200 | 746 MB | 346 MB |

The default seed is `353259855`. A capped deterministic long-tail allocator preserves exact totals and puts the maximum on `perf-session-0001` (`PERF-1`). The `real` preset has 21 Sessions at or above 1,000 events (p50 149, p95 592, p99 1,164), while retaining exactly one 1,668-event maximum. Event and transcript payloads contain generated prose, fenced code, and tool results only.

### Row counts are not the workload — payload mass is

Session Events are generated from a weighted, unit-aware mix (`event-mix.mjs`) rather than a uniform cycle of tiny rows: mostly runtime observations, a third of them tool-result-sized, wrapped in turn and run lifecycle pairs, with transcript references, spend, interactions, attention and authority in the proportions a long-running Session accumulates them. Families that are inherently paired allocate in units and declare how many events a unit costs, so a history never contains half a turn. That mix is what puts the `real` preset's `session_events` at ~175 MB over 259,855 rows — about 674 physical bytes per event, which is what the captured owner profile measured.

Every generated payload is validated with the production write-side gate `assertSessionEvent` from `@volli/shared` before insert, so a payload this build cannot decode fails at generation instead of at the first benchmark that reads it. `verifyFixture` then decodes **every** `session_events` row through the production codec and reports the count, rather than sampling.

The owner's file was 373 MB with 173 MB in `session_events`. The remaining ~200 MB cannot be attributed row-for-row — it is indexes, months of churn, and deleted history — so the fixture does not invent rows to fake it. It reproduces the Session Event mass exactly and reproduces the remaining physical file mass as free pages, by inserting and deleting real rows without vacuuming, which is what churn actually leaves behind. Verification reports total file bytes, live bytes, free-page bytes and `session_events` bytes separately, so nobody has to guess which part of the file is content.

### Determinism and safety

The database is generated **portable**: project and worktree columns hold a fixed sentinel root, so the same seed produces byte-identical database bytes at any output path. `localizeFixture(profileDirectory)` then rewrites exactly those schema-confirmed columns to the real profile location, and `generateFixture` calls it by default. `fixture.test.mjs` proves this by generating the same seed into two different directories and comparing digests.

`--force` will not delete anything it cannot recognise as a fixture. It refuses the filesystem root, the home directory, the repository root, symlinks, non-directories, any directory containing `package.json` or `.git`, and any non-empty directory without a `performance-fixture.json` marker. The refusal names the path and the reason.

Fixture verification opens the DB through production code, checks schema/counts/distribution/foreign keys/worktree overlap, folds the long Session, decodes every ledger event, reads a content-addressed transcript artifact, and asserts that no `app_state` row is oversized — that last one exists so nobody is ever tempted to reach a byte target with a padding blob, which would be read straight into the renderer bootstrap and would corrupt the very numbers this fixture exists to produce.

## Matrix and timing boundaries

Each full-app repetition uses a fresh APFS clone of the verified fixture and a fixture-only Electron profile. The built renderer assertion rejects a dev-server run.

1. **Cold launch to interactive** — before Electron launch until all fixture board cards and the New ticket control exist and two animation frames settle. FCP, buffered long tasks, and renderer RSS are also recorded.
2. **Long chat** — click the fixture’s busiest Session (1,668 events in `real`) until the first transcript row paints; interactive additionally requires its real transcript scroller to respond across two animation frames.
3. **Streaming while scrolling** — the existing Electron `ChatPlane` bench seeds the preset’s long-transcript message count. One stable assistant message grows under the production `turnActive` lifecycle at 30 tokens/s while the transcript scroll position moves inside the live row on two paint frames per stream step. Staying near the live tail is load-bearing: Streamdown defers offscreen code work with `content-visibility`, so an absolute scroll offset would let the growing fence leave the viewport and make the probe vacuous. The second paint lets Streamdown commit and run its lazy highlighter before the next snapshot can supersede that work. The deterministic stream traverses prose, opens a roughly 4 KB TypeScript fence, grows it across 96 more snapshots, closes it, and continues with prose. The earlier 107-character fence reported zero dropped frames before VC-357 and could not measure that bug. Each raw sample records whether it streamed while a Turn was active, whether it reached both fence phases, live and settled code/highlight counts, and how many `ResizeObserver` callbacks ran. The concurrent frame and long-task window ends before the final settle-time Shiki pass; that pass has its own latency and long-task fields. The stream renderer is isolated from SQLite intentionally: this interaction prices the production rendering path after the fixture-backed app measurement prices migration, replay, IPC, and artifact hydration. RSS is sampled directly after every stream.
4. **New chat** — `+ Chat` until the newly visible composer is enabled and accepts focus.
5. **New terminal** — terminal menu action until a visible real terminal canvas answers `stty size` through its PTY.
6. **Sidebar** — close and open separately, retaining rAF frame deltas through each complete transition.
7. **Ticket workspace switch** — both workspaces are opened to a usable state first and the first is returned to, so the timed step is a switch between two existing Ticket workspaces rather than a first open. It runs until the target tab is selected, its heading and description editor are visible, and that content accepts focus.
8. **Board render** — navigate back to Board until every fixture ticket slot is present.
9. **RPC round trip** — one native preload/session-RPC `session.projection` call timed wholly in the renderer.

Latency summaries report nearest-rank p50 and p95 plus population variance. Renderer memory is Electron’s renderer working-set reading from `app.getAppMetrics()`. Long-task counts are summarized per sample so runs with different repetition counts are not compared by a misleading raw sum.

### Frames and streaming

Frame intervals come from `requestAnimationFrame`. Every sample derives its refresh interval from the 25th percentile of ordinary positive sub-50 ms deltas, rather than assuming a 60 Hz display. A gap contributes `round(gap / refreshInterval) - 1` dropped frames. Chromium `PerformanceObserver` supplies long tasks.

The stream rate is wall-clock based. If a frame stalls, the next snapshot coalesces the tokens that would have arrived during that stall; it does not unrealistically slow the producer to match the renderer. Override the documented default only when the report records the same `--stream-token-rate` in every compared arm.

## Reproducible background load

The loaded arm is named `N-busy-core-for-Ns` — worker count **and** a fixed exposure, because a load that simply runs until the arm finishes gives a slower build more load and more thermal pressure than a faster one, which is precisely backwards for a regression gate. N Node worker threads run the fixed integer-mixing loop in `apps/desktop/e2e/bench/performance/busy-worker.mjs`, warm up, then share one monotonic deadline; the arm fails if measurement outlives that deadline, and short smoke runs that stop early say so in JSON. The JSON records N, the configured and actual duration, worker iterations, and checksums. It is a scheduler/thermal pressure primitive, not a simulation of any particular compiler.

The defaults are two workers and a 3,600-second exposure (`--busy-cores`, `--load-duration-seconds`). The exposure is a ceiling rather than a target: the arm fails if measurement is still running when the deadline lands, and a run that finishes early holds the load until the deadline so both arms see the same exposure. Twenty repetitions against the `real` fixture take roughly twenty minutes idle on the machine this was written on and longer under load, so an hour leaves room; if a slower machine outlives it, the run says so and names this flag. Choose values explicitly and keep them fixed for all runs being compared:

```sh
pnpm bench:desktop -- --preset real --busy-cores 4 --output performance-results/real-4-busy-core
```

Do not run unrelated builds, tests, screen recording, or energy-mode changes during either arm. Keep the machine on power and let it reach a stable thermal state first.

## Regression-sensitivity proof

A harness is only worth its baseline if it moves when the product gets slower. That is proven by injecting a deliberate regression, measuring the movement, and then **removing** the injection: leaving a slow path behind — even an opt-in one — leaves a foot-gun in the bench and a flag that a future baseline could accidentally carry. The bench carries no such flag today.

It is measured as a **curve rather than a single point**, because where the threshold sits is the useful fact: [the sensitivity record](performance-baselines/vc-353-owner-real/sensitivity.md) holds the injection, the command and the numbers. In short, on the baseline machine the stream+scroll probe calls a per-step main-thread regression of ≥40 ms unmistakably (1.5× wall time, 120+ dropped frames against a control that drops none), detects 20 ms through the dropped-frame counter alone, and does not see ≤10 ms — which is correct, since that still fits the frame budget the user actually experiences.

Two traps that record explains and every future reader should know:

- The stream interaction's **wall time is floored by the scripted token schedule** (120 steps at 30 tokens/s take ~4.0s regardless), so latency alone would have called a real 20 ms regression clean. Read dropped frames and frame times beside it.
- A **development-React bench has less frame budget to spare**, so sensitivity measured on one does not transfer to the shipped build. The old +40%-at-20 ms claim came from exactly that mistake and is withdrawn.

## Research references

The harness decisions are supported by these scoped research records:

- [Electron app measurement precedent](research/perf/electron-app-prior-art.md)
- [Ephemeral Sessions and background load](research/perf/ephemeral-sessions-and-load.md)
- [IPC, Session RPC, and SQLite](research/perf/ipc-rpc-sqlite.md)
- [React, Zustand, and streaming transcripts](research/perf/react-zustand-streaming.md)

## Baseline use

The owner-machine `real` baseline is [`docs/performance-baselines/vc-353-owner-real/benchmark.md`](performance-baselines/vc-353-owner-real/benchmark.md), taken at commit `e3c936ed` on a clean tree: both arms, 20 repetitions plus a discarded warm-up, zero renderer errors, every health check true. The 2026-09-13 baseline it replaces was withdrawn rather than corrected — development React, a published run whose renderer had thrown, arms with different cache warmth, and a 145 MB fixture standing in for 373 MB.

One caveat travels with it and is recorded in the file: the host was **not exclusively idle** (mean load 7.66 and 306% of 800% CPU during the idle arm, from the owner's own running app). Absolute numbers are therefore pessimistic and the idle → loaded gap is understated. Re-taking it on a quiet machine is worth about 75 minutes whenever one is free.

Before using any baseline as a comparison point, check its SHA, dirty flag, device/macOS fields, preset/seed, load name, worker count, and load duration — the report records all of them for exactly this purpose. A later ticket should publish its own before/after pair on one machine rather than compare its machine to an owner baseline.

The program tickets that consume this instrument are `VC-316` (board and sidebar profiling at ticket scale) and `VC-319` (the packed-app release matrix); both reuse `pnpm bench:desktop` and these presets rather than build a second fixture stack. The Session RPC round-trip primitive is published separately in `apps/desktop/e2e/bench/performance/session-rpc-round-trip.mjs` so the RPC ticket can import it instead of re-deriving it.
