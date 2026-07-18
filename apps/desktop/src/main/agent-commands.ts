import type Database from "better-sqlite3";
import {
  createTicket,
  displayTicketId,
  isTicketPriority,
  isTicketStatus,
  moveTicket as moveTicketDomain,
  resolveAgentContext,
  shortSessionId,
  TICKET_STATUSES,
} from "@volli/shared";
import type {
  AgentErrorCode,
  AgentRequest,
  AgentResponse,
  Project,
  TicketEventActor,
  Ticket,
} from "@volli/shared";

import { listTicketEvents, recordTicketEvent } from "./db/events-repo";
import { createComment } from "./db/comments-repo";
import { addTicketLabel, getOrCreateLabel } from "./db/labels-repo";
import { listProjects } from "./db/projects-repo";
import { getSession } from "./db/sessions-repo";
import {
  getTicket,
  insertTicket,
  listAllTickets,
  listTicketsByProject,
  nextPositionInStatus,
  nextTicketNumberForProject,
  updateTicketPositionStatus,
} from "./db/tickets-repo";

export interface AgentCommandServiceOptions {
  db: Database.Database;
  appVersion: string;
  now?: () => number;
  newId?: () => string;
}

export interface AgentCommandService {
  execute(request: AgentRequest): Promise<AgentResponse>;
}

function failure(code: AgentErrorCode, message: string): AgentResponse {
  return { v: 1, ok: false, error: { code, message } };
}

function projectForCreate(
  projects: readonly Project[],
  request: AgentRequest,
): { ok: true; project: Project } | { ok: false; response: AgentResponse } {
  const selector = request.args["project"];
  const result = resolveAgentContext({
    explicit: typeof selector === "string" ? { project: selector } : {},
    env: {
      VOLLI_SESSION: request.ctx.env.session,
      VOLLI_TICKET: request.ctx.env.ticket,
      VOLLI_SOCKET: request.ctx.env.socket,
    },
    cwd: request.ctx.cwd,
    projects,
    tickets: [],
    sessions: [],
  });
  if (!result.ok) {
    const code = result.code as AgentErrorCode;
    return { ok: false, response: failure(code, result.message) };
  }
  const project = projects.find(({ id }) => id === result.context.projectId);
  return project
    ? { ok: true, project }
    : {
        ok: false,
        response: failure("PROJECT_NOT_FOUND", "The resolved project no longer exists."),
      };
}

