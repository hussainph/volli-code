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

The loaded arm is two continuously busy Node worker threads doing fixed integer
mixing with no allocation, started before Electron and stopped after the report.
The measurements in the table below were taken with that generator managed
externally to the bench, which made `--load` a label rather than a lever; the
bench now starts and stops the workers itself (`--busy 2`) so the arm cannot
drift between two runs that claim the same name. When VC-353's background-load
generator lands, this should call that instead of its own busy loop.

The bench is a gate as well as a report. It exits non-zero on a fixture fault, a
lost terminal identity, an endpoint that never settles, any renderer console
error, a reduced-motion endpoint that took longer than 50 ms (long enough to
have been animated rather than swapped), and a pin whose worst frame missed
`--budget-ms`, default 33.3.

### What this fixture is not

It is the built app with ONE Session and four live restty canvases on a fresh
database — the expensive-sibling half of VC-353's `real` fixture, not its
migrated 1,200-Session/260k-event half. The report labels it `live-app` rather
than `real` for that reason. Results are comparable within this machine and arm
and are not a replacement for that matrix; a database large enough to make a
bootstrap slow is exactly the condition under which the broadcast coalescing
below matters most, and it has not been measured here.

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

### Re-measured after the review changes

Both arms below were driven by the bench's own `--busy` generator, so the loaded
arm is reproducible rather than described. Taken on the same machine while five
sibling worktrees were running their own test suites — real contention on top of
the two synthetic workers, which is the condition the ticket is actually about.

| arm | action | resize callbacks | resize entries | FPS | p95 frame | max frame | frames >33 ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `--busy 0` | close | 1 | 4 | 59.9 | 17.6 ms | 17.7 ms | 0 |
| `--busy 0` | open | 1 | 4 | 60.0 | 17.5 ms | 17.6 ms | 0 |
| `--busy 2` | close | 1 | 4 | 58.2 | 17.5 ms | 32.4 ms | 0 |
| `--busy 2` | open | 1 | 4 | 60.0 | 17.6 ms | 17.6 ms | 0 |

Both runs exited zero, which now means more than "it finished": no renderer
console error, every terminal host object still connected and never present in a
removal mutation, and every endpoint settled with no active marker or retained
transform. Reduced-motion endpoints settled in 4–21 ms against a 50 ms swap bar
— they are swaps, not shortened animations. A preference change mid-journey
settled in 154–158 ms, i.e. it lands on the endpoint rather than continuing.

The one number worth naming is the loaded close's 32.4 ms worst frame. It is
under the 33.3 ms budget and it is the only reading in either arm above one
frame, on a machine simultaneously running two synthetic busy cores and five
other test suites.

The implementation removes the spacer's `width` transition. The content keeps
one endpoint's layout while a WAAPI standalone `translate` runs on the
compositor, then commits the final spacer/card geometry once where the two
presentations coincide.

A visible Browser Tab is the deliberate exception, **and it is VC-363's ask, not
this ticket's invention.** Its native `WebContentsView` cannot inherit a DOM
transform, and the existing captured-frame path does not hide that plane until an
asynchronous capture settles. Starting the transform at the same time would
visibly detach page pixels from Browser chrome for up to that handoff. VC-363
reviewed exactly this and asked for the conservative shape in writing: "overlay
detection is currently rAF-coalesced, then capture({tabId}) and native hide are
async (bounded by 80ms). Starting WAAPI in the same layout effect necessarily
races it — please take the conservative no-gap path for this slice: make
pin/unpin instant whenever a visible [data-browser-plane] exists." So when one
exists, pin/unpin takes both endpoints directly: one endpoint layout and one
final Browser bounds report, with no intermediate native resizes. A
motion-preserving version needs the explicit two-phase arm/capture/ready protocol
VC-363 describes, which is transition-specific machinery that should be owned and
tested separately rather than implied here.

The predicate itself lives in `browser/browser-plane-freeze.ts`
(`hasVisibleNativePlane`) rather than in the shell: `[data-browser-plane]` is
`browser-pane.tsx`'s marker, that module already owns every other rule about when
a plane may hold the top of the window, and it is coverage-gated where the shell
is not.

That exception carries **its own marker, `data-pin-motion="instant"`, and not
the shell's `data-motion="instant"`.** The first draft reused the existing hatch,
which silently widened it: `data-motion` belongs to terminal focus and rail
geometry, it is read by the sidebar primitive's own width transitions
(`ui/sidebar.tsx`), and its contract is one frame of snapped geometry — not
"nothing in this shell may animate". Reusing it made ⌘B animation-free whenever
any Browser Tab was on screen, which is a different promise from the one that
attribute makes.

