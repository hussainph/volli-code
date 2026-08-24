# VC-87 Slice D — the local usage surfaces

Design pass for the app-side read surfaces. The ledger, the projection and
`reportSessionUsage` already exist (Slices A and B); this document decides what
a person sees, and nothing here changes what is recorded.

> **Slice C landed after this design.** The CLI was deferred here and then
> shipped in response to review: `volli cost` and the token/cost columns on
> `volli session list` are the ticket's first two deliverables, and the branch
> could not close without them. The rules below still govern the rails; the
> CLI's own notation is documented in `packages/cli/src/render.ts` and quotes
> the same hedge, because the two surfaces quote the same money.

## Scope decisions taken with the owner

Three surfaces the parent plan proposed are **cut**, and the cuts are the shape
of this design rather than omissions from it:

| Proposed | Ruling | Consequence |
| --- | --- | --- |
| Chrome band trigger + global card | **Cut** | The 36px drag band keeps its empty trailing slot. There is no cross-project view; the widest scope is one project |
| Composer running-cost pill | **Cut** | The footer is untouched. The context meter remains the only meter beside the turn |
| Global by-model rollup | **Rehomed** | Lives in the Home rail, scoped to the project |

The through-line: **cost lives where work lives, and only in the rails.** No
window chrome, no per-turn control. A reader goes looking for money; money does
not come looking for the reader.

## What the data can and cannot say

Everything below is drawn from `SessionUsageSummary`
(`packages/shared/src/session-usage.ts`). Four facts govern every drawing:

| Fact | Consequence for the UI |
| --- | --- |
| Token classes are separate and non-overlapping | A breakdown has exactly four parts: uncached input, cache read, cache write, output |
| `costUsd` is per **operation**, never per token class | **No cost-weighted breakdown is derivable.** A bar split by spend would have to re-price tokens from a catalogue, which the architecture refuses |
| `knownCostUsd` is null when nothing was priced | `—`, never `$0.00` |
| `costBasis` may be `mixed`, `costCoverage` may be `partial` | The headline needs hedging notation, and it must cost one glyph, not a sentence |

`cachedInputShare` is the most actionable number in the feature — CONTEXT.md
calls a falling share "an operational incident rather than a curiosity". It
earns its place beside the cost on every surface.

## Hedging notation — one glyph, not a sentence

Six representable states, rendered with at most one character of hedge. The
words live in the popover; the readout stays readable.

| State | Renders | Why |
| --- | --- | --- |
| `provider-reported`, complete | `$8.42` | The only case that may print bare |
| `catalog-estimate` or `mixed`, complete | `~$8.42` | **`~` already means "estimated" in this app** — the context popover marks every estimated count with it. Reused, not invented |
| any basis, `partial` | `~$8.42+` | `+` is "at least this much"; the popover names the denominator |
| `unavailable` | `—` | Never `$0.00` |
| no metered operations | *absent* | The block does not render. Matches the context pill, which is absent until a first reply is metered |
| tokens but no price | `184k` | Token count carries the surface when money cannot |

## The token bar

One shape at two sizes, replacing what would otherwise be four rows of numbers
nobody compares by reading.

```
▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▓▓▓▓▓▓▒▒▒▒░░░░
└─ cache read ────────────────────┘└ in ─┘└ w ┘└ out ┘
```

**It is a token bar and says so.** Because cost cannot be split by class, a
reader seeing "78% cached" beside "~$12.48" could infer that 78% of the *spend*
was cache — which is false and backwards, cache reads billing at roughly a
tenth. So the bar is labelled in tokens, the caption reads in tokens, and the
word "cost" never appears on the same line as the bar.

Colour follows the **context grid's precedent** (`context-usage-ui.tsx` already
maps a non-status breakdown onto the semantic family) rather than inventing a
palette:

| Class | Token | Reading |
| --- | --- | --- |
| Cache read | `bg-info` | The cheap majority — good news, and usually most of the bar |
| Uncached input | `bg-primary` | Full price, and the part prompt design controls |
| Cache write | `bg-attention` | The 1.25–2× premium |
| Output | `bg-positive` | What the spend bought |

A stacked bar rather than a donut, on the `ui-ux-pro-max` chart rule:
part-to-whole above a handful of slices reads better as a stacked bar with a
legend, and a donut of four unbounded quantities implies a ceiling that does not
exist.

