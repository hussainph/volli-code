/**
 * The read verbs: what an agent can ask without changing anything (VC-167).
 *
 * Every one of these is read tier — any caller, no session actor required —
 * and none of them writes. They share the context ladder in `resolution.ts`
 * and the public shapes in `wire.ts`; what is here is the answer each verb
 * composes out of them.
 */

import {
  displayTicketId,
  isTicketStatus,
  MUTATION_PLAN_CONTRACT,
  pathContains,
  shortSessionId,
} from "@volli/shared";
import type { AgentRequest, AgentResponse, Project, SessionEvent } from "@volli/shared";
import type Database from "better-sqlite3";

import { listMaterializableLinks } from "../db/blobs-repo";
import { listRecentComments } from "../db/comments-repo";
import { listRecentTicketEvents } from "../db/events-repo";
import { listAllLabels } from "../db/labels-repo";
import { listLatestSignals } from "../db/signals-repo";
import {
  getTicket,
  listArchivedTicketsByProject,
  listTicketsByProject,
  listWorktreePathsByProject,
} from "../db/tickets-repo";
import { isInside } from "../worktree/paths";
import { composeTicketBrief } from "./briefs";
import { failure } from "./context";
import type { AgentCommandContext } from "./context";
import {
  countOr,
  invalidPriorityResponse,
  positiveIntOr,
  projectForCreate,
  ticketForDisplayId,
} from "./resolution";
import { agentTicket, boardData, publicEvent } from "./wire";

/**
 * The warning an agent gets from `identify` when it is working somewhere other
 * than its ticket's worktree (VC-98).
 *
 * A Session binds its directory once, at attach, and keeps it (see
 * `SessionLocationResolver.prepare`) — so a Session that started before its
 * ticket's worktree existed goes on running in the main checkout after one is
 * materialized, which is precisely the state that let VC-81's work land in the
 * wrong checkout. Volli deliberately does NOT re-point that live binding, so
 * the divergence is real and the agent is the only party that can resolve it.
 *
 * Measured against the CALLER'S CWD rather than the binding, and recomputed on
 * every call rather than stored: an agent drives its own working directory
 * through bash, so where it actually is cannot be tracked from here, only
 * observed at the moment it asks. That also makes the warning self-clearing —
 * an agent that moves into the worktree simply stops being told it hasn't,
 * with no flag left behind to go stale.
 */
function worktreeMisalignment(
  displayId: string,
  worktreePath: string | null,
  cwd: string,
): string | null {
  // No stamped worktree means nothing to be misaligned WITH: either the ticket
  // runs in the main checkout by choice, or its worktree has yet to be created.
  if (worktreePath === null) return null;
  if (isInside(worktreePath, cwd)) return null;
  return `You are working in ${cwd}, which is outside ${displayId}'s worktree at ${worktreePath}. Move your work there before continuing.`;
}

/**
 * The outer boundary for a project-scoped environment read.
 *
 * A caller can stand in either the main checkout or any stamped worktree. The
 * most specific worktree containing its cwd wins — a Project Session standing
 * in some ticket's worktree is measured against that worktree, not against the
 * checkout it was registered from. Otherwise the main checkout is the
 * boundary, and `fallback` covers a Session addressed from somewhere outside
 * the project entirely, preserving its own worktree as the scope rather than
 * measuring that unrelated directory.
 *
 * Called only when there is an environment to scope: it costs a query, and
 * `identify` is the command every agent runs first.
 */
function environmentProjectRoot(
  db: Database.Database,
  project: Project,
  cwd: string,
  fallback: string = project.path,
): string {
  const worktree = listWorktreePathsByProject(db, project.id)
    .filter((path) => pathContains(path, cwd))
    .toSorted((a, b) => b.length - a.length)[0];
  if (worktree !== undefined) return worktree;
  return pathContains(project.path, cwd) ? project.path : fallback;
}

/** Reads VC-164's frozen list without backfilling or consulting current Settings. */
function recordedAgentToolSurface(events: readonly SessionEvent[]): readonly string[] | null {
  for (const event of events) {
    if (
      event.payload.kind === "session.input.recorded" &&
      event.payload.input.kind === "tool-surface"
    ) {
      return event.payload.input.tools;
    }
  }
  return null;
}

