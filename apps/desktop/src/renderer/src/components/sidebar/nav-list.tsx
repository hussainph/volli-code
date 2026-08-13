import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { FoldersIcon } from "@phosphor-icons/react/dist/csr/Folders";
import { KanbanIcon } from "@phosphor-icons/react/dist/csr/Kanban";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";

import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@renderer/components/ui/sidebar";
import { useActiveNav } from "@renderer/hooks/use-active-nav";
import { useUiStore } from "@renderer/stores/ui";
import type { NavKey } from "@renderer/stores/workspace";

const NAV_ITEMS: ReadonlyArray<{ key: NavKey; label: string; icon: PhosphorIcon }> = [
  { key: "board", label: "Board", icon: KanbanIcon },
  { key: "sessions", label: "Sessions", icon: TerminalWindowIcon },
  { key: "files", label: "Files", icon: FoldersIcon },
  { key: "configure", label: "Configure", icon: SlidersHorizontalIcon },
];

/** Primary feature navigation: Board / Sessions / Files / Configure. App-wide Settings lives in the sidebar footer. */
export function NavList() {
  const [activeNav, setActiveNav] = useActiveNav();
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);

  return (
    <SidebarGroup>
      <SidebarMenu>
        {NAV_ITEMS.map(({ key, label, icon: Icon }) => (
          <SidebarMenuItem key={key}>
            {/* The Settings overlay dims the nav highlight and any click closes
                it — picking a page always lands you on that page. */}
            <SidebarMenuButton
              isActive={!settingsOpen && activeNav === key}
              onClick={() => {
                setSettingsOpen(false);
                setActiveNav(key);
              }}
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
