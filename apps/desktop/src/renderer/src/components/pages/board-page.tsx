import * as React from "react";
import { Board } from "@renderer/components/board/board";
import { TicketDetail } from "@renderer/components/ticket/ticket-detail";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { useBoardStore } from "@renderer/stores/board";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";

/**
 * Thin mount: renders the selected project's board, or — when a ticket is
 * open (`openTicketId` set, ticket-detail-mvp decision #1) — the full-page
 * ticket detail view IN PLACE of the board. A stale `openTicketId` (the
 * ticket was archived/deleted, whether just now or in a previous session
 * before restart restored it) falls back to the plain board instead of
 * rendering a detail view for a ticket that no longer exists on the board.
 */
export function BoardPage() {
  const project = useSelectedProject();
  const openTicketId = useWorkspaceStore(
    (state) =>
      (project ? state.byProject[project.id]?.openTicketId : undefined) ??
      DEFAULT_WORKSPACE_UI.openTicketId,
  );
  const ticket = useBoardStore((state) =>
    project && openTicketId !== null
      ? state.ticketsByProject[project.id]?.find((candidate) => candidate.id === openTicketId)
      : undefined,
  );
  const closeTicket = useWorkspaceStore((state) => state.closeTicket);

  React.useEffect(() => {
    if (project && openTicketId !== null && ticket === undefined) {
      closeTicket(project.id);
    }
  }, [project, openTicketId, ticket, closeTicket]);

  if (project === null) return null;

  if (openTicketId !== null && ticket !== undefined) {
    return (
      <TicketDetail
        projectId={project.id}
        projectPath={project.path}
        ticketPrefix={project.ticketPrefix}
        ticket={ticket}
      />
    );
  }

  return <Board projectId={project.id} ticketPrefix={project.ticketPrefix} />;
}
