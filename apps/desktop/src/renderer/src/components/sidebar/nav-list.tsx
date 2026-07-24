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
  // Routing keys off `key`; the label is presentation only (renamed to
  // "Terminals" while the sessions surface keeps its "sessions" identity).
  { key: "sessions", label: "Terminals", icon: TerminalWindowIcon },
  { key: "files", label: "Files", icon: FoldersIcon },
  { key: "configure", label: "Configure", icon: SlidersHorizontalIcon },
];

interface NavListProps {
  /** The collapsed presentation is a separate fixed-width layer so its icons
   * never respond to the outer sidebar's in-between animation widths. */
  collapsed?: boolean;
}

/** Primary feature navigation: Board / Terminals / Files / Configure. App-wide Settings lives in the sidebar footer. */
export function NavList({ collapsed = false }: NavListProps) {
  const [activeNav, setActiveNav] = useActiveNav();
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);

  return (
    <SidebarGroup className={collapsed ? "p-2" : undefined}>
      <SidebarMenu>
        {NAV_ITEMS.map(({ key, label, icon: Icon }) => (
          <SidebarMenuItem key={key}>
            {/* tooltip only shows in the collapsed icon strip (stock behavior).
                The Settings overlay dims the nav highlight and any click closes
                it — picking a page always lands you on that page. */}
            <SidebarMenuButton
              aria-label={collapsed ? label : undefined}
              tooltip={collapsed ? label : undefined}
              isActive={!settingsOpen && activeNav === key}
              onClick={() => {
                setSettingsOpen(false);
                setActiveNav(key);
              }}
            >
              <Icon weight="fill" />
              {!collapsed && <span>{label}</span>}
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
