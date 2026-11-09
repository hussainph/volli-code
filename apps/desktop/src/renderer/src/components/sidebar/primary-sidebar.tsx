import { NewSessionControl } from "@renderer/components/sessions/new-session-control";
import {
  startProjectChat,
  startProjectTerminal,
} from "@renderer/components/sessions/session-create";
import * as React from "react";
import { ControlShapeProvider } from "../ui/control-shape";
import { EmptyStateScope } from "../ui/empty-state";
import { ConversationsIcon as Chats, FolderIcon, SettingsIcon } from "@renderer/components/ui/icon";

import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { SidebarFiles } from "./sidebar-files";

import { ActiveSessions } from "@renderer/components/sidebar/active-sessions";
import { CloudMoveRailRow } from "@renderer/components/cloud-moves/cloud-moves";
import { NavList } from "@renderer/components/sidebar/nav-list";
import { UpdateButton } from "@renderer/components/sidebar/update-button";
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
import { useProjectsStore } from "@renderer/stores/projects";

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
// Plain per-window memory: no durable preference or renderer storage. The
// choice survives sidebar remounts without changing any workspace's lifetime.
const rememberedContent = new Map<string, "sessions" | "files">();

export function PrimarySidebar({ previewProjectId }: { previewProjectId?: string | null } = {}) {
  const current = useSelectedProject();
  const preview = useProjectsStore((state) =>
    previewProjectId
      ? state.projects.find((project) => project.id === previewProjectId)
      : undefined,
  );
  const selected = preview ?? current;
  const [activeNav] = useActiveNav(selected?.id);
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);
  const selectedId = selected?.id;
  const [contents, setContents] = React.useState(() => new Map(rememberedContent));
  const content = contents.get(selectedId ?? "") ?? "sessions";
  const filesVisible = content === "files";
  // The Session bands ride with Home, which is the one page their rows navigate
  // into — both a Ticket view and a Board Session are reached from there.
  const sessionsVisible = activeNav === "home" && content === "sessions";

  return (
    <EmptyStateScope tier="inline">
      <ControlShapeProvider context="sidebar">
        <div className="relative h-full w-full overflow-hidden">
          <div
            data-sidebar-presentation="expanded"
            className="absolute inset-y-0 left-0 flex min-h-0 w-[calc(var(--sidebar-width)-var(--rail-width)-var(--sidebar-edge))] flex-col overflow-hidden"
          >
            {/* ChromeBar above owns the traffic lights and the drag region — this
            is now a plain panel header. */}
            <SidebarHeader className="px-4 pt-3 pb-2">
              {selected ? (
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-ui font-semibold font-display">
                      {selected.name}
                    </div>
                    <div className="text-label text-muted-foreground">{selected.ticketPrefix}</div>
                  </div>
                </div>
              ) : (
                <div className="text-sm font-medium text-sidebar-foreground">Projects</div>
              )}
            </SidebarHeader>

            {selected ? (
              <>
                <NavList projectId={selected.id} />
                <NavigatorSelector
                  projectId={selected.id}
                  active={content}
                  onSelect={(next) => {
                    rememberedContent.set(selected.id, next);
                    setContents((previous) => new Map(previous).set(selected.id, next));
                  }}
                />

                <React.Activity mode={filesVisible ? "visible" : "hidden"}>
                  <SidebarFiles project={selected} />
                </React.Activity>
                <div
                  className={cn("flex min-h-0 flex-1 flex-col", content === "files" && "hidden")}
                >
                  <SidebarScrollArea>
                    <div className={cn(!sessionsVisible && "hidden")}>
                      {/* Render-hidden, not unmounted — so the section cannot tell it
                    is off screen, and the coarse chat-activity poll it runs
                    would keep firing behind Configure or Settings. `visible`
                    is that fact, handed down from the one place that has it. */}
                      <ActiveSessions project={selected} visible={sessionsVisible} />
                    </div>
                  </SidebarScrollArea>
                </div>
              </>
            ) : (
              <SidebarContent />
            )}

            <SidebarFooter>
              <CloudMoveRailRow />
              {/* Settings keeps the wide row; the updater (VC-59) is the square
              beside it — a rare, occasionally-important control that must not
              compete with a daily one. UpdateButton renders null in dev and
              until main's first snapshot, leaving the row exactly as it was. */}
              <div className="flex items-center gap-1">
                <div className="min-w-0 flex-1">
                  <SettingsMenuButton
                    active={settingsOpen}
                    onSelect={() => setSettingsOpen(!settingsOpen)}
                  />
                </div>
                <UpdateButton />
              </div>
            </SidebarFooter>
          </div>
        </div>
      </ControlShapeProvider>
    </EmptyStateScope>
  );
}

const NAVIGATORS = [
  { key: "sessions", label: "Sessions", icon: Chats },
  { key: "files", label: "Files", icon: FolderIcon },
] as const;

/** Fixed navigator selector; the two independent scrollports remain mounted below it. */
function NavigatorSelector({
  projectId,
  active,
  onSelect,
}: {
  projectId: string;
  active: "sessions" | "files";
  onSelect(next: "sessions" | "files"): void;
}) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div
      data-slot="navigator-selector"
      // 22px drawing, 24px targets. Icon centres share the nav rows' 24px inset.
      className="flex h-[22px] shrink-0 items-center gap-1 border-b border-sidebar-border/50 px-3"
    >
      <div role="tablist" aria-label="Sidebar content" className="flex h-[22px] items-center gap-1">
        {NAVIGATORS.map(({ key, label, icon: Icon }, index) => (
          <Tooltip key={key}>
            <TooltipTrigger asChild>
              <button
                ref={(node) => {
                  refs.current[index] = node;
                }}
                type="button"
                role="tab"
                aria-label={label}
                aria-selected={key === active}
                tabIndex={key === active ? 0 : -1}
                data-choice={key}
                onClick={() => onSelect(key)}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
                  onSelect(NAVIGATORS[next]!.key);
                  refs.current[next]?.focus();
                }}
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-control-small outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-sidebar-accent-veil",
                  key === active ? "text-primary" : "text-muted-foreground",
                )}
              >
                <Icon className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      <div className="ml-auto flex min-w-0 items-center">
        <NewSessionControl
          projectId={projectId}
          placement="rail"
          align="end"
          disabled={false}
          onNewChat={() => void startProjectChat(projectId)}
          onNewTerminal={() => void startProjectTerminal(projectId)}
        />
      </div>
    </div>
  );
}

function SettingsMenuButton({ active, onSelect }: { active: boolean; onSelect(): void }) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton isActive={active} onClick={onSelect}>
          <SettingsIcon />
          <span>Settings</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
