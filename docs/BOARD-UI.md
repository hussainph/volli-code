# Board UI reference

The kanban board's design system and architecture decisions, fixed on branch
`feat/kanban-ui` (2026-07-11). Read this before touching anything under
`apps/desktop/src/renderer/src/components/board/`. Product-level board
semantics (what the columns *mean*, automation rules) live in
[CONCEPT.md](./CONCEPT.md) — this doc covers how the UI is built.

Design lineage: a simplified **Linear** issue board, with **Vibe Kanban** as
the kanban-for-agents shape reference. Motion follows the Emil Kowalski
school: ease-out everything, UI durations under 300ms, transform/opacity
only, animation frequency decides animation existence.

## Scope of the scaffold

Ships: five fixed columns, Linear-style cards, drag & drop, filter bar,
empty-column auto-hide, selection, non-destructive card context menu, inline
add-card.
Doesn't ship (lands with later layers): SQLite persistence, agent-state
badges (Needs Review reason, live-agent pulse, behind-base), ticket detail
view, keyboard navigation between cards, WIP limits.

Demo data: `lib/demo-tickets.ts` seeds ~11 tickets per project on first
board open (`ensureSeeded`). Delete that file with the SQLite ticket layer.

## Layout system

```
Board (flex min-h-0 flex-1 flex-col)
├─ BoardHeader   px-4 py-3 — title · count · FilterBar
└─ canvas        flex min-h-0 flex-1 items-start gap-3 overflow-x-auto px-4 pb-4
   ├─ BoardColumn ×shown   w-72 flex-none max-h-full min-h-0 flex-col rounded-lg bg-muted/40
   │  ├─ header  px-3 pt-2.5 pb-2 — label (13px medium) · count (mono xs muted)
   │  ├─ body    flex-1 min-h-0 overflow-y-auto px-2 pb-2 gap-2   ← the ONLY vertical scroller
   │  └─ footer  + New ghost button ⇄ inline composer
   └─ CollapsedColumnRail  w-44 flex-none — "Empty" caption + pills
```

Scroll contract: the **canvas** is the only horizontal scroller; each
**column body** is the only vertical scroller; the page itself never
scrolls. Columns are `items-start` children capped by `max-h-full`, so short
columns hug their content and long ones scroll internally.

## Card anatomy (user decision: Linear-standard)

Row 1: ticket id (`font-mono text-[11px] text-muted-foreground`) ·
`PriorityIndicator` right-aligned. Row 2: title (`text-sm font-medium
leading-snug line-clamp-2`). Row 3 (when tags exist): `TagChip` row.
Surface: `rounded-lg border border-border bg-card px-3 py-2.5`, hover
border `#333333`, selected `ring-1 ring-primary/70 border-transparent`.

`TicketCardContent` is pure presentation; `TicketCard` wraps it with
useSortable + ContextMenu. The drag overlay reuses `TicketCardContent`
directly — keep it prop-driven and side-effect free.

### Priority indicator

Linear-style 3-bar signal glyph (1/2/3 bars filled for low/medium/high),
NOT the Swift app's colored dot — a medium-orange dot reads as the ember
brand accent (`--primary #e8652A`). Current fills: low `#7d8ca3`, medium
`#b8935f`, high `var(--destructive)`; unfilled `#3a3a3a`.
**Flagged for a design pass** — these hexes are placeholders chosen to stay
out of ember's lane, not blessed tokens.

## Empty-column auto-hide (user decision: always on)

- Hidden set = statuses with zero **visible** (post-filter) tickets, in
  column order. Hidden columns render as pills in the rail; shown columns
  render in full. A status is never both.
- **Frozen-during-drag invariant**: the hidden/shown split is snapshotted at
  `onDragStart` and held until drop, so columns never collapse or expand
  under the pointer. The set recomputes on drop — that's when an emptied
  column collapses or a filled pill expands.
- During a drag, all pills brighten (affordance); the hovered pill gets
  `ring-1 ring-primary/60 bg-accent`. Dropping on a pill sends the card to
  that column's end and the column expands in place.
- Clicking a pill expands that empty column directly into its focused inline
  composer. Escape or an empty blur closes it and restores the pill.
