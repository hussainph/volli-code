import type { ReactNode } from "react";
import { SidebarIcon, WorkspaceIcon } from "@renderer/components/ui/icon";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { useSidebar } from "@renderer/components/ui/sidebar";
import { useUiStore } from "@renderer/stores/ui";

/** Rail visibility is a layout choice, not a second routine sidebar glyph. */
export function SidebarLayoutMenu({ children }: { children: ReactNode }) {
  const { open, toggleSidebar } = useSidebar();
  const hidden = useUiStore((state) => state.projectRailHidden);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent aria-label="Layout">
        <ContextMenuCheckboxItem
          checked={open}
          onCheckedChange={() => toggleSidebar({ instant: true })}
        >
          <SidebarIcon />
          Navigation sidebar<ContextMenuShortcut>⌘B</ContextMenuShortcut>
        </ContextMenuCheckboxItem>
        <ContextMenuCheckboxItem
          checked={!hidden}
          onCheckedChange={() => useUiStore.getState().toggleProjectRailHidden()}
        >
          <WorkspaceIcon />
          Project switcher<ContextMenuShortcut>⌘⇧S</ContextMenuShortcut>
        </ContextMenuCheckboxItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
