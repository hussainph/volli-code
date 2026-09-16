# What a ticket switch actually costs — VC-385

Scope: switching from one already-open ticket workspace to another, measured
end to end, then broken into its parts so a fix could be chosen on evidence
rather than on the shape of the code.

The headline: **the switch was 707.5 ms p50 and is now 278.5 ms p50 idle, a
61% cut; 771.9 → 287.8 ms loaded, a 63% cut.** None of it came from the thing
this ticket was opened about.

## The premise this ticket started from, and why it was wrong

VC-385 was opened on the reading that a switch is expensive because
`home-surface.tsx` draws the workspace as `<TicketDetail key={ticket.id} …>`,
so every switch throws away the ticket page, its rail, every rail panel and the
description editor and builds them again. The ticket's own review had already
withdrawn the numbers attached to it and flagged that "the cost is re-render,
not IPC" did not follow from the evidence given.

It does not follow, and it is not true. Rebuilding the entire ticket workspace
costs **1.1 ms**. Two thirds of the switch was one IPC read.

## Method

One machine, one fixture, nothing else running.

| | |
|---|---|
| Tree | `13312a74` plus this branch's instrumentation |
| Machine | MacBookPro17,1 · Apple M1 · 8 cores · 16 GB · macOS 26.5.1 (25F80) |
| Fixture | `real` preset, seed 353259855 — 1,198 Sessions, 392 tickets, 373 MB |
| Arms | idle, and loaded at 2 busy cores |
| Repetitions | 20 per arm, after one discarded warm-up |
| Command | `--preset real --interactions ticket_switch --arms <arm> --repetitions 20` |

Four runs in all: before and after, on each arm, same machine, same fixture,
nothing else running. Each "before" build is this branch's instrumentation on
top of the unfixed palette, so a pair differs by the fix and by nothing else.

Reports, all four under `docs/performance-baselines/`:

| Run | Directory |
|---|---|
| idle, before | `vc-385-ticket-switch-before/` |
| idle, after | `vc-385-ticket-switch-after/` |
| loaded, before | `vc-385-ticket-switch-loaded-before/` |
| loaded, after | `vc-385-ticket-switch-loaded-after/` |

### What the git stamps in those reports mean

Each report is stamped with a SHA and a dirty working tree, and within a pair
both reports carry the SAME SHA — so the stamp cannot tell a "before" from an
"after". That is a property of how the pairs were taken, not an accident, and
each report now says so in its own Provenance section:

| Run | Stamp | What the tree actually was |
|---|---|---|
| idle, before | `13312a74` dirty | instrumentation only, palette fix not applied |
| idle, after | `13312a74` dirty | same tree, palette fix applied |
| loaded, before | `2f0f55c2` dirty | fix commit with the palette fix reverted in the working tree |
| loaded, after | `2f0f55c2` dirty | fix commit as committed |

The loaded pair is stamped with the fix commit itself, which would otherwise
read as "both runs include the fix". The before run does not. In both loaded
runs the dirty flag also covers one uncommitted harness change — the validation
that lets a narrowed loaded arm end early, later `92e0643d` — which changes
what the harness accepts, never what the app does, and was identical across
both runs.

The consequence worth stating plainly: **none of the four reports is
reproducible from its SHA alone.** This write-up is the record of what each arm
ran. On a ticket opened because earlier numbers had bad provenance, that is
exactly the kind of thing that has to be said rather than left for a reader to
discover.

All four runs were taken before this branch was synced with `main` — the idle
pair at `13312a74`, the loaded pair at `2f0f55c2`, both ancestors of the merge.
The nine commits the sync picked up include two on neighbouring paths —
VC-387 (the board no longer re-reads on every data change, and the ticket body
is now a per-open read) and VC-389 (the async git runner's concurrency is
bounded). Neither touches the palette's Session read or the phases measured
here, and the split is unchanged in shape by them, but the absolute numbers
belong to the tree they were taken on. A re-measure on the merged tree would be
the honest input to any future comparison.

One caveat on the loaded arm: a narrowed run stops its busy workers once the
measurements are done rather than holding the exposure open for the configured
hour, and records that as `narrowed-interactions-early-stop`. So it is a
2-busy-core exposure sized to the measurements, not a complete fixed-duration
one. The two loaded runs here are comparable to each other; neither is
comparable to a full nine-interaction matrix.

### How the split was taken

The renderer stamps a `performance.mark` at each boundary a switch crosses
(`@renderer/lib/perf-marks`), and `ticket-switch-breakdown.mjs` reduces the
stamps into the segments between them. They are segments, not spans: every
millisecond of the measured window belongs to exactly one, so they sum back to
the latency and nothing can hide in a gap. `sessions.list` is the one figure
reported inside another (it sits within "find row"), because it is VC-388's
cost appearing in our window and had to be nameable without being counted
twice.

Marks are off unless a measuring page turns them on, so an ordinary run stamps
nothing. Mark names are string literals either side of a process boundary with
no module able to reach both, so the reducer reports any mark it never saw and
the harness fails the run on a non-empty list — drift becomes a failed
measurement instead of a phase that silently reads as zero.

