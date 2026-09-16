import * as React from "react";
import type { Ticket } from "@volli/shared";

import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { planningChangeAffects, useBoardStore } from "@renderer/stores/board";

/**
 * Keeps the open ticket's Markdown body fresh without putting bodies back into
 * the steady-state board roster. Socket refreshes only re-open this cold read
 * when their scope could include this ticket, and late reads cannot cross a
 * ticket switch. This is background refinement: a failed read leaves the
 * board's last body in place and has no user-facing failure.
 */
export function useTicketBody(ticket: Pick<Ticket, "id" | "projectId">): void {
  const planningChange = useBoardStore((state) => state.lastPlanningChange);
  const bodyRead = useLatestAsync();
  const openTicket = React.useRef(ticket);
  openTicket.current = ticket;

  const reload = React.useCallback(() => {
    const ticketId = ticket.id;
    const projectId = ticket.projectId;
    const token = bodyRead.claim();
    void window.api.tickets
      .body({ ticketId })
      .then((result) => {
        if (
          !bodyRead.isCurrent(token) ||
          openTicket.current.id !== ticketId ||
          openTicket.current.projectId !== projectId
        )
          return;
        if (result.ok) useBoardStore.getState().adoptTicketBody(projectId, ticketId, result.body);
      })
      .catch(() => {
        // A stale body is already on screen; background refinement stays silent.
      });
  }, [ticket.id, ticket.projectId, bodyRead]);

  React.useEffect(() => {
    reload();
    return bodyRead.invalidate;
  }, [reload, bodyRead]);

  const seenPlanningVersion = React.useRef(planningChange.version);
  React.useEffect(() => {
    if (planningChange.version === seenPlanningVersion.current) return;
    seenPlanningVersion.current = planningChange.version;
    if (planningChangeAffects(planningChange, ticket.id)) reload();
  }, [planningChange, ticket.id, reload]);
}
