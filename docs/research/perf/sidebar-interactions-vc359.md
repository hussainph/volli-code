# VC-359 — sidebar interaction jank under concurrent load

Measured 2026-09-13 on a MacBookPro17,1 (Apple M1, 8 cores, 16 GiB), macOS
26.5.1 (25F80). The fixed point for the before arm was
`09acc82e67c810d48e791d80b1605e86daa224d9`.

## Method

`apps/desktop/e2e/sidebar-transition-bench.mjs` launches the built application
against an isolated profile, starts a real terminal Session, creates four
visible restty split panes, and drives the ordinary Cmd+B close/open path. A
`ResizeObserver` watches each terminal host while a requestAnimationFrame probe
records frame intervals. The preload API is read-only, so the probe could not
wrap `window.api.terminal.resize`; terminal-host observer callbacks/entries are
the resize-cascade metric.

The loaded arm used VC-353's fixed integer-mixing worker unchanged: two
continuously busy Node worker threads, started before Electron and stopped after
the report. The before and after runs used the same worker count and 500 ms
sample window. `--load` is report metadata only; the load generator is started
outside this ticket's bench so VC-353 remains its owner.

This fixture exercises the real shell and four expensive terminal canvases, but
not VC-353's still-in-progress 1,200-Session/260k-event database. The results are
comparable within this machine and arm; they are not a replacement for that
matrix.

## Sidebar results

| arm | revision | action | resize callbacks | resize entries | FPS | p95 frame | max frame | frames >33 ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| idle | before | close | 10 | 40 | 60.0 | 17.3 ms | 17.6 ms | 0 |
| idle | before | open | 8 | 32 | 60.0 | 17.7 ms | 17.7 ms | 0 |
| idle | after | close | 1 | 4 | 60.0 | 17.6 ms | 17.7 ms | 0 |
| idle | after | open | 1 | 4 | 60.0 | 17.6 ms | 17.7 ms | 0 |
| 2-busy-core | before | close | 3 | 12 | 58.7 | 18.1 ms | 18.1 ms | 0 |
| 2-busy-core | before | open | 2 | 8 | 15.6 | 299.9 ms | 299.9 ms | 3 |
| 2-busy-core | after | close | 1 | 4 | 60.0 | 17.4 ms | 17.6 ms | 0 |
| 2-busy-core | after | open | 1 | 4 | 60.0 | 17.5 ms | 17.7 ms | 0 |

The low loaded-arm callback count before the change is not evidence that layout
was cheap: the renderer delivered only four close intervals and seven open
intervals, with the open path stalling for 299.9 ms. A separate baseline under
the live eight-Session workload delivered the full cascade (10/40 close, 9/36
open) and one 166.7 ms open frame. In both reproductions, every delivered width
step resized all four terminal hosts.

The implementation removes the spacer's `width` transition. The content keeps
one endpoint's layout while a WAAPI standalone `translate` runs on the
compositor, then commits the final spacer/card geometry once where the two
presentations coincide.

A visible Browser Tab is the deliberate exception. Its native
`WebContentsView` cannot inherit a DOM transform, and the existing captured-frame
path does not hide that plane until an asynchronous capture settles. Starting
the transform at the same time would visibly detach page pixels from Browser
chrome for up to that handoff. When a visible `[data-browser-plane]` exists,
pin/unpin therefore takes the shell's existing one-frame
`data-motion="instant"` path: one endpoint layout and one final Browser bounds
report, with no intermediate native resizes. VC-363 owns Browser-plane batching;
a future animated version requires an explicit two-phase arm/capture/ready
protocol rather than hiding that asynchronous dependency in this shell.

The bench also reverses both directions after 45 ms and verifies the final
layout has no active marker or retained transform. It verifies reduced-motion
endpoint swaps both when the preference is already set and when it changes
mid-journey. Finally it enters/exits terminal focus through Alt+Cmd+Enter,
observes `data-motion="instant"`, and proves all original terminal host objects
stay connected and are never present in a removal mutation; comparing Session
IDs alone would miss a destroy/recreate regression. All behavior checks passed.

## Broadcast result