## The split

### Idle arm

| Phase | Before p50 | After p50 | Before p95 | After p95 |
|---|---:|---:|---:|---:|
| **Whole switch** | **707.5 ms** | **278.5 ms** | **846.0 ms** | **414.1 ms** |
| open palette | 33.0 ms | 37.6 ms | 45.4 ms | 46.1 ms |
| find row | 566.3 ms | 130.4 ms | 662.7 ms | 162.1 ms |
| rebuild workspace | 1.1 ms | 1.0 ms | 1.3 ms | 1.5 ms |
| description editor | 28.9 ms | 30.8 ms | 35.0 ms | 50.0 ms |
| settle | 81.8 ms | 85.1 ms | 105.1 ms | 190.0 ms |
| ↳ of which `sessions.list` | 470.3 ms | 10.3 ms | 542.1 ms | 13.2 ms |

### Loaded arm (2 busy cores)

| Phase | Before p50 | After p50 | Before p95 | After p95 |
|---|---:|---:|---:|---:|
| **Whole switch** | **771.9 ms** | **287.8 ms** | **1185.2 ms** | **351.3 ms** |
| open palette | 37.3 ms | 39.3 ms | 51.7 ms | 53.5 ms |
| find row | 615.3 ms | 120.9 ms | 941.5 ms | 146.9 ms |
| rebuild workspace | 1.1 ms | 1.0 ms | 1.4 ms | 1.2 ms |
| description editor | 30.1 ms | 27.1 ms | 37.8 ms | 30.9 ms |
| settle | 103.4 ms | 88.5 ms | 157.6 ms | 140.0 ms |
| ↳ of which `sessions.list` | 496.8 ms | 8.9 ms | 760.6 ms | 9.6 ms |

The loaded arm is where this change matters most, and the tail is the reason.
Contention does almost nothing to the switch's renderer work — the rebuild is
1.1 ms on both arms, the description editor moves by a millisecond — but it
punishes a blocking main-process transaction badly: `sessions.list` p95 was
542 ms idle and 761 ms loaded before the fix. Removing the repeat read takes
the loaded p95 from 1185.2 ms to 351.3 ms (−70%) and collapses its variance
from 35,415 ms² to 1,308 ms², 27× tighter. The switch is not only faster, it
is far more predictable under load — which is the state a person's machine is
actually in while agents are running, and the state the original "feels slow"
report came from.

Read the idle "before" column as the answer to the question the ticket asked:

- **66% of the switch was `sessions.list`.** Opening the command palette read
  every tracked project's whole Session listing, every time, with no cache.
  That call folds a project's entire roster inside one blocking transaction on
  the main process — 1,198 Sessions in this fixture.
- **0.16% was the workspace rebuild.** The keyed remount that names this
  ticket is 1.1 ms. It is not worth changing.
- **4% was the description editor.** Creating and laying out Monaco for the
  first time is 28.9 ms — real, and an order of magnitude below the palette.
- The remaining ~12% is settle: the two frames the harness waits for after the
  workspace is ready.

## What was changed

**The palette reads the cached Session store instead of re-asking.**
`stores/project-sessions.ts` already holds every project's listing rows,
seeded once per project and kept current by the `volli:session-activity` push
channel — two other surfaces read it. The palette was asking the same question
again on every ⌘K and keeping the answer in component state. It now reads the
cache and merges across projects (`mergedProjectSessionRows`), and calls
`ensure` per project, which is at-most-once and never twice at a time.

`sessions.list` inside the switch: **470.3 ms → 10.3 ms (−98%)**. The whole
switch: **707.5 ms → 278.5 ms (−61%)**; p95 846.0 → 414.1 ms (−51%).

The residual 10.3 ms is the first ⌘K of a window, which still has to seed any
project no other surface has visited. Every later open is a cache read.

### What the palette gave up: its correction path

The palette previously re-read on every open and on every `lastPlanningChange`.
Both are gone. It now calls `ensure`, which is at-most-once per project and
trusts an existing entry for the life of the window, and the
`volli:session-activity` channel carries everything after that. **The palette
no longer has any way to correct a listing that has drifted.**

This is safe today, for two reasons that are worth stating because the safety
depends on them rather than on the design:

1. **Rows are never removed.** `listSessions` is a plain
   `SELECT … FROM sessions WHERE project_id = ?`, and there is no
   `DELETE FROM sessions` anywhere in the main process — a Session ends by
   getting an `ended_at`, not by disappearing. The push channel upserts, so a
   listing can gain rows and change them but cannot be left holding one that no
   longer exists. Drift in the direction that would show a person a destination
   that is not there is therefore not reachable.
2. **The selected project keeps a correction path anyway.** The sidebar's
   `ActiveSessions` calls `refresh` on its own `refreshTick` — notably when a
   throttled window becomes visible again — and writes through the same shared
   store, so the palette sees the corrected rows for free.

