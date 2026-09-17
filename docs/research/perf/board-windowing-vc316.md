# VC-316 — what a board card costs, and what bounding the column bought

> Performance numbers are comparable only on the same machine, in the same
> power/thermal state, with the same load arm.

VC-316 asked for two things in order: profile the board and the sidebar at
300 / 3,000 / 10,000 tickets and at real session volume, then bound only what
the measurement justifies. This is the record of both halves. The board half
warranted a bound and got one. The sidebar half did not get one, and the
reason is a measurement rather than a judgement.

## What was measured, and with what

`apps/desktop/e2e/bench/performance/run.mjs`, the VC-353 harness, extended
here with what the ticket asks for and did not exist:

- **Three ticket-scale presets** — `tickets-300`, `tickets-3k`, `tickets-10k`.
  They vary the ticket count and hold the rest of the `small` preset's Session
  mass, so a ten-thousand-card board generates in seconds instead of scaling a
  373 MB file by twenty-five. They answer the board's per-card slope and
  nothing else; `real` stays the arm for anything about the whole app, and
  their absolute numbers are not comparable with its.
- **A `board_scroll` interaction** that drives the fullest column end to end in
  a fixed 60 frames and reports the frame times. Windowing is exactly the kind
  of change that buys a mount and sells a scroll, so the scroll had to be on
  the record before and after.
- **Mounted-card instrumentation.** Every board sample now carries how many
  tickets the board HELD and how many cards its columns had MOUNTED. The board
  and each column publish both numbers as data attributes, which is also what
  the harness's readiness check now reads — counting `[data-board-ticket-slot]`
  nodes used to mean "every ticket is drawn" and would have quietly come to
  mean "the window is full".
- **Sidebar band row counts**, for the same reason: a band bounded by age and a
  band that is genuinely short read identically on a stopwatch.

Command, for each fixture:

```sh
node apps/desktop/e2e/bench/performance/run.mjs \
  --preset tickets-10k --interactions board_render,board_scroll \
  --arms idle --repetitions 8 --skip-build --fixture <generated>
```

## Host conditions — read before comparing

MacBookPro17,1 (Apple M1, 8 logical cores, 16 GiB), macOS 26.5.1 (25F80),
Node v24.18.0. **The host was not idle.** Other Volli Sessions were running
throughout; the one-minute load average at the start of each arm was:

| Fixture | before | after |
|---|---:|---:|
| `tickets-300` | 10.52 | 5.72 |
| `tickets-3k` | 13.98 | 10.33 |
| `tickets-10k` | 13.81 | 11.85 |
| `real` | 5.44 | 7.78 |

That matters to how much each row below is worth, and it is not uniform:

- **`tickets-10k` and `tickets-3k` are the strong evidence.** Both pairs were
  taken at comparable load, and both deltas are far larger than load could
  explain.
- **`tickets-300` is the weakest.** Its "after" ran at roughly half the load of
  its "before", so some of that improvement is the machine.
- **`real` is strong in the other direction.** It improved while the load went
  UP, so its delta is if anything understated.
- Every absolute number here is **pessimistic**, and none of them is comparable
  with `docs/performance-baselines/vc-353-owner-real/benchmark.md`, which was
  taken on the same machine in a different state.

Both sweeps ran 8 repetitions per arm plus a discarded warm-up, against the
same four generated fixtures, with zero renderer console errors — the harness
publishes nothing otherwise.

## The board: what a card cost

`board-column.tsx` rendered one `TicketCard` per ticket with no bound. A card
is not cheap: a dnd-kit `useSortable` registration, a Radix context-menu root
whose ~40-element item tree is built on every render, two store subscriptions,
and a retention read for every ticket that has a branch. The board is also
re-mounted from scratch on every return from a Ticket — Home passes `plane={null}`
while a ticket takes it over (`home-surface.tsx`), which is why the
`board_render` arm below is a RETURN to the board rather than a first mount,
and why it is the arm the owner's reported stutter lives in.

### Board render (idle arm, 8 repetitions)

