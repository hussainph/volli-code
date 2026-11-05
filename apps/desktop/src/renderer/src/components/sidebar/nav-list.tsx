import { type IconComponent, HomeIcon, AutomationIcon } from "@renderer/components/ui/icon";

import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@renderer/components/ui/sidebar";
import { useActiveNav } from "@renderer/hooks/use-active-nav";
import { useUiStore } from "@renderer/stores/ui";
import type { NavKey } from "@renderer/stores/project-ui";

const NAV_ITEMS: ReadonlyArray<{ key: NavKey; label: string; icon: IconComponent }> = [
  // Not Kanban any more. The row used to name a board and now names a tabbed
  // environment whose board is one tab of several, so the glyph has to name the
  // PLACE rather than the first thing in it — the board keeps Kanban on its own
  // tab, where it is the exception among Session tabs and still means a board.
  { key: "home", label: "Home", icon: HomeIcon },
  // The lightning bolt is the feature's mark everywhere it appears — the
  // `automation` Actor's glyph on a Session, and this row. One drawing for one
  // concept, so the nav row and the provenance mark are recognisably the
  // same thing (VC-112, "Observability").
  { key: "automations", label: "Automations", icon: AutomationIcon },
];

/** Primary feature navigation. Agent configuration lives in the Settings footer. */
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
