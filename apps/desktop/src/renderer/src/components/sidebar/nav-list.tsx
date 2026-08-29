import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { HouseIcon } from "@phosphor-icons/react/dist/csr/House";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
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
  // The lightning bolt is the feature's mark everywhere it appears — the
  // `automation` Actor's glyph on a Session, and this row. One drawing for one
  // concept, so the nav row and the provenance mark are recognisably the
  // same thing (VC-112, "Observability").
  { key: "automations", label: "Automations", icon: LightningIcon },
  { key: "configure", label: "Configure", icon: SlidersHorizontalIcon },
];

/**
 * Primary feature navigation: Home / Automations / Configure. App-wide
 * Settings lives in the sidebar footer.
 *
 * Three rows, and each absence below is a decision rather than a gap: the
 * Sessions page is gone, and its Sessions live inside Home as tabs (VC-54);
 * the Files page is gone too, and Main-checkout file access lives inside Home
 * as File tabs beside them, opened from the Home rail's own Files navigator
 * (VC-121/VC-122).
 *
 * Configure and Automations deliberately stay OUT of Home — the guardrail on
 * this shape is that Home must not become a junk drawer, and VC-112 cites this
 * very comment when it rules that the Automations surface is a nav page rather
 * than a room inside Home. Automations is also the ONLY surface that authors
 * an Automation; the board, the ticket rail and the palette merely run one, so
 * none of them owns a nav row.
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