function agentTicket(ticket: Ticket, project: Project): Record<string, unknown> {
  return {
    id: displayTicketId(project.ticketPrefix, ticket.ticketNumber),
    project: project.name,
    title: ticket.title,
    body: ticket.body,
    status: ticket.status,
    priority: ticket.priority,
    labels: ticket.labels,
    usesWorktree: ticket.usesWorktree,
    branch: ticket.branch,
    baseBranch: ticket.baseBranch,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

function ticketForDisplayId(
  db: Database.Database,
  projects: readonly Project[],
  displayId: unknown,
): { ok: true; ticket: Ticket; project: Project } | { ok: false; response: AgentResponse } {
  if (typeof displayId !== "string") {
    return { ok: false, response: failure("INVALID_REQUEST", "A ticket display id is required.") };
  }
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const matches = listAllTickets(db)
    .map((ticket) => ({ ticket, project: projectById.get(ticket.projectId) }))
    .filter(
      (entry): entry is { ticket: Ticket; project: Project } =>
        entry.project !== undefined &&
        displayTicketId(entry.project.ticketPrefix, entry.ticket.ticketNumber) === displayId,
    );
  if (matches.length > 1) {
    return {
      ok: false,
      response: failure(
        "AMBIGUOUS_TICKET",
        `Ticket ${displayId} matches multiple projects. Make project prefixes unique in Settings.`,
      ),
    };
  }
  const match = matches[0];
  return match
    ? { ok: true, ...match }
    : { ok: false, response: failure("TICKET_NOT_FOUND", `No ticket matches ${displayId}.`) };
}

function boardData(db: Database.Database, project: Project): Record<string, unknown> {
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

function requestActor(
  db: Database.Database,
  request: AgentRequest,
): { ok: true; actor: TicketEventActor } | { ok: false; response: AgentResponse } {
  const sessionId = request.ctx.env.session;
  if (!sessionId) return { ok: true, actor: { kind: "user" } };
  const session = getSession(db, sessionId);
  return session
    ? {
        ok: true,
        actor: { kind: "session", sessionId: session.id, ticketId: session.ticketId },
      }
    : {
        ok: false,
        response: failure("SESSION_NOT_FOUND", `No session matches ${sessionId}.`),
      };
}

export function createAgentCommandService(
  options: AgentCommandServiceOptions,
): AgentCommandService {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? crypto.randomUUID;

  return {
    async execute(request): Promise<AgentResponse> {
      const projects = listProjects(options.db);
      if (request.cmd === "board") {
        const resolved = projectForCreate(projects, request);
        return resolved.ok
          ? { v: 1, ok: true, data: boardData(options.db, resolved.project) }
          : resolved.response;
      }
      if (request.cmd === "ticket.move") {
        const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
        if (!resolved.ok) return resolved.response;
        const actor = requestActor(options.db, request);
        if (!actor.ok) return actor.response;
        const to = request.args["to"];
        if (!isTicketStatus(to)) {
          return failure("INVALID_REQUEST", "ticket move requires a valid destination column.");
        }
        try {
          const movedAt = now();
          const run = options.db.transaction((): Ticket => {
            const before = listTicketsByProject(options.db, resolved.project.id);
            const beforeById = new Map(before.map((ticket) => [ticket.id, ticket]));
            const toIndex = before.filter((ticket) => ticket.status === to).length;
            const after = moveTicketDomain(before, resolved.ticket.id, to, toIndex, movedAt);
            for (const ticket of after) {
              const prior = beforeById.get(ticket.id);
              if (
                prior !== undefined &&
                (prior.status !== ticket.status || prior.order !== ticket.order)
              ) {
                updateTicketPositionStatus(
                  options.db,
                  ticket.id,
                  ticket.status,
                  ticket.order,
                  ticket.updatedAt,
                );
              }
            }
            if (resolved.ticket.status !== to) {
              recordTicketEvent(
                options.db,
                resolved.ticket.id,
                { kind: "status_changed", from: resolved.ticket.status, to },
                movedAt,
                actor.actor,
              );
            }
            return getTicket(options.db, resolved.ticket.id)!;
          });
          return {
            v: 1,
            ok: true,
            data: { ticket: agentTicket(run(), resolved.project) },
          };
        } catch (error) {
          return failure("MUTATION_FAILED", error instanceof Error ? error.message : String(error));
        }
      }
      if (request.cmd === "ticket.comment") {
        const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
        if (!resolved.ok) return resolved.response;
        const actor = requestActor(options.db, request);
        if (!actor.ok) return actor.response;
        const message = request.args["message"];
        if (typeof message !== "string" || message.trim().length === 0) {
          return failure("INVALID_REQUEST", "ticket comment requires a message.");
        }
        try {
          const comment = createComment(
            options.db,
            {
              ticketId: resolved.ticket.id,
              body: message,
              actor: request.ctx.env.session ? "session" : "user",
              sessionId: request.ctx.env.session ?? null,
              eventActor: actor.actor,
            },
            now(),
          );
          return {
            v: 1,
            ok: true,
            data: {
              comment: {
                ticket: displayTicketId(
                  resolved.project.ticketPrefix,
                  resolved.ticket.ticketNumber,
                ),
                body: comment.body,
                actor: comment.actor,
                session: comment.sessionId,
                createdAt: comment.createdAt,
              },
            },
          };
        } catch (error) {
          return failure("MUTATION_FAILED", error instanceof Error ? error.message : String(error));
        }
      }
      if (request.cmd === "ticket.events") {
        const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
        if (!resolved.ok) return resolved.response;
        const requestedLimit = request.args["limit"];
        const limit =
          typeof requestedLimit === "number" &&
          Number.isInteger(requestedLimit) &&
          requestedLimit > 0
            ? requestedLimit
            : 50;
        const projectById = new Map(projects.map((project) => [project.id, project]));
        const events = listTicketEvents(options.db, resolved.ticket.id)
          .slice(-limit)
          .map((event) => {
            const contextTicket = event.actorContext?.ticketId
              ? getTicket(options.db, event.actorContext.ticketId)
              : undefined;
            const contextProject = contextTicket
              ? projectById.get(contextTicket.projectId)
              : undefined;
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
              payload: event.payload,
              createdAt: event.createdAt,
            };
          });
        return { v: 1, ok: true, data: { events } };
      }
      if (request.cmd !== "ticket.create") {
        return failure("UNSUPPORTED_COMMAND", `Unsupported command ${request.cmd}`);
      }
      const resolved = projectForCreate(projects, request);
      if (!resolved.ok) return resolved.response;
      const title = request.args["title"];
      const status = request.args["status"] ?? "backlog";
      const priority = request.args["priority"] ?? "medium";
      const labels = request.args["labels"] ?? [];
      if (
        typeof title !== "string" ||
        title.trim().length === 0 ||
        !isTicketStatus(status) ||
        !isTicketPriority(priority) ||
        !Array.isArray(labels) ||
        !labels.every((label) => typeof label === "string")
      ) {
        return failure("INVALID_REQUEST", "Invalid ticket create arguments.");
      }

      try {
        const createdAt = now();
        const run = options.db.transaction((): Ticket => {
          const ticket = createTicket({
            id: newId(),
            projectId: resolved.project.id,
            ticketNumber: nextTicketNumberForProject(options.db, resolved.project.id),
            title: title.trim(),
            body: typeof request.args["body"] === "string" ? request.args["body"] : "",
            status,
            priority,
            labels,
            usesWorktree:
              typeof request.args["usesWorktree"] === "boolean"
                ? request.args["usesWorktree"]
                : true,
            order: nextPositionInStatus(options.db, resolved.project.id, status),
            baseBranch: typeof request.args["base"] === "string" ? request.args["base"] : null,
            now: createdAt,
          });
          insertTicket(options.db, ticket);
          recordTicketEvent(
            options.db,
            ticket.id,
            { kind: "created", status: ticket.status, title: ticket.title },
            createdAt,
          );
          for (const name of labels) {
            const label = getOrCreateLabel(options.db, ticket.projectId, name, createdAt);
            addTicketLabel(options.db, ticket.id, label.id);
          }
          if (labels.length > 0) {
            recordTicketEvent(
              options.db,
              ticket.id,
              { kind: "labels_changed", added: labels, removed: [] },
              createdAt,
            );
          }
          return getTicket(options.db, ticket.id)!;
        });
        const ticket = run();
        return {
          v: 1,
          ok: true,
          data: { ticket: agentTicket(ticket, resolved.project) },
        };
      } catch (error) {
        return failure("MUTATION_FAILED", error instanceof Error ? error.message : String(error));
      }
    },
  };
}
