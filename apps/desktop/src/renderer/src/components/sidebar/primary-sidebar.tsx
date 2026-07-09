import { SidebarContent, SidebarHeader, SidebarSeparator } from "@renderer/components/ui/sidebar";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";

/** Stub: navigation (board / sessions / files / settings) lands in the next work package. */
export function PrimarySidebar() {
  const selected = useSelectedProject();

  return (
    <>
      <SidebarHeader className="app-region-drag px-4 py-3">
        {selected ? (
          <div className="app-region-no-drag min-w-0">
            <div className="truncate text-sm font-semibold">{selected.name}</div>
            <div className="text-xs text-muted-foreground">{selected.ticketPrefix}</div>
          </div>
        ) : (
          <div className="app-region-no-drag text-sm text-muted-foreground">
            Add a project to get started
          </div>
        )}
      </SidebarHeader>
      <SidebarSeparator />
      <SidebarContent className="p-4">
        <p className="text-sm text-muted-foreground">Navigation lands in the next commit</p>
      </SidebarContent>
    </>
  );
}
