# Fullscreen placement — the swap

The controls trade lanes. The tab-strip corner takes the right-rail toggle; the
chrome band's right lane takes terminal focus, as one button whose glyph flips.

**Shipped, then half-reversed.** The Calm Stack landed (`07fd594e`) and this was
built on top of it. The line numbers below are the pre-Calm-Stack coordinates and
are stale; the reasoning is not. §"What shipped" records where the plan was
overruled at the time.

**Read §"The band kept the exit and gave back the entrance" before the plan
body.** The corner half held — the tab-strip corner is the details-rail toggle,
and that is what ships. The band half did not: terminal focus is no longer one
persistent button whose glyph flips. *Enter* moved onto the terminal pane; only
*exit* stayed in the band. Everything below that says otherwise — the second
Verdict bullet, step 4 of §"The change, in order", and the `TerminalFocusToggle`
line in §"Shipped" — describes a shape that existed for one round and is gone.

## First, the premise is wrong in a way that matters

**There is no fullscreen button.** `useFullScreen` (`hooks/use-fullscreen.ts`) is
read-only — it exists so the 78px traffic-light spacer can collapse. The control
this issue is about is *terminal focus*, an in-app zen mode scoped to one Session
tab (`CornersOutIcon` in `ticket-tabs.tsx:392`, `CornersInIcon` in
`chrome-bar.tsx:143`).

Two consequences. It does not duplicate macOS's green button, so "a second
fullscreen affordance has to earn its place" does not apply. And it is the *only*
way in or out — `ticket-detail.tsx:873–876` deliberately leaves Escape to the
PTY — so it cannot simply be deleted.

## Verdict

- **Yes — the corner suits the rail toggle better.** The tab strip is full-width
  *above both the main column and the rail* (`ticket-detail.tsx:891–893`), so its
  right corner sits directly on top of the pane it would collapse. That is the
  mapping argument, and it is geometric, not aesthetic.
- ~~**Terminal focus moves up 40px into the chrome band's right lane**~~ — the
  slot the rail toggle vacates, and the slot its own Exit button already
  occupies. Enter and exit become one persistent button at one point on screen,
  glyph `CornersOut ⇄ CornersIn`, `aria-pressed={focused}`. **Reversed in round
  two** — see the closing section. Exit stayed; enter went to the pane.
- **The cluster is not built.** The user was right that it was the closest, and
  right that it was chaotic — but the chaos was never the corner. It was that
  focus-enter is *conditional* (`disabled` on 3 of 4 tab kinds; the scratch
  invented `FocusCornerCell`'s reserved fade to hide a hole that only exists
  because the wrong control is in the slot). The rail toggle is never
  conditional on the ticket surface. Put it in the corner and the fade
  machinery, the divider and the dead slot all disappear together.

### Why not the alternatives

- **Inside the Calm Stack panel.** It cannot reopen itself. The scratch has no
  collapse control anywhere in it (`ticket-right-sidebar.tsx`), which is
  consistent, not an oversight.
- **Hover-summoned right edge, mirroring the left.** Ruled out by the
  fullscreen-placement scratch's own variant-D note (lines 426–433): Files and
  Changes are navigators you keep open while clicking through rows, and a
  dismissing container is wrong for them. Calm Stack's Diffs and Files pages are
  exactly those navigators, so the objection got stronger, not weaker.
