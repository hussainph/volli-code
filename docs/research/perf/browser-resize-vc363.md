# VC-363 — Browser Tab resize and agent-tool performance

Measured 2026-09-13 on a MacBookPro17,1 (Apple M1, 8 cores, 16 GiB), macOS
26.5.1, Electron 44.0.0 / Chromium 152.0.7977.54. The fixed source revision was
`09acc82e67c810d48e791d80b1605e86daa224d9`; the rAF candidate and benchmark
were measured before commit, so the benchmark working tree was dirty.

Raw run output is intentionally not committed. The tables below retain the
reviewed results, and the harness can regenerate machine-readable output at a
caller-selected path.

The harness is `apps/desktop/e2e/browser-resize-bench.mjs`. It uses a real
visible `BrowserWindow`, a real `WebContentsView` for the active tab, and a
never-shown `BaseWindow` stage for standing tabs, matching `BrowserTabHost`.
Fixtures are local `data:` pages, so network variance is excluded.

## Load arms and caveat

The idle arm had no controlled load generator or validation running in
parallel; VC-363 was the only working Volli Session. Launch load average was
14.84 / 14.05 / 14.84, still decaying from earlier benchmark and validation
work, so “idle” names the controlled arm rather than a thermally cold machine.

The loaded arm reused VC-353's published fixed integer-mixing generator: two
continuously busy Node worker threads, each confirmed ready, followed by its
1,500 ms warmup before Electron launch. Launch load average was
19.47 / 16.33 / 15.66. The exact condition is embedded in the JSON; the
benchmark itself deliberately does not duplicate or silently start VC-353's
generator.

Commands:

```sh
env -u ELECTRON_RUN_AS_NODE apps/desktop/node_modules/.bin/electron \
  apps/desktop/e2e/browser-resize-bench.mjs \
  --arm idle \
  --load-note "No controlled load generator or parallel validation; VC-363 was the only working Volli Session at launch" \
  --transitions 3 \
  --modes uncoalesced,raf-latest,endpoint-snap \
  --json /tmp/vc363-idle.json

# Run this child after VC-353 startBusyLoad(2) has received both ready
# messages and completed its 1,500 ms warmup; stop both workers afterward.
env -u ELECTRON_RUN_AS_NODE apps/desktop/node_modules/.bin/electron \
  apps/desktop/e2e/browser-resize-bench.mjs \
  --arm loaded \
  --load-note "VC-353 shared fixed integer-mixing generator: 2 continuously busy worker threads, ready plus 1500ms warmup before Electron launch" \
  --transitions 3 \
  --modes uncoalesced,raf-latest,endpoint-snap \
  --json /tmp/vc363-loaded.json
```

Each resize cell is three 200 ms CSS width transitions. Four active-page
weights are covered: static, continuously animating canvas, canvas-backed
video, and a 1,800-node heavy SPA that mutates and measures a bounded subset of
cards each frame. Tab counts are 1 / 4 / 8; standing tabs remain parented in
the hidden stage with product-default background throttling.

## Headline: batching versus the structural floor

Numbers below average the four page weights at each tab count. “Dropped” is
the sum across all 12 transitions represented by a row; p95 is the worst cell
for that row.

| arm | tabs | mode | bounds calls / transition | dropped frames | worst frame p95 | worst IPC p95 |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| idle | 1 | uncoalesced | 12.33 | 0 | 18.6 ms | 1.7 ms |
| idle | 1 | rAF latest | 12.00 | 0 | 18.6 ms | 1.7 ms |
| idle | 1 | endpoint floor | **1.00** | 0 | 18.6 ms | 1.4 ms |
| idle | 4 | uncoalesced | 12.33 | 0 | 18.6 ms | 2.0 ms |
| idle | 4 | rAF latest | 12.00 | 0 | 18.6 ms | 2.5 ms |
| idle | 4 | endpoint floor | **1.00** | 0 | 18.6 ms | 1.6 ms |
| idle | 8 | uncoalesced | 12.33 | 0 | 18.6 ms | 5.1 ms |
| idle | 8 | rAF latest | 12.00 | 0 | 18.7 ms | 1.6 ms |
| idle | 8 | endpoint floor | **1.00** | 0 | 18.7 ms | 1.3 ms |
| 2-busy-core | 1 | uncoalesced | 12.33 | 0 | 18.5 ms | 3.0 ms |
| 2-busy-core | 1 | rAF latest | 12.00 | 0 | 18.6 ms | 3.1 ms |
| 2-busy-core | 1 | endpoint floor | **1.00** | 0 | 18.6 ms | 1.5 ms |
| 2-busy-core | 4 | uncoalesced | 12.33 | 0 | 18.6 ms | 2.5 ms |
| 2-busy-core | 4 | rAF latest | 12.00 | 0 | 18.6 ms | 3.6 ms |
| 2-busy-core | 4 | endpoint floor | **1.00** | 0 | 18.7 ms | 60.2 ms |
| 2-busy-core | 8 | uncoalesced | 12.33 | 0 | 18.7 ms | 1.4 ms |
| 2-busy-core | 8 | rAF latest | 12.00 | 0 | 18.7 ms | 3.2 ms |
| 2-busy-core | 8 | endpoint floor | **1.00** | 0 | 18.6 ms | 1.6 ms |

