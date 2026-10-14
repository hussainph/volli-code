# Desktop performance benchmark

The repeatable desktop matrix measures production behavior with a generated,
real-scale database. It does not enable product optimizations.

> Compare runs only on the same machine, in the same power/thermal state, with
> the same preset, seed, build, repetition count and load arm.

## Run the matrix

From a clean macOS checkout:

```sh
pnpm install
pnpm bench:desktop -- --preset real --output performance-results/my-real-run
```

This builds the production Electron app and real-`ChatPlane` renderer bench,
creates/verifies a deterministic migrated fixture, and measures idle/loaded arms.
For a quick harness check:

```sh
pnpm bench:desktop -- --preset small --repetitions 2 --arms idle --stream-steps 30 --output performance-results/harness-check
```

Use `--help` for controls. With `--fixture`, pass its generation preset too.
`--skip-build` is for repeated probes after the relevant bundles are built.
A full run uses 20 repetitions, giving a meaningful nearest-rank p95, and
throws away one complete warm-up iteration in **each** arm. The arms run
sequentially; comparing a cold first arm with a warm second is invalid.

Any renderer console error, failed health check or not-ok streaming sample
fails the run instead of publishing an aggregate. Renderer timing uses a
production build. Fixture generation restores `NODE_ENV` around its Vite server;
the runner/bench select production explicitly, and `chat-window-bench.mjs`
refuses emitted development React/JSX. A plausible timing number is not proof
that the shipped build was measured.

## Outputs

- `benchmark.json`: raw samples, frame deltas and full host/fixture metadata.
- `benchmark.summary.json`: compact aggregates plus device/macOS, Git SHA/dirty
  state, preset/seed/verification, load, worker count/duration and repetitions.
- `benchmark.md`: tables, complete run context and interpretation method.

`performance-results/` is ignored. Keep generated JSON alongside its run and
attach relevant artifacts to the issue or PR; do not commit investigation
reports or machine-specific benchmark runs to the public repository. A shared
comparison must retain its full context, not only headline numbers.

## Fixture contract

`apps/desktop/e2e/bench/performance/fixture.mjs` generates `volli.db`, transcript
artifacts, project/worktree directories and `performance-fixture.json` through
production `openVolliDb` and migrations, never copied SQL or an in-memory schema.

| preset | Sessions | Session Events | Tickets | Ticket Events | Commands | Live worktrees | overlaps | busiest Session | transcript messages | file bytes | `session_events` bytes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `small` | 120 | 26,040 | 40 | 547 | 856 | 8 | 3 | 1,200 | 220 | 37.3 MB | 17.3 MB |
| `real` | 1,198 | 259,855 | 392 | 5,361 | 8,541 | 50 | 17 | 1,668 | 1,600 | 373 MB | 173 MB |
| `2x` | 2,396 | 519,710 | 784 | 10,722 | 17,082 | 100 | 34 | 3,336 | 3,200 | 746 MB | 346 MB |
| `tickets-300` | 120 | 26,040 | 300 | 600 | 856 | 8 | 3 | 1,200 | 220 | 37.3 MB | 17.3 MB |
| `tickets-3k` | 120 | 26,040 | 3,000 | 6,000 | 856 | 8 | 3 | 1,200 | 220 | 37.3 MB | 17.3 MB |
| `tickets-10k` | 120 | 26,040 | 10,000 | 20,000 | 856 | 8 | 3 | 1,200 | 220 | 37.3 MB | 17.3 MB |

The `tickets-*` presets vary only ticket scale, holding Session mass at `small`;
they measure the board's per-card slope, not whole-app scale. The default seed
is `353259855`. A deterministic capped long-tail allocator preserves exact
totals and places the maximum on `perf-session-0001` (`PERF-1`). The `real`
preset has 21 Sessions at/above 1,000 events (p50 149, p95 592, p99 1,164).
Payloads contain generated prose, code and tool results, never user history.

### Payload mass and verification

`event-mix.mjs` uses weighted, unit-aware event families: runtime observations,
tool-result-sized payloads, paired turn/run lifecycles, transcript references,
usage, interactions and Attention. Paired families never create half a turn.
Physical file mass includes free pages from inserted/deleted rows without vacuum,
not invented content rows or `app_state` padding blobs. Verification reports
file/live/free-page/Session-event bytes separately.

Every payload passes production `assertSessionEvent` before insertion and every
ledger row passes the production codec during verification. Verification also
checks schema, exact counts/distribution, foreign keys, overlaps, long-Session
folding, a content-addressed artifact and bounded `app_state` values.