What is genuinely gone is coverage for a project that neither the sidebar nor
Home ever renders: for that project the palette's first `ensure` is the only
read of the window's life. Nothing can go wrong with it while (1) holds. If a
Session ever becomes deletable, or the listing gains a filter that can flip a
row out of it, this is the surface that will not notice — and the fix is a
`refresh` on a coarse trigger, not a return to reading per open.

### Overlap with VC-388

This is a renderer-side cache in front of a main-process problem VC-388 owns:
`listSessions` still folds a project's whole roster in one blocking
transaction, and it still blocks Electron's main thread for as long as it
takes. What changed here is how often a ticket switch pays for it — once per
window per project instead of once per ⌘K. **The call itself is not faster and
was not touched.** The first open of a window still pays full price, and so
does every other caller.

## What was considered and dropped

**Stop rebuilding the workspace on every switch** — dropped. The rebuild is
1.1 ms p50 and ≤ 1.4 ms p95, and it is 1.1 ms on the loaded arm too: it does
not even degrade under contention. `<Activity mode="hidden">` would keep the subtree's
DOM and state alive across switches at the cost of holding every open ticket's
tree resident, and it still tears down effects when hiding — so the Monaco
editor, which is created in an effect, would be destroyed and rebuilt anyway.
Paying that complexity and that memory for 1.1 ms is not defensible. The
`key={ticket.id}` stays.

**Reuse one Monaco editor instead of creating one per switch** — dropped for
now. At 28.9 ms p50 it is the second largest renderer-side phase, and swapping
the model on a single editor is the pattern Monaco's maintainers point tabbed
apps at. But it is 4% of the before number and 11% of the after one, the work
is invasive (the editor's whole lifecycle moves out of its mount effect), and
there is a cheaper question to answer first — see the budget below. Worth
revisiting only if the description editor is still the largest remaining phase
after settle is understood.

**Timing the switch from a tab click instead of the palette** — not adopted.
The ticket raised it: a switch between two open tabs is better timed from
clicking the tab than from opening ⌘K, and changing it would need a fresh
baseline rather than a comparison to the old figures. The split made the
argument moot for this round. Far from being noise around the "real" switch,
the palette *was* the switch: 599 ms of the 707 ms before this change. Timing
from a tab click would have measured a 111 ms interaction and hidden the entire
finding. The interaction is unchanged, and the before/after pair above is
therefore directly comparable.

Keep it in mind for later: once the palette is no longer dominant, the
palette-driven number stops being a good proxy for "switching between two open
tabs", and a second interaction — not a replacement — is the honest way to
measure that.

## A budget, now that a clean "before" exists

`real` fixture, `--interactions ticket_switch`, 20 repetitions:

| Arm | p50 | p95 |
|---|---:|---:|
| idle | ≤ 300 ms | ≤ 450 ms |
| loaded, 2 busy cores | ≤ 320 ms | ≤ 400 ms |

Set from the measured "after" (278.5 / 414.1 idle, 287.8 / 351.3 loaded) with a
little headroom, not from an aspiration. A ratchet against regression, not a
target to optimise toward.

The loaded p95 budget is *tighter* than the idle one, which looks wrong and is
not: the idle "after" p95 carries a settle outlier the loaded run did not (see
below). If the settle noise turns out to be real rather than drift, the idle
p95 budget is the one to revisit.

## Loose ends

- **Settle is the noisy one now.** On the idle arm its p50 is unchanged (81.8
  → 85.1 ms) but p95 went 105.1 → 190.0 ms with variance up eightfold. The
  loaded arm shows the opposite — settle p50 103.4 → 88.5 ms and p95 157.6 →
  140.0 ms, both improving. A phase that gets worse on the quiet arm and better
  on the busy one is not a regression the fix caused; it is two 20-repetition
  runs on one machine failing to separate a tail from thermal drift. Same
  caution the ticket applied to the dropped-frame jump: treat it as noise until
  it repeats. Dropped frames p95 went 2 → 3 idle and stayed at 2 loaded, within
  the same doubt.
- **`sessions.list` is still slow, just rarer.** VC-388.
- **The loaded arm is a narrowed exposure**, not a full fixed-duration one —
  see the method note. Comparable within this pair only.
- The description editor is now the largest phase after settle, on both arms.

## Harness fixes that came with this

Two bugs in `--interactions`, the flag this work depends on:

- `selectTicketFromPalette` matched its row by page-wide text, which also finds
  the open ticket's `h1`. Harmless in a full run, where the interactions before
  it have navigated away; a strict-mode violation the moment `--interactions
  ticket_switch` skips them. Now scoped to the palette's own list.
- `validateBenchmarkReport` expected all nine interactions regardless of what
  the run was asked for, so a filtered run measured everything correctly and
  then refused to write its report. The filter is now recorded in
  `config.interactions` and validation honours it.
- The loaded arm of a narrowed run stops its busy workers as soon as the
  measurements are done, but validation only knew the two completions a full
  run can end with, so it rejected its own arm as `load ended as
  narrowed-interactions-early-stop`. Narrowed is now an expected ending, held
  to a bar it can actually meet: the exposure has to cover its measurements,
  rather than fill the configured hour.