### Verdict and acceptance bar

The accepted regression bar is: at most one native `setBounds` per vsync,
settled guest/anchor geometry within 100 ms, and no blank visible-surface frame.
Hiding or detaching the native view during routine sidebar motion is rejected:
prior art observed flashing, and an asynchronous capture/hide handoff cannot
satisfy the no-blank requirement reliably.

The cheap rAF change is correct defense in depth, but it does **not** remove the
sidebar-transition floor. `ResizeObserver` already delivered approximately one
notification per display frame in this fixture, so latest-value coalescing plus
main-owned exact deduplication moved 12.33 native calls to 12.00: 2.7%, not the
order-of-magnitude improvement the visible bug needs. It does establish a hard
bound of at most one lazy geometry read and one bounds IPC per animation frame
when ResizeObserver/window-resize notifications collide, and the focused test
proves a same-frame burst reads and sends only the latest observation.

The only material win is deleting in-flight native resizing. The
`endpoint-snap` control performs no native bounds update during the 200 ms
flight and one exact settled report: **12.33 calls -> 1**, a 91.9% reduction in
both arms, at every tab count and page weight. This is the structural result
VC-359's Browser-specific instant endpoint/no-reflow boundary is designed to
buy. It is a lower-bound mode, not a claim that this harness boots VC-359's
real-app presentation; that probe separately measured terminal-host resize
callbacks falling from 10/8 to 1/1 while holding 60 FPS.

This mechanism benchmark directly establishes the per-vsync call bound. Its
endpoint arm also stayed within 60.2 ms IPC p95, but it does not timestamp guest
viewport convergence or capture the OS-composited native surface, so it does
not overclaim the 100 ms/no-blank halves of the bar. VC-359's real-app probe
owns those presentation assertions for the endpoint/no-reflow sidebar change.
VC-363 preserves the live native view throughout; it adds no transition hide,
detach, or screenshot-freeze path.

## Isolated `setBounds`

| arm | p50 | p95 |
| --- | ---: | ---: |
| idle | 0.07 ms | 0.10 ms |
| 2-busy-core | 0.02 ms | 0.02 ms |

This measures only the synchronous main-process `WebContentsView.setBounds()`
invocation. It proves JavaScript call overhead is not the problem; it does
**not** measure when Chromium presents a correctly sized compositor frame. The
renderer CSS transition and the main-owned native surface still cannot share a
frame clock across asynchronous IPC. Most loaded IPC p95s were 0.6–3.6 ms, but
the 4-tab video endpoint cell recorded **60.2 ms p95**. Even the one-call
strategy therefore has a scheduling tail; it simply avoids restarting that
cross-process work a dozen times.

## Navigation to first-frame proxy

`firstPaintMs` is navigation start to the fixture's first
`requestAnimationFrame`, sent from the new document before `loadURL` settles.
It is an explicit first-frame proxy, not a Paint Timing API entry.

| page | idle cold | idle warm | concurrent cold | concurrent warm |
| --- | ---: | ---: | ---: | ---: |
| static | 148.36 ms | 167.19 ms | 365.14 ms | 274.22 ms |
| animating | 121.51 ms | 129.43 ms | 310.92 ms | 366.41 ms |
| video | 213.81 ms | 196.02 ms | 385.22 ms | 434.53 ms |
| heavy SPA | 121.35 ms | 214.38 ms | 385.24 ms | 481.45 ms |

The controlled load arm raised every cold first-frame proxy to roughly
311–385 ms and the slowest warm result to 481 ms. The fixture order is fixed,
so these are one-sample latency indicators rather than distribution claims.

## Per-tab standing cost

Static page; one active tab and the remainder in the never-shown stage.
Working-set deltas include the renderer process and shared Electron process
accounting reported by `app.getAppMetrics()`.

| arm | tabs | process count | working set | incremental per new tab | sampled idle CPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| idle | 1 | 5 | 444.2 MiB | 114.1 MiB | 0.06% |
| idle | 4 | 8 | 681.6 MiB | 79.1 MiB | 0.07% |
| idle | 8 | 12 | 958.9 MiB | 69.3 MiB | 0.14% |
| 2-busy-core | 1 | 5 | 446.7 MiB | 109.7 MiB | 0.05% |
| 2-busy-core | 4 | 8 | 643.9 MiB | 65.7 MiB | 0.07% |
| 2-busy-core | 8 | 12 | 937.5 MiB | 73.4 MiB | 0.16% |

The first tab pays fixed renderer/process costs; marginal readings are noisy as
Chromium reclaims memory. Across the two arms the observed incremental range
was approximately **66–114 MiB per new tab**. The process count rose one per
view. Static app CPU stayed 0.05–0.16%; the two external busy workers are not
part of `app.getAppMetrics()`.

