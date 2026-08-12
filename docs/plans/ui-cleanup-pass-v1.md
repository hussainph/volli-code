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
| 1 | Icon-weight audit learnings | **done** — see the count below |
| 2 | Sidebar: hover reveal + row anatomy + ghosting + scrollbar | **done** — `3a1e6bff` |
| 3 | Session-start controls + shortcuts | **done** — `58797fcb` |
| 4 | Fullscreen placement — the terminal-focus / rail-toggle swap | **done** — `docs/plans/fullscreen-placement.md` |
| 5 | Ticket composer, ported from Paper | **done** — `6daf4e09` |

Split tabs (`split-tabs.tsx`) stays a lab scratch. Drag-and-select in split view
has bugs the user wants to work through separately; do not implement it here.

### The icon sweep, counted rather than estimated

"58 to outline, 15 keep fill" was a planning estimate and was never true of the
tree. The measurement anyone can rerun is
`grep -rn 'weight="fill"' apps/desktop/src/renderer/src`, which stands at **22**
sites. They fall into four groups, and only the last is unfinished:

- **The one that went wrong.** Denied / blocked / errored marks in the
  transcript and the rail — `chat/activity-ui.tsx` ×3, `chat/interaction-ui.tsx`
  ×3, `chat/chat-plane.tsx`, `ticket/rail-panel-parts.tsx`,
  `theme/canvas-editor.tsx`, `ticket/ticket-changes-panel.tsx`,
  `board/ticket-card.tsx` — plus the stop square in `chat/composer-ui.tsx`. Each
  is the exception among its neighbours, which is what the rule asks fill to
  mark.
- **Filled by definition.** `ui/context-menu.tsx`'s radio dot, and
  `ticket/ticket-repository-summary.tsx`'s GitHub mark, which is a brand logo
  and not an icon this app draws.
- **A four-icon toast vocabulary.** `ui/sonner.tsx` ×4: success / info /
  warning / error. A toast has no neighbours to be the exception among, and the
  filled disc is the whole type signal.
- **Dead, not deliberate.** `ticket/ticket-session-actions.tsx` ×2 and
  `sessions/new-session-menu.tsx` ×2 — the four in the two zero-caller modules
  listed under "Carried items". They go with those files, not with a sweep.

## Round two — the live-app nitpicks

Nine defects found by running the built app, plus one parity mandate added
mid-round. Fanned out across six agents partitioned by file ownership.

| # | Defect | Owner |
|---|--------|-------|
| 1 | Toggle-open animation clips the workspace rail; animation cost | sidebar |
| 2 | An empty chat counts as a live Session and blocks archive | liveness |
| 3 | `+Chat` wears a tab's silhouette in dark mode | tabs |
| 4 | The Calm Stack rail was merged with the old rail, not reproduced | rail |
| 5 | Composer offers unauthenticated models; first send hits the wrong one | chat |
| 6 | The composer keeps its text after a successful send | chat |
| 7 | ⌘T / ⌥⌘T should resolve against context, not always globally | tabs |
| 8 | Terminal focus sits on the chrome band; wrong surface | tabs |
| 9 | Sidebar ticket ids render in Mona and blend into the row | sidebar |
| — | Terminal focus is ticket-only; chat and terminal diverge across surfaces | tabs |
| — | "The app is starting to feel really sluggish and slow" | perf |

### Decisions the owner settled before the round started

- **`+Chat` moves to a trailing action cluster**, past a divider at the strip's
  right edge. Tabs own the left, actions own the right. Distance is half the
  fix; losing the tab silhouette is the other half.
- **Terminal focus moves onto the terminal pane** — a hover-revealed control in
  the pane's own corner. It acts on that pane, so it lives on it, and it cannot
  then appear where no terminal is. Exit stays in the band — not, as first
  argued, because zen leaves no chrome to host it (the pane is still there and
  could), but because in zen the user is driving a PTY from the keyboard, and a
  hover-revealed control is not a way out of a mode.

### Decisions this round reverses

- **⌘T is now context-sensitive.** `new-session-shortcut.ts` documents the
  opposite — "the alternative … was drawn and rejected" — on the grounds that a
  chord meaning two things is a chord you have to look up. The owner has
  overruled it: inside a ticket the chord starts a Session on that ticket. The
  doc comment gets rewritten rather than left arguing against its own code.
