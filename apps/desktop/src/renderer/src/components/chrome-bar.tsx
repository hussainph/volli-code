import * as React from "react";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CornersInIcon } from "@phosphor-icons/react/dist/csr/CornersIn";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { SidebarIcon } from "@phosphor-icons/react/dist/csr/Sidebar";

import { CommandPalette } from "@renderer/components/command-palette";
import { QuickOpen } from "@renderer/components/files/quick-open";
import { Button } from "@renderer/components/ui/button";
import { SidebarTrigger } from "@renderer/components/ui/sidebar";
import { useCommandPaletteShortcut } from "@renderer/hooks/use-command-palette-shortcut";
import { useFullScreen } from "@renderer/hooks/use-fullscreen";
import { navBack, navForward } from "@renderer/hooks/use-nav-history";
import { useQuickOpenShortcut } from "@renderer/hooks/use-quick-open-shortcut";
import { useTerminalFocusShortcut } from "@renderer/hooks/use-terminal-focus-shortcut";
import { cn } from "@renderer/lib/utils";
import { canGoBack, canGoForward } from "@renderer/lib/nav-history";
import { useBoardStore } from "@renderer/stores/board";
import { useProjectsStore } from "@renderer/stores/projects";
import { useSessionsStore } from "@renderer/stores/sessions";
import { useUiStore } from "@renderer/stores/ui";
import { useWorkspaceStore } from "@renderer/stores/workspace";
import { displayTicketId } from "@volli/shared";

/**
 * Full-width window chrome band — the ONLY drag-region owner for window
 * chrome (traffic lights, drag-to-move, the sidebar toggle). Everything
 * below it is ordinary layout. Its height (h-9, 36px) must stay in sync
 * with trafficLightPosition in main/index.ts, which centers the lights
 * inside it. 36 over the original 40 was a judged call (2026-08-15, the
 * lab's chrome rig): the lights re-seat at y:12 and nothing else moves.
 */
export function ChromeBar() {
  const fullScreen = useFullScreen();
  const terminalFocusTarget = useUiStore((state) => state.terminalFocusTarget);
  const [commandPaletteOpen, setCommandPaletteOpen] = useCommandPaletteShortcut();
  // Quick-open (VC-190) mounts beside the palette for the palette's own reason:
  // it is a window-level surface summoned by a chord from anywhere, and it is
  // suppressed by the same terminal focus for the same reason.
  const [quickOpenOpen, setQuickOpenOpen] = useQuickOpenShortcut();
  // The band owns the terminal-focus control, so it owns its chord too.
  useTerminalFocusShortcut();
  React.useEffect(() => {
    if (terminalFocusTarget !== null) {
      setCommandPaletteOpen(false);
      setQuickOpenOpen(false);
    }
  }, [terminalFocusTarget, setCommandPaletteOpen, setQuickOpenOpen]);

  return (
    <>
      {/* relative: the command trigger centers itself against the band, not the
          flex row, so it stays put when the traffic-light spacer collapses. */}
      {/* No fill (#74): the band was already painted in the backdrop's own
          token, so it has nothing of its own to give up — it now sits on the
          canvas layer like the rail does. The ⌘K pill keeps its own material
          (`bg-foreground/10`), which was already written as a material over a
          fill rather than as a fill of its own. */}
      <div className="app-region-drag relative flex h-9 shrink-0 items-center">
        {/* Clears the traffic lights (start x:10, group renders ≈60px wide,
          ending ≈70px) plus breathing room so the trigger doesn't crowd them.
          Fullscreen hides the lights, so the spacer collapses and the trigger
          slides to the left edge — same animation the old rail-top-strip used. */}
        <div
          className={cn(
            "shrink-0 transition-[width] duration-300 ease-swift",
            fullScreen ? "w-2" : "w-[78px]",
          )}
        />
        {terminalFocusTarget !== null ? (
          <TerminalFocusBreadcrumb />
        ) : (
          <>
            {/* translate-y-px: the lights' optical center lands at ~18.5px (y:12 +
          half their ~13px diameter), just below the band's 18px flex center —
          nudge the trigger down to meet them. */}
            <div className="app-region-no-drag flex translate-y-px items-center">
              <WorkspaceRailToggle />
              <SidebarTrigger
                aria-label="Toggle navigation sidebar"
                title="Toggle navigation sidebar (⌘B)"
              />
            </div>
            <NavHistoryButtons />
            <CommandPaletteTrigger onClick={() => setCommandPaletteOpen(true)} />
            {/* The content-area tab strip (if any) lives below in MainContent, not here. */}
          </>
        )}
        {/* Outside the ternary so the spacer keeps its slot in this element's
            children across the focus transition rather than being reconciled
            against the breadcrumb. */}
        <div className="flex-1" />
        <TerminalFocusExit />
      </div>
      <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
      <QuickOpen open={quickOpenOpen} onOpenChange={setQuickOpenOpen} />
      {/* No Automation editor here. It used to mount beside the palette as a
          window-level surface summoned from anywhere (VC-126) — which is a
          second authoring surface by another name. VC-112 rules that only the
          Automations page authors, so the page mounts its own form. */}
    </>
  );
}