**It is not the context grid**, and the difference is load-bearing. That grid is
100 cells because the window is bounded and `free` is the number it protects.
Cumulative usage has no denominator and no free space; drawing it as the same
object would promise a ceiling the Session does not have.

Height 8px, `rounded-full`. A class contributing less than one rendered pixel is
folded into its neighbour rather than dropped — the parts must sum to the whole.

The gutter between classes is an **open detail for the lab**: abutting segments
read as one object, a hairline `gap-px` separates them, and the context grid
precedent is `gap-0.5`. `check-design-tokens.mjs` gates radius, type, status
palette, shadow and focus ring — not spacing — so this is settled by looking at
it, against DESIGN.md's rule that sub-ladder `px` is hairline alignment rather
than spacing rhythm.

## Surface 1 — Home rail, Now page

Usage is **a property of each scope, not a section of its own.** Two blocks both
headed "Usage" on one page would be a collision; instead the page's three
headings each name a scope, and cost is one of the facts that scope carries.

```
  VENUE
  ┌────────────────────────────────────┐
  │ volli-code/VC-87-ax-cost-telemetry │
  │ ⑂ volli/VC-87-ax-cost…      ● 3    │
  └────────────────────────────────────┘

  SESSION
    Model              claude-opus-4-1
    Effort                        high
    Activity                 ● Working
    Cost                        ~$0.42
    Tokens                        184k
    Cached input                   78%

  PROJECT
  ┌────────────────────────────────────┐
  │ ~$12.48                    30d ⌄   │
  │ ▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▓▓▓▓▒▒░░░        │
  │ 4.6M tokens · 78% cached           │
  │                                    │
  │ Claude Opus 4.1             ~$8.10 │
  │ GPT-5.3 Codex               ~$3.42 │
  │ Gemini 3 Pro                ~$0.96 │
  │                                    │
  │ 38 sessions · 24 metered           │
  └────────────────────────────────────┘
```

### Session block

The three cost facts append to the existing `<Fact>` list in `SessionFacts`,
inside the chat case only. They are not a new component and not a new heading.

- **Terminal tabs render none.** A manual companion runs models Volli never
  mediated; a row saying "unavailable" on the default rail is noise, not honesty.
- **Board and file tabs render none** — they are not Sessions.
- Before a first metered reply the three rows are absent, not zero.

### Project block

A card, matching `VenueCard`'s treatment (`rounded-row`, `border-border`,
`bg-card`, `p-4`), because it groups a heterogeneous cluster — a hero figure, a
bar, a ranked list and a footnote — where the Session block is a flat `<dl>`.

- **Window control** (`30d ⌄`) offers 7d / 30d / All, defaulting to 30d. A
  project's lifetime total only grows and stops being actionable; the recent
  window is the one an orchestrator can act on.
- **Models ranked by known cost**, top three, with a `+2 more` line when there
  are more. Not "favourite models" — ranked by what they cost.
- `38 sessions · 24 metered` keeps the gap visible. Counting only metered
  Sessions would make an honest gap look like a cheap project.
- Empty reads **"No metered model calls yet"**, never `$0.00`.

## Surface 2 — Ticket rail, Now page

A card between Properties and Sessions, answering the owner's question: *what
did this Ticket cost?*

```
  USAGE
  ┌────────────────────────────────────┐
  │ ~$3.18                  4 sessions │
  │ ▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▓▓▓▓▒▒░░           │
  │ 1.2M tokens · 81% cached           │
  │ Claude Opus 4.1                    │
  └────────────────────────────────────┘
```

The Ticket rail has no "session in front" block — it is Repository → Properties
→ Sessions roster. So **per-session cost for a ticket Session lives in this
card's popover**, which is exactly a by-session breakdown. That adds no block
and keeps the one-line roster rows intact.

```
┌──────────────────────────────────────┐
│  Ticket usage                 ~$3.18 │
│  Estimated · 34 of 36 operations     │
│                                      │
│  Cache read                    980k  │
│  Uncached input                142k  │
│  Cache write                    61k  │
│  Output                         38k  │
│ ──────────────────────────────────── │
│  Cached input share             81%  │
│                                      │
│  BY SESSION                          │
│  Wire the projection         ~$1.84  │
│  Cost basis mapping          ~$0.91  │
│  Backfill spike              ~$0.43  │
│  Terminal (claude)                —  │
└──────────────────────────────────────┘
```

