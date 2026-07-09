import * as React from "react";
import { toast } from "sonner";

import { MainContent } from "@renderer/components/pages/main-content";
import { ProjectRail } from "@renderer/components/rail/project-rail";
import { PrimarySidebar } from "@renderer/components/sidebar/primary-sidebar";
import { SidebarResizeHandle } from "@renderer/components/sidebar/sidebar-resize-handle";
import {
  Sidebar,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@renderer/components/ui/sidebar";
import { Toaster } from "@renderer/components/ui/sonner";
import { useProjectShortcuts } from "@renderer/hooks/use-project-shortcuts";
import { errorMessage } from "@renderer/lib/errors";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";

/**
 * Window shell, sidebar-09 composition: a collapsible two-pane sidebar (60px
 * project rail + resizable primary sidebar) beside the main content.
 * Collapsing (⌘B) keeps the rail plus a 48px icon strip of the primary nav
 * (sidebar-07 style), so navigation stays one click away.
 */
export function AppShell() {
  useProjectShortcuts();
  useProjectRootsSync();
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  const [resizing, setResizing] = React.useState(false);

  return (
    <SidebarProvider
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
      <Sidebar collapsible="icon" className="overflow-hidden *:data-[sidebar=sidebar]:flex-row">
        <Sidebar collapsible="none" className="w-(--rail-width) shrink-0 bg-rail">
          <ProjectRail />
        </Sidebar>
        <Sidebar collapsible="none" className="min-w-0 flex-1">
          <PrimarySidebar />
        </Sidebar>
        <SidebarResizeHandle onResizingChange={setResizing} />
      </Sidebar>
      <SidebarInset>
        {/* hiddenInset chrome: the top strip doubles as the window titlebar. */}
        <header className="app-region-drag flex h-[38px] shrink-0 items-center px-2">
          <SidebarTrigger className="app-region-no-drag" />
        </header>
        <MainContent />
      </SidebarInset>
      <Toaster />
    </SidebarProvider>
  );
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