## Agent-tool latency and VC-277

Tools are sampled once per weight with eight tabs open. The harness approximates
post-load AgentBrowserPort work with controller-shaped CDP commands. `act`
includes click dispatch, a fresh AX snapshot and `capturePage`/JPEG result
frame; screenshot includes PNG decode. Ref formatting, navigation-grace waits,
picture-store writes, scope/hold policy and transcript rendering are excluded,
so these are mechanism timings rather than full runtime-envelope timings.

| arm | page | snapshot | screenshot | act + result evidence | 15 s timeout | click observed by page |
| --- | --- | ---: | ---: | ---: | --- | --- |
| idle | static | 0.69 ms | 65.80 ms | 44.59 ms | no | yes |
| idle | animating | 0.67 ms | 78.34 ms | 43.62 ms | no | yes |
| idle | video | 3.04 ms | 60.15 ms | 45.27 ms | no | yes |
| idle | heavy SPA | 193.16 ms | 201.35 ms | 433.70 ms | no | yes |
| 2-busy-core | static | 0.81 ms | 59.63 ms | 62.98 ms | no | yes |
| 2-busy-core | animating | 2.09 ms | 69.85 ms | 32.62 ms | no | yes |
| 2-busy-core | video | 1.13 ms | 86.81 ms | 23.43 ms | no | yes |
| 2-busy-core | heavy SPA | 217.00 ms | 144.61 ms | 424.15 ms | no | yes |

No attached active-tab CDP operation approached 15 seconds in either matrix;
heavy-SPA snapshot/act cost was nevertheless hundreds of milliseconds.
Separately, the existing `browser-throttle-bench.mjs` under real concurrent
load produced:

- never-parented detached screenshot: **15,032 ms, timed out**;
- previously attached then detached: 241 ms without a hold, 86 ms held;
- six static idle tabs: 2.0% app CPU without holds, 2.1% with one hold;
- detached timer: 1 tick/s without hold, 100 ticks/s held.

VC-277 verdict: the 15-second screenshot failure is **lifecycle/load-shape
dependent**, not normal attached-tab CDP latency. VC-278's never-shown stage is
the right structural fix, but VC-277 should retain timeout/error distinction
and test the surfaced view path. The benchmark also verifies the button's text
changed after every sampled click; returning equivalent observable evidence in
the real `browser_act` result remains the recommended no-op-click fix.

## Implementation decision

VC-363 lands the small, reusable part:

- `BrowserPlaneController.reportBounds` accepts a lazy bounds reader;
- only the latest observation is retained per animation frame;
- first show synchronously flushes real geometry before attaching the native
  plane;
- exact repeated planes are suppressed in `BrowserTabHost`, where initial and
  page/DevTools placements are all visible, instead of a stale renderer cache;
- pending work is cancelled on dispose.

It does not add main-owned animation, repeated sidebar capture, or timed
main-side batching. The benchmark shows those would not beat the one-endpoint
solution, and VC-359 owns removal of the width transition at the source.

## Evidence for VC-253 (OSR investigation)

The native-view evidence is mixed, intentionally:

- Good: direct `setBounds` invocation was 0.02–0.10 ms at p50/p95, all resize
  cells stayed at 18.7 ms p95 or lower in this isolated shell, attached
  screenshot latency stayed 60–201 ms, and the endpoint strategy removes 91.9%
  of transition calls
  without changing rendering architecture.
- Structural cost: renderer motion and the native surface cannot be
  frame-locked; an in-flight width transition still performs ~12 native
  surface resizes, and lifecycle state can turn a screenshot from 86–241 ms
  into a 15 s timeout.
- OSR benefit: a DOM-composited texture eliminates native z-order/freeze/resize
  synchronization as a class.
- OSR price on Electron 44: GPU+CPU bitmap mode adds per-frame readback and
  upload; shared-texture mode requires a native per-platform consumer,
  cross-process texture lifetime/release discipline, popup composition and
  complete input forwarding. macOS shared-texture consumption remains the
  least documented path. OSR does not remove the renderer-process-per-tab
  standing cost.

These numbers favor exhausting endpoint native-view motion before adopting
OSR, but they do not decide VC-253. Its spike should compare macOS scroll/video,
IME, drag, `<select>` popups, HiDPI and input latency against this measured
one-endpoint native baseline.

## Research follow-ups

The broader comparison is in `browser-agent-apps.md`; the resize/OSR source
review is in `browser-view-performance.md`. The filed set is deliberately
small:

1. **VC-364** — stable per-generation AX refs plus bounded literal
   `browser_find`, preserving generation/latest-snapshot safety.
2. **VC-277** (existing owner, not duplicated) — observable act evidence,
   empty/read-failure distinction and screenshot timeout reliability.
3. **VC-365** — once-per-hold approval for personal/authenticated tabs plus
   bounded agent-origin policy.

Highlighting, recordings, network tooling and consumer-browser features were
not filed from this pass.
