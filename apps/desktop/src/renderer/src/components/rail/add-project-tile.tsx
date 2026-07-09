import { Plus } from "lucide-react";
import { toast } from "sonner";

import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { errorMessage } from "@renderer/lib/errors";
import { useProjectsStore } from "@renderer/stores/projects";

export function AddProjectTile() {
  const addProject = useProjectsStore((state) => state.addProject);

  async function pickAndAdd() {
    try {
      const result = await window.api.projects.pickFolder();
      // Duplicate paths are handled inside the store (it selects the existing project).
      if (!result.canceled) addProject({ path: result.path, defaultName: result.defaultName });
    } catch (error) {
      toast.error(`Could not open folder picker: ${errorMessage(error)}`);
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void pickAndAdd()}
          className="app-region-no-drag group/tile relative flex size-10 shrink-0 items-center justify-center rounded-[11px] bg-muted transition-transform duration-100 ease-out active:scale-[0.96]"
        >
          <Plus className="size-[15px] text-muted-foreground" />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[11px] bg-foreground/8 opacity-0 group-hover/tile:opacity-100"
          />
          <span className="sr-only">Add Project</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">Add Project…</TooltipContent>
    </Tooltip>
  );
}
