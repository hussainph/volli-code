import * as React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { MinusCircleIcon } from "@phosphor-icons/react/dist/csr/MinusCircle";
import { errorMessage, monogram, projectColor, type Project } from "@volli/shared";
import { toast } from "sonner";

import { RemoveProjectDialog } from "@renderer/components/rail/remove-project-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";
import { useProjectsStore } from "@renderer/stores/projects";

interface ProjectTileProps {
  project: Project;
  /** Position in the rail; drives the ⌘N tooltip hint for the first nine. */
  index: number;
  /** True while this tile is the active dnd-kit drag item. */
  dimmed: boolean;
}

export function ProjectTile({ project, index, dimmed }: ProjectTileProps) {
  const select = useProjectsStore((state) => state.select);
  const isSelected = useProjectsStore((state) => state.selectedProjectId === project.id);
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: project.id,
  });

  async function revealInFinder() {
    try {
      const result = await window.api.fs.revealInFinder(project.path);
      if (!result.ok) toast.error(`Could not reveal in Finder: ${result.error}`);
    } catch (error) {
      toast.error(`Could not reveal in Finder: ${errorMessage(error)}`);
    }
  }

  return (
    <>
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Transform.toString(transform), transition }}
        className={cn("app-region-no-drag shrink-0", dimmed && "opacity-[0.45]")}
        {...attributes}
        {...listeners}
      >
        {/* Tooltip root sits between the two triggers so each `asChild` slots
            onto a prop-forwarding element and both merge onto the button. */}
        <ContextMenu>
          <Tooltip>
            <ContextMenuTrigger asChild>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => select(project.id)}
                  style={{ backgroundColor: projectColor(project.colorIndex) }}
                  className={cn(
                    "group/tile relative flex size-9 items-center justify-center rounded-[10px] text-sm font-semibold text-white transition-transform duration-100 ease-out active:scale-[0.96]",
                    isSelected && "ring-2 ring-foreground/90 ring-offset-[3px] ring-offset-rail",
                  )}
                >
                  {monogram(project.name)}
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 rounded-[10px] bg-foreground/8 opacity-0 group-hover/tile:opacity-100"
                  />
                </button>
              </TooltipTrigger>
            </ContextMenuTrigger>
            <TooltipContent side="right" className="max-w-80">
              <div className="flex items-center gap-1.5">
                <span className="font-bold">{project.name}</span>
                {index < 9 && (
                  <kbd className="rounded-sm bg-background/20 px-1 py-px font-sans text-label font-bold">
                    ⌘{index + 1}
                  </kbd>
                )}
              </div>
              <div className="text-background/70">{project.path}</div>
            </TooltipContent>
          </Tooltip>
          <ContextMenuContent>
            <ContextMenuItem icon={FolderOpenIcon} onSelect={() => void revealInFinder()}>
              Reveal in Finder
            </ContextMenuItem>
            <ContextMenuItem
              icon={MinusCircleIcon}
              variant="destructive"
              onSelect={() => setRemoveOpen(true)}
            >
              Remove from Volli…
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>
      {/* Sibling of the ContextMenu, not a child of its content: the dialog
          must survive the menu unmounting on item select. */}
      <RemoveProjectDialog project={project} open={removeOpen} onOpenChange={setRemoveOpen} />
    </>
  );
}