- **Two reveal gestures, two animations.** The toggle returns to the old
  layout-participating push; hover keeps the overlay slide the owner likes. One
  animation for both is what put the panel over the workspace rail.
- **Liveness is not `exitCode === null`.** That predicate is a fair proxy for a
  shell and meaningless for a chat, which has no process and so is live
  forever. Archive gates on an agent loop actually running.

### Where the diagnoses were wrong

Worth keeping, because in four of these the reported symptom was real and the
cause named in the report was not. Reading the code first would have produced
four wrong fixes.

- **The archive refusal was not in the renderer.** `exitCode === null` in
  `ticket-context-menu.tsx` was already terminal-only and already correct — chats
  never enter that store. The refusal came from main, where a *binding* counted
  as busy, and `adapter.release` had no production caller, so one chat pinned a
  worktree for the life of the process. Its comments claimed the renderer
  conflation, which is how the wrong file got blamed.

  Both halves are closed now, but they were closed a round apart, and only
  moving the predicate shipped first. Gating on `turnActive` stopped the false
  refusal while leaving the binding itself to leak — so a destroy then *passed*
  the gate and left a live chat aimed at a directory that no longer existed.
  `worktree/agent-sites.ts` is the second half: every binding rooted at the
  checkout is released immediately before `git worktree remove`, on all three
  destroy paths. Release is best-effort by design — refusing a delete on a
  failed release would rebuild the unremovable worktree this whole item began
  as, since the force step is only reachable from the dirty refusal.
- **The sidebar's old animation was never replaced.** The content push still
  runs; the card animates 326→68 exactly as before. The defect was the travel —
  both reveals parked a full window's width away and slid in unclipped over a
  transparent, unlayered rail.
- **The ticket id was already `font-mono`.** `text-label` bakes in +0.05em
  tracking, which gives up the one property anyone wants from a monospace face,
  and there was no column to line up in.
- **Theme switching is not derivation.** Tokens land in under 7ms at any scale.
  The ~400ms is a deliberate 300ms crossfade, inside which 331ms is style
  recalculation, because the transition is declared on
  `:root, :root *, :root *::before, :root *::after`.

### Two fixes that looked right and were not

Both passed review and typecheck while rendering wrong; only a browser caught
them. This is the third round in a row that has happened.

- `clip-path` on the panel **rides the panel's own transform**, so it clips
  nothing — 20 of 20 sweep positions still put ink on the rail.
- `clip-path` on the wrapper **forms a backdrop root**, silently killing the
  peek's `backdrop-blur-2xl`. An oversized `overflow-hidden` box does both jobs
  and neither harm.

### Measured outcomes

| | before | after |
|---|---|---|
| Sidebar pin/unpin toggle, script | 98.8ms | 6.3ms |
| 600 pointer moves, forced layouts | 599 | 0 |
| `AlertDialog` fibers at 150 tickets | 360 | 14 |
| Whole-window fibers at 150 tickets | 10,039 | 7,619 |

The dialog hoist removed 24% of the tree for ~10ms of render time — a closed
dialog is a cheap subtree, and the per-card mass is the card body and
`useSortable`. What it bought outright: opening a confirm at 150 tickets costs
0ms of long task with the board at zero renders behind it.

The 1620ms sidebar-drag figure that started the performance thread is gone, and
not from the dialog work — the `pointermove` fix removed the state writes, so
that drag now produces one commit and zero attributed renders.

### Still open

- **The stored default model is still `azure-openai-responses`.** Code cannot
  repair it silently and no agent may write to the live DB. One visit to
  Settings fixes it; until then new Sessions record Azure, but now say so
  before a message is spent rather than after.
- **The rail card is still flat in light mode.** The token question is settled —
  the lift wants `var(--shadow-raised)`, the generated tier-1 shadow, and
  `ticket-right-sidebar.tsx` now carries that instead of the invalid
  `hsl(var(--foreground)/0.06)` it was reviewed with (`--foreground` is a hex, so
  the browser dropped the whole declaration). What is left is porting it into
  `ticket-repository-summary.tsx`, whose comment still argues for the flat card.
- **`lab-boot-check` has never once run.** It pointed at port 5178 for its whole
  life and `pnpm lab` serves 5174, so the guard added because "the browser is the
  only witness" has witnessed nothing. The port and the browser lookup are fixed;
  the four scratches it names are unverified until someone runs it.
