import { useLayoutEffect } from "react";

import { Board } from "@renderer/components/board/board";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { useBoardStore } from "@renderer/stores/board";

/** Thin mount: seeds the selected project's board, then renders it. */
export function BoardPage() {
  const project = useSelectedProject();

  // Layout effect so the first paint already has the seeded board — a plain
  // effect flashes one empty frame (all five columns collapsed) on first open.
  useLayoutEffect(() => {
    if (project === null) return;
    useBoardStore.getState().ensureSeeded(project.id, project.ticketPrefix);
  }, [project]);

  if (project === null) return null;

  return <Board projectId={project.id} ticketPrefix={project.ticketPrefix} />;
}
