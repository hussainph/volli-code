import { Settings } from "lucide-react";

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
import { useAddProject } from "@renderer/hooks/use-add-project";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { cn } from "@renderer/lib/utils";
import { useUiStore } from "@renderer/stores/ui";

/**
 * Two-tier sidebar's right pane: project header, feature nav, contextual
 * content keyed to the active nav item, and a pinned Settings footer entry.
 * With no project selected, nav + contextual content are replaced by an
 * "add a project" prompt (header and footer stay put).
 *
 * When the sidebar collapses (⌘B) this pane narrows to a 48px icon strip:
 * the nav buttons shrink to icons with hover tooltips (stock icon-collapse
 * machinery), while the header text and contextual content hide.
 */
export function PrimarySidebar() {
  const selected = useSelectedProject();
  const pickAndAdd = useAddProject();
  const activeNav = useUiStore((state) => state.activeNav);
  const setActiveNav = useUiStore((state) => state.setActiveNav);

  return (
    <>
      {/* ChromeBar above owns the traffic lights and the drag region — this
          is now a plain panel header. */}
      <SidebarHeader className="px-4 py-3">
        {selected ? (
          <div className="min-w-0 group-data-[collapsible=icon]:hidden">
            <div className="truncate text-sm font-semibold">{selected.name}</div>
            <div className="text-xs text-muted-foreground">{selected.ticketPrefix}</div>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground group-data-[collapsible=icon]:hidden">
            No project selected
          </div>
        )}
      </SidebarHeader>

      {selected ? (
        <>
          <NavList />
          {/* Contextual content hides in the collapsed icon strip; the (empty)
              SidebarContent stays in flow so the footer keeps to the bottom. */}
          <SidebarContent>
            <div className="group-data-[collapsible=icon]:hidden">
              {/* Render-hidden, not unmounted, across nav switches so the file
                  tree keeps its lazily-fetched listings and expansion state
                  (same keep-alive seam main-content.tsx documents for pages). */}
              <div className={cn(activeNav !== "files" && "hidden")}>
                <FileTree key={selected.id} project={selected} />
              </div>
              <div className={cn(activeNav !== "board" && activeNav !== "sessions" && "hidden")}>
                <ActiveSessions project={selected} />
              </div>
            </div>
          </SidebarContent>
        </>
      ) : (
        <SidebarContent className="items-center justify-center gap-3 p-4 text-center">
          <div className="contents group-data-[collapsible=icon]:hidden">
            <p className="text-sm text-muted-foreground">Add a project to get started</p>
            <Button size="sm" className="app-region-no-drag" onClick={() => void pickAndAdd()}>
              Add Project…
            </Button>
          </div>
        </SidebarContent>
      )}

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Settings"
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
