import * as React from "react";
import { ControlShapeProvider } from "./ui/control-shape";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  RestoreWindowIcon,
  SearchIcon,
  SidebarIcon,
} from "@renderer/components/ui/icon";

import { CommandPalette } from "@renderer/components/command-palette";
import { HostChip } from "@renderer/components/hosts/host-chip";
import { HostsChrome } from "@renderer/components/hosts/hosts-chrome";
import { QuickOpen } from "@renderer/components/files/quick-open";
import { UsageLimitsPopover } from "@renderer/components/usage-limits/usage-limits-popover";
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
import { useProjectUiStore } from "@renderer/stores/project-ui";
import { displayTicketId } from "@volli/shared";

/** The 46px canvas band owns dragging and clears main's native traffic lights.
 * Navigation controls group at the left; search stays window-centred and the
 * inspector control stays at the far right, independent of workspace tabs. */
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
    <ControlShapeProvider context="toolbar">
      {/* relative: the command trigger centers itself against the band, not the
          flex row, so it stays put when the traffic-light spacer collapses. */}
      {/* No fill (#74): the band was already painted in the backdrop's own
          token, so it has nothing of its own to give up — it now sits on the
          canvas layer like the rail does. The ⌘K pill keeps its own material
          (`bg-foreground/10`), which was already written as a material over a
          fill rather than as a fill of its own. */}
      <div
        data-slot="chrome-bar"
        className="app-region-drag relative flex h-(--spacing-titlebar) shrink-0 items-center"
      >
        {/* Clears the traffic lights (start x:10, group renders ≈60px wide,
          ending ≈70px) plus breathing room so the trigger doesn't crowd them.
          Fullscreen hides the lights, so the spacer collapses and the trigger
          slides to the left edge — same animation the old rail-top-strip used. */}
        <div className={cn("shrink-0", fullScreen ? "w-2" : "w-[100px]")} />
        {terminalFocusTarget !== null ? (
          <TerminalFocusBreadcrumb />
        ) : (
          <>
            <NavHistoryButtons />
            <div className="app-region-no-drag ml-px flex items-center gap-px">
              <ProjectRailToggle />
              <SidebarTrigger
                variant="toolbar"
                size="icon"
                aria-label="Toggle navigation sidebar"
                title="Toggle navigation sidebar (⌘B)"
              />
            </div>
            {/* Which machine the project in front runs on (VC-576). Nothing
                with the `cloud` flag off. */}
            <HostChip />
            <CommandCluster onCommandPalette={() => setCommandPaletteOpen(true)} />
            {/* The content-area tab strip (if any) lives below in MainContent, not here. */}
          </>
        )}
        {/* Outside the ternary so the spacer keeps its slot in this element's
            children across the focus transition rather than being reconciled
            against the breadcrumb. */}
        <div className="flex-1" />
        {terminalFocusTarget === null ? <InspectorToolbarToggle /> : null}
        <TerminalFocusExit />
      </div>
      <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
      {/* "Add a host…" and "Manage hosts…" (VC-700): the Add-a-host sheet and
          the switcher's entry points. Nothing with the `cloud` flag off. */}
      <HostsChrome />
      <QuickOpen open={quickOpenOpen} onOpenChange={setQuickOpenOpen} />
      {/* No Automation editor here. It used to mount beside the palette as a
          window-level surface summoned from anywhere (VC-126) — which is a
          second authoring surface by another name. VC-112 rules that only the
          Automations page authors, so the page mounts its own form. */}
    </ControlShapeProvider>
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
      className="pointer-events-none absolute left-1/2 top-1/2 flex max-w-[45vw] -translate-x-1/2 -translate-y-1/2 items-center gap-2 text-ui text-muted-foreground"
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
function ProjectRailToggle() {
  const projectRailHidden = useUiStore((state) => state.projectRailHidden);
  const toggleProjectRailHidden = useUiStore((state) => state.toggleProjectRailHidden);

  return (
    <Button
      variant="toolbar"
      size="icon"
      // No `aria-pressed`: the label below already carries the state, and the
      // button has no pressed appearance for it to describe. Both together
      // announce "Show project switcher, pressed" while the switcher is
      // hidden, which reads as its own opposite.
      onClick={() => toggleProjectRailHidden()}
      aria-label={projectRailHidden ? "Show project switcher" : "Hide project switcher"}
      title={`${projectRailHidden ? "Show" : "Hide"} project switcher`}
    >
      <SidebarIcon className="size-4" />
      <span className="sr-only">Toggle project switcher</span>
    </Button>
  );
}

