import { Button } from "@renderer/components/ui/button";
import { SearchIcon } from "@renderer/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { SearchableCommand } from "@renderer/components/ui/searchable-command";
import { scrollEdgeMask } from "@renderer/components/ui/scroll-edge-mask";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import * as React from "react";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Project } from "@volli/shared";

import { AddProjectTile } from "@renderer/components/rail/add-project-tile";
import {
  CloudWorkspaceHead,
  LocalProjectsFoot,
  NewCloudProjectTile,
} from "@renderer/components/rail/cloud-rail";
import { ProjectTile } from "@renderer/components/rail/project-tile";
import { useProjectsStore } from "@renderer/stores/projects";
import { launchStore } from "@renderer/stores/launch";

/**
 * Memoized for the same reason as `Board`, and it takes no props at all, so the
 * boundary is free: it hangs directly under `AppShell`, which re-renders on
 * every pointermove of the sidebar resize grip. Profiling a drag showed the rail
 * dropping out of the rendered set entirely once this was in place. Its
 * `useProjectsStore` subscription still updates it normally — memo blocks
 * parent-driven renders, never a hook's own update.
 */
export const ProjectRail = React.memo(function ProjectRail({
  presentation = "rail",
}: { presentation?: "rail" | "menu" } = {}) {
  const projects = useProjectsStore((state) => state.projects);
  const reorder = useProjectsStore((state) => state.reorder);
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  // Fixed for the window's life: main chose it before the window opened.
  const cloudLaunch = launchStore() === "cloud";
  const [activeDragId, setActiveDragId] = React.useState<string | null>(null);
  // The order at drag start, so `commitReorder` persists (and can revert to)
  // it once — a drag can cross many tiles, and each crossing only updates
  // local state via `reorder` (see its handler below); the store writes to
  // SQLite exactly once, when the drag settles.
  const dragStartOrder = React.useRef<Project[] | null>(null);
  // `SortableContext` keys its context value on this array's identity, and the
  // rail sits high enough in the shell that it re-renders on unrelated chrome
  // changes — a fresh array there re-renders every `useSortable` tile with it.
  const sortableIds = React.useMemo(() => projects.map((project) => project.id), [projects]);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState({ atTop: true, atBottom: true });
  const measureEdges = React.useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const atTop = element.scrollTop <= 0;
    const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
    setEdges((current) =>
      current.atTop === atTop && current.atBottom === atBottom ? current : { atTop, atBottom },
    );
  }, []);
  // Tile geometry is fixed; collection changes and viewport resizes are the two
  // ways its scroll range changes. The footer stays outside this scrollport.
  React.useLayoutEffect(measureEdges, [measureEdges, projects.length, presentation, cloudLaunch]);
  React.useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const observer = new ResizeObserver(measureEdges);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measureEdges]);

  // distance: 4 keeps plain clicks (select) and the press-scale animation
  // working — the drag only activates after pointer travel through the
  // browser event pipeline.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function handleDragStart({ active }: DragStartEvent) {
    dragStartOrder.current = useProjectsStore.getState().projects;
    setActiveDragId(String(active.id));
  }

  // Live shuffle: reorder the store as the pointer crosses tiles, not on drop.
  // The store no-ops unknown ids; the guard here just avoids render churn.
  function handleDragOver({ active, over }: DragOverEvent) {
    if (over && active.id !== over.id) reorder(String(active.id), String(over.id));
  }

  // Fires on both a normal drop and a cancelled drag (`onDragCancel` below) —
  // either way, whatever the live shuffle left in place is the order to
  // persist, so both wire to this one commit.
  function handleDragEnd() {
    setActiveDragId(null);
    const previousOrder = dragStartOrder.current;
    dragStartOrder.current = null;
    if (previousOrder !== null) void useProjectsStore.getState().commitReorder(previousOrder);
  }

  return (
    <div className="app-region-drag flex h-full min-h-0 flex-col">
      {projects.length > 8 ? (
        <div className="app-region-no-drag flex shrink-0 justify-center py-2">
          <Popover
            open={switcherOpen}
            onOpenChange={(next) => {
              setSwitcherOpen(next);
              if (!next) setQuery("");
            }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button variant="toolbar" size="icon-sm" aria-label="Switch project">
                    <SearchIcon />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>Switch project</TooltipContent>
            </Tooltip>
            <PopoverContent side="right" align="start" className="w-80 p-0">
              <SearchableCommand
                items={projects.filter(
                  (project) =>
                    project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) ||
                    project.ticketPrefix
                      .toLocaleLowerCase()
                      .includes(query.trim().toLocaleLowerCase()),
                )}
                query={query}
                onQueryChange={setQuery}
                placeholder="Search projects"
                keyOf={(project) => project.id}
                renderItem={(project) => (
                  <>
                    <span className="min-w-0 flex-1 truncate" title={project.name}>
                      {project.name}
                    </span>
                    <span className="text-label text-muted-foreground">{project.ticketPrefix}</span>
                  </>
                )}
                onSelect={(project) => {
                  useProjectsStore.getState().select(project.id);
                  setSwitcherOpen(false);
                  setQuery("");
                }}
              />
            </PopoverContent>
          </Popover>
        </div>
      ) : null}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragEnd}
      >
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          <div
            ref={scrollRef}
            data-slot="project-rail-scroll"
            // The icon column keeps no scroll thumb: its edge fades say where
            // it is, and a thumb would crowd the tiles. The menu keeps one.
            data-scroll-thumb={presentation === "menu" ? undefined : "none"}
            onScroll={measureEdges}
            style={{ maskImage: scrollEdgeMask(edges) }}
            className={
              presentation === "menu"
                ? "flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1"
                : "flex min-h-0 flex-1 flex-col items-center gap-3 overflow-y-auto px-2 pt-0.5 pb-2"
            }
          >
            {cloudLaunch ? <CloudWorkspaceHead /> : null}
            {projects.map((project, index) => (
              <ProjectTile
                key={project.id}
                project={project}
                presentation={presentation}
                index={index}
                dimmed={project.id === activeDragId}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {/* A cloud launch adds no folder of this Mac's (VC-889). */}
      {cloudLaunch ? (
        <div className="flex shrink-0 flex-col items-center gap-4 pt-2 pb-4">
          <NewCloudProjectTile />
          <LocalProjectsFoot />
        </div>
      ) : (
        <div className="flex shrink-0 justify-center pt-2 pb-4">
          <AddProjectTile />
        </div>
      )}
    </div>
  );
});
