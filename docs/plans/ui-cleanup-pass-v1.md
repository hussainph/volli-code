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
| 1 | Icon-weight audit learnings | in progress — runs LAST, it sweeps every file |
| 2 | Sidebar: hover reveal + row anatomy + ghosting + scrollbar | **done** — `3a1e6bff` |
| 3 | Session-start controls + shortcuts | **done** — `58797fcb` |
| 4 | Fullscreen placement, planned against `ui/right-sidebar-fixes` | **planned** — `docs/plans/fullscreen-placement.md`; blocked on that branch landing |
| 5 | Ticket composer, ported from Paper | **done** — `6daf4e09` |

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

All of the original list is done except `SplitDivider`, which never depended on
this work. What remains is what the implementation itself turned up.

**Still open**

- `SplitDivider` ignores `uiScale` (in the shipped split layout, not the shelved
  split-tabs scratch).
- **Dead, and deletable as one change**: `components/ticket/ticket-session-actions.tsx`
  and `components/sessions/new-session-menu.tsx` now have zero app callers. They
  survive only because `lab/scratches/session-start-controls.tsx` imports them as
  its "shipped today" baseline. Delete them together with those baseline
  sections — it costs the scratch its before/after comparison, which is why it
  did not happen automatically.
- **Dead by selector**: nothing now uses `collapsible="icon"`/`"offcanvas"`, so in
  `components/ui/sidebar.tsx` the `SIDEBAR_WIDTH_ICON` constant, every
  `group-data-[collapsible=icon]:*` variant, `data-slot="sidebar-gap"`,
  `data-slot="sidebar-container"`, the `tooltip` prop on `SidebarMenuButton` and
  the `toggleSidebar({instant:true})` machinery are all unreachable. It is a
  vendored file; the deletion is clean but standalone.
- The ghost **indent** never rendered. `globals.css` forces
  `padding: 0.5rem !important` / `height: 2rem !important` on every expanded menu
  button, and the row-anatomy scratch sets that attribute too — so what was
  reviewed as "ghost + indent" was always ghost alone. Shipping the indent means
  relaxing those rules, which changes every sidebar row's height.
- Terminal focus (`data-volli-shell="focused"`) is **code-verified only** — the
  lab mounts no PTY. Wants a local desktop smoke.
- `docs-shots.mjs` and `ticket-detail-smoke.mjs` were edited but not run. CI does
  not run desktop smokes, so nothing else will catch it.

**Live judgement calls, easy to reverse**

- Composer at 576px wraps the branch pair to a second right-aligned line; Paper's
  mock fits one line only because its chip reads "Explore" and ours reads a real
  harness name. Widening the collapsed dialog is the alternative.
- Sidebar pinning now persists (`sidebarPinned`). Revert = delete the field and
  hold it in `AppShell` state.
- No attention mark on the sliver — it would vanish whenever the workspace rail
  is hidden, which is worse than not having it.
- "Starting…" dropped from the Sessions empty state; dimming is now the single
  vocabulary for a booting Session.

**Unrelated, noticed in passing**

- The Monaco description area renders as a bluish-slate slab against the warm
  composer dialog once the editor mounts. Editor theme, not layout. May be
  lab-only, since the theme derives from the canvas at runtime — worth one look
  in the real app.