The exception is also armed off the resolved pin TARGET rather than inside the
⌘B handler, because that handler was never the only writer: Settings' "Keep the
sidebar open" switch calls the store directly and the fullscreen suspension is
not a control at all, so a guard at one control was a guard the other two walked
past — a pin from Settings with a Browser Tab up ran the full WAAPI journey. The
price is one commit of arming, which React flushes before paint: the journey the
first commit starts is cancelled by the second, and no frame is painted between
them.

The bench also reverses both directions after 45 ms and verifies the final
layout has no active marker or retained transform. It verifies reduced-motion
endpoint swaps both when the preference is already set and when it changes
mid-journey, and now asserts the elapsed settle time rather than only that the
endpoint eventually arrives — a 5 s allowance cannot tell a swap from a played
animation. Finally it enters/exits terminal focus through Alt+Cmd+Enter,
observes `data-motion="instant"`, and proves all original terminal host objects
stay connected and are never present in a removal mutation; comparing Session
IDs alone would miss a destroy/recreate regression. All behavior checks passed.

### The state machine, and the trap it had

The decision half now lives in `components/sidebar/content-motion.ts` as a pure
module under the coverage gate, because the first version had a reachable
stranded state that no test could see from inside a `useLayoutEffect`.

An opening that lands leaves its WAAPI record `settling`: finished, but still
holding the endpoint with `fill: "forwards"` until the next pass cancels it. A
⌘B in that same React commit — pressing it on the last frame of an open — found
that record and read it as a LIVE journey, which made the close skip the layout
release. The result was terminal: the spacer stayed at `var(--panel-w)` with no
panel in it, the moving marker was stuck on so every Browser plane stayed frozen
behind a stand-in, and nothing could re-run the effect to heal it. The fix is
two lines of rule — a settling record is the previous journey's shadow and may
be walked over, and both directions commit their layout on finish — and nineteen
tests that could not have been written where the rule used to live.

## Broadcast result

Before this change every `broadcastDataChanged()` call immediately sent one
`volli:data-changed` event to every live window. The renderer maps each event to
one full `refreshPlanningData()` bootstrap/hydration. After this change, calls
within an 8 ms half-frame window produce one event per live window.

The focused test drives 15 same-scope mutations and measures **15 potential
hydrates -> 1**. Additional cases prove conservative scope widening, retention
of the special `kind: "worktree"` venue invalidation, untargeted invalidations,
destroyed-window filtering, re-entrancy, the zero-window case, and a fresh window
after each flush.

**What this is not: it is a fan-out count, not a hydration measurement.** The
tests count `webContents.send` against a mocked Electron; no renderer hydrates in
them, and none of it runs under load. The claim they support is "fifteen notices
become one", and the claim they do NOT support is "the app spends less time
hydrating". The size of each saved bootstrap belongs to VC-355 and a smaller
planning-only projection to VC-362; the honest before/after under a 260k-event
database needs VC-353's fixture and is not in this ticket's evidence.

The coalescer is a **factory over a sink** (`main/data-change-coalescer.ts`), on
`pty/output.ts`'s pattern, rather than a process-global timer. A shared window is
fine while there is exactly one consumer; with a second subscriber — a remote
Session client, a window with its own cadence — one global timer folds one
consumer's burst into another consumer's latency, and no tuning makes a shared
window per-connection. What it deliberately does not copy from `output.ts` is
ack-based flow control: that pipeline carries unbounded bytes, this one carries a
fixed-size notice whose merge is idempotent, so the queue can never hold more
than one and the coalescing IS the backpressure.

One ordering claim died with the change and is recorded here because the code
used to argue it: `data-ipc.ts`'s worktree-materialisation broadcast said it
"lands last by construction" because it was queued before the reply. The 8 ms
deferral makes the reply win that race. The outcome is unchanged — the
re-hydrate is a full bootstrap and the renderer's optimistic revert is one field,
so the bootstrap is the last word either way — but the reasoning no longer
describes the code, and the comment now says so.

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