- **No by-model list here.** The card already names the top model and the Home
  rail's Project block carries the full ranking. A second copy would be a second
  opinion about the same money.
- A Session with no metered operations still appears, at `—`. Dropping it would
  make the rows fail to add up to the total above them.
- At the 240px narrow floor the top-model line drops first, then the caption
  folds to two lines. **The bar never drops** — it is the cheapest information
  per pixel on the card.

## Surface 3 — Settings → Appearance → Display

A switch, `Show cost and token usage`, beside zoom and diff layout. Those three
are the same kind of preference: what this window puts on screen, app-wide, with
no bearing on what the app does.

**Not Settings → Telemetry.** That surface configures the developer OTLP export.
A reader who went there to stop a dollar figure appearing during a screen-share
would turn off an unrelated subsystem and still see the figure.

Stated as the positive, like General's project-switcher row — a switch reading
"Hide cost" that is ON when the number is absent is a double negative every
reader has to unpick. The hint carries the one thing a reader could otherwise
get wrong:

> Turning this off hides those readouts only — usage is still recorded, so
> switching it back on shows the full history.

That matters because hiding and disabling are different acts. Metering keeps
running, the ledger keeps recording, and nothing about the projection changes;
only the rails go quiet. A preference that silently stopped measuring would
leave a hole in the history that turning it back on could never fill.

Persisted app-wide through `app_state` (never `localStorage`), defaulting to
visible. Anything other than an explicit `false` — a missing key from an older
build, corrupt JSON — shows cost, so the feature can never go missing for a
reader who never turned it off.

## Surface 4 — Session rosters

**Untouched.** Those rows were deliberately reduced to one line, and status and
age outrank cost as navigation facts. Per-session cost is reachable from the
Ticket card's popover (ticket Sessions) and the Session block (the Home Session
in front), which is every Session there is.

`usage` still rides on `SessionListingRow` so a later surface reads one source,
but nothing renders it in this pass.

## How it is wired

| Layer | Where |
| --- | --- |
| Presentational blocks, pure over `SessionUsageSummary` | `components/usage/{usage-bar,session-usage-facts,project-usage-block,ticket-usage-block}.tsx` |
| Notation and bar geometry | `usage/usage-format.ts` |
| Store read, window state, preference gate | `components/usage/usage-rail.tsx` |
| Cache of rollups | `stores/usage.ts` |
| Channel, guard, handler, bridge | `ipc/contract.ts`, `main/ipc-descriptors.ts`, `main/data-ipc.ts`, `preload/index.ts` |

The split between the first row and the third is what keeps the UI lab honest:
the blocks take props, so the lab mounts the **real** components against fixture
operations rather than a reimplementation of them. A store read inside a block
would end that — the lab would need a seeded ledger to draw a card.

### Nothing polls

Usage changes when a turn settles, which the renderer already learns from the
Session stream. `useSettleSignal` derives one value from every chat Session's
lifecycle; the blocks re-read when it moves. A timer would spend an indexed read
every few seconds to be told nothing happened, on a feature whose whole argument
is that spend should be cheap to watch.

The signal is deliberately broad rather than per-Session: one settle changes the
Session's rollup, its Ticket's and its project's at once, and the Ticket card
aggregates a roster that can grow while it is on screen, so it cannot know every
id that could affect it.

### Verified in the running app

Against a copy of a real 379-Session profile, with the projection seeded:

- `volli:usage-report` round-trips; the guard refuses a bad scope arm and a NaN
  bound with `Invalid usage query` rather than reaching SQLite.
- The Ticket card renders `~$0.34 · 1 session · 724k tokens · 48% cached`, and
  its popover the four token classes, the cached share and the by-session
  breakdown.
- The Settings switch defaults on, persists across a full relaunch, and the
  card leaves and returns with it — no restart.

