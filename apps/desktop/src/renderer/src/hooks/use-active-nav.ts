import * as React from "react";

import { useProjectsStore } from "@renderer/stores/projects";
import { DEFAULT_PROJECT_UI, useProjectUiStore, type NavKey } from "@renderer/stores/project-ui";

/**
 * The selected project's nav page and its setter. Each project remembers its
 * own page, so switching workspaces restores where you were in each one.
 * Falls back to the default for never-visited projects; the setter is a no-op
 * with no project selected (the sidebar shows no nav then anyway).
 */
export function useActiveNav(): [NavKey, (nav: NavKey) => void] {
  const selectedProjectId = useProjectsStore((state) => state.selectedProjectId);
  const activeNav = useProjectUiStore(
    (state) =>
      (selectedProjectId ? state.byProject[selectedProjectId]?.nav : undefined) ??
      DEFAULT_PROJECT_UI.nav,
  );
  const setNav = useProjectUiStore((state) => state.setNav);

  const setActiveNav = React.useCallback(
    (nav: NavKey) => {
      if (selectedProjectId) setNav(selectedProjectId, nav);
    },
    [selectedProjectId, setNav],
  );

  return [activeNav, setActiveNav];
}