3. **CPU contention can starve interaction delivery — confirmed at one level,
   not characterised across several.** The identical old open interaction went
   from a 17.7 ms idle maximum to a 299.9 ms loaded maximum, which settles the
   existence question the ticket already treated as settled. What was NOT done is
   the rest of what the ticket asked for: only one load level (two busy workers)
   was measured, so there is no curve, and no audit of synchronous work on main
   was performed here. The sweep is now one flag — `--busy N` — and whoever wants
   the curve should take it rather than inherit this single point. VC-355's finding that a full event-log walk blocks main
   for ~630 ms is the same mechanism from the other end and that ticket owns the
   fix. VC-355 separately measured zero Session RPC calls for
   sidebar open, so the transition itself does not synchronously request Session
   projections. The changed path held 60 FPS in the two-worker arm, which does
   not disprove jank from a separate long synchronous main-process task.

4. **There is no idle deferral — source-confirmed only, and NOT measured.** There
   are zero non-test `requestIdleCallback` call sites under `apps/` or
   `packages/`. That is a grep, not a measurement, and it is reported as one: no
   listing rebuild, provenance refresh or title refinement was timed against a
   pin frame. It stays a grep because the two candidates this ticket could have
   deferred are the wrong ones — the planning recovery is correctness-critical
   and the endpoint resize is the thing being animated, and deferring either
   would only prolong incorrect geometry. Listing/provenance/title work should be
   measured at its owning call site before anyone defers it.

5. **Data-change broadcasts are uncoalesced — confirmed and fixed.** There are
   23 textual `broadcastDataChanged(` occurrences in main source (including the
   definition) and each receipt triggers a full planning bootstrap. The
   coalescer reduces a 15-event burst to one send per window while preserving
   scope safety and worktree cache invalidation. Measured as a fan-out count
   against a mocked Electron, not as renderer hydration time — see the broadcast
   section above for what that does and does not license.

6. **Fifty registered worktrees imply a watcher-driven rehydrate storm — mostly
   disproved, by construction rather than by event counting.** The ticket asked
   for a measured event rate under load; what follows is an argument from the
   watchers' implementation and their existing deterministic tests. It is enough
   to disprove the *storm* — the channels and the refcounting settle that — and
   it is not a measurement of how many events a churning build actually emits.
   Registration count is not live watcher count. Change Set watches
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

No process-priority change was made, and `nice`-ing a user's own build stays
rejected by default: those children are the work they asked for, and slowing a
build to smooth an animation is a trade nobody requested.

The ticket asked which of the three named coverage gaps actually bites here.
They are not equally guilty, and the answer is structural rather than
statistical.

**Gap 3 — no coverage of main-process or renderer-thread work — is the one that
bites this symptom, and it bites completely.** The budget reaches exactly two
places: a PTY child's environment (`pty/manager.ts:659`, via
`sessionConcurrencyEnv`) and the agent-socket spawn path (`index.ts:1177`).
Electron's main, renderer and GPU processes are children of neither. They are
the app itself, they read no budget variable, and no value of
`VOLLI_CONCURRENCY_HINT` could have changed a single frame in the table above —
the janking thread was Volli's own renderer. That is why the fix that worked was
inside the renderer and not in the environment: for this symptom the concurrency
budget is not undersized, it is out of scope by construction.

**Gap 1 — tools that ignore the variables — is real and does not bite here.**
`concurrency-budget.ts` names the variables it writes and, unusually, names what
it deliberately leaves out and why: `GOMAXPROCS` (caps every Go program's
threads, not a build's parallelism) and Jest (reads no environment variable at
all, so covering it would mean rewriting command lines). Both are honest gaps in
child-process coverage. Neither is a renderer frame.

**Gap 2 — no priority lowering, so background builds contend equally — is the
real remaining lever, and it stays unpulled.** The mechanism exists and is
present on this machine: macOS `taskpolicy -b` (`PRIO_DARWIN_BG`), its `-c` QoS
clamp and I/O throttling, all inherited by children, plus `nice`/`renice` and
Node's `os.setPriority`. The choke point is already built — `sessionConcurrencyEnv`
is where a Session's environment is assembled. What is missing is not the
plumbing but the user's consent, and the published norm is against it: ninja
defaults to available CPUs, make guidance is cores+1, VS Code answers its own
jank reports with thread caps rather than by deprioritising ripgrep, and no team
publishes child-priority tuning for an Electron app hosting compilers. If it is
ever built it should be an opt-in the user controls, and it should be justified
by a measurement that gap 3 does not already explain — which, for the sidebar,
it does.

A ninja-style load-average guard before starting new heavy work was not costed
and remains open. It would act on the same lever as gap 2 (when to start work
rather than how to prioritise it) and has the same prerequisite: evidence that
child-process load, rather than the app's own threads, is what a person is
feeling.
