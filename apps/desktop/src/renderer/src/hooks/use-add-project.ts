import * as React from "react";
import { errorMessage } from "@volli/shared";

import { toastError } from "@renderer/lib/toast";
import { useProjectsStore } from "@renderer/stores/projects";

// Shared across BOTH entry points: one native picker/claim flow per window.
let picking = false;

/**
 * Native picker → existing-folder/relink judgement → new-workspace identity.
 * Picking a new folder is not a durable create; the editor's commit is.
 * Shared by the rail's "+" tile and the empty-sidebar "Add Project" button.
 */
export function useAddProject(): () => Promise<void> {
  const addProject = useProjectsStore((state) => state.addProject);

  return React.useCallback(async () => {
    const state = useProjectsStore.getState();
    if (picking || state.newProjectDraft || state.folderClaim) return;
    picking = true;
    try {
      const result = await window.api.projects.pickFolder();
      if (!result.canceled)
        await addProject({ path: result.path, defaultName: result.defaultName, onboard: true });
    } catch (error) {
      toastError(`Couldn't open folder picker: ${errorMessage(error)}`);
    } finally {
      picking = false;
    }
  }, [addProject]);
}
