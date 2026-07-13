import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";

import { ActiveSessions } from "@renderer/components/sidebar/active-sessions";
import { FileTree } from "@renderer/components/sidebar/file-tree";
import { NavList } from "@renderer/components/sidebar/nav-list";
import {
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@renderer/components/ui/sidebar";
import { useActiveNav } from "@renderer/hooks/use-active-nav";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { cn } from "@renderer/lib/utils";
import { useUiStore } from "@renderer/stores/ui";

/**
 * Two-tier sidebar's right pane: project header, feature nav, contextual
 * content keyed to the active nav item, and a pinned Settings footer entry.
 * With no project selected, nav + contextual content stay intentionally quiet:
 * the first-run canvas owns the explanatory import state and primary action.
 *
 * Expanded and collapsed presentations live in separate fixed-width layers.
 * The outer sidebar clips and cross-fades those layers while its width moves,
 * so text never reflows through intermediate widths and the collapsed icons
 * keep stable, symmetrical positions.
 */
export function PrimarySidebar() {
  const { state: sidebarState } = useSidebar();
  const selected = useSelectedProject();
  const [activeNav] = useActiveNav();
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);
  const collapsed = sidebarState === "collapsed";

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div
        aria-hidden={collapsed}
        inert={collapsed}
        data-sidebar-presentation="expanded"
        className={cn(
          "absolute inset-y-0 left-0 flex min-h-0 w-[calc(var(--sidebar-width)-var(--rail-width))] flex-col overflow-hidden",
          "transition-[opacity,transform] duration-[120ms] ease-swift group-data-[motion=instant]/sidebar-wrapper:transition-none motion-reduce:transform-none motion-reduce:transition-opacity motion-reduce:duration-100",
          collapsed
            ? "pointer-events-none -translate-x-1.5 opacity-0"
            : "translate-x-0 opacity-100 delay-[30ms]",
        )}
      >
        {/* ChromeBar above owns the traffic lights and the drag region — this
            is now a plain panel header. */}
        <SidebarHeader className="px-4 py-3">
          {selected ? (
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{selected.name}</div>
              <div className="text-xs text-muted-foreground">{selected.ticketPrefix}</div>
            </div>
          ) : (
            <div className="text-sm font-medium text-sidebar-foreground">Projects</div>
          )}
        </SidebarHeader>

        {selected ? (
          <>
            <NavList />
            <SidebarContent className="overflow-x-hidden">
              {/* Render-hidden, not unmounted, across nav switches so the file
                  tree keeps its lazily-fetched listings and expansion state
                  (same keep-alive seam main-content.tsx documents for pages). */}
              <div className={cn((settingsOpen || activeNav !== "files") && "hidden")}>
                <FileTree key={selected.id} project={selected} />
              </div>
              <div
                className={cn(
                  (settingsOpen || (activeNav !== "board" && activeNav !== "sessions")) && "hidden",
                )}
              >
                <ActiveSessions project={selected} />
              </div>
            </SidebarContent>
          </>
        ) : (
          <SidebarContent />
        )}

        <SidebarFooter>
          <SettingsMenuButton active={settingsOpen} onSelect={() => setSettingsOpen(true)} />
        </SidebarFooter>
      </div>

      <div
        aria-hidden={!collapsed}
        inert={!collapsed}
        data-sidebar-presentation="collapsed"
        className={cn(
          "absolute inset-y-0 left-0 flex w-[calc(var(--sidebar-width-icon)-var(--rail-width))] flex-col overflow-hidden",
          "transition-[opacity,transform] duration-[120ms] ease-swift group-data-[motion=instant]/sidebar-wrapper:transition-none motion-reduce:transform-none motion-reduce:transition-opacity motion-reduce:duration-100",
          collapsed
            ? "translate-x-0 opacity-100 delay-[30ms]"
            : "pointer-events-none translate-x-1.5 opacity-0",
        )}
      >
        {/* Equal 8px top and bottom insets keep the icon rail visually balanced. */}
        {selected && <NavList collapsed />}
        <div className="min-h-0 flex-1" />
        <SidebarFooter className="p-2">
          <SettingsMenuButton
            active={settingsOpen}
            collapsed
            onSelect={() => setSettingsOpen(true)}
          />
        </SidebarFooter>
      </div>
    </div>
  );
}

function SettingsMenuButton({
  active,
  collapsed = false,
  onSelect,
}: {
  active: boolean;
  collapsed?: boolean;
  onSelect(): void;
}) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          aria-label={collapsed ? "Settings" : undefined}
          tooltip={collapsed ? "Settings" : undefined}
          isActive={active}
          onClick={onSelect}
        >
          <GearSixIcon weight="fill" />
          {!collapsed && <span>Settings</span>}
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
