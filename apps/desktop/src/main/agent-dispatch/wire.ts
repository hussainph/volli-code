/**
 * What a resolved subject looks like once it crosses the socket.
 *
 * One place, because the same ticket shape is answered by six verbs and a
 * second rendering of it would read as the door disagreeing with itself.
 * Internal ids never cross: a comment's row id is dropped, and a Session
 * travels as the short public handle every verb addresses it by.
 */

import type Database from "better-sqlite3";
import { displayTicketId, shortSessionId, TICKET_STATUSES } from "@volli/shared";
import type { Project, Ticket } from "@volli/shared";

import { listTicketEvents } from "../db/events-repo";
import { getTicket, listTicketsByProject } from "../db/tickets-repo";

export function agentTicket(ticket: Ticket, project: Project): Record<string, unknown> {
  return {
    id: displayTicketId(project.ticketPrefix, ticket.ticketNumber),
    project: project.name,
    title: ticket.title,
    body: ticket.body,
    status: ticket.status,
    priority: ticket.priority,
    labels: ticket.labels,
    usesWorktree: ticket.usesWorktree,
    harness: ticket.preferredHarnessId,
    worktreePath: ticket.worktreePath,
    branch: ticket.branch,
    baseBranch: ticket.baseBranch,
    // Reserved for the loop milestone's reason badge (the Needs Review signal);
    // always null today, so the --json shape stays stable when it lands.
    badge: null,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

export function boardData(db: Database.Database, project: Project): Record<string, unknown> {
  const tickets = listTicketsByProject(db, project.id);
  const columns = Object.fromEntries(
    TICKET_STATUSES.map((status) => [
      status,
      tickets
        .filter((ticket) => ticket.status === status)
        .map((ticket) => agentTicket(ticket, project)),
    ]),
  );
  return {
    project: { name: project.name, prefix: project.ticketPrefix, path: project.path },
    columns,
  };
}

export function publicEvent(
  db: Database.Database,
  projects: readonly Project[],
  event: ReturnType<typeof listTicketEvents>[number],
): Record<string, unknown> {
  const contextTicket = event.actorContext?.ticketId
    ? getTicket(db, event.actorContext.ticketId)
    : undefined;
  const contextProject = contextTicket
    ? projects.find(({ id }) => id === contextTicket.projectId)
    : undefined;
  // Internal ids never cross the socket: a comment's row id is dropped, and a
  // session_started's cited Session travels as the short public handle — the
  // same one `session list` prints and `session peek` addresses.
  const payload =
    event.payload.kind === "commented"
      ? { kind: "commented" }
      : event.payload.kind === "session_started"
        ? { kind: "session_started", session: shortSessionId(event.payload.sessionId) }
        : event.payload;
  return {
    actor: event.actor,
    actorContext: event.actorContext
      ? {
          session: shortSessionId(event.actorContext.sessionId),
          ticket:
            contextTicket && contextProject
              ? displayTicketId(contextProject.ticketPrefix, contextTicket.ticketNumber)
              : null,
        }
      : null,
    payload,
    createdAt: event.createdAt,
  };
}
