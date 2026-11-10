# Guarded chat-window benchmark

A synthetic page mounting the real product `ChatPlane`, with deterministic
transcripts, a refusing bridge and trusted Chromium input. **Not a real-app UX
proof.** The real app hosts the measurement through `volli-drive`; the removed
`electron-main.cjs` direct launcher has no replacement/fallback outside the driver.
Never run the historical direct entry to compare old numbers.

On shared machines, obtain a coordinated slot before installs, production builds
or any live run. Use the pinned runtime and `VOLLI_CONCURRENCY_HINT`. No packaged
app, legacy entry, real profile, real model or provider credentials are supported.

## Single source

After an approved dependency install:

```sh
vp env exec --node 24.22.1 -- node apps/desktop/e2e/chat-window-bench.mjs \
  --arm draft --sessions 2 --turns 2000 --draft-ballast 8000 \
  --output .scratch/chat-draft
```

This builds the app and production bench, then invokes the supported driver:
`launch --model fake --fixture empty --no-build --json` → `doctor` →
`chat-window-bench` → `doctor` → `stop`. Each run has a fresh scratch profile;
normal cleanup must be graceful, with no forced leftovers or keychain violations.
The existing global driver registry/cap and both static/live launch gates remain
unchanged. A supervisor-owned 300s measurement watchdog uses the driver's same
bounded stop and exact-process ownership cleanup. The native measurement window
is nonfocusable, below normal windows, ignores mouse input and uses focus
emulation, never OS keyboard/pointer input. GC uses CDP's awaited collection,
not an extra process-wide Chromium switch.

`--skip-build` requires an unchanged source/overlay/artifact proof from a previous
build through this entry. It cannot bless arbitrary existing bundles.

## Two exact source revisions

Prepare **without dependencies, builds or a live app**:

```sh
vp env exec --node 24.22.1 -- node apps/desktop/e2e/chat-window-bench.mjs \
  --compare v0.3.0-canary.6 v0.3.0-canary.7 --prepare-only \
  --output .scratch/chat-canaries
```

The output lists two snapshot directories under this checkout. Each is a `git
archive` of the resolved product commit (not a packaged release), overlaid only
with the controller, bench, driver and its e2e support files. No `src/`, workspace
package or lockfile is overlaid. Product source hashes, exact commit SHAs and the
separate overlay file/hash list are recorded in `sources.json`. Both sides get
identical overlay bytes, fixture recipe, ballast, key cadence, throttle, sample
count and trace mode. The snapshots have no `.git`; the driver records the
snapshot's source SHA rather than accidentally reading the parent checkout's
HEAD. Changes to either source or overlay fail verification; choose a new output
directory after changing the harness. Snapshots/evidence are intentionally kept.

**Only in an approved slot**, install each listed snapshot's own frozen lockfile
(`vp env exec --node 24.22.1 -- pnpm install --frozen-lockfile`, from that directory)
and prepare its native dependencies per the repository instructions. Install the
controller checkout's dependencies too if not already present. Then:

```sh
vp env exec --node 24.22.1 -- node apps/desktop/e2e/chat-window-bench.mjs \
  --compare v0.3.0-canary.6 v0.3.0-canary.7 \
  --arm draft --sessions 2 --turns 2000 --draft-ballast 8000 --phases \
  --output .scratch/chat-canaries
```

All builds finish **before** either measurement starts. The sides then run one
after the other, cleanup completing before the next launch. Each side records its
own launch, doctor-before/after, stop, source/overlay identities, bench asset and
host bundle hashes, native quiet-window check and embedded runtime versions.
Unmatched Electron/Chromium/Node versions reject the comparison. Historical
sources that cannot build with this harness or cannot pass today's driver guards
are unsupported: fix the measurement overlay or report the incompatibility;
never patch product sources or bypass a gate to make them launch.

Use the same display refresh rate, power/thermal state and background load;
repeat with alternating revision order. Serial execution and matching settings
do not by themselves prove equivalent machine load or a speedup. Separate
trace-on attribution runs from trace-off latency runs, using the same trace mode
on both sides.

## Arms and results

Existing controls and output remain: `--arm transcript` (default), `draft`,
`reveal`; their `--sessions`, `--turns`, `--label`, `--draft-*`, `--reveal-*` and
`--stream-*` knobs, `__BENCH__<json>__BENCH__`, DOM/RSS table, input-handler and
key/click-to-paint distributions, and streaming raw samples. `--arm stream`
is the existing stream+scroll probe without the other transcript steps.

`--phases` (or `--draft-trace`, `--reveal-trace`, `--stream-trace <file>`) captures
raw Chromium lanes and adds machine-readable `report.phases`: exclusive **script,
style/layout, paint, main-thread composite preparation** milliseconds, clipped to
the measured renderer's marked input/frame windows. Nested events cannot double
count. Streaming setup, calibration and settlement are excluded. Main-thread
composite preparation is **not GPU work or presentation duration**; raw cc/gpu/viz
lanes are kept for inspection. Stream `latencyMs` is the sample duration, **not**
a keystroke-to-paint metric. Draft `draftTyping.latencyMs` retains key-to-paint
samples. A run missing trusted characters/paint samples or live streaming code
fails rather than publishing a healthy-looking result.

`<output>/comparison.json` carries settings, machine context and the full reports;
`<output>/<source-sha>.json` retains each successful side. Trace files and the
full synthetic report also survive in each driver's normal evidence directory.
Explicit trace output paths gain a source-SHA suffix in comparison mode.

The output schema and workload remain comparable to earlier PR tables, but the
measurement transport now includes supervisor IPC and a guarded host. Do not mix
historical direct-launch latency numbers with guarded runs as a causal A/B;
re-run both source revisions through this same harness.

## Source-only checks

No install or app required:

```sh
vp env exec --node 24.22.1 -- node --test \
  --test-concurrency="$VOLLI_CONCURRENCY_HINT" \
  apps/desktop/e2e/bench/chat-window/integration.test.mjs
```

The tests exercise the real NDJSON codec, lifecycle order/cleanup, source archive
identity and overlay verification, all measurement arms, parameter/guard
refusals, and exclusive trace attribution. CI runs them in the driver rules lane.
