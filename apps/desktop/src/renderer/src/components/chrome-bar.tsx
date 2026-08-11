import * as React from "react";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CornersInIcon } from "@phosphor-icons/react/dist/csr/CornersIn";
import { CornersOutIcon } from "@phosphor-icons/react/dist/csr/CornersOut";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { SidebarIcon } from "@phosphor-icons/react/dist/csr/Sidebar";

import { CommandPalette } from "@renderer/components/command-palette";
import { TICKET_BODY_TAB_ID } from "@renderer/components/ticket/ticket-body-tab";
import { Button } from "@renderer/components/ui/button";
import { SidebarTrigger } from "@renderer/components/ui/sidebar";
import { useCommandPaletteShortcut } from "@renderer/hooks/use-command-palette-shortcut";
import { useFullScreen } from "@renderer/hooks/use-fullscreen";
import { navBack, navForward } from "@renderer/hooks/use-nav-history";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { useTerminalFocusShortcut } from "@renderer/hooks/use-terminal-focus-shortcut";
import { cn } from "@renderer/lib/utils";
import { canGoBack, canGoForward } from "@renderer/lib/nav-history";
import {
  activeTerminalSessionId,
  terminalFocusTargetForChrome,
} from "@renderer/lib/terminal-focus";
import { useBoardStore } from "@renderer/stores/board";
import { useProjectsStore } from "@renderer/stores/projects";
import { useSessionsStore } from "@renderer/stores/sessions";
import { useUiStore } from "@renderer/stores/ui";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";
import { displayTicketId } from "@volli/shared";

/**
 * Full-width window chrome band — the ONLY drag-region owner for window
 * chrome (traffic lights, drag-to-move, the sidebar toggle). Everything
 * below it is ordinary layout. Its height (h-10, 40px) must stay in sync
 * with trafficLightPosition in main/index.ts, which centers the lights
 * inside it.
 */
export function ChromeBar() {
  const fullScreen = useFullScreen();
  const terminalFocusTarget = useUiStore((state) => state.terminalFocusTarget);
  const [commandPaletteOpen, setCommandPaletteOpen] = useCommandPaletteShortcut();
  // The band owns the terminal-focus control, so it owns its chord too.
  useTerminalFocusShortcut();
  React.useEffect(() => {
    if (terminalFocusTarget !== null) setCommandPaletteOpen(false);
  }, [terminalFocusTarget, setCommandPaletteOpen]);

  return (
    <>
      {/* relative: the command trigger centers itself against the band, not the
          flex row, so it stays put when the traffic-light spacer collapses. */}
      {/* No fill (#74): the band was already painted in the backdrop's own
          token, so it has nothing of its own to give up — it now sits on the
          canvas layer like the rail does. The ⌘K pill keeps its own material
          (`bg-foreground/6`), which was already written as a material over a
          fill rather than as a fill of its own. */}
      <div className="app-region-drag relative flex h-10 shrink-0 items-center">
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
            {/* translate-y-px: the lights' optical center lands at ~20.5px (y:14 +
          half their ~13px diameter), just below the band's 20px flex center —
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
        {/* Both OUTSIDE the ternary, at a fixed position in this element's
            children, so React reconciles the trailing toggle as the same node
            across the focus transition instead of unmounting and remounting it.
            Enter and exit are one button at one point on screen; a remount would
            make them two buttons that happen to share a slot. */}
        <div className="flex-1" />
        <TerminalFocusToggle />
      </div>
      <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
    </>
  );
}

/**
 * Says WHICH Session owns the canvas while terminal focus is on. The band
 * remains the only window drag region and traffic-light owner; all ordinary
 * navigation/search controls step aside so the terminal gets every pixel below
 * this single 40px row.
 *
 * It carries no exit control of its own — leaving is the band's persistent
 * `TerminalFocusToggle`, which never moved.
 */
function TerminalFocusBreadcrumb() {
  const target = useUiStore((state) => state.terminalFocusTarget);
  const project = useProjectsStore((state) =>
    target === null
      ? undefined
      : state.projects.find((candidate) => candidate.id === target.projectId),
  );
  const ticket = useBoardStore((state) =>
    target === null
      ? undefined
      : state.ticketsByProject[target.projectId]?.find(
          (candidate) => candidate.id === target.ticketId,
        ),
  );
  const sessionTitle = useSessionsStore((state) =>
    target === null
      ? undefined
      : state.byOwner[target.ticketId]?.tabs.find(
          (candidate) => candidate.sessionId === target.sessionId,
        )?.title,
  );

  if (target === null) return null;

  const ticketLabel =
    project !== undefined && ticket !== undefined
      ? displayTicketId(project.ticketPrefix, ticket.ticketNumber)
      : "Ticket";

  return (
    <div
      aria-live="polite"
      // top-[21px], not top-1/2: same 1px correction as the ⌘K pill — the
      // trailing focus toggle carries translate-y-px to meet the traffic lights.
      className="pointer-events-none absolute left-1/2 top-[21px] flex max-w-[45vw] -translate-x-1/2 -translate-y-1/2 items-center gap-2 text-xs text-muted-foreground"
    >
      <span className="shrink-0 font-medium text-foreground">{ticketLabel}</span>
      <span aria-hidden="true">/</span>
      <span className="truncate">{sessionTitle ?? "Terminal"}</span>
    </div>
  );
}

/**
 * Visibility control for the outer Slack-style project/workspace switcher.
 * It sits immediately before the primary nav's existing SidebarTrigger so the
 * controls follow the same outside-to-inside order as the panes they affect.
 */