- **Focus onto the plane (variant B's chip).** The scratch already priced it
  (lines 350–357): it sits over a live PTY, and a TUI running mouse reporting
  loses that corner.

### The left cluster, per the ledger overrides

`ui-cleanup-pass-v1.md` sets hover dwell to **20ms** with a **375ms** exit grace
and a sliver only while the workspace rail is visible. At 20ms the left edge is
effectively touch-to-open, which demotes `SidebarTrigger` from "how you see the
sidebar" to "how you pin it". The band's left cluster keeps four buttons but
loses a primary. That is an argument for the band *shedding* a panel-visibility
control, not gaining a partner for one — and it is the second reason the rail
toggle leaves.

## Reconciling with the Calm Stack

Read from `.../ui+right-sidebar-fixes/.../lab/scratches/ticket-right-sidebar.tsx`:

1. **The panel now owns its own header.** `ActiveLabelTabs` (168–308) is
   `sticky top-0 z-20 … backdrop-blur-xl`, `bg-sidebar/80`, holding an `h-10`
   `w-40 mx-auto rounded-full border border-sidebar-border bg-background/75`
   tablist. The vertical `TicketRailModeStrip` on the rail's outer edge is gone;
   Properties folds inline (`PropertiesSection`, 1019–1089).
2. **Nothing in it collapses it.** Confirmed by reading the whole file. The
   collapse control must therefore stay outside the panel.
3. **The pill is centred with ~54px of clear space each side at width 300.**
   Putting a collapse button in that row either breaks the centring or crowds
   it. Don't.
4. **This is what would have made the cluster chaotic.** Two glyphs in a
   bordered corner cell, ~40px from a third control group (the pill), on one
   horizontal band, with the chrome bar above. One control in the corner reads
   as the seam between the two columns; two reads as a bolted-on toolbar.
5. **Sizing the corner cell to `railWidth` is tempting and wrong.** The corner
   is a button in a corner, not a column header — the Calm Stack already draws
   the column's header. Keep the shipped ~32px cell.
6. **Tooltips.** Calm Stack uses Radix `Hint`/`TooltipProvider` (149–166, 1313);
   the band and strip use native `title=`. Keep `title=` for both controls here.
   Revisit only if `ui/right-sidebar-fixes` lands a global `TooltipProvider`.
7. **No motion on the glyph swap.** `app-shell.tsx:64–70` deliberately forces
   `data-motion="instant"` through the first frame of entering/exiting focus, to
   collapse the PTY resize cascade. A crossfade would fight that. The corner
   control doesn't animate either — `SidebarSimpleIcon` is the same glyph in
   both states (only `aria-label`/`aria-pressed` change), exactly as shipped.

## The change, in order

**1. `apps/desktop/src/renderer/src/components/ticket/ticket-tabs.tsx`**

- L17: `CornersOutIcon` import → `SidebarSimpleIcon`.
- L139–140 (`TicketTabStripProps`): replace `canFocusTerminal: boolean` /
  `onEnterTerminalFocus(): void` with `railCollapsed: boolean` /
  `onToggleRail(): void`. Prop count unchanged; the strip stays presentational
  (L319).
- L330–331: destructure the new names.
- L377–394: keep the corner `<div>` and its comment **verbatim** — the
  `-mt-1.5 … self-stretch` geometry is deliberate and still correct. Swap only
  the `<Button>`: same `size="icon-xs" variant="ghost" className="h-full rounded-none"`,
  `<SidebarSimpleIcon weight="fill" className="size-3.5 scale-x-[-1]" />`,
  `onClick={onToggleRail}`, `aria-pressed={railCollapsed}`, and **the accessible
  names preserved exactly**: `aria-label={railCollapsed ? "Show details rail" : "Hide details rail"}`,
  ``title={`${railCollapsed ? "Show" : "Hide"} details (⌥⌘B)`}``.
- No `disabled`, no reserved slot, no `aria-pressed={false}`. Ledger item
  "aria-pressed used decoratively … incl. `ticket-tabs.tsx:385`" dies here.

**2. `apps/desktop/src/renderer/src/components/ticket/ticket-detail.tsx`**

- L197: already reads `railCollapsed`; add `toggleRailCollapsed` from
  `useUiStore`.
- L855–862: delete `enterTerminalFocus`. Keep `setTerminalFocusTarget` (still
  used at L772) and `activeSessionTab` (still used at L702, L797).
- L949–950: `canFocusTerminal` / `onEnterTerminalFocus` → `railCollapsed` /
  `onToggleRail`.
- L1031 (`railCollapsed || terminalFocused ? null :`) unchanged.

**3. `apps/desktop/src/renderer/src/components/ticket/ticket-tab-strip-actions.test.tsx`**

- L25–26 and L47–48: swap the two props. Add one assertion that the corner
  renders `aria-label="Hide details rail"` when `railCollapsed={false}`.

**4. `apps/desktop/src/renderer/src/components/chrome-bar.tsx`** — *built as
written, then reversed in round two. The deletions below stand; the new
`TerminalFocusToggle` does not exist. See the closing section.*

- L8: delete the `SidebarSimpleIcon` import (it moved). L5 keeps `CornersInIcon`;
  add `CornersOutIcon`.
- L212–247: delete `RightRailToggle` entirely.
- L93–148: `TerminalFocusControls` keeps only the breadcrumb block (L124–133).
  Delete its `flex-1` and Exit `<Button>` (L134–145). Rename it
  `TerminalFocusBreadcrumb`.
- L41–86: restructure so the trailing toggle is **one node outside the ternary**,
  at a stable position, so React does not remount it across the focus
  transition:

  ```jsx
  <spacer/>
  {focused ? <TerminalFocusBreadcrumb/> : <><left cluster/><NavHistoryButtons/><CommandPaletteTrigger/></>}
  <div className="flex-1" />
  <TerminalFocusToggle />
  ```

- New `TerminalFocusToggle`, reusing the deleted Exit button's exact classes
  (`app-region-no-drag mr-1 translate-y-px`, `variant="ghost" size="icon"`):
  - When `terminalFocusTarget !== null`: `CornersInIcon`,
    `aria-label="Exit terminal focus"`, `aria-pressed`, clears the target.
  - Otherwise it derives its own target — **no prop drilling from ticket-detail**:
    `useSelectedProject()` → `useActiveNav()[0] === "board"` **and**
    `!useUiStore(s => s.settingsOpen)` → `byProject[pid].openTicketId` →
    `byProject[pid].ticketTabs[tid]?.active ?? BODY_TAB_ID` →
    `useSessionsStore(...).tabs.find(t => t.sessionId === active)`. If that
    resolves, render `CornersOutIcon`, `aria-label="Enter terminal focus"`,
    `title="Enter terminal focus"`. Otherwise return `null`.
  - **Selector footgun:** return a *primitive* (`string | null` sessionId) from
    the `useSessionsStore` selector, not an object — an object literal
    re-renders forever and neither lint nor typecheck sees it.
  - The `nav`/`settingsOpen` gate is not optional: `setNav` deliberately does not
    clear `openTicketId` (`workspace.ts:64–69`), so `openTicketId != null` alone
    is true on Files, Sessions and Settings.

## Dead code

- `RightRailToggle` (`chrome-bar.tsx:212–247`) and its `SidebarSimpleIcon` import.
- The Exit `<Button>` + sibling `flex-1` inside `TerminalFocusControls`
  (`chrome-bar.tsx:134–145`).
- `enterTerminalFocus` (`ticket-detail.tsx:855–862`).
- `CornersOutIcon` import in `ticket-tabs.tsx:17`; the corner's `disabled`
  branch, its two-way `title`, and `aria-pressed={false}` (L382–390).
- `useSelectedProject` does **not** become unused in `chrome-bar.tsx` — the new
  toggle needs it. `useWorkspaceStore` stays (`NavHistoryButtons`).
- A latent bug dies with `RightRailToggle`: today it renders on Files, Sessions
  and Settings whenever a ticket is open, toggling a rail that is not on screen.
  The tab strip only mounts in the detail view, so the move fixes it for free.

## Behaviour changes and smokes

One smoke covers both: **`node apps/desktop/e2e/ticket-detail-smoke.mjs`** (after
`pnpm run build`). It is not in CI — run it locally.

- **Step 6b** clicks `getByRole("button", { name: "Enter terminal focus" })` and
  `"Exit terminal focus"`. Both still resolve — Playwright queries the whole DOM
  and the accessible names are unchanged. Its precondition (step 8b re-activates
  the session tab) is exactly what the band's new gate requires. *It did not pass
  unedited, though: the Calm Stack's rail added a second `role="tablist"`, so the
  restored count is 2, not 1.*
- **Step 10** clicks `"Hide details rail"`. Passes unedited, for the same reason.
  Its `aside` counts and the restart-persistence check are untouched.
- **Therefore: preserve those four accessible-name strings verbatim.** That is
  the single constraint that keeps the smoke green.
- **What is genuinely uncovered, and the three lines to add.** Nothing today
  asserts that the band's focus control appears and disappears with tab kind.
  Extend step 6b: before L1112, click the Doc tab and assert
  `getByRole("button", { name: "Enter terminal focus" }).count() === 0`; click
  the session tab back and assert `=== 1`. That is the one regression this move
  can cause and the cheapest place to catch it.
- **Coverage is unaffected.** The gate covers `src/stores/**` and extracted `.ts`
  modules only (`vite.config.ts:80–85`); `.tsx` view glue is deliberately
  outside. This plan adds no store branch — it only reads existing state. Do not
  add a store action for it.
- `ticket-rail-shots.mjs` and `docs-shots.mjs` are untouched by this plan.

## What the Calm Stack settled, and where the plan was overruled

The Calm Stack landed first, so every "blocked on" item above is answered:

- **The geometric assumption held.** `ticket-detail.tsx` still renders one
  full-width `TicketTabStrip` above the row that holds the main column and the
  `<aside>`. The corner is a cap above the rail, not a seam cell between two
  columns, so its `border-l` treatment needed no second look and the shipped
  `-mt-1.5 … self-stretch` geometry moved across verbatim.
- **The rail's vocabulary changed under the plan.** `railMode` is three pages
  (`now` / `changes` / `files`), the vertical `TicketRailModeStrip` is gone, and
  the rail draws its own `role="tablist"`. Nothing in this change touched it.

Three places the plan was overruled, all in the same direction:

- **No `aria-pressed` on either control.** The plan asked for
  `aria-pressed={railCollapsed}` on the corner and `aria-pressed={focused}` on
  the band. Both were dropped. `WorkspaceRailToggle` and the deleted
  `RightRailToggle` already carry the written reason: a button whose LABEL flips
  with its state and which has no pressed appearance announces "Exit terminal
  focus, pressed", which reads as if exiting were the thing already done. The
  four pinned accessible names force the label to flip, so the state may not
  also ride `aria-pressed`. The ledger item this plan set out to kill was
  "aria-pressed used decoratively" — adding two more would have re-filed it.
- **No `weight="fill"` on the corner glyph.** `SidebarSimpleIcon` shipped at
  regular weight in the band and every glyph in the tab strip is regular; the
  icon-weight audit points the same way. It moved lanes, not weights.
- **The strip's tablist gained `aria-label="Ticket tabs"`.** Two unlabeled
  tablists now share the ticket screen — the strip's and the rail's — and
  `getByRole("tab")` could no longer say which it meant.

## Shipped

- `lib/terminal-focus.ts` — the pure decision: `isTerminalFocusKeyEvent`
  (⌥⌘Return), `terminalFocusTargetForChrome` (the nav + `settingsOpen` gate) and
  `activeTerminalSessionId`. In the coverage gate at 100%.
- `hooks/use-terminal-focus-shortcut.ts` — the chord, still mounted from
  `chrome-bar.tsx`: the band is the one component alive on every page, and after
  the reversal below the *enter* control comes and goes with the pane it sits on.
  A chord hosted by a component that unmounts is a chord that stops working
  exactly where it is hardest to notice. Capture-phase and swallowed
  unconditionally, like ⌥⌘B: falling through would hand ⌥⌘Return to the nearest
  composer, whose submit guard reads `metaKey || ctrlKey` without excluding
  Option.
- `hooks/use-terminal-focus-target.ts` — the store reads behind both, derived
  once: `useTerminalFocusTarget` (subscribed, for the pane control) and
  `readTerminalFocusChrome` (imperative, for the chord). The two used to be
  hand-written copies of the same six facts.
- Smoke: `ticket-detail-smoke.mjs` step 6b now asserts the band control appears
  and disappears with tab kind, and round-trips the chord in both directions;
  step 8/8b/5 moved to the Calm Stack's `ticket-rail-tab-*` testids and
  `Status: <value>` pill names; 6b's restored `tablists` count is 2 (strip +
  rail). All 14 checks pass.

