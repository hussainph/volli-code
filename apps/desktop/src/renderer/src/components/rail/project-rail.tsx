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

import { AddProjectTile } from "@renderer/components/rail/add-project-tile";
import { ProjectTile } from "@renderer/components/rail/project-tile";
import { useProjectsStore } from "@renderer/stores/projects";

export function ProjectRail() {
  const projects = useProjectsStore((state) => state.projects);
  const reorder = useProjectsStore((state) => state.reorder);
  const [activeDragId, setActiveDragId] = React.useState<string | null>(null);

  // distance: 4 keeps plain clicks (select) and the press-scale animation
  // working — the drag only activates after real pointer travel.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function handleDragStart({ active }: DragStartEvent) {
    setActiveDragId(String(active.id));
  }

  // Live shuffle: reorder the store as the pointer crosses tiles, not on drop.
  // The store no-ops unknown ids; the guard here just avoids render churn.
  function handleDragOver({ active, over }: DragOverEvent) {
    if (over && active.id !== over.id) reorder(String(active.id), String(over.id));
  }

  function handleDragEnd() {
    setActiveDragId(null);
  }

  return (
    <div className="app-region-drag flex h-full min-h-0 flex-col">
      {/* Clears the hiddenInset traffic lights; stays part of the drag region. */}
      <div className="h-[38px] shrink-0" />
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
          <div className="flex min-h-0 flex-1 flex-col items-center gap-3 overflow-y-auto px-3 pt-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