/**
 * Says WHICH Session owns the canvas while terminal focus is on. The band
 * remains the only window drag region and traffic-light owner; all ordinary
 * navigation/search controls step aside so the terminal gets every pixel below
 * this single 36px row.
 *
 * It carries no exit control of its own — leaving is the band's persistent
 * {@link TerminalFocusExit}, in the trailing slot.
 *
 * The owner half names the ticket when a ticket owns the Session and the project
 * when none does. That is not a fallback string: a ticketless Session genuinely
 * belongs to the project, and in zen mode the rail that would otherwise say
 * which project you are in is gone.
 */
function TerminalFocusBreadcrumb() {
  const target = useUiStore((state) => state.terminalFocusTarget);
  const project = useProjectsStore((state) =>
    target === null
      ? undefined
      : state.projects.find((candidate) => candidate.id === target.projectId),
  );
  const ticket = useBoardStore((state) =>
    target === null || target.ticketId === null
      ? undefined
      : state.ticketsByProject[target.projectId]?.find(
          (candidate) => candidate.id === target.ticketId,
        ),
  );
  // One lookup for both kinds: the sessions store is keyed by `ownerKey`, which
  // is a ticketId for a ticket Session and a projectId for a ticketless one.
  const sessionTitle = useSessionsStore((state) =>
    target === null
      ? undefined
      : state.byOwner[target.ticketId ?? target.projectId]?.tabs.find(
          (candidate) => candidate.sessionId === target.sessionId,
        )?.title,
  );

  if (target === null) return null;

  const ownerLabel =
    target.ticketId === null
      ? (project?.name ?? "Sessions")
      : project !== undefined && ticket !== undefined
        ? displayTicketId(project.ticketPrefix, ticket.ticketNumber)
        : "Ticket";

  return (
    <div
      aria-live="polite"
      // top-[19px], not top-1/2: same 1px correction as the ⌘K pill — the
      // trailing focus toggle carries translate-y-px to meet the traffic lights.
      className="pointer-events-none absolute left-1/2 top-[19px] flex max-w-[45vw] -translate-x-1/2 -translate-y-1/2 items-center gap-2 text-ui text-muted-foreground"
    >
      <span className="max-w-[40%] shrink-0 truncate font-medium text-foreground">
        {ownerLabel}
      </span>
      <span aria-hidden="true">/</span>
      <span className="truncate">{sessionTitle ?? "Terminal"}</span>
    </div>
  );
}

/**
 * Visibility control for the outer Slack-style project switcher ("project" is
 * the one user-facing word for a rail entry — CONTEXT.md's ruling). It sits
 * immediately before the primary nav's existing SidebarTrigger so the
 * controls follow the same outside-to-inside order as the panes they affect.
 */
function WorkspaceRailToggle() {
  const workspaceRailHidden = useUiStore((state) => state.workspaceRailHidden);
  const toggleWorkspaceRailHidden = useUiStore((state) => state.toggleWorkspaceRailHidden);

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      // No `aria-pressed`: the label below already carries the state, and the
      // button has no pressed appearance for it to describe. Both together
      // announce "Show project switcher, pressed" while the switcher is
      // hidden, which reads as its own opposite.
      onClick={() => toggleWorkspaceRailHidden()}
      aria-label={workspaceRailHidden ? "Show project switcher" : "Hide project switcher"}
      title={`${workspaceRailHidden ? "Show" : "Hide"} project switcher`}
    >
      <SidebarIcon />
      <span className="sr-only">Toggle project switcher</span>
    </Button>
  );
}

/**
 * Slack-style ←/→ project navigation. Reads the back/forward stack depth from
 * the workspace store's in-memory history; each button is disabled (muted,
 * non-interactive) when its stack is empty. `navBack` / `navForward` apply the
 * step to the live stores — see hooks/use-nav-history.ts.
 */
function NavHistoryButtons() {
  const backEnabled = useWorkspaceStore((state) => canGoBack(state.navHistory));
  const forwardEnabled = useWorkspaceStore((state) => canGoForward(state.navHistory));

  return (
    <div className="app-region-no-drag flex translate-y-px items-center">
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={!backEnabled}
        onClick={() => navBack()}
        aria-label="Back"
        title="Back (⌘[)"
      >
        <CaretLeftIcon weight="bold" />
        <span className="sr-only">Back</span>
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={!forwardEnabled}
        onClick={() => navForward()}
        aria-label="Forward"
        title="Forward (⌘])"
      >
        <CaretRightIcon weight="bold" />
        <span className="sr-only">Forward</span>
      </Button>
    </div>
  );
}

