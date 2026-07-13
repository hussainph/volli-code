import * as React from "react";
import { errorMessage } from "@volli/shared";
import { toast } from "sonner";

import { useProjectsStore } from "@renderer/stores/projects";

/**
 * Returns a handler that opens the native folder picker and adds the chosen
 * folder as a project. Duplicate paths are handled inside the store (it selects
 * the existing one). Shared by the rail's "+" tile and the empty-sidebar
 * "Add Project" button so both entry points behave identically.
 */
export function useAddProject(): () => Promise<void> {
  const addProject = useProjectsStore((state) => state.addProject);

  return React.useCallback(async () => {
    try {
      const result = await window.api.projects.pickFolder();
      if (!result.canceled)
        await addProject({ path: result.path, defaultName: result.defaultName });
    } catch (error) {
      toast.error(`Could not open folder picker: ${errorMessage(error)}`);
    }
  }, [addProject]);
}
