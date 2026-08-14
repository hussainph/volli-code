import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";

import { ActiveSessions } from "@renderer/components/sidebar/active-sessions";
import { FileTree } from "@renderer/components/sidebar/file-tree";
import { NavList } from "@renderer/components/sidebar/nav-list";
import { SidebarScrollArea } from "@renderer/components/sidebar/sidebar-scroll";
import {
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@renderer/components/ui/sidebar";
import { useActiveNav } from "@renderer/hooks/use-active-nav";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { cn } from "@renderer/lib/utils";
import { useUiStore } from "@renderer/stores/ui";

/**
 * The sidebar panel's contents: project header, feature nav, contextual content
 * keyed to the active nav item, and a pinned Settings footer entry. With no
 * project selected, nav + contextual content stay intentionally quiet: the
 * first-run canvas owns the explanatory import state and primary action.
 *
 * ONE presentation, not two. There used to be a second, fixed-width layer here
 * carrying the collapsed icon strip, cross-faded against this one while the
 * shell animated its width. The strip is gone — collapsed is now genuinely zero
 * and the panel is summoned by the pointer or pinned by ⌘B (app-shell.tsx) —
 * so with nothing to cross-fade against, the layer and its transition went with
 * it. What the strip sized itself from, `--sidebar-width-icon`, did NOT: the
 * token is still declared and still written onto the wrapper by
 * `components/ui/sidebar.tsx`, along with the `collapsible="icon"` variants,
 * `data-slot="sidebar-gap"` and `data-slot="sidebar-container"` that read it.
 * Nothing in this app sets `collapsible` to anything but `"none"` any more, so
 * all of it is unreachable rather than gone — a deletion of its own, tracked in
 * the branch ledger, not a claim this file gets to make.
 *
 * What stays is the fixed width, which was never about the cross-fade: the pane
 * sizes itself off the shell's width tokens rather than `100%` so it is the same
 * pane whether the panel is docked into the seam or floating over the canvas —
 * two arrangements whose parent boxes differ by exactly the borders
 * `--sidebar-edge` names. Those tokens are border-box widths, so that edge has
 * to come out of the calc or the pane is wider than the box clipping it and the
 * overhang is shaved off the right.
 */
export function PrimarySidebar() {
  const selected = useSelectedProject();
  const [activeNav] = useActiveNav();
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);
  const sessionsVisible = !settingsOpen && (activeNav === "board" || activeNav === "sessions");

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div
        data-sidebar-presentation="expanded"
        className="absolute inset-y-0 left-0 flex min-h-0 w-[calc(var(--sidebar-width)-var(--rail-width)-var(--sidebar-edge))] flex-col overflow-hidden"
      >
        {/* ChromeBar above owns the traffic lights and the drag region — this
            is now a plain panel header. */}
        <SidebarHeader className="px-4 py-4">
          {selected ? (
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{selected.name}</div>
              <div className="text-ui text-muted-foreground">{selected.ticketPrefix}</div>
            </div>
          ) : (
            <div className="text-sm font-medium text-sidebar-foreground">Projects</div>
          )}
        </SidebarHeader>

        {selected ? (
          <>
            <NavList />
            <SidebarScrollArea>
              {/* Render-hidden, not unmounted, across nav switches so the file
                  tree keeps its lazily-fetched listings and expansion state
                  (same keep-alive seam main-content.tsx documents for pages). */}
              <div className={cn((settingsOpen || activeNav !== "files") && "hidden")}>
                <FileTree key={selected.id} project={selected} />
              </div>
              <div className={cn(!sessionsVisible && "hidden")}>
                {/* Render-hidden, not unmounted (above) — so the section cannot
                    tell it is off screen, and the coarse chat-activity poll it
                    runs would keep firing behind Files or Settings. `visible`
                    is that fact, handed down from the one place that has it. */}
                <ActiveSessions project={selected} visible={sessionsVisible} />
              </div>
            </SidebarScrollArea>
          </>
        ) : (
          <SidebarContent />
        )}

        <SidebarFooter>
          <SettingsMenuButton active={settingsOpen} onSelect={() => setSettingsOpen(true)} />
        </SidebarFooter>
      </div>
    </div>
  );
}

function SettingsMenuButton({ active, onSelect }: { active: boolean; onSelect(): void }) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton isActive={active} onClick={onSelect}>
          <GearSixIcon />
          <span>Settings</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
