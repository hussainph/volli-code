import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { FoldersIcon } from "@phosphor-icons/react/dist/csr/Folders";
import { HouseIcon } from "@phosphor-icons/react/dist/csr/House";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";

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
  // Not Kanban any more. The row used to name a board and now names a tabbed
  // environment whose board is one tab of several, so the glyph has to name the
  // PLACE rather than the first thing in it — the board keeps Kanban on its own
  // tab, where it is the exception among Session tabs and still means a board.
  { key: "home", label: "Home", icon: HouseIcon },
  { key: "files", label: "Files", icon: FoldersIcon },
  { key: "configure", label: "Configure", icon: SlidersHorizontalIcon },
];

/**
 * Primary feature navigation: Home / Files / Configure. App-wide Settings lives
 * in the sidebar footer.
 *
 * Three rows, not four: the Sessions page is gone, and its Sessions live inside
 * Home as tabs (VC-54). Files and Configure deliberately stay OUT of Home — the
 * guardrail on this shape is that Home must not become a junk drawer.
 */
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
