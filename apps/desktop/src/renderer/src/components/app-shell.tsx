import * as React from "react";
import { toast } from "sonner";

import { ChromeBar } from "@renderer/components/chrome-bar";
import { MainContent } from "@renderer/components/pages/main-content";
import { ProjectRail } from "@renderer/components/rail/project-rail";
import { PrimarySidebar } from "@renderer/components/sidebar/primary-sidebar";
import { SidebarResizeHandle } from "@renderer/components/sidebar/sidebar-resize-handle";
import { Sidebar, SidebarInset, SidebarProvider } from "@renderer/components/ui/sidebar";
import { Toaster } from "@renderer/components/ui/sonner";
import { useProjectShortcuts } from "@renderer/hooks/use-project-shortcuts";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { errorMessage } from "@volli/shared";
import { useBoardStore } from "@renderer/stores/board";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";

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
  useProjectRootsSync();
  useZoomCommands();
  useSeedSelectedProjectBoard();
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  const uiScale = useUiStore((state) => state.uiScale);
  const [resizing, setResizing] = React.useState(false);

  return (
    <SidebarProvider
      className="h-svh flex-col"
      data-resizing={resizing || undefined}
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
          // Collapsed = rail + 48px nav icon strip.
          "--sidebar-width-icon": "108px",
          // 60px: a ring-2/offset-3 selected tile (36px + 10) keeps 7px of
          // air to each rail edge.
          "--rail-width": "60px",
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
        className="flex min-h-0 flex-1 contain-layout"
        style={{ zoom: uiScale } as React.CSSProperties}
      >
        <Sidebar
          collapsible="icon"
          className="h-full overflow-hidden *:data-[sidebar=sidebar]:flex-row"
        >
          <Sidebar collapsible="none" className="w-(--rail-width) shrink-0 bg-rail">
            <ProjectRail />
          </Sidebar>
          <Sidebar collapsible="none" className="min-w-0 flex-1">
            <PrimarySidebar />
          </Sidebar>
          <SidebarResizeHandle onResizingChange={setResizing} />
        </Sidebar>
        <SidebarInset>
          <MainContent />
        </SidebarInset>
      </div>
      <Toaster />
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
 * Seeds the selected project's demo board — the ONE seeding site, so every
 * surface reading `ticketsByProject` (board page, sidebar Active Sessions, and
 * whatever comes next) is a pure reader. A layout effect: children's layout
 * effects run first, but all run before paint, and the seeding `set` re-renders
 * synchronously — so the first paint already has the seeded board. Goes away
 * with the SQLite ticket layer.
 */
function useSeedSelectedProjectBoard() {
  const project = useSelectedProject();
  React.useLayoutEffect(() => {
    if (project === null) return;
    useBoardStore.getState().ensureSeeded(project.id, project.ticketPrefix);
  }, [project]);
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
      toast.error(`Could not sync project roots: ${errorMessage(error)}`);
    });
  }, [rootsKey]);
}
