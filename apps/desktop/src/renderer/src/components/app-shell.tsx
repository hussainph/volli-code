import * as React from "react";

import { ChromeBar } from "@renderer/components/chrome-bar";
import { NewTicketDialog } from "@renderer/components/board/new-ticket-dialog";
import { MainContent } from "@renderer/components/pages/main-content";
import { ProjectRail } from "@renderer/components/rail/project-rail";
import { PrimarySidebar } from "@renderer/components/sidebar/primary-sidebar";
import { SidebarResizeHandle } from "@renderer/components/sidebar/sidebar-resize-handle";
import { Sidebar, SidebarInset, SidebarProvider } from "@renderer/components/ui/sidebar";
import { Toaster } from "@renderer/components/ui/sonner";
import { takeBootNotice } from "@renderer/lib/boot-notice";
import { takeCliLaunchNotice } from "@renderer/lib/cli-launch-notice";
import { toastError } from "@renderer/lib/toast";
import { useNavHistory } from "@renderer/hooks/use-nav-history";
import { useNewTicketShortcut } from "@renderer/hooks/use-new-ticket-shortcut";
import { useProjectShortcuts } from "@renderer/hooks/use-project-shortcuts";
import { cn } from "@renderer/lib/utils";
import { errorMessage } from "@volli/shared";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";
import { toast } from "sonner";

const WORKSPACE_RAIL_WIDTH = 60;
const COLLAPSED_NAV_WIDTH = 48;

/**
 * Window shell, sidebar-09 composition: a collapsible two-pane sidebar (60px
 * project rail + resizable primary sidebar) beside the main content.
 * Collapsing (⌘B) keeps the rail plus a 48px icon strip of the primary nav
 * (sidebar-07 style), so navigation stays one click away.
 *
 * ChromeBar owns the top 40px of window chrome and sits above the sidebar +
 * content row, so SidebarProvider lays out as a column (h-svh, not the stock
 * min-h-svh row) with ChromeBar first.
 */
export function AppShell() {
  useProjectShortcuts();
  useNewTicketShortcut();
  useNavHistory();
  useProjectRootsSync();
  useZoomCommands();
  useBootNotice();
  useCliLaunchNotice();
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  const workspaceRailHidden = useUiStore((state) => state.workspaceRailHidden);
  const terminalFocusTarget = useUiStore((state) => state.terminalFocusTarget);
  const uiScale = useUiStore((state) => state.uiScale);
  const [resizing, setResizing] = React.useState(false);
  const terminalFocused = terminalFocusTarget !== null;
  const [focusGeometryInstant, setFocusGeometryInstant] = React.useState(false);
  const previousTerminalFocused = React.useRef(terminalFocused);
  const workspaceRailWidth = workspaceRailHidden || terminalFocused ? 0 : WORKSPACE_RAIL_WIDTH;

  // A timed sidebar-width transition sends a cascade of intermediate PTY
  // resizes while entering/exiting focus. Hold the shell's existing
  // data-motion=instant escape hatch through the first frame of either change,
  // producing one settled grid resize instead.
  React.useLayoutEffect(() => {
    if (previousTerminalFocused.current === terminalFocused) return;
    previousTerminalFocused.current = terminalFocused;
    setFocusGeometryInstant(true);
    const frame = window.requestAnimationFrame(() => setFocusGeometryInstant(false));
    return () => window.cancelAnimationFrame(frame);
  }, [terminalFocused]);

  return (
    <SidebarProvider
      className="h-svh flex-col"
      data-motion={terminalFocused || focusGeometryInstant ? "instant" : undefined}
      data-resizing={resizing || undefined}
      style={
        {
          // `sidebarWidth` stores the full two-tier width. When the workspace
          // rail is hidden, subtract its 60px instead of letting the primary
          // sidebar expand into that space — the canvas genuinely gains it.
          "--sidebar-width": terminalFocused
            ? "0px"
            : `${sidebarWidth - (WORKSPACE_RAIL_WIDTH - workspaceRailWidth)}px`,
          // Collapsed = optional workspace rail + 48px nav icon strip.
          "--sidebar-width-icon": terminalFocused
            ? "0px"
            : `${COLLAPSED_NAV_WIDTH + workspaceRailWidth}px`,
          // 60px: a ring-2/offset-3 selected tile (36px + 10) keeps 7px of
          // air to each rail edge.
          "--rail-width": `${workspaceRailWidth}px`,
        } as React.CSSProperties
      }
    >
      <ChromeBar />
      {/* ui/sidebar.tsx's fixed sidebar-container positions itself via
          inset-y-0 relative to the nearest containing-block-establishing
          ancestor. contain-layout makes THIS row that ancestor (instead of
          the viewport), so the sidebar starts below ChromeBar and its height
          tracks this row, not the window; h-full below (overriding the
          Sidebar's own h-svh) makes that height resolve exactly, not just
          get clipped at the window edge. */}
      {/* UI-zoom invariant: CSS `zoom` scales everything BELOW the chrome band
          (sidebar + content), never the band itself and never SidebarProvider —
          so the band stays at native scale and its SidebarTrigger keeps aligning
          with the fixed native traffic lights (which don't scale). Unlike
          transform:scale, CSS `zoom` participates in layout, so terminal
          canvases and ResizeObservers below see real resized boxes. `zoom` is
          missing from this TS lib's CSSProperties, hence the same cast style
          used for the CSS custom properties above. */}
      <div
        className="flex min-h-0 flex-1 bg-rail contain-layout"
        style={{ zoom: uiScale } as React.CSSProperties}
      >
        <Sidebar
          collapsible="icon"
          aria-hidden={terminalFocused || undefined}
          inert={terminalFocused}
          className={cn(
            "h-full overflow-hidden *:data-[sidebar=sidebar]:flex-row",
            terminalFocused && "invisible",
          )}
        >
          <Sidebar
            collapsible="none"
            data-workspace-rail
            aria-hidden={workspaceRailHidden}
            inert={workspaceRailHidden}
            className={cn(
              "w-(--rail-width) shrink-0 overflow-hidden bg-rail transition-[width,opacity] duration-[180ms] ease-swift",
              "group-data-[resizing]/sidebar-wrapper:transition-none group-data-[motion=instant]/sidebar-wrapper:transition-none",
              workspaceRailHidden && "opacity-0",
            )}
          >
            <ProjectRail />
          </Sidebar>
          <Sidebar collapsible="none" className="min-w-0 flex-1">
            <PrimarySidebar />
          </Sidebar>
          <SidebarResizeHandle onResizingChange={setResizing} />
        </Sidebar>
        {/* The framed content surface (docs/DESIGN.md, amends the flat
            chrome-band treatment): every page — sessions layer included —
            renders inside this one card, floating on the rail-dark backdrop
            with a hairline border. overflow-hidden clips full-bleed children
            (tab strips, terminals) to the rounded corners. */}
        <SidebarInset
          className={cn(
            "overflow-hidden",
            terminalFocused ? "m-0 rounded-none border-0" : "m-2 rounded-xl border border-border",
          )}
        >
          <MainContent />
        </SidebarInset>
      </div>
      <Toaster />
      <NewTicketDialog />
    </SidebarProvider>
  );
}

