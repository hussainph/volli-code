import { FolderTree, SquareKanban, Terminal } from "lucide-react";

import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@renderer/components/ui/sidebar";
import { useActiveNav } from "@renderer/hooks/use-active-nav";
import type { NavKey } from "@renderer/stores/workspace";

const NAV_ITEMS: ReadonlyArray<{ key: NavKey; label: string; icon: typeof SquareKanban }> = [
  { key: "board", label: "Board", icon: SquareKanban },
  { key: "sessions", label: "Sessions", icon: Terminal },
  { key: "files", label: "Files", icon: FolderTree },
];

/** Primary feature navigation: Board / Sessions / Files. Settings lives in the sidebar footer. */
export function NavList() {
  const [activeNav, setActiveNav] = useActiveNav();

  return (
    <SidebarGroup>
      <SidebarMenu>
        {NAV_ITEMS.map(({ key, label, icon: Icon }) => (
          <SidebarMenuItem key={key}>
            {/* tooltip only shows in the collapsed icon strip (stock behavior). */}
            <SidebarMenuButton
              tooltip={label}
              isActive={activeNav === key}
              onClick={() => setActiveNav(key)}
            >
              <Icon />
              <span>{label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
