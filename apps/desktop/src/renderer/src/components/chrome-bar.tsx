import * as React from "react";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { SidebarIcon } from "@phosphor-icons/react/dist/csr/Sidebar";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import { Button } from "@renderer/components/ui/button";
import { SidebarTrigger } from "@renderer/components/ui/sidebar";
import { useFullScreen } from "@renderer/hooks/use-fullscreen";
import { navBack, navForward } from "@renderer/hooks/use-nav-history";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { cn } from "@renderer/lib/utils";
import { canGoBack, canGoForward } from "@renderer/lib/nav-history";
import { useBoardStore } from "@renderer/stores/board";
import { useUiStore } from "@renderer/stores/ui";
import { useWorkspaceStore } from "@renderer/stores/workspace";

/**
 * Full-width window chrome band — the ONLY drag-region owner for window
 * chrome (traffic lights, drag-to-move, the sidebar toggle). Everything
 * below it is ordinary layout. Its height (h-10, 40px) must stay in sync
 * with trafficLightPosition in main/index.ts, which centers the lights
 * inside it.
 */
export function ChromeBar() {
  const fullScreen = useFullScreen();

  return (
    // relative: the search pill centers itself against the band, not the flex
    // row, so it stays put in the window when the traffic-light spacer
    // collapses in fullscreen.
    <div className="app-region-drag relative flex h-10 shrink-0 items-center bg-rail">
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
      <UniversalSearchPill />
      {/* The content-area tab strip (if any) lives below in MainContent, not here. */}
      <div className="flex-1" />
      <RightRailToggle />
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
      className="size-7"
      aria-pressed={workspaceRailHidden}
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
        className="size-7"
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
        className="size-7"
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
      className="app-region-no-drag mr-1 size-7 translate-y-px"
      aria-pressed={railCollapsed}
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
 * The chrome band's ⌘K center: the band was designed with its middle reserved
 * for a command surface (Slack-style), and this pill claims it as universal
 * search. Board search state lives per-project in the board store
 * (filterByProject[id].search) — the pill is just another writer of it, so
 * board filtering keeps working unchanged.
 *
 * Absolutely centered so it anchors to the WINDOW's midline regardless of the
 * traffic-light spacer / fullscreen collapse. Overlap math at minWidth 940px
 * (main/index.ts): left chrome occupies ≈110px (78px spacer + trigger); the
 * pill's left edge sits at (940 − 380) / 2 = 280px — comfortably clear.
 * max-w-[40vw] only shrinks it further on narrow windows.
 */
function UniversalSearchPill() {
  const project = useSelectedProject();
  const projectId = project?.id ?? null;
  // Subscribe to the search string itself (not the filter object) so the pill
  // only re-renders on actual query changes.
  const search = useBoardStore((state) =>
    projectId === null ? "" : (state.filterByProject[projectId]?.search ?? ""),
  );
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    // ⌘K routes to the pill (the band's ⌘K-center design decision — see the
    // chrome band notes). Window-level listener: focus must work from
    // anywhere, including when no input has focus.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        const input = inputRef.current;
        if (input === null || input.disabled) return;
        input.focus();
        // Select any existing query so typing replaces rather than appends.
        input.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const disabled = projectId === null;

  return (
    <div
      className={cn(
        "absolute left-1/2 top-1/2 flex h-[26px] w-[380px] max-w-[40vw] -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-md border border-border/60 bg-white/[0.06] px-2 transition-colors",
        "focus-within:border-ring/60 focus-within:ring-1 focus-within:ring-ring/40",
        // app-region-no-drag: the pill sits inside the drag region and must
        // reclaim its clicks or the window steals them as drag-to-move. Only
        // while it's live — the disabled pill (no project) is inert, so it
        // stays draggable window chrome rather than a dead strip in the band.
        disabled ? "opacity-50" : "app-region-no-drag hover:bg-white/[0.08]",
      )}
    >
      <MagnifyingGlassIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        type="text"
        value={search}
        disabled={disabled}
        onChange={(event) => {
          if (projectId !== null) useBoardStore.getState().setSearch(projectId, event.target.value);
        }}
        // "Search tickets…" exactly — the e2e smoke locates the input by this
        // placeholder. The project-less variant is never exercised by it.
        placeholder={disabled ? "Search" : "Search tickets…"}
        className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
      />
      {search !== "" ? (
        <button
          type="button"
          onClick={() => {
            if (projectId !== null) useBoardStore.getState().setSearch(projectId, "");
          }}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