/**
 * Bridges the native View-menu zoom items (⌘+/⌘-/⌘0) to the ui store. The
 * menu handlers live in the main process (menu.ts) because global accelerators
 * must; they only fire an event, and the store — not Electron's page zoom —
 * owns UI scale so the chrome band stays at native scale (see the zoom
 * invariant on the content row above).
 */
function useZoomCommands() {
  React.useEffect(() => {
    return window.api.window.onZoomCommand((cmd) => {
      const { stepUiScale, resetUiScale } = useUiStore.getState();
      if (cmd === "in") stepUiScale(1);
      else if (cmd === "out") stepUiScale(-1);
      else resetUiScale();
    });
  }, []);
}

/**
 * Surfaces a one-shot boot notice (e.g. a failed legacy import) as a toast on
 * mount. boot() runs before the Toaster mounts, so it stashes the message
 * rather than toasting directly (see lib/boot-notice.ts). `takeBootNotice`
 * clears as it reads, so StrictMode's double-invoke surfaces it exactly once.
 */
function useBootNotice() {
  React.useEffect(() => {
    const notice = takeBootNotice();
    if (notice !== null) toastError(notice);
  }, []);
}

function useCliLaunchNotice() {
  React.useEffect(() => {
    const notice = takeCliLaunchNotice(window.api.app.launchedByCli);
    if (notice !== null) toast.info(notice);
  }, []);
}

/** Mirrors tracked project paths into the main process's fs-root allowlist. */
function useProjectRootsSync() {
  // Key on the SET of paths, not the array identity: a rail reorder churns a
  // fresh projects array on every pointer-cross (live shuffle) yet never
  // changes the allowlist, so an order-independent digest keeps a single drag
  // from firing a burst of redundant syncRoots IPC round-trips.
  const rootsKey = useProjectsStore((state) =>
    state.projects
      .map((project) => project.path)
      .toSorted()
      .join("\n"),
  );

  React.useEffect(() => {
    const paths = useProjectsStore.getState().projects.map((project) => project.path);
    window.api.projects.syncRoots(paths).catch((error: unknown) => {
      toastError(`Could not sync project roots: ${errorMessage(error)}`);
    });
  }, [rootsKey]);
}