Still open, adjacent: `⌥⌘B` at `use-nav-history.ts` is now gated on an open
ticket, so that ledger item is closed — but `docs-shots.mjs` has NOT been rerun,
and the chrome band lost a control, so `apps/docs/src/assets/screenshots/`
is stale by one button.

## The band kept the exit and gave back the entrance

Round two of the cleanup pass reversed the band half of this plan. The single
`TerminalFocusToggle` shipped, was used, and is gone; what stands today is:

- **Enter is `PaneFocusControl`** (`sessions/session-split-layout.tsx`), a
  hover-revealed button in the terminal pane's own top-right corner, mounted only
  for the visible tab.
- **Exit is `TerminalFocusExit`** (`chrome-bar.tsx`), still the band's trailing
  slot, still persistent, still `CornersInIcon`.
- **⌥⌘Return still does both**, unchanged, and both controls resolve against the
  same target the chord does.

The reason, recorded verbatim: *in zen the user is driving a PTY from the
keyboard, and a hover-revealed control is not a way out of a mode.* That is why
the asymmetry is deliberate rather than an unfinished move — a mode's exit has to
be persistent, visible and in one fixed place, while its entrance is a statement
about one terminal and belongs on that terminal.

Two things this plan argued for come out better under the reversal, not worse:

- **The conditional-control complaint is answered structurally.** The plan's own
  §Verdict identified the real chaos as focus-enter being *conditional*, and
  moved it to a band that then had to derive whether a terminal was on screen at
  all before it could decide to render. `PaneFocusControl` cannot appear where a
  terminal isn't, because it only exists inside a visible pane tree — no gate to
  keep in sync, and no `disabled` state to hide.
- **The ticket-only accident dies with it.** The band could only offer entry by
  reaching for an `openTicketId`, which is how terminal focus stayed accidentally
  ticket-only. `terminalFocusTargetForChrome` now answers per page, so the
  project's own Sessions surface enters focus too.

The corner half of the plan is untouched and still ships: the tab strip's right
corner is the details-rail toggle, with the `-mt-1.5 … self-stretch` geometry and
the four pinned accessible names intact. The band's variant-B objection in §"Why
not the alternatives" — that a control on the plane sits over a live PTY and a
TUI running mouse reporting loses that corner — was priced and accepted: the
control stops `pointerdown` before the pane sees it, and the chord is the
pointer-free route for anyone the corner fails.

## Settled: the terminal-focus chord lands here, not in task 3

Terminal focus has no keyboard chord in either direction (`⌃⌘F` is macOS's own
and is not wired to it). Turning it into a single stateful toggle in a fixed slot
is what makes a chord natural: **`⌥⌘Return`** is free and mirrors `⌥⌘B`.

It belongs to this change, not to the session-start work. Task 3 is about
*creating* a Session; this is about *viewing* one already open. Wiring it there
would put an unrelated chord in a module named for session creation, and would
gate on state that module has no other reason to read.