Generation uses a fixed sentinel root for portable byte-identical database
bytes. `localizeFixture` rewrites only schema-confirmed project/worktree columns
to the actual profile. `fixture.test.mjs` compares same-seed digests from distinct
output paths.

`--force` deletes only recognized fixtures. It refuses root, home, repository,
symlinks, non-directories, directories containing `package.json`/`.git`, and
nonempty directories without the fixture marker. It names the refusal reason.

## Timing boundaries

Each full-app repetition uses a fresh APFS clone and fixture-only Electron
profile. The built-renderer assertion rejects dev-server runs.

1. **Cold launch:** before Electron start until all board cards and New ticket
   exist and two animation frames settle. Also capture FCP, long tasks and RSS.
2. **Long chat:** select the busiest Session until a transcript row paints;
   interactive requires its real scroller to respond over two frames.
3. **Stream plus scroll:** one stable assistant message grows under production
   `turnActive` at 30 tokens/s while scrolling inside its live row. Two paints
   per step allow lazy highlighter work. Keep the growing fence visible:
   offscreen `content-visibility` can otherwise make the probe vacuous. The
   default 120 steps opens a roughly 4 KB TypeScript fence, grows it over 96
   snapshots, closes it and continues prose. Short runs may end while it is
   open. Samples record turn activity, fence phases, highlight counts and
   `ResizeObserver` callbacks. Frame/long-task capture ends before the final
   settle-time Shiki pass, which has separate fields. This renderer probe is
   deliberately SQLite-independent; fixture-backed measurements cover migration,
   replay, IPC and hydration separately. Sample RSS after streaming.
4. **New chat:** `+ Chat` until the visible composer enables and accepts focus.
5. **New terminal:** until real terminal canvas answers `stty size` via its PTY.
6. **Sidebar:** close/open separately, retaining rAF deltas through transitions.
   Inspect active/previous row counts first: a frozen fixture timestamp can
   empty an age-bounded Previous band, measuring chrome rather than listing.
7. **Ticket switch:** pre-open both workspaces, then time switching existing tabs
   until heading/editor are visible and accept focus, not a first open.
8. **Board render:** until published held-ticket count equals the fixture and
   every nonempty column paints a card. Count held tickets versus mounted cards;
   a windowed DOM is not the entire board.
9. **Column scroll:** drive the fullest column end-to-end in 60 frame-spaced
   steps. Compare frame times, not just gesture duration; fail if none scrolls.
10. **Board filter:** apply Priority to an already-drawn board until held count
    decreases. Restore unfiltered state afterwards. This measures derivation
    over held tickets, not only mounted cards.
11. **RPC:** one native preload/session-RPC projection round trip in renderer.

Report nearest-rank p50/p95 and population variance. Renderer memory uses
`app.getAppMetrics()` working set. Long-task counts are per-sample, not a raw
sum across unequal repetition counts. The reusable RPC primitive is
`apps/desktop/e2e/bench/performance/session-rpc-round-trip.mjs`.

### Frames and sensitivity

rAF samples derive the refresh interval from the 25th percentile of positive
sub-50 ms deltas, not a fixed 60 Hz assumption. A gap contributes
`round(gap / refreshInterval) - 1` dropped frames. Chromium's
`PerformanceObserver` supplies long tasks.

Streaming is wall-clock based: after a stall the next snapshot coalesces tokens
already due; it does not slow the producer to match rendering. Keep overridden
`--stream-token-rate` identical in compared arms. Scheduled token duration floors
wall time, so a real frame regression can leave latency unchanged. Inspect
frame times and dropped frames together. Sensitivity measured with development
React does not transfer to production. Any temporary regression injection used
to check sensitivity must be removed, not retained as an accidental baseline flag.

## Reproducible load and comparison

The loaded arm is `N-busy-core-for-Ns`: fixed worker count **and** exposure,
not load that grows with measured build duration. Workers run the integer-mixing
loop in `busy-worker.mjs`, warm up and share a monotonic deadline. Overrunning it
fails; finishing early holds load to the deadline. JSON records configured/actual
duration, iterations and checksums. This is scheduler/thermal pressure, not a
simulation of a compiler.

Defaults are two workers and 3,600 seconds; choose explicit fixed values for
compared runs, within the available machine budget:

```sh
pnpm bench:desktop -- --preset real --busy-cores 4 --output performance-results/real-4-busy-core
```

Keep power/thermal state stable. No unrelated builds, tests, recordings or
energy-mode changes during either arm. Before comparing, check SHA/dirty state,
device/macOS, preset/seed, event distribution, warm-up, worker count and duration.
A fixture or instrumentation change invalidates an unmatched historical baseline.
Use a before/after pair on the same machine rather than absolute numbers from a
different environment.
