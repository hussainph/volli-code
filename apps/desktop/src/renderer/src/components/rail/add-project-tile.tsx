import { Plus } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { useAddProject } from "@renderer/hooks/use-add-project";

export function AddProjectTile() {
  const pickAndAdd = useAddProject();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void pickAndAdd()}
          className="app-region-no-drag group/tile relative flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-muted transition-transform duration-100 ease-out active:scale-[0.96]"
        >
          <Plus className="size-[15px] text-muted-foreground" />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[10px] bg-foreground/8 opacity-0 group-hover/tile:opacity-100"
          />
          <span className="sr-only">Add Project</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">Add Project…</TooltipContent>
    </Tooltip>
  );
}
