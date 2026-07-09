import * as React from "react";
import { toast } from "sonner";

import { MainContent } from "@renderer/components/pages/main-content";
import { ProjectRail } from "@renderer/components/rail/project-rail";
import { PrimarySidebar } from "@renderer/components/sidebar/primary-sidebar";
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

/**
 * Window shell, sidebar-09 composition: a collapsible two-pane sidebar (68px
 * project rail + primary sidebar) beside the main content. Collapsing leaves
 * just the rail visible.
 */
export function AppShell() {
  useProjectShortcuts();
  useProjectRootsSync();

  return (
    <SidebarProvider
      style={{ "--sidebar-width": "318px", "--sidebar-width-icon": "68px" } as React.CSSProperties}
    >
      <Sidebar collapsible="icon" className="overflow-hidden *:data-[sidebar=sidebar]:flex-row">
        <Sidebar collapsible="none" className="w-(--sidebar-width-icon) shrink-0 bg-rail">
          <ProjectRail />
        </Sidebar>
        <Sidebar collapsible="none" className="min-w-0 flex-1">
          <PrimarySidebar />
        </Sidebar>
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
  const projects = useProjectsStore((state) => state.projects);

  React.useEffect(() => {
    window.api.projects
      .syncRoots(projects.map((project) => project.path))
      .catch((error: unknown) => {
        toast.error(`Could not sync project roots: ${errorMessage(error)}`);
      });
  }, [projects]);
}
