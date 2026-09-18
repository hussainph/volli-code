# VC-353 regression-sensitivity: what this harness can and cannot see

> Performance numbers are comparable only on the same machine, in the same power/thermal state, with the same load arm.

A harness is only worth its baseline if it moves when the product gets slower.
This records how much slower the product has to get before the stream+scroll
probe says so, measured on the machine that took
[the baseline](benchmark.md) at commit `e3c936ed`.

The previous version of this file claimed a single data point — a 20 ms
per-frame injection moving interaction latency +40.3% — and that claim is
withdrawn. It was measured through the old harness, which built the renderer
bench with **development React**; a debug renderer has far less frame budget to
spare, so a regression that overruns it there can still fit inside it in the
build the product ships. Sensitivity has to be re-measured against the shipped
build, and it is below.

## Method

A temporary local edit burns a fixed slice of main-thread time inside each step
of `streamAndScroll` in `apps/desktop/e2e/bench/chat-window/main.tsx`, before
the step's two paint frames:

```ts
// TEMPORARY — regression-sensitivity proof only. Revert before measuring.
const until = performance.now() + N;
while (performance.now() < until) {
  /* burn one frame's worth of main-thread time */
}
```

Each level ran the bench directly, two samples each, at the same settings the
matrix uses for its stream interaction:

```sh
node apps/desktop/e2e/chat-window-bench.mjs --sessions 1 --turns 1600 \
  --stream-samples 2 --stream-steps 120 --stream-token-rate 30 --label burn-N
git checkout -- apps/desktop/e2e/bench/chat-window/main.tsx
```

The injection is not committed, and no flag carries it: a shipped slow path is
a foot-gun and a switch a future baseline could accidentally leave on.

## Result — the detection curve

| Injected per step | stream wall time (2 samples) | vs control | dropped frames | long tasks |
|---:|---|---:|---:|---:|
| 0 ms (control) | 3996.8 / 4000.2 ms | — | 0 / 0 | 0 / 0 |
| 5 ms | 3996.4 / 4000.0 ms | ~1.00× | 0 / 0 | 0 / 0 |
| 10 ms | 4000.7 / 3999.9 ms | ~1.00× | 0 / 0 | 0 / 0 |
| 20 ms | 4050.1 / 4080.9 ms | 1.02× | 3 / 5 | 0 / 0 |
| 40 ms | 6115.5 / 6033.7 ms | 1.51× | 126 / 121 | 7 / 0 |
| 80 ms | 11932.7 / 11915.2 ms | 2.98× | 473 / 472 | 120 / 120 |

Read it as a threshold, not a single number:

- **≥ 40 ms per step is unmistakable** — half again the wall time, and over a
  hundred dropped frames where the control drops none.
- **20 ms is the detection floor.** Wall time barely moves (+2%), but dropped
  frames go 0 → 3-5, and zero is what every healthy sample reports, so the
  signal is in the frame counter rather than the clock.
- **≤ 10 ms is invisible, and correctly so.** At 30 tokens/s each step owns a
  two-frame budget of about 33 ms and uses roughly 13 ms of it. Work that still
  fits the budget does not miss a frame, and a frame-based probe should not
  invent a regression where the user would see none. It does mean this probe is
  not the instrument for shaving single milliseconds — use it for regressions
  that threaten the frame, and measure smaller deltas with a narrower tool.

A trap worth recording: the stream interaction's **wall time is floored by the
scripted token schedule**. 120 steps at 30 tokens/s take about 4.0s no matter
what, so a regression smaller than the per-step slack cannot show up in latency
at all. That is why this probe reports dropped frames and frame times beside
latency, and why the 20 ms row moves the frame counter while the clock stays
flat. Reading latency alone would have called a real 20 ms regression clean.

## The other sensitivity evidence: the load arm

The published baseline carries its own controlled perturbation. Two busy cores,
against the same build and fixture on the same machine, moved:

| Interaction | p50 | p95 |
|---|---:|---:|
| Long-chat first paint and interactive | 1.72× | 2.46× |
| Board render | 1.06× | 1.54× |
| Switch between ticket workspaces | 1.21× | 1.25× |
| New terminal session | 1.09× | 1.27× |

That is a different claim from the injection above — it perturbs the machine,
not the product's code — but it does show the full-app interactions respond to
contention with movement far outside their sample variance.