| Fixture | mounted / held | p50 | p95 | frame p95 | dropped p95 | long tasks p95 | RSS p95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| **300 before** | 300 / 300 | 917.7 ms | 1,406.9 ms | 100.1 ms | 39 | 2 | 328.3 MB |
| **300 after** | 200 / 300 | 337.3 ms | 861.4 ms | 83.3 ms | 33 | 2 | 293.2 MB |
| **3,000 before** | 3,000 / 3,000 | 1,789.0 ms | 2,561.7 ms | 299.9 ms | 121 | 2 | 628.4 MB |
| **3,000 after** | 200 / 3,000 | 608.3 ms | 1,035.4 ms | 100.1 ms | 39 | 2 | 318.9 MB |
| **10,000 before** | 10,000 / 10,000 | 5,797.6 ms | 9,978.0 ms | 233.4 ms | 568 | 4 | 1,133.1 MB |
| **10,000 after** | 200 / 10,000 | 365.6 ms | 750.8 ms | 83.3 ms | 30 | 2 | 333.3 MB |
| **`real` (392) before** | 392 / 392 | 265.2 ms | 480.8 ms | 83.2 ms | 11 | 1 | 371.3 MB |
| **`real` (392) after** | 200 / 392 | 205.2 ms | 320.9 ms | 49.9 ms | 3 | 1 | 314.5 MB |

### Board column scroll (idle arm, 8 repetitions, 60-frame gesture)

| Fixture | p50 | p95 | frame p95 | dropped p95 |
|---|---:|---:|---:|---:|
| 300 before / after | 1,039.4 / 1,030.1 ms | 1,057.7 / 1,040.5 ms | 18.4 / 18.5 ms | 0 / 0 |
| 3,000 before / after | 1,036.5 / 1,028.2 ms | 1,056.3 / 1,046.1 ms | 18.5 / 18.4 ms | 0 / 0 |
| 10,000 before / after | 1,093.2 / 1,029.7 ms | 1,248.3 / 1,083.9 ms | 33.0 / 18.5 ms | 13 / 1 |
| `real` before / after | 1,031.3 / 1,030.7 ms | 1,092.0 / 1,101.3 ms | 18.2 / 18.5 ms | 0 / 3 |

Latency is not the metric here — the gesture is a fixed 60 frames, so p50 is
~1,030 ms by construction. The frame times are the metric, and the answer is
that the bound did not sell the scroll to buy the mount: every arm still lands
on one refresh interval, and the 10,000-card column got BETTER (frame p95 33 →
18.5 ms, 13 dropped → 1) because it is no longer scrolling ten thousand
composited cards. `real`'s 0 → 3 dropped frames is the one number that moved
the wrong way; at three frames over eight repetitions and a p95 frame time
still inside one refresh interval, it is inside this host's noise.

### What the numbers decided

**The slope is the finding.** Unbounded, board render grows with the card
count and worse than linearly at the top: 918 → 1,789 → 5,798 ms at 300 →
3,000 → 10,000, with dropped frames going 39 → 121 → 568 and renderer RSS
reaching 1.1 GB. Bounded, it is flat in the ticket count — 337 / 608 / 366 ms
— because what the column mounts no longer depends on how much it holds.