/**
 * `volli identify` — the project, ticket, session and session environment the
 * caller is standing in.
 */
export async function identifyVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects, sessions, envSession, sessionEngine } = context;
  const envSessionId = request.ctx.env.session;
  if (envSessionId) {
    if (!envSession) {
      return failure("SESSION_NOT_FOUND", `No session matches ${envSessionId}.`);
    }
    const project = projects.find(({ id }) => id === envSession.projectId);
    if (!project) {
      return failure("PROJECT_NOT_FOUND", "The session's project no longer exists.");
    }
    const ticket = envSession.ticketId ? getTicket(options.db, envSession.ticketId) : undefined;
    // Measured at the moment the agent asks, like the worktree-misalignment
    // warning below: main adopted the PATH once at boot, and this reports that
    // outcome — never re-probes, never guesses. The second path is the outer
    // boundary; a package cwd may still walk up to its monorepo root.
    const env = options.sessionEnv
      ? await options.sessionEnv(
          request.ctx.cwd,
          environmentProjectRoot(
            options.db,
            project,
            request.ctx.cwd,
            ticket?.worktreePath ?? project.path,
          ),
        )
      : undefined;
    // A PTY session's directory is its terminal's cwd; a structured
    // Session has no PTY, so its workspace is the ticket worktree — or
    // the project root a ticketless Session was pointed at.
    const terminal = sessions.find((candidate) => candidate.id === envSessionId);
    const displayId = ticket ? displayTicketId(project.ticketPrefix, ticket.ticketNumber) : null;
    const warning =
      ticket && displayId
        ? worktreeMisalignment(displayId, ticket.worktreePath, request.ctx.cwd)
        : null;
    // Read-only, opt-in, and deliberately nullable for Sessions that
    // predate VC-164. Help must never freeze or reconstruct a bundle as a
    // side effect of asking what this Session already recorded.
    //
    // Only the caller that needs it pays for it. Reading the frozen list
    // means folding this Session's whole ledger, and `identify` already
    // folds it once through `getSession` — doing it twice on the command
    // agents are told to run first would be a real cost for a fact only
    // role-aware `volli help` consumes.
    const frozenTools =
      request.args["agentSurface"] === true
        ? recordedAgentToolSurface(await sessionEngine.listEvents({ sessionId: envSession.id }))
        : null;
    return {
      v: 1,
      ok: true,
      data: {
        project: { name: project.name, prefix: project.ticketPrefix, path: project.path },
        ticket: displayId,
        session: shortSessionId(envSession.id),
        worktreePath: terminal?.cwd ?? ticket?.worktreePath ?? project.path,
        ...(warning === null ? {} : { warning }),
        socket: request.ctx.env.socket ?? null,
        appVersion: options.appVersion,
        // Declared, not implied by a version: a CLI refuses to send a
        // dryRun request to a build that does not answer this marker,
        // because an older build would run the real write instead.
        previewContract: MUTATION_PLAN_CONTRACT,
        ...(frozenTools === null
          ? {}
          : {
              agentSurface: {
                role: envSession.ticketId === null ? "project" : "ticket",
                tools: frozenTools,
              },
            }),
        ...(env === undefined ? {} : { env }),
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
    : projectForCreate(options.db, projects, envSession, request);
  if (!resolved.ok) return resolved.response;
  const env = options.sessionEnv
    ? await options.sessionEnv(
        request.ctx.cwd,
        environmentProjectRoot(
          options.db,
          resolved.project,
          request.ctx.cwd,
          ticket?.ok ? (ticket.ticket.worktreePath ?? ticket.project.path) : resolved.project.path,
        ),
      )
    : undefined;
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
      previewContract: MUTATION_PLAN_CONTRACT,
      ...(env === undefined ? {} : { env }),
    },
  };
}

/** `volli board` — a project's board, grouped by column. */
export async function boardVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects, envSession } = context;
  const resolved = projectForCreate(options.db, projects, envSession, request);
  return resolved.ok
    ? { v: 1, ok: true, data: boardData(options.db, resolved.project) }
    : resolved.response;
}