**A note for anyone who ran this branch before the merge:** `session_usage` has
been renumbered twice — it was 025 until VC-44's authority policy store reached
main first, then 026 until VC-118's Automations did. It is now **027**. Any
scratch profile that applied an earlier numbering sits at that `user_version`
and will fail with `table session_usage already exists`. Nothing shipped on
either number, so no real profile is affected — but a scratch database from an
earlier build of this branch has to be discarded rather than migrated.

### Open

- **The window selector does not persist.** It is a question someone asks, not a
  standing preference, and 30d is worth opening on every time. If it proves
  otherwise it belongs beside `railMode` in the UI store.

## Settled after review

- **`sessionCount` on the Project card** reads the durable per-project listing
  (`stores/project-sessions.ts`) — the same rows the sidebar's bands and ⌘K
  show. It was briefly the count of resident chat slices, which dropped every
  closed and terminal Session and counted other projects' as well, so
  `38 sessions · 24 metered` was two numbers about two different populations.
  The metered count is still the floor, because the listing can lag a Session
  whose first turn is already metered.
- **The Ticket popover lists every Session on the Ticket**, not only the metered
  ones — the union of the durable roster and the report's groups, with an
  unmetered Session at `—`. Passing the groups alone dropped every manual
  terminal companion and every chat that never reached a model, which is where
  the spend Volli did not mediate actually went.
- **The rollups always re-read on mount.** The store has one verb, `refresh`,
  and no read-through `ensure`: a rail unmounts on every page change while work
  goes on settling, and nothing invalidates behind it, so a cached answer would
  have been shown indefinitely and looked settled. `refresh` keeps the old
  figure on screen while it re-reads, so there is no flicker and no lie.
- **`costBasis: "unavailable"` is never called an estimate.** An unknown or
  custom provider API can report a finite cost Volli cannot vouch for; the
  popover reads `Unverified basis` and the CLI `unverified-basis`. The tilde
  stays — the figure may not print bare — but the words no longer claim this
  build priced it against a catalogue.
- **A window reaching behind the metering floor says so.** An existing profile
  has spend that predates the projection and no honest way to recover it, so
  migration 027 records where metering began and every report carries it.
  Deliberately not backfilled: settled transcripts are a biased sample of spend
  (a tool-only reply, a failed reply, a compaction and a title each cost money
  and settle nothing), so a backfill would be systematically low and
  indistinguishable from a complete answer.

## Rejected

- **A chrome-band trigger.** Owner's call: the drag band keeps its empty slot.
- **A composer cost pill.** Owner's call: the footer already wraps at narrow
  widths, and the context meter stays the only meter beside the turn.
- **A cost-weighted breakdown bar.** Not derivable — cost is per operation.
- **Reusing the 100-cell context grid.** It promises a ceiling that cumulative
  spend does not have.
- **A donut.** Four unbounded quantities, and the same false-ceiling problem.
- **Cost on every board card.** Noisy, weak for in-progress work, duplicates the
  Ticket rail.
- **Cost on every roster row.** Those rows already spend their second line on
  identity, attention and recency.
- **Settings → Telemetry.** That surface is OTLP export configuration; a billing
  report there merges two unrelated user tasks.

## What is covered

`usage-format.ts` is on the 100% coverage gate (`vite.config.ts`), and the tests
assert the sentences it must never print: no bare `$` on an estimate, no `$0.00`
for an unpriced report, no cost row for a Session nobody metered, no share
rounded down to `0%` when it is merely small. `stores/usage.ts` is at 100% under
`src/stores/**`. The IPC guard has its own suite covering every scope arm, an
unknown arm, non-finite window bounds, and the four legal groupings.

## States every surface must be tested at

Empty (no metered calls) · unavailable cost with known tokens · partial coverage
· mixed basis · single model · long model name · the 240px rail floor · light and
dark · reduced motion · a live reply updating the figure once, without a poll.

## Delivery notes

- One event-driven renderer store over the Session RPC usage query. **No
  polling** — the parent plan's exit proof is a live reply updating the Ticket
  card and the Session facts once, without reopening the surface.
- Prototype the Project card and the token bar in the UI lab
  (`renderer/lab/scratches/`) before wiring either to production, as the parent
  plan requires for any new rail block.
- A usage fact must not move `lastActivityAt`; telemetry arriving is not new
  agent work, and a rail that re-sorted its roster on a cost update would say
  otherwise.
