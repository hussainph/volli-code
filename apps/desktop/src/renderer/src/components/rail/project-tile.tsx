import * as React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  SwapIcon,
  FolderOpenIcon,
  StorageIcon,
  RemoveCircleIcon,
  CloudUploadIcon,
} from "@renderer/components/ui/icon";

import { errorMessage, monogram, projectColor, type Project } from "@volli/shared";

import { RelinkProjectDialog } from "@renderer/components/rail/relink-project-dialog";
import { RemoveProjectDialog } from "@renderer/components/rail/remove-project-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import {
  notAvailableOn,
  useCloudEnabled,
  useRemoteProjectHost,
} from "@renderer/components/hosts/use-hosts";
import { prepareCloudMove, showCloudMoves, useCloudMovesStore } from "@renderer/stores/cloud-moves";
import { launchStore } from "@renderer/stores/launch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { toastError } from "@renderer/lib/toast";
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
  // A remote project's host (VC-711): its tile says where it runs, and this
  // Mac's folder actions stand down for it. Null for This Mac's, flag off too.
  const remoteHost = useRemoteProjectHost(project.id);
  const cloudEnabled = useCloudEnabled();
  const move = useCloudMovesStore((state) =>
    state.snapshot?.moves.findLast((item) => item.projectId === project.id),
  );
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const [relinkOpen, setRelinkOpen] = React.useState(false);
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: project.id,
  });

  async function revealInFinder() {
    try {
      const result = await window.api.fs.revealInFinder(project.path);
      if (!result.ok) toastError(`Couldn't reveal in Finder: ${result.error}`);
    } catch (error) {
      toastError(`Couldn't reveal in Finder: ${errorMessage(error)}`);
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
                  onKeyDown={(event) => {
                    if (!cloudEnabled) return;
                    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
                      return;
                    // macOS does not synthesize contextmenu for keyboard activation.
                    event.preventDefault();
                    event.stopPropagation();
                    const target = event.currentTarget;
                    const rect = target.getBoundingClientRect();
                    target.dispatchEvent(
                      new MouseEvent("contextmenu", {
                        bubbles: true,
                        cancelable: true,
                        clientX: rect.right,
                        clientY: rect.top,
                        button: 2,
                      }),
                    );
                  }}
                  aria-label={project.name}
                  aria-current={isSelected ? "true" : undefined}
                  style={
                    { "--tile-color": projectColor(project.colorIndex) } as React.CSSProperties
                  }
                  className={cn(
                    "workspace-tile group/tile relative flex size-[38px] items-center justify-center rounded-row text-ui font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    isSelected && "workspace-tile-selected",
                  )}
                >
                  {monogram(project.name)}
                  {remoteHost === null ? null : (
                    <span
                      aria-hidden
                      data-slot="project-tile-host"
                      className="pointer-events-none absolute -right-1 -bottom-1 grid size-3.5 place-items-center rounded-full border border-border bg-card text-foreground"
                    >
                      <StorageIcon strokeWidth={2.25} className="size-2.5" />
                    </span>
                  )}
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 rounded-control bg-foreground/10 opacity-0 group-hover/tile:opacity-100"
                  />
                </button>
              </TooltipTrigger>
            </ContextMenuTrigger>
            <TooltipContent side="right" className="max-w-80">
              <div className="flex items-center gap-1">
                <span className="font-semibold">{project.name}</span>
                {index < 9 && (
                  <kbd className="rounded-sm bg-background/30 px-1 py-px font-sans text-label font-bold">
                    ⌘{index + 1}
                  </kbd>
                )}
              </div>
              {remoteHost === null ? null : (
                <div className="text-background/70">On {remoteHost.name}</div>
              )}
              <div className="mt-2 flex items-start gap-2 rounded-control border border-background/30 px-2 py-1">
                <FolderOpenIcon aria-hidden className="mt-1 size-4 shrink-0" />
                <span className="min-w-0 font-mono [overflow-wrap:anywhere]">{project.path}</span>
              </div>
            </TooltipContent>
          </Tooltip>
          <ContextMenuContent>
            {remoteHost === null ? (
              <LocalProjectActions
                onReveal={() => void revealInFinder()}
                onRelink={() => setRelinkOpen(true)}
                onRemove={() => setRemoveOpen(true)}
                onMove={
                  cloudEnabled && launchStore() === "local" && move?.state !== "returned"
                    ? () =>
                        move === undefined || move.state === "rolled-back"
                          ? prepareCloudMove(project.id)
                          : showCloudMoves(move.queueId)
                    : undefined
                }
              />
            ) : (
              <ContextMenuItem icon={StorageIcon} disabled>
                {notAvailableOn(remoteHost)}
              </ContextMenuItem>
            )}
          </ContextMenuContent>
        </ContextMenu>
      </div>
      {/* Sibling of the ContextMenu, not a child of its content: the dialog
          must survive the menu unmounting on item select. */}
      {remoteHost === null ? (
        <>
          <RelinkProjectDialog project={project} open={relinkOpen} onOpenChange={setRelinkOpen} />
          <RemoveProjectDialog project={project} open={removeOpen} onOpenChange={setRemoveOpen} />
        </>
      ) : null}
    </>
  );
}

/** This Mac's folder actions on one of its own projects. */
function LocalProjectActions({
  onReveal,
  onRelink,
  onRemove,
  onMove,
}: {
  onReveal: () => void;
  onRelink: () => void;
  onRemove: () => void;
  onMove?: () => void;
}) {
  return (
    <>
      <ContextMenuItem icon={FolderOpenIcon} onSelect={onReveal}>
        Reveal in Finder
      </ContextMenuItem>
      <ContextMenuItem icon={SwapIcon} onSelect={onRelink}>
        Relink folder
      </ContextMenuItem>
      {onMove === undefined ? null : (
        <ContextMenuItem icon={CloudUploadIcon} onSelect={onMove}>
          Move to Volli Cloud…
        </ContextMenuItem>
      )}
      <ContextMenuItem icon={RemoveCircleIcon} variant="destructive" onSelect={onRemove}>
        Remove from Volli
      </ContextMenuItem>
    </>
  );
}
