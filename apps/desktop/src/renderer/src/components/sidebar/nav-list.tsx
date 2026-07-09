import { FolderTree, SquareKanban, Terminal } from "lucide-react";

import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@renderer/components/ui/sidebar";
import { useUiStore, type NavKey } from "@renderer/stores/ui";

const NAV_ITEMS: ReadonlyArray<{ key: NavKey; label: string; icon: typeof SquareKanban }> = [
  { key: "board", label: "Board", icon: SquareKanban },
  { key: "sessions", label: "Sessions", icon: Terminal },
  { key: "files", label: "Files", icon: FolderTree },
];

/** Primary feature navigation: Board / Sessions / Files. Settings lives in the sidebar footer. */
export function NavList() {
  const activeNav = useUiStore((state) => state.activeNav);
  const setActiveNav = useUiStore((state) => state.setActiveNav);

  return (
    <SidebarGroup>
      <SidebarMenu>
        {NAV_ITEMS.map(({ key, label, icon: Icon }) => (
          <SidebarMenuItem key={key}>
            <SidebarMenuButton isActive={activeNav === key} onClick={() => setActiveNav(key)}>
              <Icon />
              <span>{label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
