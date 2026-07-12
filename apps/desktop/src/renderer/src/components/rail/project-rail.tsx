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
import { ProjectTile } from "@renderer/components/rail/project-tile";
import { useProjectsStore } from "@renderer/stores/projects";

export function ProjectRail() {
  const projects = useProjectsStore((state) => state.projects);
  const reorder = useProjectsStore((state) => state.reorder);
  const [activeDragId, setActiveDragId] = React.useState<string | null>(null);
  // The order at drag start, so `commitReorder` persists (and can revert to)
  // it once — a drag can cross many tiles, and each crossing only updates
  // local state via `reorder` (see its handler below); the store writes to
  // SQLite exactly once, when the drag settles.
  const dragStartOrder = React.useRef<Project[] | null>(null);

  // distance: 4 keeps plain clicks (select) and the press-scale animation
  // working — the drag only activates after real pointer travel.
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
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragEnd}
      >
        <SortableContext
          items={projects.map((project) => project.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="flex min-h-0 flex-1 flex-col items-center gap-3 overflow-y-auto px-2 pt-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {projects.map((project, index) => (
              <ProjectTile
                key={project.id}
                project={project}
                index={index}
                dimmed={project.id === activeDragId}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <div className="flex shrink-0 justify-center pt-2 pb-3">
        <AddProjectTile />
      </div>
    </div>
  );
}
