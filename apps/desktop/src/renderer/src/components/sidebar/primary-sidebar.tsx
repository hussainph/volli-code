import { Settings } from "lucide-react";
import { toast } from "sonner";

import { ActiveSessions } from "@renderer/components/sidebar/active-sessions";
import { FileTree } from "@renderer/components/sidebar/file-tree";
import { NavList } from "@renderer/components/sidebar/nav-list";
import { Button } from "@renderer/components/ui/button";
import {
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@renderer/components/ui/sidebar";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { errorMessage } from "@renderer/lib/errors";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";

/**
 * Two-tier sidebar's right pane: project header, feature nav, contextual
 * content keyed to the active nav item, and a pinned Settings footer entry.
 * With no project selected, nav + contextual content are replaced by an
 * "add a project" prompt (header and footer stay put).
 */
export function PrimarySidebar() {
  const selected = useSelectedProject();
  const addProject = useProjectsStore((state) => state.addProject);
  const activeNav = useUiStore((state) => state.activeNav);
  const setActiveNav = useUiStore((state) => state.setActiveNav);

  async function pickAndAdd() {
    try {
      const result = await window.api.projects.pickFolder();
      // Duplicate paths are handled inside the store (it selects the existing project).
      if (!result.canceled) addProject({ path: result.path, defaultName: result.defaultName });
    } catch (error) {
      toast.error(`Could not open folder picker: ${errorMessage(error)}`);
    }
  }

  return (
    <>
      <SidebarHeader className="app-region-drag px-4 py-3">
        {/* Static text stays draggable — only interactive children opt out. */}
        {selected ? (
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{selected.name}</div>
            <div className="text-xs text-muted-foreground">{selected.ticketPrefix}</div>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">No project selected</div>
        )}
      </SidebarHeader>

      {selected ? (
        <>
          <NavList />
          <SidebarContent>
            {activeNav === "files" && <FileTree key={selected.id} project={selected} />}
            {(activeNav === "board" || activeNav === "sessions") && (
              <ActiveSessions project={selected} />
            )}
          </SidebarContent>
        </>
      ) : (
        <SidebarContent className="items-center justify-center gap-3 p-4 text-center">
          <p className="text-sm text-muted-foreground">Add a project to get started</p>
          <Button size="sm" className="app-region-no-drag" onClick={() => void pickAndAdd()}>
            Add Project…
          </Button>
        </SidebarContent>
      )}

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={activeNav === "settings"}
              onClick={() => setActiveNav("settings")}
            >
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
