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

Every stream sample runs with a working, active Turn, so the activity island is
live and each sample reports `island.drawnSteps`, `shimmerSteps` and the captions
it drew. `--island on|hidden|shimmer-off|filters-off` (default `on`) is the
island's A/B: page CSS only, never product code. `hidden` takes the island out
of paint, `shimmer-off` stops the verb's shimmer and `filters-off` drops the
material's drop shadows. Compare arms with `--skip-build` on one build and the
same trace mode, and repeat each: run-to-run spread on a loaded machine is
larger than most single-arm differences.

`--materials on|backdrop-off|masks-off|off` (default `on`) is the Volli Glass
A/B (VC-1145), page CSS applied before any plane mounts, never product code:
`backdrop-off` drops every backdrop blur, `masks-off` the transcript's two fade
masks, `off` both and the glass rims. It applies to every arm.

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

## Headless phases, no Electron

`headless.mjs` drives the same page in chrome-headless-shell with GPU
compositing (`--use-angle=metal`), a fresh page per run, no app and no
credentials. Two workloads on a 2,000-turn Session: `type` (150 keys at 60 ms
into its composer beside an 8,000-node ballast: key-to-paint and Chromium's
key-to-present) and `stream` (a prose reply following at 30 words/s for 8 s:
frame times, long tasks). `--trace` adds exclusive main-thread script, style,
layout, prePaint, paint and composite milliseconds, viz draw time and render
passes per frame.

```sh
node apps/desktop/e2e/bench/chat-window/headless.mjs build .scratch/hl/head
node apps/desktop/e2e/bench/chat-window/headless.mjs stream .scratch/hl/head --runs 3 --trace
node apps/desktop/e2e/bench/chat-window/headless.mjs type .scratch/hl/head \
  --runs 3 --materials on,off --trace --json .scratch/hl/type.json
```

To compare revisions, check each out under `.scratch/`, copy this folder's
`main.tsx`, `bench.css`, `index.html`, `vite.config.ts` and `headless.mjs` over
its own, run `headless.mjs build` there, then pass every build directory
comma-separated: builds and materials arms alternate within each round.
Headless is not the app (no shell, canvas or real window): confirm a decisive
result through the guarded entry above.

The number to watch for streaming is `stream` script milliseconds per 8 s at
2,000 turns: about 0.6 s on 0.3.0-canary.7, 7.7 s on main before VC-1145, and
1.4 s after it.

## Invented diagram cadence probe

The `stream`/`transcript` arms accept `--stream-content diagram`. The fixture is
an invented 18-group topology, not a private transcript or prototype. Each sample
must stream through a working, active Turn, open and close its fence, scroll,
and show a changing, viewport-intersecting SVG with all 18 output labels both
live and settled. Icons, empty/hidden/static SVGs and missing samples fail closed.
The default code-fence contract and all draft/reveal arms remain intact.

In a coordinated slot, run the same guarded production pipeline for each cadence:

```sh
vp env exec --node 24.22.1 -- node apps/desktop/e2e/chat-window-bench.mjs \
  --arm stream --sessions 1 --turns 1600 --stream-content diagram \
  --stream-samples 3 --stream-steps 240 --diagram-sample-ms 100 \
  --label sampled --output .scratch/chat-diagram-100
```

Repeat with `--diagram-sample-ms 0 --label every-update` and a fresh output
`.scratch/chat-diagram-0`. Run serially, one guarded instance at a time. Use enough
steps to finish the graph at the display's refresh rate; an incomplete graph is a
failed probe, not a usable faster result. Repeat in alternating cadence order
before drawing causal conclusions; 2–3 samples are exploratory/noisy evidence.

`--diagram-sample-ms` accepts only `0` or `100`, with diagram content. A bench-only
Vite transform replaces the adapter's exact local `const SAMPLE_MS = 100;` in
memory, never product source. The normal app build retains its 100ms cadence.
The transform must reach the real adapter or the build fails. The emitted cadence
artifact is checked against the settings by the controller and guarded driver,
recorded in the report/source metadata, and included alongside asset and host
hashes in the skip-build proof. `--skip-build` can reuse only that exact cadence's
unchanged proof; switching cadence requires a fresh build. Omitting the override
measures unmodified production source and records a null instrumentation value.
A historical revision without this adapter cannot support a cadence override.

Earlier direct-renderer/direct-launch diagram measurements are **historical and
noncomparable** to this guarded path or changed main layout/theme. They are not
current release evidence; rerun both cadences through this entry.

## Source-only checks

No install or app required:

```sh
vp env exec --node 24.22.1 -- node --test \
  --test-concurrency="$VOLLI_CONCURRENCY_HINT" \
  apps/desktop/e2e/bench/chat-window/integration.test.mjs \
  apps/desktop/e2e/chat-window-bench.test.mjs
```

The tests exercise the real NDJSON codec, lifecycle order/cleanup, source archive
identity and overlay verification, all measurement arms, parameter/guard
refusals, and exclusive trace attribution. CI runs them in the driver rules lane.