- **No width tween** on collapse/expand — layout snaps at the drop moment
  (user-initiated commit reads as responsiveness) and the entering
  column/pill plays a 200ms opacity+scale enter instead. FLIP everything on
  the canvas is the future-polish path if this ever feels abrupt.

## Filters (user decision: all four facets)

Search (title OR id, case-insensitive substring) · Priority · Label ·
Harness, as chips with `DropdownMenuCheckboxItem` multi-select. Facets AND
together; values within a facet OR (`@volli/shared` `ticket-filter.ts` owns
the semantics — components never reimplement predicates). Filter state is
per-project and **session-only** (deliberately not persisted; a stale
invisible filter after relaunch is worse than re-picking one). The Label
chip hides itself when the project has no tags. "Clear" appears only while
`isFilterActive`.

## Drag & drop

- **Id scheme**: card draggable id = ticket id (`"VC-12"`); column droppable
  id = `column:<status>` — used by BOTH the column body and its collapsed
  pill (only one is ever mounted per status).
- **Collision**: `pointerWithin` first (precision for narrow pills / tall
  columns), `closestCorners` fallback (fast flicks between rects).
- **Preview-then-commit** (deliberate divergence from the project rail's
  live-commit pattern): `onDragStart` snapshots the ticket array;
  `onDragOver` applies the shared pure `moveTicket` to the snapshot;
  `onDragEnd` commits the final position to the store exactly once;
  `onDragCancel` discards. Why: the store persists to localStorage on every
  set (a live-commit drag would write dozens of times), `updatedAt` should
  bump once per user action, and cancel must be able to revert a
  cross-column move.
- Drop resolution is pure and tested: `board-dnd.ts` (`resolveDrop`,
  `ticketPosition`) — in the coverage gate's include list. Over a card
  resolves to that card's slot (with moveTicket's remove-then-insert this
  reproduces `arrayMove`); over a column droppable resolves to column end
  (clamped by `moveTicket`).
- Sensors: `PointerSensor` distance 4 (clicks/context-menu stay clicks) +
  `KeyboardSensor` with sortable coordinates.

## Motion rules

| Interaction | Treatment |
| --- | --- |
| Overlay lift | `scale-[1.03] shadow-lg shadow-black/40`, instant |
| Drop settle | 200ms `cubic-bezier(0.32, 0.72, 0, 1)` (= `--ease-swift`) |
| Sibling shift during drag | 180ms `cubic-bezier(0.23, 1, 0.32, 1)` |
| Card hover border | 150ms ease-out, border-color only |
| Column/pill enter | 200ms opacity + scale-from-0.98 via `starting:` — **only** when appearing on an already-mounted board, never on board open (many-times-a-day action ⇒ no animation) |
| Selection ring, composer | Instant (frequent, user-focused actions) |
| Source card while dragging | `opacity-40`, no transition |

Reduced motion (`useReducedMotion` hook + `motion-reduce:` variants): drop
animation off, sortable transitions off, enter scale off — opacity fades
stay. Transform/opacity only throughout; nothing animates width, height, or
layout.

## Data layer

`stores/board.ts` — per-project `ticketsByProject` persisted to
localStorage key `volli:board` (v1, partialized to scaffold metadata + tickets);
`filterByProject` session-only. All mutations delegate to `@volli/shared`
pure ops (`moveTicket`, `setTicketPriority`, `createTicket`,
`nextTicketNumber`) and use their same-reference returns as no-op guards.
`removeProject` calls `board.forget(id)`.

SQLite swap path: replace the store's internals (seed → SELECT, mutations →
UPDATEs via IPC) behind the same action surface; the shared ops and every
component stay untouched.

Cutover policy: localStorage records carry `persistenceKind: "demo-scaffold"`.
They are disposable preview state, not SQLite migration input. The SQLite
ticket layer must start from its own fresh database and remove the `volli:board`
key after a one-time in-app notice; no demo or preview edits are silently
imported as real tickets.

Ticket deletion is intentionally absent until the Archive and its explicit
discard flow land (Concept decision #16).

## Open items

- Priority indicator colors need a real design pass (see above).
- FLIP canvas reflow on collapse/expand and filter toggles.
- Agent-state card badges (reason badge, live pulse, behind-base) — land
  with the automation layer, top row right slot is reserved for them.
- Ticket detail view; keyboard card navigation; WIP limits.