/**
 * Slack-style ←/→ project navigation. Reads the back/forward stack depth from
 * the project UI store's in-memory history; each button is disabled (muted,
 * non-interactive) when its stack is empty. `navBack` / `navForward` apply the
 * step to the live stores — see hooks/use-nav-history.ts.
 */
function NavHistoryButtons() {
  const backEnabled = useProjectUiStore((state) => canGoBack(state.navHistory));
  const forwardEnabled = useProjectUiStore((state) => canGoForward(state.navHistory));

  return (
    <div className="glass-control app-region-no-drag flex translate-y-px items-center rounded-full [&_button]:border-0 [&_button]:bg-transparent [&_button]:shadow-none">
      <Button
        variant="toolbar"
        size="icon"
        disabled={!backEnabled}
        onClick={() => navBack()}
        aria-label="Back"
        title="Back (⌘[)"
      >
        <ChevronLeftIcon strokeWidth={2.25} />
        <span className="sr-only">Back</span>
      </Button>
      <Button
        variant="toolbar"
        size="icon"
        disabled={!forwardEnabled}
        onClick={() => navForward()}
        aria-label="Forward"
        title="Forward (⌘])"
      >
        <ChevronRightIcon strokeWidth={2.25} />
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
      variant="toolbar"
      size="icon"
      // mr-1 keeps it off the window's right edge; translate-y-px meets the
      // traffic lights, like every other icon button on this band.
      className="app-region-no-drag mr-1 translate-y-px"
      // No `aria-pressed`, for the same reason as ProjectRailToggle above:
      // the label already carries the state, and "Exit terminal focus, pressed"
      // reads as if exiting were the thing already done.
      onClick={() => useUiStore.getState().setTerminalFocusTarget(null)}
      aria-label="Exit terminal focus"
      title="Exit terminal focus (⌥⌘⏎)"
    >
      <RestoreWindowIcon strokeWidth={2.25} />
      <span className="sr-only">Exit terminal focus</span>
    </Button>
  );
}

/** The inspector's standing toolbar door; both workspace scopes share its pin. */
function InspectorToolbarToggle() {
  const collapsed = useUiStore((state) => state.railCollapsed);
  const toggle = useUiStore((state) => state.toggleRailCollapsed);
  return (
    <Button
      variant="toolbar"
      size="icon"
      className="app-region-no-drag mr-2"
      data-inspector-trigger="shell"
      onClick={toggle}
      aria-label={collapsed ? "Show details rail" : "Hide details rail"}
      title={`${collapsed ? "Show" : "Hide"} details (⌥⌘B)`}
    >
      <SidebarIcon className="size-4 scale-x-[-1]" />
    </Button>
  );
}

/** Search and usage form one elastic, window-centred toolbar group. */
function CommandCluster({ onCommandPalette }: { onCommandPalette(): void }) {
  return (
    <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2">
      <CommandPaletteTrigger onClick={onCommandPalette} />
      <UsageLimitsPopover />
    </div>
  );
}

/**
 * The chrome band's ⌘K trigger opens the app-wide ticket/session/page destination
 * picker. It is a button, not a board filter: the palette can move directly to
 * a ticket document or an already-running terminal from anywhere in the app.
 */
function CommandPaletteTrigger({ onClick }: { onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-label="Search tickets, sessions, and commands"
      title="Search tickets, sessions, and commands (⌘K)"
      className="search-capsule glass-control app-region-no-drag flex h-(--spacing-chrome-control) w-[380px] max-w-[40vw] items-center gap-2 px-3 text-left text-ui text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">Search tickets, sessions, and commands</span>
      {/* The keycap reads as cut out of the pill, so it goes the other way:
          toward the canvas floor. `--background` is near-black in dark (what
          the literal used to be) and near-white in light, which is what a key
          cap looks like on a light chrome. */}
      <kbd className="shrink-0 font-sans text-label text-muted-foreground">⌘K</kbd>
    </button>
  );
}