/**
 * The band's trailing slot: the way OUT of terminal focus, and nothing else.
 *
 * The way in moved onto the pane it acts on (`session-split-layout.tsx`'s
 * `PaneFocusControl`). Entering is a statement about one terminal, so it belongs
 * on that terminal; the band is window chrome and could only ever offer it by
 * first deriving whether a terminal was on screen at all — a control conditional
 * on facts it has no business holding, and the reason terminal focus stayed
 * accidentally ticket-only for as long as it did.
 *
 * Exit stays here, and the asymmetry is the point rather than a leftover. In zen
 * mode this 36px row is the only chrome left: the tab strips are gone, the
 * sidebars are gone, and the pane fills everything below. A hover-revealed
 * corner control on a terminal the user is driving from the keyboard is not a
 * way out of a mode — it is a thing you have to remember exists and then go
 * hunting for with a mouse. So the exit is persistent, visible, and always in
 * the same place, with ⌥⌘Return doing the same job without a pointer.
 *
 * No crossfade on appearing: `app-shell.tsx` forces `data-motion="instant"`
 * through the first frame of the transition to collapse the PTY resize cascade,
 * and a glyph animating against that would be the one thing on screen fighting
 * the freeze.
 */
function TerminalFocusExit() {
  const focused = useUiStore((state) => state.terminalFocusTarget !== null);
  if (!focused) return null;

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      // mr-1 keeps it off the window's right edge; translate-y-px meets the
      // traffic lights, like every other icon button on this band.
      className="app-region-no-drag mr-1 translate-y-px"
      // No `aria-pressed`, for the same reason as WorkspaceRailToggle above:
      // the label already carries the state, and "Exit terminal focus, pressed"
      // reads as if exiting were the thing already done.
      onClick={() => useUiStore.getState().setTerminalFocusTarget(null)}
      aria-label="Exit terminal focus"
      title="Exit terminal focus (⌥⌘⏎)"
    >
      <CornersInIcon weight="bold" />
      <span className="sr-only">Exit terminal focus</span>
    </Button>
  );
}

/**
 * The chrome band's ⌘K center opens the app-wide ticket/session destination
 * picker. It is a button, not a board filter: the palette can move directly to
 * a ticket document or an already-running terminal from anywhere in the app.
 *
 * Absolutely centered so it anchors to the WINDOW's midline regardless of the
 * traffic-light spacer / fullscreen collapse. Overlap math at minWidth 940px
 * (main/index.ts): left chrome occupies ≈110px (78px spacer + trigger); the
 * pill's left edge sits at (940 − 380) / 2 = 280px — comfortably clear.
 * max-w-[40vw] only shrinks it further on narrow windows.
 */
function CommandPaletteTrigger({ onClick }: { onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-label="Search tickets and sessions"
      title="Search tickets and sessions (⌘K)"
      // top-[19px] (not top-1/2): band center is 18px, but the sibling
      // icon-buttons carry translate-y-px to meet the traffic lights at ~19px.
      // Anchor the pill's -translate-y-1/2 center to 19px so it aligns with them.
      //
      // The fill is a MATERIAL over the canvas rather than a rung of the ladder,
      // so it is a wash of the ink: `--foreground` runs toward white in dark and
      // toward black in light, which is the direction a material has to move in
      // each mode. A literal white lightens a light canvas and disappears.
      //
      // THE HOVER IS THE EDGE, not the fill. The wash used to step 6% → 8% on
      // hover, two rungs of a twenty-step alpha ladder that has since collapsed
      // to four — and on this ladder the next rung up from the wash (30%) is a
      // grey patch on the band, not a hover. The border was already doing the
      // work (`border-border/50` → `border-border`); the fill now holds still at
      // the one wash rung and lets it.
      className="app-region-no-drag absolute left-1/2 top-[19px] flex h-[22px] w-[380px] max-w-[40vw] -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-md border border-border/50 bg-foreground/10 px-2 text-left text-ui text-muted-foreground transition-colors hover:border-border focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
    >
      <MagnifyingGlassIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">Search tickets and sessions</span>
      {/* The keycap reads as cut out of the pill, so it goes the other way:
          toward the canvas floor. `--background` is near-black in dark (what
          the literal used to be) and near-white in light, which is what a key
          cap looks like on a light chrome. */}
      <kbd className="shrink-0 rounded-sm border border-border/70 bg-background/10 px-1 py-px font-sans text-label leading-none text-muted-foreground">
        ⌘K
      </kbd>
      <CaretDownIcon aria-hidden className="size-3 shrink-0" weight="bold" />
    </button>
  );
}
