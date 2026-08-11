import * as React from "react";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CornersInIcon } from "@phosphor-icons/react/dist/csr/CornersIn";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { SidebarIcon } from "@phosphor-icons/react/dist/csr/Sidebar";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";

import { CommandPalette } from "@renderer/components/command-palette";
import { Button } from "@renderer/components/ui/button";
import { SidebarTrigger } from "@renderer/components/ui/sidebar";
import { useCommandPaletteShortcut } from "@renderer/hooks/use-command-palette-shortcut";
import { useFullScreen } from "@renderer/hooks/use-fullscreen";
import { navBack, navForward } from "@renderer/hooks/use-nav-history";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
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
 * below it is ordinary layout. Its height (h-10, 40px) must stay in sync
 * with trafficLightPosition in main/index.ts, which centers the lights
 * inside it.
 */
export function ChromeBar() {
  const fullScreen = useFullScreen();
  const terminalFocusTarget = useUiStore((state) => state.terminalFocusTarget);
  const [commandPaletteOpen, setCommandPaletteOpen] = useCommandPaletteShortcut();
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
          <TerminalFocusControls />
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
            <div className="flex-1" />
            <RightRailToggle />
          </>
        )}
      </div>
      <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
    </>
  );
}

/**
 * Compact terminal-focus chrome. The existing band remains the only window
 * drag region and traffic-light owner; all ordinary navigation/search controls
 * step aside so the terminal gets every pixel below this single 40px row.
 */
function TerminalFocusControls() {
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
    <>
      <div
        aria-live="polite"
        // top-[21px], not top-1/2: same 1px correction as the ⌘K pill — the
        // sibling Exit button carries translate-y-px to meet the traffic lights.
        className="pointer-events-none absolute left-1/2 top-[21px] flex max-w-[45vw] -translate-x-1/2 -translate-y-1/2 items-center gap-2 text-xs text-muted-foreground"
      >
        <span className="shrink-0 font-medium text-foreground">{ticketLabel}</span>
        <span aria-hidden="true">/</span>
        <span className="truncate">{sessionTitle ?? "Terminal"}</span>
      </div>
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="icon"
        className="app-region-no-drag mr-1 translate-y-px"
        onClick={() => useUiStore.getState().setTerminalFocusTarget(null)}
        aria-label="Exit terminal focus"
        title="Exit terminal focus"
      >
        <CornersInIcon weight="bold" />
        <span className="sr-only">Exit terminal focus</span>
      </Button>
    </>
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
      <SidebarIcon weight="fill" />
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
 * VS-Code secondary-sidebar toggle: a mirrored sidebar icon pinned at the
 * chrome band's RIGHT edge that collapses the ticket-detail right rail (⌥⌘B).
 * Shown only when the selected project has a ticket open in the detail view —
 * the rail only exists there. The layout agent consumes `railCollapsed` from
 * the ui store to actually hide/show the rail.
 */
function RightRailToggle() {
  const project = useSelectedProject();
  const projectId = project?.id ?? null;
  const hasOpenTicket = useWorkspaceStore((state) =>
    projectId === null ? false : state.byProject[projectId]?.openTicketId != null,
  );
  const railCollapsed = useUiStore((state) => state.railCollapsed);
  const toggleRailCollapsed = useUiStore((state) => state.toggleRailCollapsed);

  if (!hasOpenTicket) return null;

  return (
    <Button
      variant="ghost"
      size="icon"
      // scale-x-[-1] mirrors the left-sidebar glyph so it reads as the RIGHT
      // panel (VS Code's secondary-sidebar convention). mr-1 keeps it off the
      // window's right edge.
      className="app-region-no-drag mr-1 translate-y-px"
      // No `aria-pressed`, for the same reason as WorkspaceRailToggle above.
      onClick={() => toggleRailCollapsed()}
      aria-label={railCollapsed ? "Show details rail" : "Hide details rail"}
      title={`${railCollapsed ? "Show" : "Hide"} details (⌥⌘B)`}
    >
      <SidebarSimpleIcon weight="fill" className="scale-x-[-1]" />
      <span className="sr-only">Toggle details rail</span>
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
