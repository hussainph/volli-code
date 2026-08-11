# UI cleanup pass v1

The running ledger for the `ui/cleanup-pass-v1` branch. Design phase is done and
committed (`5f632454`, six lab scratches); this file tracks the implementation.

**The scratches are the design of record.** Where this doc and a scratch disagree
about a pixel, a delay or an order, the scratch wins — it is what was reviewed.
Where the user's later notes and a scratch disagree, the notes win, and every
such override is written down below.

## Status

| # | Task | State |
|---|------|-------|
| 1 | Icon-weight audit learnings | not started — runs LAST, it sweeps every file |
| 2 | Sidebar: hover reveal + row anatomy + ghosting + scrollbar | not started |
| 3 | Session-start controls + shortcuts | not started |
| 4 | Fullscreen placement, planned against `ui/right-sidebar-fixes` | **planned** — `docs/plans/fullscreen-placement.md`; blocked on that branch landing |
| 5 | Ticket composer, ported from Paper | not started |

Split tabs (`split-tabs.tsx`) stays a lab scratch. Drag-and-select in split view
has bugs the user wants to work through separately; do not implement it here.

## Overrides the user gave after the scratches were reviewed

- **Hover dwell 20ms, exit grace 375ms.** The scratch opens on 100/220. The rail
  is thin, so a long dwell makes the sidebar feel unreachable; a long grace is
  what stops it snapping shut when the pointer clips a corner.
- **A sliver, shown only while the workspace rail is visible.** With the rail
  hidden the whole window edge is the target and needs no hint. With the rail
  shown the remaining strip is thin enough that the user has to aim, and the
  sliver is what they aim at.
- **Ghost at 0.80**, not the scratch's dial default.
- **No broom on cleaned rows.** The ghosting *is* the signifier; a second one is
  clutter. (User: "trust the user knows the filter is on".)
- **⌘T starts a global chat session** — not a ticket-scoped one.
- **Composer scope: craft + branch row.** Paper's layout, the harness picker
  moved out of the footer into the chip row, and a real `base → new worktree`
  row wired to actual git refs. Automation presets are NOT in scope.

## Corrections the work turned up

- **There is no fullscreen button.** `useFullScreen` is read-only; it exists so
  the traffic-light spacer can collapse. Issue 5's control is *terminal focus*,
  an in-app zen mode. See `fullscreen-placement.md`.
- **The branch-listing verb the composer needs already exists** — it does not
  have to be built. Confirm what it returns before adding anything.

## Rules for this branch

- Subagents never commit, never stash, never checkout. The orchestrator commits.
- `vp fmt` — never Prettier. Then `vp lint`, `vp run -r typecheck`.
- `vp run -r test:coverage` is a separate gate and CI runs it. A green
  `vp run -r test` says nothing about it.
- Verify in a real browser. Three bugs in the design phase passed typecheck,
  lint and review while rendering broken; none were reachable from types.
- Commit at every green cycle so a usage reset loses nothing.

## Carried items — outside any scratch, easy to lose

- `new-session-menu.tsx` lines 66–73 list Terminal above Chat → flip to Chat, Terminal.
- `CLAUDE.md` context-menu line: drop `(weight="fill")`, keep the icon requirement.
- `tracking-widest` belongs out of `DropdownMenuShortcut` / `ContextMenuShortcut`.
- `aria-pressed` used decoratively in four places, incl. `ticket-tabs.tsx:385`.
- ⌥⌘B at `use-nav-history.ts:176` fires globally with no ticket gate.
- `SplitDivider` ignores `uiScale`.
- `compactAge` → `"now"`; the cross-year `"Dec 6, 2025"` form overflows the age column.
- `SidebarResizeHandle`'s `null`-on-collapsed early return, plus the dead
  collapsed-nav code (`primary-sidebar.tsx` ~101–123, `NavList collapsed`,
  `COLLAPSED_NAV_WIDTH`, `--sidebar-width-icon`).
