import { Board } from "@renderer/components/board/board";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";

/** Thin mount: renders the selected project's board (seeded by AppShell). */
export function BoardPage() {
  const project = useSelectedProject();

  if (project === null) return null;

  return <Board projectId={project.id} ticketPrefix={project.ticketPrefix} />;
}
