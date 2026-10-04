/**
 * What a resolved subject looks like once it crosses the socket.
 *
 * One place, because the same ticket shape is answered by six verbs and a
 * second rendering of it would read as the door disagreeing with itself.
 * Internal ids never cross: a comment's row id is dropped, and a Session
 * travels as the short public handle every verb addresses it by.
 */

import type Database from "better-sqlite3";
import { displayTicketId, readSessionOrigin, shortSessionId, TICKET_STATUSES } from "@volli/shared";
import type { Project, SessionOrigin, Ticket } from "@volli/shared";

import { listTicketEvents } from "@volli/host-core/db/events-repo";
import { getTicket, listTicketsByProject } from "@volli/host-core/db/tickets-repo";

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

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Session a stored event payload cites, as the short public handle every
 * verb addresses it by. Only a minted UUID is shortened — payload text that
 * merely sits where an id should be is passed through, so a malformed fact
 * stays visible as malformed rather than being truncated into something that
 * looks valid. (Ids Volli itself holds are always shortened outright.)
 */
function publicEventSession(sessionId: string): string {
  return SESSION_UUID.test(sessionId) ? shortSessionId(sessionId) : sessionId;
}

/**
 * Who asked for work, with the one Session id it can name shortened to its
 * public handle. Everything else is verbatim: a Run id is not a Session handle
 * and is the only way to find the Run. `null` stays `null`, because a legacy
 * fact that recorded no origin is unknown — never a person.
 */
export function publicSessionOrigin(origin: SessionOrigin | null): SessionOrigin | null {
  return origin?.kind === "session"
    ? { kind: "session", sessionId: shortSessionId(origin.sessionId) }
    : origin;
}

/** A turn id is internal; the first eight characters correlate it across surfaces. */
export function publicTurnHandle(turnId: string): string {
  return turnId.slice(0, 8);
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
  // Session a launch or resume event cites travels as the short public handle
  // — the same one `session list` prints and `session peek` addresses — in
  // `session`, and so does any Session its `origin` names.
  const payload =
    event.payload.kind === "commented"
      ? { kind: "commented" }
      : event.payload.kind === "session_started"
        ? {
            kind: "session_started",
            session: publicEventSession(event.payload.sessionId),
            ...publicLaunchOrigin(event.payload.origin),
          }
        : event.payload.kind === "session_resumed"
          ? {
              kind: "session_resumed",
              session: publicEventSession(event.payload.sessionId),
              attachment: event.payload.attachmentId.slice(0, 8),
              origin: publicSessionOrigin(readSessionOrigin(event.payload.origin)),
            }
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

/** A launch's origin when it recorded a readable one; legacy launches carry none. */
function publicLaunchOrigin(stored: unknown): { origin?: SessionOrigin } {
  const origin = publicSessionOrigin(readSessionOrigin(stored));
  return origin === null ? {} : { origin };
}
