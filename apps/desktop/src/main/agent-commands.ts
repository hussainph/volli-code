import type Database from "better-sqlite3";
import {
  applyTicketBodyMutation,
  composeTicketPrompt,
  displayTicketId,
  errorMessage,
  isTicketPriority,
  isTicketStatus,
  isHarnessId,
  resolveAgentContext,
  shortSessionId,
  TICKET_STATUSES,
} from "@volli/shared";
import type {
  AgentErrorCode,
  AgentRequest,
  AgentResponse,
  Project,
  SessionActivityState,
  TicketEventActor,
  TicketBodyMutation,
  Ticket,
} from "@volli/shared";

import { listTicketEvents, recordTicketEvent } from "./db/events-repo";
import { listComments } from "./db/comments-repo";
import { listAllLabels } from "./db/labels-repo";
import { listProjects } from "./db/projects-repo";
import { getSession, listSessions } from "./db/sessions-repo";
import {
  getTicket,
  listAllTickets,
  listArchivedTicketsByProject,
  listTicketsByProject,
} from "./db/tickets-repo";
import {
  archiveTicketCommand,
  createTicketCommand,
  createTicketCommentCommand,
  moveTicketCommand,
  setTicketLabelsCommand,
  setTicketPriorityCommand,
  updateTicketFieldsCommand,
} from "./ticket-commands";

export interface AgentCommandServiceOptions {
  db: Database.Database;
  appVersion: string;
  now?: () => number;
  newId?: () => string;
  observeSession?: (
    sessionId: string,
    lines: number,
  ) => { status: SessionActivityState; output: string } | undefined;
  notify?: (title: string, message: string) => void;
}

export interface AgentCommandService {
  execute(request: AgentRequest): Promise<AgentResponse>;
}

function failure(code: AgentErrorCode, message: string): AgentResponse {
  return { v: 1, ok: false, error: { code, message } };
}

/**
 * A CLI count option (`--events`/`--comments`/`--limit`/`--lines`) is honored
 * only when it's a positive integer; 0, negatives, and NaN fall back to the
 * command's default — never `slice(-0)`, which would return the whole history.
 */
function positiveIntOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function projectForCreate(
  db: Database.Database,
  projects: readonly Project[],
  request: AgentRequest,
): { ok: true; project: Project } | { ok: false; response: AgentResponse } {
  const selector = request.args["project"];
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const allTickets = projects.flatMap((project) => [
    ...listTicketsByProject(db, project.id),
    ...listArchivedTicketsByProject(db, project.id),
  ]);
  const ticketDisplayById = new Map(
    allTickets.flatMap((ticket) => {
      const project = projectById.get(ticket.projectId);
      return project
        ? [[ticket.id, displayTicketId(project.ticketPrefix, ticket.ticketNumber)] as const]
        : [];
    }),
  );
  const result = resolveAgentContext({
    explicit: typeof selector === "string" ? { project: selector } : {},
    env: {
      VOLLI_SESSION: request.ctx.env.session,
      VOLLI_TICKET: request.ctx.env.ticket,
      VOLLI_SOCKET: request.ctx.env.socket,
    },
    cwd: request.ctx.cwd,
    projects: projects.map((project) => ({
      ...project,
      worktreePaths: allTickets
        .filter((ticket) => ticket.projectId === project.id && ticket.worktreePath !== null)
        .map((ticket) => ticket.worktreePath!),
    })),
    tickets: allTickets.map((ticket) => ({
      displayId: ticketDisplayById.get(ticket.id)!,
      projectId: ticket.projectId,
    })),
    sessions: projects.flatMap((project) =>
      listSessions(db, project.id).map((session) => ({
        id: session.id,
        projectId: session.projectId,
        ticketDisplayId: session.ticketId
          ? (ticketDisplayById.get(session.ticketId) ?? null)
          : null,
      })),
    ),
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
    harness: ticket.preferredHarnessId,
    branch: ticket.branch,
    baseBranch: ticket.baseBranch,
    // Reserved for the loop milestone's reason badge (the Needs Review signal);
    // always null today, so the --json shape stays stable when it lands.
    badge: null,
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
  if (match) return { ok: true, ...match };
  const archivedMatches = projects.flatMap((project) =>
    listArchivedTicketsByProject(db, project.id)
      .filter((ticket) => displayTicketId(project.ticketPrefix, ticket.ticketNumber) === displayId)
      .map((ticket) => ({ ticket, project })),
  );
  if (archivedMatches.length > 1) {
    return {
      ok: false,
      response: failure(
        "AMBIGUOUS_TICKET",
        `Ticket ${displayId} matches multiple projects. Make project prefixes unique in Settings.`,
      ),
    };
  }
  return archivedMatches.length === 1
    ? {
        ok: false,
        response: failure("ARCHIVED_TICKET", `Ticket ${displayId} is archived.`),
      }
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

function publicEvent(
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
  const payload =
    event.payload.kind === "commented"
      ? { kind: "commented" }
      : event.payload.kind === "session_started"
        ? {
            kind: "session_started",
            session: shortSessionId(event.payload.sessionId),
            title: event.payload.title,
            harnessId: event.payload.harnessId,
          }
        : event.payload.kind === "session_ended"
          ? { kind: "session_ended", session: shortSessionId(event.payload.sessionId) }
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

function isBodyMutation(value: unknown): value is TicketBodyMutation {
  if (typeof value !== "object" || value === null || !("mode" in value)) return false;
  if (value.mode === "replace") return "body" in value && typeof value.body === "string";
  if (value.mode === "append") return "text" in value && typeof value.text === "string";
  return (
    value.mode === "edit" &&
    "oldText" in value &&
    typeof value.oldText === "string" &&
    "newText" in value &&
    typeof value.newText === "string"
  );
}

function sessionForPublicId(
  db: Database.Database,
  projects: readonly Project[],
  selector: unknown,
):
  | { ok: true; session: NonNullable<ReturnType<typeof getSession>> }
  | { ok: false; response: AgentResponse } {
  if (typeof selector !== "string") {
    return { ok: false, response: failure("INVALID_REQUEST", "A session id is required.") };
  }
  // Short ids are the only public session handles (decision 3): `session list`
  // prints them and `session peek` addresses by them. Full UUIDs never cross
  // the socket as an input — only requestActor's env `VOLLI_SESSION` uses them,
  // and that's the door contract, resolved separately.
  const matches = projects
    .flatMap((project) => listSessions(db, project.id))
    .filter((session) => shortSessionId(session.id) === selector);
  if (matches.length > 1) {
    return {
      ok: false,
      response: failure("AMBIGUOUS_CONTEXT", `Session id ${selector} is ambiguous.`),
    };
  }
  return matches[0]
    ? { ok: true, session: matches[0] }
    : {
        ok: false,
        response: failure("SESSION_NOT_FOUND", `No session matches ${selector}.`),
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
      if (request.cmd === "identify") {
        const sessionId = request.ctx.env.session;
        if (sessionId) {
          const session = getSession(options.db, sessionId);
          if (!session) {
            return failure("SESSION_NOT_FOUND", `No session matches ${sessionId}.`);
          }
          const project = projects.find(({ id }) => id === session.projectId);
          if (!project) {
            return failure("PROJECT_NOT_FOUND", "The session's project no longer exists.");
          }
          const ticket = session.ticketId ? getTicket(options.db, session.ticketId) : undefined;
          return {
            v: 1,
            ok: true,
            data: {
              project: { name: project.name, prefix: project.ticketPrefix, path: project.path },
              ticket: ticket ? displayTicketId(project.ticketPrefix, ticket.ticketNumber) : null,
              session: shortSessionId(session.id),
              worktreePath: session.cwd,
              socket: request.ctx.env.socket ?? null,
              appVersion: options.appVersion,
            },
          };
        }
        const ticketSelector = request.ctx.env.ticket;
        const ticket = ticketSelector
          ? ticketForDisplayId(options.db, projects, ticketSelector)
          : undefined;
        if (ticket && !ticket.ok) return ticket.response;
        const resolved = ticket?.ok
          ? { ok: true as const, project: ticket.project }
          : projectForCreate(options.db, projects, request);
        if (!resolved.ok) return resolved.response;
        return {
          v: 1,
          ok: true,
          data: {
            project: {
              name: resolved.project.name,
              prefix: resolved.project.ticketPrefix,
              path: resolved.project.path,
            },
            ticket: ticket?.ok
              ? displayTicketId(ticket.project.ticketPrefix, ticket.ticket.ticketNumber)
              : null,
            session: null,
            worktreePath: request.ctx.cwd,
            socket: request.ctx.env.socket ?? null,
            appVersion: options.appVersion,
          },
        };
      }
      if (request.cmd === "board") {
        const resolved = projectForCreate(options.db, projects, request);
        return resolved.ok
          ? { v: 1, ok: true, data: boardData(options.db, resolved.project) }
          : resolved.response;
      }
      if (request.cmd === "project.list") {
        return {
          v: 1,
          ok: true,
          data: {
            projects: projects.map((project) => ({
              name: project.name,
              prefix: project.ticketPrefix,
              path: project.path,
              tickets: listTicketsByProject(options.db, project.id).length,
              archived: listArchivedTicketsByProject(options.db, project.id).length,
            })),
          },
        };
      }
      if (request.cmd === "label.list") {
        const resolved = projectForCreate(options.db, projects, request);
        if (!resolved.ok) return resolved.response;
        const projectTickets = listTicketsByProject(options.db, resolved.project.id);
        const labels = listAllLabels(options.db)
          .filter(({ projectId }) => projectId === resolved.project.id)
          .map((label) => ({
            name: label.name,
            color: label.color,
            tickets: projectTickets.filter((ticket) => ticket.labels.includes(label.name)).length,
          }));
        return { v: 1, ok: true, data: { labels } };
      }
      if (request.cmd === "session.list") {
        const ticketSelector = request.args["ticket"];
        const ticketResolution =
          ticketSelector === undefined
            ? undefined
            : ticketForDisplayId(options.db, projects, ticketSelector);
        if (ticketResolution && !ticketResolution.ok) return ticketResolution.response;
        const resolvedProject = ticketResolution?.ok
          ? ticketResolution.project
          : projectForCreate(options.db, projects, request);
        if (!("id" in resolvedProject)) {
          if (!resolvedProject.ok) return resolvedProject.response;
        }
        const project = "id" in resolvedProject ? resolvedProject : resolvedProject.project;
        const projectById = new Map(projects.map((entry) => [entry.id, entry]));
        const sessions = listSessions(options.db, project.id)
          .filter(
            (session) => !ticketResolution?.ok || session.ticketId === ticketResolution.ticket.id,
          )
          .map((session) => {
            const ticket = session.ticketId ? getTicket(options.db, session.ticketId) : undefined;
            const ticketProject = ticket ? projectById.get(ticket.projectId) : undefined;
            return {
              id: shortSessionId(session.id),
              kind: session.ticketId ? "ticket" : "scratch",
              status: session.endedAt === null ? "running" : "exited",
              ticket:
                ticket && ticketProject
                  ? displayTicketId(ticketProject.ticketPrefix, ticket.ticketNumber)
                  : null,
              title: session.title,
              harness: session.harnessId,
              ageMs: Math.max(0, now() - session.createdAt),
            };
          });
        return { v: 1, ok: true, data: { sessions } };
      }
      if (request.cmd === "session.peek") {
        const resolved = sessionForPublicId(options.db, projects, request.args["id"]);
        if (!resolved.ok) return resolved.response;
        const lines = positiveIntOr(request.args["lines"], 60);
        const observation = options.observeSession?.(resolved.session.id, lines);
        if (!observation) {
          return failure(
            "SESSION_NOT_FOUND",
            `Session ${shortSessionId(resolved.session.id)} has no observable live terminal.`,
          );
        }
        return {
          v: 1,
          ok: true,
          data: {
            session: shortSessionId(resolved.session.id),
            status: observation.status,
            output: observation.output,
          },
        };
      }
      if (request.cmd === "notify") {
        const message = request.args["message"];
        const title = request.args["title"] ?? "Volli Code";
        if (
          typeof message !== "string" ||
          message.trim().length === 0 ||
          typeof title !== "string" ||
          title.trim().length === 0
        ) {
          return failure("INVALID_REQUEST", "notify requires a message and optional title.");
        }
        options.notify?.(title, message);
        return { v: 1, ok: true, data: { notified: true } };
      }
      if (request.cmd === "session.done" || request.cmd === "session.blocked") {
        const sessionId = request.ctx.env.session;
        if (!sessionId) {
          return failure(
            "CONTEXT_REQUIRED",
            "session done and blocked require VOLLI_SESSION context.",
          );
        }
        const session = getSession(options.db, sessionId);
        if (!session) return failure("SESSION_NOT_FOUND", `No session matches ${sessionId}.`);
        const reasonValue = request.args["reason"];
        if (reasonValue !== undefined && typeof reasonValue !== "string") {
          return failure("INVALID_REQUEST", "The lifecycle reason must be text.");
        }
        const reason = typeof reasonValue === "string" ? reasonValue : null;
        const signal = request.cmd === "session.done" ? "done" : "blocked";
        // A scratch session has no ticket to record against — the signal is a
        // no-op beyond acknowledging it. When the session drives a ticket, the
        // outcome is written to that ticket's event log as an `automation`
        // actor (the door, not the keyboard — decision 8), in one transaction.
        const ticketId = session.ticketId;
        if (ticketId !== null) {
          options.db.transaction(() => {
            recordTicketEvent(
              options.db,
              ticketId,
              { kind: "session_signal", signal, reason },
              now(),
              { kind: "automation", sessionId: session.id, ticketId },
            );
          })();
        }
        return {
          v: 1,
          ok: true,
          data: {
            session: shortSessionId(session.id),
            signal,
            reason,
            recorded: ticketId !== null,
          },
        };
      }
      if (request.cmd === "ticket.list") {
        const resolved = projectForCreate(options.db, projects, request);
        if (!resolved.ok) return resolved.response;
        const status = request.args["status"];
        const priority = request.args["priority"];
        const label = request.args["label"];
        const limit = request.args["limit"];
        if (
          (status !== undefined && !isTicketStatus(status)) ||
          (priority !== undefined && !isTicketPriority(priority)) ||
          (label !== undefined && typeof label !== "string") ||
          (limit !== undefined &&
            (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0))
        ) {
          return failure("INVALID_REQUEST", "Invalid ticket list filters.");
        }
        const tickets = listTicketsByProject(options.db, resolved.project.id)
          .filter((ticket) => status === undefined || ticket.status === status)
          .filter((ticket) => priority === undefined || ticket.priority === priority)
          .filter((ticket) => label === undefined || ticket.labels.includes(label))
          .slice(0, typeof limit === "number" ? limit : undefined)
          .map((ticket) => agentTicket(ticket, resolved.project));
        return { v: 1, ok: true, data: { tickets } };
      }
      if (request.cmd === "ticket.show") {
        const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
        if (!resolved.ok) return resolved.response;
        const eventLimit = positiveIntOr(request.args["events"], 5);
        const commentLimit = positiveIntOr(request.args["comments"], 5);
        const displayId = displayTicketId(
          resolved.project.ticketPrefix,
          resolved.ticket.ticketNumber,
        );
        const events = listTicketEvents(options.db, resolved.ticket.id)
          .slice(-eventLimit)
          .map((event) => publicEvent(options.db, projects, event));
        const comments = listComments(options.db, resolved.ticket.id)
          .slice(-commentLimit)
          .map((comment) => ({
            ticket: displayId,
            body: comment.body,
            actor: comment.actor,
            session: comment.sessionId ? shortSessionId(comment.sessionId) : null,
            createdAt: comment.createdAt,
            updatedAt: comment.updatedAt,
          }));
        return {
          v: 1,
          ok: true,
          data: { ticket: agentTicket(resolved.ticket, resolved.project), events, comments },
        };
      }
      if (request.cmd === "ticket.brief") {
        const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
        if (!resolved.ok) return resolved.response;
        const displayId = displayTicketId(
          resolved.project.ticketPrefix,
          resolved.ticket.ticketNumber,
        );
        const ticketPrompt = composeTicketPrompt({
          displayId,
          title: resolved.ticket.title,
          body: resolved.ticket.body,
        });
        return {
          v: 1,
          ok: true,
          data: {
            prompt: `Load and follow the \`volli\` skill for board coordination.\n\n${ticketPrompt}`,
          },
        };
      }
      if (request.cmd === "ticket.update") {
        const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
        if (!resolved.ok) return resolved.response;
        const actor = requestActor(options.db, request);
        if (!actor.ok) return actor.response;
        const title = request.args["title"];
        const priority = request.args["priority"];
        const base = request.args["base"];
        const harness = request.args["harness"];
        const mutation = request.args["bodyMutation"];
        const addLabels = request.args["addLabels"] ?? [];
        const removeLabels = request.args["removeLabels"] ?? [];
        if (
          (title !== undefined && (typeof title !== "string" || title.trim().length === 0)) ||
          (priority !== undefined && !isTicketPriority(priority)) ||
          (base !== undefined && typeof base !== "string") ||
          (harness !== undefined && !isHarnessId(harness)) ||
          (mutation !== undefined && !isBodyMutation(mutation)) ||
          !Array.isArray(addLabels) ||
          !addLabels.every((label) => typeof label === "string") ||
          !Array.isArray(removeLabels) ||
          !removeLabels.every((label) => typeof label === "string")
        ) {
          return failure("INVALID_REQUEST", "Invalid ticket update arguments.");
        }
        const nextBody = mutation
          ? applyTicketBodyMutation(resolved.ticket.body, mutation)
          : undefined;
        if (nextBody && !nextBody.ok) {
          return failure(nextBody.code, nextBody.message);
        }
        try {
          const updatedAt = now();
          const run = options.db.transaction((): Ticket => {
            let ticket = updateTicketFieldsCommand(
              options.db,
              {
                ticketId: resolved.ticket.id,
                ...(typeof title === "string" ? { title: title.trim() } : {}),
                ...(nextBody?.ok ? { body: nextBody.body } : {}),
                ...(typeof base === "string" ? { baseBranch: base } : {}),
                ...(isHarnessId(harness) ? { preferredHarnessId: harness } : {}),
              },
              { now: updatedAt, actor: actor.actor },
            );
            if (priority !== undefined && priority !== resolved.ticket.priority) {
              ticket = setTicketPriorityCommand(
                options.db,
                { ticketId: resolved.ticket.id, priority },
                { now: updatedAt, actor: actor.actor },
              );
            }
            const currentLabels = resolved.ticket.labels;
            const requestedLabels = currentLabels
              .filter((label) => !removeLabels.includes(label))
              .concat(addLabels.filter((label) => !currentLabels.includes(label)));
            ticket = setTicketLabelsCommand(
              options.db,
              { ticketId: resolved.ticket.id, labels: requestedLabels },
              { now: updatedAt, actor: actor.actor },
            );
            return ticket;
          });
          return {
            v: 1,
            ok: true,
            data: { ticket: agentTicket(run(), resolved.project) },
          };
        } catch (error) {
          return failure("MUTATION_FAILED", errorMessage(error));
        }
      }
      if (request.cmd === "ticket.archive") {
        const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
        if (!resolved.ok) return resolved.response;
        const actor = requestActor(options.db, request);
        if (!actor.ok) return actor.response;
        try {
          const archivedAt = now();
          archiveTicketCommand(options.db, resolved.ticket.id, {
            now: archivedAt,
            actor: actor.actor,
          });
          return {
            v: 1,
            ok: true,
            data: {
              ticket: {
                id: displayTicketId(resolved.project.ticketPrefix, resolved.ticket.ticketNumber),
                archived: true,
                archivedAt,
              },
            },
          };
        } catch (error) {
          return failure("MUTATION_FAILED", errorMessage(error));
        }
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
          const before = listTicketsByProject(options.db, resolved.project.id);
          const toIndex = before.filter((ticket) => ticket.status === to).length;
          const moved = moveTicketCommand(
            options.db,
            {
              projectId: resolved.project.id,
              ticketId: resolved.ticket.id,
              toStatus: to,
              toIndex,
            },
            { now: movedAt, actor: actor.actor },
          );
          const ticket = moved.find(({ id }) => id === resolved.ticket.id)!;
          return {
            v: 1,
            ok: true,
            data: { ticket: agentTicket(ticket, resolved.project) },
          };
        } catch (error) {
          return failure("MUTATION_FAILED", errorMessage(error));
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
          const comment = createTicketCommentCommand(
            options.db,
            {
              ticketId: resolved.ticket.id,
              body: message,
              commentActor: request.ctx.env.session ? "session" : "user",
              sessionId: request.ctx.env.session ?? null,
            },
            { now: now(), actor: actor.actor },
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
                session: comment.sessionId ? shortSessionId(comment.sessionId) : null,
                createdAt: comment.createdAt,
              },
            },
          };
        } catch (error) {
          return failure("MUTATION_FAILED", errorMessage(error));
        }
      }
      if (request.cmd === "ticket.events") {
        const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
        if (!resolved.ok) return resolved.response;
        const limit = positiveIntOr(request.args["limit"], 50);
        const events = listTicketEvents(options.db, resolved.ticket.id)
          .slice(-limit)
          .map((event) => publicEvent(options.db, projects, event));
        return { v: 1, ok: true, data: { events } };
      }
      if (request.cmd !== "ticket.create") {
        return failure("UNSUPPORTED_COMMAND", `Unsupported command ${request.cmd}`);
      }
      const resolved = projectForCreate(options.db, projects, request);
      if (!resolved.ok) return resolved.response;
      const title = request.args["title"];
      const status = request.args["status"] ?? "backlog";
      const priority = request.args["priority"] ?? "medium";
      const labels = request.args["labels"] ?? [];
      const harness = request.args["harness"];
      if (
        typeof title !== "string" ||
        title.trim().length === 0 ||
        !isTicketStatus(status) ||
        !isTicketPriority(priority) ||
        (harness !== undefined && !isHarnessId(harness)) ||
        !Array.isArray(labels) ||
        !labels.every((label) => typeof label === "string")
      ) {
        return failure("INVALID_REQUEST", "Invalid ticket create arguments.");
      }

      try {
        const createdAt = now();
        const actor = requestActor(options.db, request);
        if (!actor.ok) return actor.response;
        const ticket = createTicketCommand(
          options.db,
          {
            id: newId(),
            projectId: resolved.project.id,
            title: title.trim(),
            body: typeof request.args["body"] === "string" ? request.args["body"] : "",
            status,
            priority,
            labels,
            usesWorktree:
              typeof request.args["usesWorktree"] === "boolean"
                ? request.args["usesWorktree"]
                : true,
            preferredHarnessId: isHarnessId(harness) ? harness : undefined,
            baseBranch:
              typeof request.args["base"] === "string"
                ? request.args["base"]
                : (resolved.project.baseBranch ?? null),
          },
          { now: createdAt, actor: actor.actor },
        );
        return {
          v: 1,
          ok: true,
          data: { ticket: agentTicket(ticket, resolved.project) },
        };
      } catch (error) {
        return failure("MUTATION_FAILED", errorMessage(error));
      }
    },
  };
}
