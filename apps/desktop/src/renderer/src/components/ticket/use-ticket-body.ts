import * as React from "react";
import type { Ticket } from "@volli/shared";

import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { isTicketBodyLoaded, planningChangeAffects, useBoardStore } from "@renderer/stores/board";

/**
 * What the open Ticket workspace may do with the body in the board store.
 *
 * `loading` is the one state a body editor must NOT be rendered in: the store
 * holds a `""` placeholder, and an editor seeded from it would let a person type
 * into a body that has not arrived, then autosave their text over the real one.
 */
export type TicketBodyStatus =
  /** The store holds this ticket's canonical body. Render it. */
  | "ready"
  /** Never read, and a read is in flight. Render a skeleton, not an editor. */
  | "loading"
  /** Never read, and the read failed. Render the fault and its one retry. */
  | "failed";

export interface TicketBodyState {
  status: TicketBodyStatus;
  /** Re-run the read — the action behind the `failed` surface's retry. */
  retry: () => void;
}

/**
 * Keeps the open ticket's Ticket Body fresh without putting bodies back into the
 * steady-state board roster (VC-387). Socket refreshes only re-open this cold
 * read when their scope could include this ticket, and late reads cannot cross a
 * ticket switch.
 *
 * TWO KINDS OF READ, and they fail differently. The read for a ticket whose body
 * this renderer has NEVER held is one a person is waiting on — they opened the
 * ticket — so its failure is reported as `failed` and the workspace shows it.
 * Every later read is background refinement over a body already on screen, so it
 * stays silent (CLAUDE.md: the test is whether a person is waiting on the
 * result). `status` reflects only the first kind; a failed refresh leaves
 * `ready` and the body that is already there.
 */
export function useTicketBody(ticket: Pick<Ticket, "id" | "projectId">): TicketBodyState {
  const planningChange = useBoardStore((state) => state.lastPlanningChange);
  const loaded = useBoardStore((state) => isTicketBodyLoaded(state, ticket.id));
  const [failed, setFailed] = React.useState(false);
  const bodyRead = useLatestAsync();
  const openTicket = React.useRef(ticket);
  openTicket.current = ticket;

  const reload = React.useCallback(() => {
    const ticketId = ticket.id;
    const projectId = ticket.projectId;
    const token = bodyRead.claim();
    setFailed(false);
    void window.api.tickets
      .body({ ticketId })
      .then((result) => {
        // A result that lost its claim belongs to a ticket this view has since
        // left; applying it would put one ticket's body on another's workspace.
        if (
          !bodyRead.isCurrent(token) ||
          openTicket.current.id !== ticketId ||
          openTicket.current.projectId !== projectId
        )
          return;
        if (result.ok) useBoardStore.getState().adoptTicketBody(projectId, ticketId, result.body);
        else setFailed(true);
      })
      .catch(() => {
        if (!bodyRead.isCurrent(token) || openTicket.current.id !== ticketId) return;
        setFailed(true);
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

  // Loaded wins over a failure: once a body is on screen, a later read that
  // fails is refinement nobody asked for, and its fallback is already rendered.
  const status: TicketBodyStatus = loaded ? "ready" : failed ? "failed" : "loading";
  return { status, retry: reload };
}