**The residue at 3,000 is honest and expected.** 608 ms with 200 cards mounted
is not the cards; it is the per-render pipeline over the whole ticket list
(filter, group, five sorts, the activity provider's id set). Windowing bounds
what the board MOUNTS, not what it reads. That remaining cost is real, it is
outside this ticket's stated scope, and it is where a follow-up should look
rather than at the columns.

**The return-to-board remount was not removed.** It is real —
`home-surface.tsx` hands `plane={null}` while a ticket takes Home over, so
every return rebuilds the board — and it was the shape the evidence comment
pointed at. Keeping the plane mounted would have meant keeping every Home chat
plane and file editor mounted behind an open ticket (against VC-338's
deliberate decision), and re-homing the board's automation-cache refresh, which
today is triggered precisely BY that remount. With the mount itself down from
5.8 s to 366 ms at ten thousand cards and from 265 ms to 205 ms at the owner's
scale, the remount is no longer worth that trade. Recorded as a decision, not
an oversight.

## The sidebar: the fixture cannot ask the question

| Interaction | before | after |
|---|---|---|
| Sidebar open/close, `real` | p50 1,454.1 ms / p95 2,118.3 ms, close 1,095.5 / open 348.1, 56 dropped, frame p95 18.5 ms | p50 1,370.1 ms / p95 2,353.0 ms, close 1,047.7 / open 333.6, 37 dropped, frame p95 18.6 ms |
| Active / Previous band rows | — | **0 / 0** |

**The `real` fixture's Session bands are empty, in every repetition.** The
fixture stamps every row from a fixed `BASE_TIME` of 2025-01-15
(`fixture.mjs`), and the Previous band already drops anything older than
`PREVIOUS_MAX_AGE_MS` — seven days (`sidebar/active-session-listing.ts`). At
1,198 Sessions, not one of them is inside that window.

Three consequences, all of them worth writing down:

1. **This ticket's sidebar half cannot be answered by the harness as it
   stands.** No bound was added to the sidebar, and the reason is that there is
   no measurement to justify one — not that a judgement was made without one.
2. **The Previous band is already bounded**, by age rather than by count. VC-116
   still owns the overflow-limit question, and it should be decided against a
   fixture that can actually produce a long band.
3. **The sidebar arm in `docs/performance-baselines/vc-353-owner-real/benchmark.md`
   measures an empty Previous band too.** Its 690 / 996 ms is the shell's
   animation and layout, not the cost of listing Sessions. Anyone reading that
   row as evidence about Session volume is reading it wrong.

Fixing that is a fixture change — Session timestamps relative to the run clock
rather than to a frozen `BASE_TIME` — and it is deliberately not made here: it
would move every Session-touching arm of the shared baseline at the same time,
which is a change that wants its own before/after rather than riding along
inside a board ticket.

## What was implemented

`components/board/column-window.ts` is the arithmetic, kept out of the DOM so
its rules can be asserted directly; `board-column.tsx` holds the hook and the
spacers. A column mounts a window around its scroll offset with a spacer
standing in for each end, and there are three rules that make that safe:

1. **The bound is on what is MOUNTED, never on what is HELD.**
   `SortableContext` still receives every id, so dnd-kit's sorting strategy
   indexes over the whole column; the count badge, the filters and the sort are
   the complete list. A column short enough to fit renders exactly the DOM it
   rendered before — `COLUMN_WINDOW_MINIMUM` is 40, so every ordinary project
   and every board e2e smoke is looking at an unwindowed board.
2. **A window may only GROW while a card is in the air.** dnd-kit keeps a
   measured rect per registered droppable and the strategy indexes it by
   position; a card unmounting mid-gesture would take its rect out from under
   that, which is the measurement churn that took this board out once already
   (VC-221, `Maximum update depth exceeded`). Auto-scrolling toward an
   unmounted card still brings it in; nothing already measured goes away. The
   union is discarded on drop.
3. **A selection outside the window scrolls the column to it**, rather than
   widening the window to reach it. Widening to row 1,500 would mount fifteen
   hundred cards and still leave the card off screen — an `aria-pressed` node
   nobody can see. Scrolling mounts it through the ordinary path and actually
   shows it.

The dropzone's ref is one stable callback rather than an inline arrow, for the
same reason rule 2 exists: React calls a ref callback whose identity changed
with `null` and then the node, so an inline one would unregister and
re-register the droppable on every render of the column.

## What was NOT measured

No first-mount arm (cold launch already covers the board's first paint, and
the stutter this ticket was opened for is the return); no loaded arm, so every
number here is the idle one; no owner-machine re-take; no measurement of a
board mid-drag at ten thousand cards, which the monotonic window makes a
bounded worry rather than an unbounded one but does not make free. Keyboard
drag across a window boundary is covered by the mount rules and by unit tests,
not by a measured gesture.
