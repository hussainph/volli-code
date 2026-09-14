# VC-353 regression-sensitivity proof — WITHDRAWN, not yet re-taken

> The earlier proof and its two run summaries have been withdrawn for the same
> reason as [the baseline](benchmark.md): they were measured through a harness
> that was building the renderer bench with development React, so both the
> control and the deliberately slowed run priced a renderer the app never ships.
> The movement they reported was real, but the numbers are not.

The injection itself is also gone, deliberately. The harness used to carry an
opt-in `--slowdown-ms` busy wait; the ticket's acceptance says to remove it once
it has done its job, because a shipped slow path is a foot-gun and a flag a
future baseline could accidentally carry.

## How to repeat the proof

Take a control and a deliberately slowed run back to back, on the same machine,
against the same build, with the injection applied as a temporary local edit:

```sh
pnpm bench:desktop -- --preset real --stream-only --arms idle --repetitions 20 \
  --output /tmp/vc353-control
# apply the injection below, then rebuild happens automatically:
pnpm bench:desktop -- --preset real --stream-only --arms idle --repetitions 20 \
  --output /tmp/vc353-deliberate-slowdown
git checkout -- apps/desktop/e2e/bench/chat-window/main.tsx
```

The injection, applied inside the per-step loop of `streamAndScroll` in
`apps/desktop/e2e/bench/chat-window/main.tsx`:

```ts
// TEMPORARY — regression-sensitivity proof only. Revert before measuring.
const until = performance.now() + 20;
while (performance.now() < until) {
  /* burn one frame's worth of main-thread time */
}
```

The expected signal is higher stream wall-time p50/p95, higher frame-time p95,
and more dropped frames in the second report. Record both runs' `benchmark.md`
under `sensitivity/`, state the injection used, and confirm the working tree is
clean again afterwards.