/** `volli project list` — every registered project, with its ticket counts. */
export async function projectListVerb(
  context: AgentCommandContext,
  _request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects } = context;
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

/** `volli label list` — a project's labels, with how many tickets wear each. */
export async function labelListVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects, envSession } = context;
  const resolved = projectForCreate(options.db, projects, envSession, request);
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

/** `volli ticket list` — a project's tickets, optionally filtered. */
export async function ticketListVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects, envSession } = context;
  const resolved = projectForCreate(options.db, projects, envSession, request);
  if (!resolved.ok) return resolved.response;
  const status = request.args["status"];
  const priority = request.args["priority"];
  const label = request.args["label"];
  const limit = request.args["limit"];
  const listPriorityError = invalidPriorityResponse(priority);
  if (listPriorityError) return listPriorityError;
  if (
    (status !== undefined && !isTicketStatus(status)) ||
    (label !== undefined && typeof label !== "string") ||
    (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0))
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

/** `volli ticket show` — one ticket, with its recent events and comments. */
export async function ticketShowVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects } = context;
  const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
  if (!resolved.ok) return resolved.response;
  // Zero is a real count here, not an absent one: an orchestrator polling this
  // ticket for a verdict wants neither log, and paying for one is the cost
  // VC-85 measured at ~60% of an orchestration pass.
  const eventLimit = countOr(request.args["events"], 5);
  const commentLimit = countOr(request.args["comments"], 5);
  const displayId = displayTicketId(resolved.project.ticketPrefix, resolved.ticket.ticketNumber);
  const events = listRecentTicketEvents(options.db, resolved.ticket.id, eventLimit).map((event) =>
    publicEvent(options.db, projects, event),
  );
  const comments = listRecentComments(options.db, resolved.ticket.id, commentLimit).map(
    (comment) => ({
      ticket: displayId,
      body: comment.body,
      actor: comment.actor,
      session: comment.sessionId ? shortSessionId(comment.sessionId) : null,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    }),
  );
  // Unconditional, and uncapped by either count: this is where the ticket
  // STANDS, and it is at most one row per kind (VC-85). Capping it would be
  // capping the answer rather than the history, and hiding it behind a flag
  // would leave the cheapest poll unable to see the thing it polls for.
  const signals = listLatestSignals(options.db, resolved.ticket.id).map((signal) => ({
    ticket: displayId,
    kind: signal.kind,
    verdict: signal.verdict,
    detail: signal.detail,
    session: signal.sessionId ? shortSessionId(signal.sessionId) : null,
    createdAt: signal.createdAt,
  }));
  // A polling projection must not resend a static ticket body every cycle.
  // `--comments-only` marks that intent explicitly; zeroing both logs is the
  // signal-only equivalent. Keep the three fields plaintext rendering needs,
  // while the full `ticket show` shape remains unchanged for ordinary reads.
  const compact = request.args["commentsOnly"] === true || (eventLimit === 0 && commentLimit === 0);
  const ticket = compact
    ? { id: displayId, status: resolved.ticket.status, title: resolved.ticket.title }
    : agentTicket(resolved.ticket, resolved.project);
  return {
    v: 1,
    ok: true,
    data: { ticket, signals, events, comments },
  };
}

/** `volli ticket events` — a ticket's event log. */
export async function ticketEventsVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects } = context;
  const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
  if (!resolved.ok) return resolved.response;
  const limit = positiveIntOr(request.args["limit"], 50);
  const events = listRecentTicketEvents(options.db, resolved.ticket.id, limit).map((event) =>
    publicEvent(options.db, projects, event),
  );
  return { v: 1, ok: true, data: { events } };
}

/** `volli ticket brief` — the agent kickoff prompt for a ticket. */
export async function ticketBriefVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects } = context;
  const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
  if (!resolved.ok) return resolved.response;
  return {
    v: 1,
    ok: true,
    data: {
      prompt: composeTicketBrief({
        project: resolved.project,
        ticket: resolved.ticket,
        attachments: listMaterializableLinks(options.db, null, resolved.ticket.id),
      }),
    },
  };
}
