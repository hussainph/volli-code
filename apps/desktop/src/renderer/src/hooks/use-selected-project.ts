import type { Project } from "@volli/shared";

import { useProjectsStore } from "@renderer/stores/projects";

/** The currently selected project, or null when none is selected. */
export function useSelectedProject(): Project | null {
  return useProjectsStore(
    (state) => state.projects.find((project) => project.id === state.selectedProjectId) ?? null,
  );
}
