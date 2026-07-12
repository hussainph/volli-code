/**
 * Resolves a ticket's *display* id ("VC-12") for presentation — never its
 * opaque UUID `Ticket.id` (see the doc comment on `Ticket.id` and
 * `displayTicketId` in `@volli/shared`). Looks the owning project's
 * `ticketPrefix` up in the projects store rather than requiring every
 * presentational component to thread it down as a prop.
 */
import { displayTicketId, type Ticket } from "@volli/shared";

import { useProjectsStore } from "@renderer/stores/projects";

/**
 * A ticket's display id, resolved via `ticket.projectId` → the project's
 * `ticketPrefix` → {@link displayTicketId}. Falls back to a `"?"` prefix in
 * the (should-never-happen) case the owning project isn't loaded, rather than
 * throwing mid-render.
 */
export function useTicketDisplayId(ticket: Pick<Ticket, "projectId" | "ticketNumber">): string {
  const prefix = useProjectsStore(
    (state) => state.projects.find((project) => project.id === ticket.projectId)?.ticketPrefix,
  );
  return displayTicketId(prefix ?? "?", ticket.ticketNumber);
}