- **The context menu is now the remaining per-card Radix mass** — 310
  `ContextMenu` + 165 `Popper` fibers at 150 tickets. Hoisting it means
  replacing Radix's `Trigger` with a board-level menu positioned from the
  pointer event. Real redesign, real behaviour risk.
- **Nothing guards the dialog host's memo.** The win rests on `children` being a
  prop and the context value memoizing on the destructured guard. Inlining the
  JSX or widening that dependency evaporates it silently, and the renderer's
  node-env harness cannot catch it.

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
- **Composer scope: craft + branch row.** Paper's layout, the harness picker
  moved out of the footer into the chip row, and a real `base → new worktree`
  row wired to actual git refs. Automation presets are NOT in scope.

## Corrections the work turned up

- **There is no fullscreen button.** `useFullScreen` is read-only; it exists so
  the traffic-light spacer can collapse. Issue 5's control is *terminal focus*,
  an in-app zen mode. See `fullscreen-placement.md`.
- **Terminal focus now has a chord: `⌥⌘Return`**, both directions, mirroring
  `⌥⌘B`. It belongs to task 4 rather than task 3 — task 3 *creates* a Session,
  this *views* one already open.
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
## Desktop smokes — run locally

CI does not run these. Run before shipping: `pnpm run build`, then each of
`ticket-detail-smoke`, `composer-basics-smoke`, `composer-kickoff-smoke`,
`ticket-rail-shots`, `docs-shots`, `terminal-smoke`, `memory-smoke`,
`park-smoke`.

**What is actually evidenced:** all eight passed on `c08ad8aa`. That SHA is now
~20 commits back, and `ticket-detail-smoke`, `composer-kickoff-smoke` and
`pi-ticket-chat-smoke` have all been edited since (`93e86903`, `16ccb956`,
`bba9169e`, and the review round after them). **No recorded run covers the
current tree** — this list is what to run, not a claim that it is green. Rerun
and replace this paragraph with the SHA it passed on.

`ticket-detail-smoke` step 6b covers terminal focus in both directions — button
in, button out, then ⌥⌘Return in and out — plus the band control appearing and
disappearing with the active tab's kind. The `data-volli-shell="focused"` path is
no longer code-verified only. Its check 6 also carries the one positive
assertion that a Session resolves its harness truthfully: since the Calm Stack,
neither the rail's roster nor its History prints a harness name (History keeps
the label only as a search key), so the sidebar's ACTIVE band second line is the
only surface left that does.

`docs-shots` rewrites `apps/docs/src/assets/screenshots/` from the running app —
expect a diff there after any chrome change, and commit it. It was last rerun in
`0a8870fb`, which is after the chrome swap, so `board.png` and
`ticket-workspace.png` are current.

**Deleted with the review round**: `ui-cleanup-shots`, `lab-rail-compare` and
`session-start-control-shots` were one-shot contact sheets hard-coded to this
branch's five tasks, and one said so in its own header. Their job was to be
looked at once. `lab-boot-check` stays — it is the "the browser is the only
witness" guard, it is not branch-specific, and it now points at the port
`pnpm lab` actually serves (5174, not 5178) and finds a Chromium rather than
assuming one path.

**Live judgement calls, easy to reverse**

- **Two ≤12px glyphs in the tab strip went to `bold`, not `regular`.** The audit's
  per-site verdict for `session-tabs.tsx` says regular, but its clause 5 ("bold is
  the small-size tier") and its own tier study both bite at this size, and the
  sidebar's kind glyph — the same ChatCircle at the same 12px beside the same
  `text-xs` label — already ships bold. Leaving the strip at regular would draw
  one glyph two weights on two adjacent surfaces. Revert = `weight="bold"` →
  no prop at `session-tabs.tsx:380` (Moon, 10px) and `:473` (ChatCircle, 12px).
- **Three transcript receipts the audit never listed went to outline**:
  `activity-ui.tsx` `AttentionReceipt` (both branches) and
  `interaction-ui.tsx` `InteractionReceiptLine`. A receipt records a decision
  already made; the row or card above it wore the filled mark, and ink still
  separates allowed from denied.
- **`canvas-editor.tsx:910` keeps its fill** — a `role="status"` contrast alert on
  `text-primary-text`, the same shape as the permission card's Warning.
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