Before this change every `broadcastDataChanged()` call immediately sent one
`volli:data-changed` event to every live window. The renderer maps each event to
one full `refreshPlanningData()` bootstrap/hydration. After this change, calls
within an 8 ms half-frame window produce one event per live window.

The focused test drives 15 same-scope mutations and measures **15 potential
hydrates -> 1**. Additional cases prove conservative scope widening, retention
of the special `kind: "worktree"` venue invalidation, untargeted invalidations,
destroyed-window filtering, and a fresh timer after each flush. Under the same
2-busy-core arm, all 23 broadcast and watcher tests passed; the broadcast file's
five tests completed in 17 ms. The test is a deterministic fan-out count, not a
260k-event SQLite timing; VC-355 owns the cost of each saved bootstrap and VC-362
owns a smaller planning-only projection.

## Hypothesis verdicts

1. **The transition resizes expensive siblings every frame — confirmed.** Idle
   baseline close/open produced 10/8 callbacks and 40/32 entries across four
   mounted terminals. The changed path produces one callback and four entries
   per endpoint. Replacing restty with xterm.js (VC-107) may lower each fit's
   cost, but would not remove a parent-width cascade; this shell fix remains
   applicable.

2. **Animating a layout property is the leading cause — confirmed.** The only
   per-frame changing sibling geometry was the spacer's CSS `width` transition.
   Under two busy cores the old open path reached a 299.9 ms frame; compositor
   motion plus one settled layout held at 17.7 ms maximum in this run. The
   Notion-style shape is reachable here only for the presentation: final pinned
   and unpinned layouts genuinely have different content widths, so one endpoint
   resize remains necessary.

3. **CPU contention can starve interaction delivery — confirmed.** The identical
   old open interaction changed from a 17.7 ms idle maximum to a 299.9 ms loaded
   maximum. VC-355 separately measured zero Session RPC calls for sidebar open,
   so the transition itself does not synchronously request Session projections;
   the main-thread/SQLite blocking paths remain VC-355's scope. The changed path
   held 60 FPS in the two-worker arm, but this does not disprove jank from a
   separate long synchronous main-process task.

4. **There is no idle deferral — source-confirmed, not the sidebar cause.** There
   are zero non-test `requestIdleCallback` call sites under `apps/` or
   `packages/`. Deferring the correctness-critical planning recovery or the one
   endpoint resize would only prolong stale/incorrect geometry, so this ticket
   does not add idle scheduling. Listing/provenance/title work should be
   measured at its owning call site before being deferred.

5. **Data-change broadcasts are uncoalesced — confirmed and fixed.** There are
   23 textual `broadcastDataChanged(` occurrences in main source (including the
   definition) and each receipt triggers a full planning bootstrap. The 8 ms
   coalescer reduces a 15-event burst to one hydrate per window while preserving
   scope safety and worktree cache invalidation.

6. **Fifty registered worktrees imply a watcher-driven rehydrate storm — mostly
   disproved.** Registration count is not live watcher count. Change Set watches
   are refcounted by path, only foreground subscribers stay armed, events use a
   250 ms trailing debounce, and continuous churn is capped at one notification
   per 1,000 ms per active root. Their channel is the scoped
   `volli:worktree-changed`, not the whole-board `volli:data-changed` channel.
   The separate retention watcher polls every 60 seconds and calls its data
   invalidation seam once only when an observation changed. The existing
   deterministic watcher tests cover burst collapse, the max-wait ceiling,
   ignored build output, refcounting, pause/resume, and teardown; all 18 passed
   under the two-worker arm. A visible Change Set can still spend git/fs work on
   its one active root, but the reported 50 registrations do not create 50
   continuously broadcasting filesystem watchers.

## Concurrency and priority

No process-priority change was made. The current Session budget writes the
cooperating toolchain variables (including Vitest, Cargo, CMake, pytest-xdist,
libuv, Make, Go, and Gradle) and this Session observed
`VOLLI_CONCURRENCY_HINT=1`. The remaining coverage gaps are tools that ignore
those variables, explicit user overrides, and work on Electron's own
main/renderer/GPU threads. Those gaps are real, but lowering the priority of a
user's build by default would trade away their requested work; any such policy
remains an explicit opt-in question rather than a sidebar fix.
