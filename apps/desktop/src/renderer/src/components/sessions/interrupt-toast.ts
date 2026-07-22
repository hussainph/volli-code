/**
 * Pure model for the backward-move interrupt toast (issue #78, CONCEPT #20).
 * Automation may de-escalate a ticket's agents, but never silently: the move
 * that Esc'd live sessions announces itself where the mover is looking, with
 * a jump-to-ticket action. This module only shapes the announcement — the
 * subscription + sonner call live in `main.tsx` (bootstrap glue), and the
 * `volli:sessions-interrupted` push it renders is fired by main only when
 * sessions were actually interrupted.
 */
import {
  displayTicketId,
  type Project,
  type SessionsInterruptedEvent,
  type Ticket,
} from "@volli/shared";

export interface InterruptToastModel {
  message: string;
  /** Where the toast's action navigates, or `null` when the ticket isn't in the board state (no action shown). */
  target: { projectId: string; ticketId: string } | null;
}

/**
 * Shapes one `volli:sessions-interrupted` push into its toast. The ticket is
 * located in the board's own hydrated state; a ticket the renderer doesn't
 * know (hydration race) still announces the interrupt, just without the
 * display id or the navigation action.
 */
export function interruptToastModel(
  event: SessionsInterruptedEvent,
  ticketsByProject: Record<string, readonly Ticket[]>,
  projects: readonly Project[],
): InterruptToastModel {
  const count = event.sessionIds.length;
  const sessions = count === 1 ? "an agent session" : `${count} agent sessions`;
  for (const [projectId, tickets] of Object.entries(ticketsByProject)) {
    const ticket = tickets.find(({ id }) => id === event.ticketId);
    if (ticket === undefined) continue;
    const prefix = projects.find(({ id }) => id === projectId)?.ticketPrefix;
    const name = prefix !== undefined ? displayTicketId(prefix, ticket.ticketNumber) : ticket.title;
    return {
      message: `${name}: interrupted ${sessions}`,
      target: { projectId, ticketId: event.ticketId },
    };
  }
  return { message: `Interrupted ${sessions}`, target: null };
}
