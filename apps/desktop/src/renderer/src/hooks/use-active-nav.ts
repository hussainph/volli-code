import * as React from "react";

import { useProjectsStore } from "@renderer/stores/projects";
import { DEFAULT_NAV, useWorkspaceStore, type NavKey } from "@renderer/stores/workspace";

/**
 * The selected project's nav page and its setter. Each project remembers its
 * own page, so switching workspaces restores where you were in each one.
 * Falls back to DEFAULT_NAV for never-visited projects; the setter is a no-op
 * with no project selected (the sidebar shows no nav then anyway).
 */
export function useActiveNav(): [NavKey, (nav: NavKey) => void] {
  const selectedProjectId = useProjectsStore((state) => state.selectedProjectId);
  const activeNav = useWorkspaceStore((state) =>
    selectedProjectId ? (state.navByProject[selectedProjectId] ?? DEFAULT_NAV) : DEFAULT_NAV,
  );
  const setNav = useWorkspaceStore((state) => state.setNav);

  const setActiveNav = React.useCallback(
    (nav: NavKey) => {
      if (selectedProjectId) setNav(selectedProjectId, nav);
    },
    [selectedProjectId, setNav],
  );

  return [activeNav, setActiveNav];
}