function WorkspaceRailToggle() {
  const workspaceRailHidden = useUiStore((state) => state.workspaceRailHidden);
  const toggleWorkspaceRailHidden = useUiStore((state) => state.toggleWorkspaceRailHidden);

  return (
    <Button
      variant="ghost"
      size="icon"
      // No `aria-pressed`: the label below already carries the state, and the
      // button has no pressed appearance for it to describe. Both together
      // announce "Show workspace switcher, pressed" while the switcher is
      // hidden, which reads as its own opposite.
      onClick={() => toggleWorkspaceRailHidden()}
      aria-label={workspaceRailHidden ? "Show workspace switcher" : "Hide workspace switcher"}
      title={`${workspaceRailHidden ? "Show" : "Hide"} workspace switcher`}
    >
      <SidebarIcon />
      <span className="sr-only">Toggle workspace switcher</span>
    </Button>
  );
}

/**
 * Slack-style ←/→ workspace navigation. Reads the back/forward stack depth from
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
        size="icon"
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
        size="icon"
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
 * The band's trailing slot: ONE persistent button that enters and exits terminal
 * focus, its glyph flipping `CornersOut ⇄ CornersIn`.
 *
 * It took this slot from the right-rail toggle, which moved down into the tab
 * strip's corner — that corner sits directly on top of the pane it collapses,
 * which is a mapping the band could never offer, and this slot is where the
 * old Exit button already lived. So entering and leaving now happen at one
 * point on screen instead of two 40px apart.
 *
 * No `weight` change across the flip and no crossfade: `app-shell.tsx` forces
 * `data-motion="instant"` through the first frame of the transition to collapse
 * the PTY resize cascade, and a glyph animating against that would be the one
 * thing on screen fighting the freeze. The shape alone says the state.
 *
 * It derives its own target rather than taking one from the ticket view: the
 * band is window chrome mounted above every page, and prop-drilling from a view
 * that unmounts on navigation would make the control's existence depend on the
 * view rather than on the state.
 */
function TerminalFocusToggle() {
  const focused = useUiStore((state) => state.terminalFocusTarget !== null);
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const projectId = useSelectedProject()?.id ?? null;
  const nav = useWorkspaceStore((state) =>
    projectId === null
      ? DEFAULT_WORKSPACE_UI.nav
      : (state.byProject[projectId]?.nav ?? DEFAULT_WORKSPACE_UI.nav),
  );
  const openTicketId = useWorkspaceStore((state) =>
    projectId === null ? null : (state.byProject[projectId]?.openTicketId ?? null),
  );
  const activeTabId = useWorkspaceStore((state) =>
    projectId === null || openTicketId === null
      ? TICKET_BODY_TAB_ID
      : (state.byProject[projectId]?.ticketTabs[openTicketId]?.active ?? TICKET_BODY_TAB_ID),
  );
  // Every selector above returns a PRIMITIVE, and this one especially: a
  // selector that built `{sessionId}` or sliced a fresh array would hand
  // Zustand a new identity on every store write anywhere in the app and
  // re-render this button forever. Neither lint nor typecheck can see that.
  const activeSessionId = useSessionsStore((state) =>
    activeTerminalSessionId(
      activeTabId,
      openTicketId === null ? undefined : state.byOwner[openTicketId]?.tabs,
    ),
  );

  const target = terminalFocusTargetForChrome({
    selectedProjectId: projectId,
    nav,
    settingsOpen,
    openTicketId,
    activeSessionId,
  });
  if (!focused && target === null) return null;

  const label = focused ? "Exit terminal focus" : "Enter terminal focus";
  const Glyph = focused ? CornersInIcon : CornersOutIcon;

  return (
    <Button
      variant="ghost"
      size="icon"
      // mr-1 keeps it off the window's right edge; translate-y-px meets the
      // traffic lights, like every other icon button on this band.
      className="app-region-no-drag mr-1 translate-y-px"
      // No `aria-pressed`, for the same reason as WorkspaceRailToggle above:
      // the label already carries the state, and "Exit terminal focus, pressed"
      // reads as if exiting were the thing already done.
      onClick={() => useUiStore.getState().setTerminalFocusTarget(focused ? null : target)}
      aria-label={label}
      title={`${label} (⌥⌘⏎)`}
    >
      <Glyph weight="bold" />
      <span className="sr-only">{label}</span>
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
      // top-[21px] (not top-1/2): band center is 20px, but the sibling
      // icon-buttons carry translate-y-px to meet the traffic lights at ~21px.
      // Anchor the pill's -translate-y-1/2 center to 21px so it aligns with them.
      //
      // The fill is a MATERIAL over the canvas rather than a rung of the ladder,
      // so it is a wash of the ink: `--foreground` runs toward white in dark and
      // toward black in light, which is the direction a material has to move in
      // each mode. A literal white lightens a light canvas and disappears.
      className="app-region-no-drag absolute left-1/2 top-[21px] flex h-[26px] w-[380px] max-w-[40vw] -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-md border border-border/60 bg-foreground/6 px-2 text-left text-ui text-muted-foreground transition-colors hover:border-border hover:bg-foreground/8 focus-visible:border-ring/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
    >
      <MagnifyingGlassIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">Search tickets and sessions</span>
      {/* The keycap reads as cut out of the pill, so it goes the other way:
          toward the canvas floor. `--background` is near-black in dark (what
          the literal used to be) and near-white in light, which is what a key
          cap looks like on a light chrome. */}
      <kbd className="shrink-0 rounded border border-border/70 bg-background/10 px-1.5 py-px font-sans text-label leading-none text-muted-foreground">
        ⌘K
      </kbd>
      <CaretDownIcon aria-hidden className="size-3 shrink-0" weight="bold" />
    </button>
  );
}
