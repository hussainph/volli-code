# What a ticket switch actually costs — VC-385

Scope: switching from one already-open ticket workspace to another, measured
end to end, then broken into its parts so a fix could be chosen on evidence
rather than on the shape of the code.

The headline: **the switch was 707.5 ms p50 and is now 278.5 ms p50, a 61%
cut.** None of it came from the thing this ticket was opened about.

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
| Tree | `13312a74` (today's `main`) plus this branch's instrumentation |
| Machine | MacBookPro17,1 · Apple M1 · 8 cores · 16 GB · macOS 26.5.1 (25F80) |
| Fixture | `real` preset, seed 353259855 — 1,198 Sessions, 392 tickets, 373 MB |
| Arms | idle only |
| Repetitions | 20, after one discarded warm-up |
| Command | `--preset real --interactions ticket_switch --arms idle --repetitions 20` |

The loaded arm was not run. Both arms at 20 repetitions is the publishable
pair this ticket ultimately wants; what is here is the idle arm, taken twice on
the same quiet machine, which is enough to choose a fix and to show what it
moved. Reports: `docs/performance-baselines/vc-385-ticket-switch-{before,after}/`.

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

| Phase | Before p50 | After p50 | Before p95 | After p95 |
|---|---:|---:|---:|---:|
| **Whole switch** | **707.5 ms** | **278.5 ms** | **846.0 ms** | **414.1 ms** |
| open palette | 33.0 ms | 37.6 ms | 45.4 ms | 46.1 ms |
| find row | 566.3 ms | 130.4 ms | 662.7 ms | 162.1 ms |
| rebuild workspace | 1.1 ms | 1.0 ms | 1.3 ms | 1.5 ms |
| description editor | 28.9 ms | 30.8 ms | 35.0 ms | 50.0 ms |
| settle | 81.8 ms | 85.1 ms | 105.1 ms | 190.0 ms |
| ↳ of which `sessions.list` | 470.3 ms | 10.3 ms | 542.1 ms | 13.2 ms |

Read the "before" column as the answer to the question the ticket asked:

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
1.1 ms p50, 1.3 ms p95. `<Activity mode="hidden">` would keep the subtree's
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

**Ticket switch, idle arm, `real` fixture: p50 ≤ 300 ms, p95 ≤ 450 ms.**

Set from the measured "after" (278.5 / 414.1) with a little headroom, not from
an aspiration. It is a ratchet against regression, not a target to optimise
toward; the next honest reduction needs the loaded arm and a look at settle.

## Loose ends

- **The loaded arm has never been run for this interaction.** Everything above
  is idle-arm only.
- **Settle got noisier.** p50 is unchanged (81.8 → 85.1 ms) but p95 went 105.1
  → 190.0 ms and its variance rose eightfold. Two 20-repetition runs on one
  machine cannot separate that from thermal drift, and the same caution the
  ticket applied to the dropped-frame jump applies here: treat it as noise
  until it repeats. Dropped frames p95 went 2 → 3 and long tasks 1 → 2, both
  within the same doubt.
- **`sessions.list` is still slow, just rarer.** VC-388.
- The description editor is now the largest phase after settle.

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
