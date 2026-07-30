import * as React from "react";

import { ChromeBar } from "@renderer/components/chrome-bar";
import { HarnessTrustDialog } from "@renderer/components/harness/harness-trust-dialog";
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
// 56px of nav strip + the 1px `border-r` sidebar-container spends on itself
// (--sidebar-edge below). The width tokens are BORDER-box, so the two panes
// inside only ever share one pixel less than the number written here — 57 is
// what leaves the strip a true 56, which centers the menu's 32px pill on the
// same 12px flanks the project rail gives its 36px tile inside 60.
const COLLAPSED_NAV_WIDTH = 57;

/**
 * Window shell, sidebar-09 composition: a collapsible two-pane sidebar (60px
 * project rail + resizable primary sidebar) beside the main content.
 * Collapsing (⌘B) keeps the rail plus a 56px icon strip of the primary nav
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
      // No fill of its own: the canvas IS the backdrop and it is painted on
      // `<html>` (globals.css), where it is outside every zoom and outside
      // React — which is what lets it be correct before any JS runs. A fill
      // here would simply cover it.
      className="relative h-svh flex-col"
      // Arms the seam's geometry (globals.css). The framed arrangement — one
      // inset unit with the canvas running around it — is exactly what terminal
      // focus takes away, and the seam's rules are unlayered author CSS, so a
      // Tailwind `m-0` on the card cannot switch them off from the other side.
      // One attribute, read by every rule that participates.
      data-volli-shell={terminalFocused ? "focused" : "framed"}
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
          // Collapsed = optional workspace rail + 56px nav icon strip.
          "--sidebar-width-icon": terminalFocused
            ? "0px"
            : `${COLLAPSED_NAV_WIDTH + workspaceRailWidth}px`,
          // 60px: a ring-2/offset-3 selected tile (36px + 10) keeps 7px of
          // air to each rail edge.
          "--rail-width": `${workspaceRailWidth}px`,
          // The hairline `sidebar-container` spends on its own `border-r`
          // (ui/sidebar.tsx). Both width tokens above are border-box widths of
          // that element, so the rail and the primary pane divide one pixel
          // less than either says — anything sized off the token arithmetic
          // has to give this back or it overhangs by exactly 1px, and the
          // parent's overflow-hidden shaves it off the right. Named once here
          // rather than as a bare literal in each pane's `calc()`.
          "--sidebar-edge": "1px",
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
      {/* No fill of its own: the canvas on `<html>` IS the backdrop, and a fill
          here would simply cover it. */}
      <div
        className="flex min-h-0 flex-1 contain-layout"
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
              // Transparent, not `bg-rail`: the rail was already painted in the
              // backdrop's own token, so it has nothing of its own to give up —
              // it simply sits on the canvas now.
              "w-(--rail-width) shrink-0 overflow-hidden bg-transparent transition-[width,opacity] duration-[180ms] ease-swift",
              "group-data-[resizing]/sidebar-wrapper:transition-none group-data-[motion=instant]/sidebar-wrapper:transition-none",
              workspaceRailHidden && "opacity-0",
            )}
          >
            <ProjectRail />
          </Sidebar>
          {/* The lifted half of the seam, and the one on-canvas tier that moves
              (globals.css § ELEVATION). It carries no fill of its own: `--lift-2`
              composites over the gradient as a background IMAGE, and a veil
              underneath would be a second mechanism pushing the same way — see
              the note on that rule.

              `data-volli-sidebar` rather than a utility class, because the seam
              has to name this element specifically: it is one of three
              `data-slot="sidebar"` roots in this tree, and selecting it by a
              fill it no longer has was how the lab did it. */}
          <Sidebar collapsible="none" data-volli-sidebar className="min-w-0 flex-1">
            <PrimarySidebar />
          </Sidebar>
          <SidebarResizeHandle onResizingChange={setResizing} />
        </Sidebar>
        {/* The framed content surface (docs/DESIGN.md, amends the flat
            chrome-band treatment): every page — sessions layer included —
            renders inside this one card, floating on the rail-dark backdrop
            with a hairline border. overflow-hidden clips full-bleed children
            (tab strips, terminals) to the rounded corners. */}
        {/* Grain is no longer a layer here: the canvas draws it as a gradient
            layer of its own, on the surface it is actually visible on. The card
            is opaque paper above it. */}
        <SidebarInset
          // Names the app's principal surface for probes that need to anchor on
          // the card rather than guess at it.
          data-volli-surface=""
          className={cn(
            "overflow-hidden",
            // Margin, radius and the seam-facing border are the seam's
            // (globals.css) in the framed arrangement; what stays here is the
            // hairline the card draws on its own three outer edges, and the
            // full-bleed shape terminal focus collapses it to.
            terminalFocused ? "m-0 rounded-none border-0" : "border border-border",
          )}
        >
          <MainContent />
        </SidebarInset>
      </div>
      <Toaster />
      <NewTicketDialog />
      <HarnessTrustDialog />
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
      toastError(`Couldn't sync project roots: ${errorMessage(error)}`);
    });
  }, [rootsKey]);
}
