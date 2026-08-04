import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import type Database from "better-sqlite3";
import type { SessionEngine } from "@volli/session-engine";
import {
  applyTicketBodyMutation,
  attachmentsSectionInput,
  composeAttachmentsSection,
  composeTicketPrompt,
  displayTicketId,
  doctorSummary,
  effectiveHarnessId,
  errorMessage,
  FIRST_CLASS_HARNESS_IDS,
  getHarnessAdapter,
  HARNESS_EVENTS,
  harnessEventOrder,
  harnessLabel,
  isHarnessEvent,
  isTicketPriority,
  isTicketStatus,
  isFirstClassHarnessId,
  isValidBranchName,
  parseHarnessId,
  resolveAgentContext,
  runDoctorChecks,
  shortSessionId,
  supersededHarnessEvent,
  declaresInputNeeded as adapterDeclaresInputNeeded,
  TICKET_PRIORITIES,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  worktreeOrientationPreamble,
} from "@volli/shared";
import type {
  AgentErrorCode,
  AgentRequest,
  AgentResponse,
  DataChangedEvent,
  DoctorFacts,
  DoctorObservation,
  HarnessEventNotice,
  HarnessId,
  Observed,
  Project,
  SessionActivityState,
  SessionHarnessNotice,
  SessionRecord,
  TicketEventActor,
  TicketBodyMutation,
  Ticket,
  WorktreeDiffMode,
} from "@volli/shared";

import { listAttachments } from "./db/attachments-repo";
import { listTicketEvents } from "./db/events-repo";
import { listComments } from "./db/comments-repo";
import { recordHarnessChannelEvent, recordHarnessLaunch } from "./db/harness-channel-repo";
import { getRegisteredHarness } from "./db/harness-registry-repo";
import { listAllLabels } from "./db/labels-repo";
import { listProjects } from "./db/projects-repo";
import {
  latestTerminalAttachment,
  readTerminalAttachmentDetail,
  terminalNativeReference,
  terminalSessionRecord,
} from "./session-control";
import { getTicket, listArchivedTicketsByProject, listTicketsByProject } from "./db/tickets-repo";
import { recordHarnessDelivery } from "./harness-registry";
import { readWorktreeDiff, readWorktreeStatus, runGitCapturing } from "./worktree";
import type { RunGit } from "./worktree";
import { isInside } from "./worktree/paths";
import {
  archiveTicketCommand,
  createTicketCommand,
  createTicketCommentCommand,
  interruptOnBackwardMove,
  moveTicketCommand,
  setTicketLabelsCommand,
  setTicketPriorityCommand,
  updateTicketFieldsCommand,
} from "./ticket-commands";

export interface AgentCommandServiceOptions {
  db: Database.Database;
  /** The app composition root's one durable Session Engine. */
  sessionEngine: SessionEngine;
  appVersion: string;
  now?: () => number;
  newId?: () => string;
  /**
   * The git runner the read-only worktree commands execute through. All git
   * calls stay inside the worktree module (CONCEPT #42); this seam only lets
   * tests substitute a scripted runner. Defaults to {@link runGitCapturing}.
   */
  git?: RunGit;
  /**
   * Whether a ticket's stamped worktree directory still exists on disk (C3):
   * threaded into the worktree read verbs' disk-existence seam so a stamped-
   * but-deleted directory refuses with INVALID_REQUEST rather than letting
   * status.ts's errs-dirty fallback report `uncommitted: true` for a tree that's
   * gone. Same seam shape as {@link git} — defaults to {@link existsSync}; tests
   * substitute a scripted predicate.
   */
  worktreeExists?: (path: string) => boolean;
  observeSession?: (
    sessionId: string,
    lines: number,
  ) => { status: SessionActivityState; output: string } | undefined;
  notify?: (title: string, message: string) => void;
  /**
   * Interrupts every live agent attachment of a ticket after a committed
   * backward move. Its command and receipt are Session evidence; Esc leaves
   * the terminal attachment alive. Absent (tests) means a no-op.
   */
  interruptTicketSessions?: (ticketId: string) => string[] | Promise<string[]>;
  /**
   * Called after a socket command COMMITS a planning mutation, with the exact
   * ticket it resolved and touched — the scope index.ts broadcasts as
   * `volli:data-changed` so the renderer refreshes the right surfaces promptly.
   * Never called for a read-only command or a no-op (e.g. a same-column
   * `ticket.move`). A ticketless Session mutation is project-scoped rather than
   * targeted, so every reader refreshes conservatively.
   * Absent (tests) means the broadcast is a no-op.
   */
  onMutation?: (change: Omit<DataChangedEvent, "entity">) => void;
  /**
   * Called for every canonical harness event this door ingests (harness-events),
   * after any session-record write it implies has committed — the notice
   * index.ts pushes to every window as `volli:harness-event`. Absent (tests)
   * means the fan-out is a no-op.
   */
  onHarnessEvent?: (notice: HarnessEventNotice) => void;
  /**
   * Called when a wrapper announce actually CHANGES which harness a session is
   * running — the notice index.ts pushes to every window as
   * `volli:session-harness`, so the sidebar's label and the session's harness
   * state move without waiting for a refetch. Never called for the ordinary
   * announce that agrees with what Volli already believes. Absent (tests) means
   * the fan-out is a no-op.
   */
  onSessionHarness?: (notice: SessionHarnessNotice) => void;
  /**
   * What only main can answer about the harness runtime — which wrappers it
   * wrote, where the shim is, what the shell integration looks like. Injected
   * rather than read here, because every one of these lives in the boot-time
   * runtime state and none of it belongs in this file. Absent (tests) makes
   * `doctor` report that it could not look.
   */
  doctorFacts?: () => Promise<DoctorFacts>;
  /**
   * Regenerates everything regenerable: wrappers, harness configs, the shell
   * integration. Idempotent by construction — it is the same work boot does —
   * so `--fix` is never destructive and never needs confirming.
   */
  doctorRepair?: () => Promise<void>;
}

export interface AgentCommandService {
  execute(request: AgentRequest): Promise<AgentResponse>;
}

function failure(code: AgentErrorCode, message: string): AgentResponse {
  return { v: 1, ok: false, error: { code, message } };
}

/**
 * A raw socket request can carry a priority the CLI parser would have rejected;
 * enumerate the valid vocabulary (from {@link TICKET_PRIORITIES}) so the error
 * teaches instead of a bare "invalid arguments". Returns null when the priority
 * is absent or valid.
 */
function invalidPriorityResponse(priority: unknown): AgentResponse | null {
  if (priority === undefined || isTicketPriority(priority)) return null;
  return failure(
    "INVALID_REQUEST",
    `Invalid priority ${JSON.stringify(priority)} (valid: ${TICKET_PRIORITIES.join(", ")})`,
  );
}

/**
 * The harness twin of {@link invalidPriorityResponse}, with the one thing a
 * priority does not have: a vocabulary that grows. A registered manifest is a
 * harness the user brought and confirmed the bytes of, and there is no reason
 * `volli` may not name one — the CLI simply cannot check it. Which slugs exist,
 * and which of them a human actually ruled on, is this process's registry, so
 * the parser vets the shape and the whole of the judgement lives here.
 *
 * Trust, not registration, is the property. A `blocked` row is a harness someone
 * looked at and said no to; pinning a ticket to it would queue a launch that can
 * never happen, and would do it silently. The two refusals are separate
 * sentences because they ask for opposite things — register the harness, or go
 * and trust the one already sitting there.
 *
 * Returns the resolved id rather than a bare verdict, so the call sites stamp
 * exactly what was checked instead of re-narrowing the raw argument and quietly
 * dropping everything but the first-class four.
 */
function resolveRequestedHarness(
  db: Database.Database,
  value: unknown,
): { ok: true; harnessId: HarnessId | undefined } | { ok: false; response: AgentResponse } {
  if (value === undefined) return { ok: true, harnessId: undefined };
  const parsed = typeof value === "string" ? parseHarnessId(value) : null;
  if (parsed === null) {
    return {
      ok: false,
      response: failure(
        "INVALID_REQUEST",
        `Invalid harness ${JSON.stringify(value)} (valid: ${FIRST_CLASS_HARNESS_IDS.join(", ")}, or a registered, trusted harness)`,
      ),
    };
  }
  if (isFirstClassHarnessId(parsed)) return { ok: true, harnessId: parsed };
  const registered = getRegisteredHarness(db, parsed);
  if (registered === undefined) {
    return {
      ok: false,
      response: failure(
        "INVALID_REQUEST",
        `Unknown harness ${JSON.stringify(value)} — no harness by that name is registered (built in: ${FIRST_CLASS_HARNESS_IDS.join(", ")})`,
      ),
    };
  }
  if (registered.decision !== "trusted") {
    return {
      ok: false,
      response: failure(
        "INVALID_REQUEST",
        `Harness ${JSON.stringify(value)} is registered but not trusted, so nothing can launch on it.`,
      ),
    };
  }
  return { ok: true, harnessId: parsed };
}

/**
 * A CLI count option (`--events`/`--comments`/`--limit`/`--lines`) is honored
 * only when it's a positive integer; 0, negatives, and NaN fall back to the
 * command's default — never `slice(-0)`, which would return the whole history.
 */
function positiveIntOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

type ProjectResolution = { ok: true; project: Project } | { ok: false; response: AgentResponse };

function finalizeContext(
  projects: readonly Project[],
  result: ReturnType<typeof resolveAgentContext>,
): ProjectResolution {
  if (!result.ok) {
    return { ok: false, response: failure(result.code as AgentErrorCode, result.message) };
  }
  const project = projects.find(({ id }) => id === result.context.projectId);
  return project
    ? { ok: true, project }
    : {
        ok: false,
        response: failure("PROJECT_NOT_FOUND", "The resolved project no longer exists."),
      };
}

/**
 * Resolves the project for a read/create request along the context ladder, doing
 * work proportional to the request: an explicit `--project` or a Volli session
 * env resolves from project metadata alone (no ticket/session scan). Only the
 * env-ticket and cwd rungs build the ticket index (display ids + worktree
 * paths); sessions are never scanned here — `VOLLI_SESSION` is resolved directly.
 */
function projectForCreate(
  db: Database.Database,
  projects: readonly Project[],
  sessions: readonly SessionRecord[],
  request: AgentRequest,
): ProjectResolution {
  const selector = request.args["project"];
  if (typeof selector === "string") {
    return finalizeContext(
      projects,
      resolveAgentContext({
        explicit: { project: selector },
        env: {},
        cwd: request.ctx.cwd,
        projects: projects.map(({ id, name, path, ticketPrefix }) => ({
          id,
          name,
          path,
          ticketPrefix,
        })),
        tickets: [],
        sessions: [],
      }),
    );
  }
  const envSession = request.ctx.env.session;
  if (envSession !== undefined) {
    const session = sessions.find((candidate) => candidate.id === envSession);
    if (!session) {
      return {
        ok: false,
        response: failure("SESSION_NOT_FOUND", `No session matches ${envSession}`),
      };
    }
    const project = projects.find(({ id }) => id === session.projectId);
    return project
      ? { ok: true, project }
      : {
          ok: false,
          response: failure("PROJECT_NOT_FOUND", "The resolved project no longer exists."),
        };
  }
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
  return finalizeContext(
    projects,
    resolveAgentContext({
      explicit: {},
      env: {
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
      sessions: [],
    }),
  );
}

/**
 * The display id of the ticket an actor's session is itself working, for the
 * "via VC-9's session" attribution. `null` when the actor has no
 * session ticket (a scratch session) or it no longer resolves.
 */
function actorSessionTicketDisplay(
  db: Database.Database,
  projects: readonly Project[],
  ticketId: string | null,
): string | null {
  if (ticketId === null) return null;
  const ticket = getTicket(db, ticketId);
  if (!ticket) return null;
  const project = projects.find(({ id }) => id === ticket.projectId);
  return project ? displayTicketId(project.ticketPrefix, ticket.ticketNumber) : null;
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

/**
 * `allowArchived` lets a read-only worktree verb serve an archived ticket
 * (retention deliberately retains worktrees past archive — decision #76): every
 * other caller defaults to false and keeps refusing with ARCHIVED_TICKET.
 */
function ticketForDisplayId(
  db: Database.Database,
  projects: readonly Project[],
  displayId: unknown,
  options: { allowArchived?: boolean } = {},
): { ok: true; ticket: Ticket; project: Project } | { ok: false; response: AgentResponse } {
  if (typeof displayId !== "string") {
    return { ok: false, response: failure("INVALID_REQUEST", "A ticket display id is required.") };
  }
  const ambiguous = (): { ok: false; response: AgentResponse } => ({
    ok: false,
    response: failure(
      "AMBIGUOUS_TICKET",
      `Ticket ${displayId} matches multiple projects. Make project prefixes unique in Settings.`,
    ),
  });
  // Parse `PREFIX-NUMBER` and query only the project(s) whose prefix matches, so
  // work is proportional to the request rather than scanning every ticket in the
  // DB. Prefixes may still collide in legacy DBs, hence the candidate list.
  const parsed = /^(.+)-(\d+)$/.exec(displayId);
  const ticketNumber = parsed ? Number(parsed[2]) : Number.NaN;
  const candidates = parsed ? projects.filter((p) => p.ticketPrefix === parsed[1]) : [];

  const liveMatches = candidates.flatMap((project) => {
    const ticket = listTicketsByProject(db, project.id).find(
      (candidate) => candidate.ticketNumber === ticketNumber,
    );
    return ticket ? [{ ticket, project }] : [];
  });
  if (liveMatches.length > 1) return ambiguous();
  const match = liveMatches[0];
  if (match) return { ok: true, ...match };

  const archivedMatches = candidates.flatMap((project) =>
    listArchivedTicketsByProject(db, project.id)
      .filter((ticket) => ticket.ticketNumber === ticketNumber)
      .map((ticket) => ({ ticket, project })),
  );
  if (archivedMatches.length > 1) return ambiguous();
  const archivedMatch = archivedMatches[0];
  if (archivedMatch) {
    return options.allowArchived
      ? { ok: true, ...archivedMatch }
      : { ok: false, response: failure("ARCHIVED_TICKET", `Ticket ${displayId} is archived.`) };
  }
  return { ok: false, response: failure("TICKET_NOT_FOUND", `No ticket matches ${displayId}.`) };
}

/**
 * Resolves the ticket a worktree command targets. An explicit display-id arg is
 * the override (and — unlike every other command — resolves an archived ticket
 * too: retention deliberately retains worktrees past archive). Otherwise the
 * shared context ladder (`resolveAgentContext`) gets first crack, so an agent
 * driving from VOLLI_SESSION/VOLLI_TICKET context but standing in an unrelated
 * cwd (e.g. the main checkout) still resolves the ticket it's orchestrating.
 * Only when the ladder yields no *ticket* (a project-level `cwd` match, or a
 * failed resolution) does the caller's cwd get matched directly against
 * worktree paths (agent cwd → worktree → ticket) — the whole point of a
 * worktree query when nothing else pins the ticket. Read-only: no git, no writes.
 */
function resolveWorktreeTicket(
  db: Database.Database,
  projects: readonly Project[],
  sessions: readonly SessionRecord[],
  request: AgentRequest,
): { ok: true; ticket: Ticket; project: Project } | { ok: false; response: AgentResponse } {
  if (request.args["id"] !== undefined) {
    return ticketForDisplayId(db, projects, request.args["id"], { allowArchived: true });
  }
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const liveTickets = projects.flatMap((project) => listTicketsByProject(db, project.id));
  const archivedTickets = projects.flatMap((project) =>
    listArchivedTicketsByProject(db, project.id),
  );
  const allTickets = [...liveTickets, ...archivedTickets];
  const ticketDisplayById = new Map(
    allTickets.flatMap((ticket) => {
      const project = projectById.get(ticket.projectId);
      return project
        ? [[ticket.id, displayTicketId(project.ticketPrefix, ticket.ticketNumber)] as const]
        : [];
    }),
  );
  const ladder = resolveAgentContext({
    explicit: {},
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
    sessions: sessions.map((session) => ({
      id: session.id,
      projectId: session.projectId,
      ticketDisplayId: session.ticketId ? (ticketDisplayById.get(session.ticketId) ?? null) : null,
    })),
  });
  if (ladder.ok && ladder.context.ticketDisplayId !== null) {
    return ticketForDisplayId(db, projects, ladder.context.ticketDisplayId, {
      allowArchived: true,
    });
  }

  // The shared ladder resolved to a project only (or failed outright); fall
  // back to matching the cwd directly against worktree paths. Live tickets
  // scan first — a cwd sitting in both a live and an archived ticket's
  // worktree isn't a real layout — so archives only get scanned (and their
  // realpath cost paid) when no live match was found.
  const liveMatches = liveTickets.filter(
    (ticket) => ticket.worktreePath !== null && isInside(ticket.worktreePath, request.ctx.cwd),
  );
  const matches =
    liveMatches.length > 0
      ? liveMatches
      : archivedTickets.filter(
          (ticket) =>
            ticket.worktreePath !== null && isInside(ticket.worktreePath, request.ctx.cwd),
        );
  if (matches.length > 1) {
    return {
      ok: false,
      response: failure("AMBIGUOUS_CONTEXT", `Cwd ${request.ctx.cwd} sits in multiple worktrees.`),
    };
  }
  const match = matches[0];
  if (match === undefined) {
    return {
      ok: false,
      response: failure(
        "CONTEXT_REQUIRED",
        "Provide a ticket id or run inside a ticket's worktree.",
      ),
    };
  }
  const project = projectById.get(match.projectId);
  return project
    ? { ok: true, ticket: match, project }
    : {
        ok: false,
        response: failure("PROJECT_NOT_FOUND", "The resolved project no longer exists."),
      };
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
  const payload = event.payload.kind === "commented" ? { kind: "commented" } : event.payload;
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
  request: AgentRequest,
  sessions: readonly SessionRecord[],
): { ok: true; actor: TicketEventActor } | { ok: false; response: AgentResponse } {
  const sessionId = request.ctx.env.session;
  if (!sessionId) return { ok: true, actor: { kind: "user" } };
  const session = sessions.find((candidate) => candidate.id === sessionId);
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

/**
 * One reported field, as {@link Observed}. A string is a measurement. `null` is
 * ALSO a measurement — the caller looked and found nothing there, which is what
 * `volli doctor` sends for an unset `ZDOTDIR` or a `volli` that resolves
 * nowhere. Anything else never became a measurement at all, and says so:
 * `undefined`, which the checks render as a warn naming what was not read
 * instead of as a confident absence with a remedy attached.
 *
 * Coercing the third case into `null` is the collapse the whole command exists
 * to avoid. `zdotDir: 123` would report "ZDOTDIR is unset — open a new
 * terminal", and `volliPath: {}` would report "`volli` resolves to nothing —
 * agents cannot reach the planner". Confident, plausible, wrong, in the one
 * place a wrong answer is worth less than none.
 *
 * A malformed VALUE does not fail the request, which is where this file's
 * validate-don't-coerce rule bends, deliberately: it means the `volli` that
 * called and the main that answered disagree about the wire, and that is one of
 * the conditions doctor exists to name (another install owns the link, a stale
 * shim on PATH). Refusing there would delete every correct check in the report
 * to punish one field, in the command whose whole worth is that it still works
 * when things are broken. The SHAPE remains a contract — see {@link
 * parseDoctorObservation}, which refuses an observation it cannot read at all.
 */
function observedText(value: unknown): Observed<string> {
  if (typeof value === "string") return value;
  return value === null ? null : undefined;
}

function parseDoctorObservation(request: AgentRequest): DoctorObservation | null {
  const pathEntries = request.args["pathEntries"];
  const resolved = request.args["resolved"];
  if (!Array.isArray(pathEntries) || !pathEntries.every((entry) => typeof entry === "string")) {
    return null;
  }
  if (typeof resolved !== "object" || resolved === null || Array.isArray(resolved)) return null;
  return {
    pathEntries,
    sessionId: request.ctx.env.session ?? null,
    zdotDir: observedText(request.args["zdotDir"]),
    resolved: Object.fromEntries(
      Object.entries(resolved as Record<string, unknown>).map(([key, value]) => [
        key,
        observedText(value),
      ]),
    ),
    volliPath: observedText(request.args["volliPath"]),
  };
}

/**
 * The harness session id an event carries, trimmed — `null` when the event
 * carries none (most events don't), `undefined` when the field is present but
 * unusable, which is a malformed request rather than an absent id.
 */
function trimmedHarnessSessionId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= 200 ? trimmed : undefined;
}

/**
 * Which harness fired this hook. `volli hook <harness> <event>` names it — the
 * slug is baked into the argv by the wrapper that wrote the harness's own hook
 * config — and it is not always the harness the session was launched with: a
 * user who types `codex` inside a claude-code session's terminal reaches the
 * codex wrapper, and codex's hooks then report from that same `VOLLI_SESSION`.
 * Read from the session row instead, every one of those events would be
 * recorded and announced as Claude Code's.
 *
 * The fallback, for the older hook contract that names no harness, is the
 * EFFECTIVE one — what last announced itself, not what the session launched
 * with — for exactly the same reason.
 *
 * Validated against the harnesses Volli knows — the first-class ids, the
 * registry rows, and the session's own — rather than accepted as a string.
 * Anything else is refused: the value is generated by Volli's own launch
 * machinery, so a name from outside that vocabulary is not a harness reporting,
 * it is something else talking, and it may not write to the capability ledger
 * under a name of its choosing. An absent argument is not an error — it is the
 * older hook contract, where the session is all there was to go on.
 */
function firingHarnessId(
  db: Database.Database,
  session: Pick<SessionRecord, "harnessId" | "activeHarnessId">,
  value: unknown,
): { ok: true; harnessId: HarnessId } | { ok: false; response: AgentResponse } {
  if (value === undefined || value === null) {
    return { ok: true, harnessId: effectiveHarnessId(session) };
  }
  const parsed = typeof value === "string" ? parseHarnessId(value) : null;
  if (parsed === null) {
    return {
      ok: false,
      response: failure("INVALID_REQUEST", `Invalid harness ${JSON.stringify(value)}.`),
    };
  }
  // Either of the session's OWN harnesses vouches for the name — the one it
  // launched with and the one now running. Both, not just the effective one: a
  // manifest untrusted since launch is no longer in the registry, and the
  // harness it started is still entitled to report on the session it is in.
  const known =
    parsed === session.harnessId ||
    parsed === effectiveHarnessId(session) ||
    isFirstClassHarnessId(parsed) ||
    getRegisteredHarness(db, parsed) !== undefined;
  return known
    ? { ok: true, harnessId: parsed }
    : {
        ok: false,
        response: failure("INVALID_REQUEST", `Unknown harness ${JSON.stringify(value)}.`),
      };
}

/**
 * Whether this harness's adapter declares `input.needed` at all.
 *
 * The renderer already refuses to raise a `waiting` state for one that doesn't
 * ({@link receiveHarnessEvent} in `@volli/shared`) — cursor maps both blocking
 * signals to null in its own source, so an `input.needed` bearing its name came
 * from something in the pipe rather than from cursor. Main has to apply the
 * same gate or it fires a native "needs you" interrupt against a sidebar
 * showing plain Idle, which is the disagreement the whole channel is built to
 * avoid. The delivery status alone cannot carry this: it is `verified` for
 * every first-class harness by construction, capability unread.
 *
 * A harness with no adapter here is a registered manifest, and main's own
 * registry is what vouches for it — matching the renderer, which believes an
 * id it cannot look up for exactly the same reason: the delivery is all the
 * evidence there is, and disbelieving it would hide a harness that IS
 * reporting.
 *
 * The rule itself is `@volli/shared`'s, deliberately: this gate and the
 * renderer's `waiting` fold have to agree, and the way two processes agree on a
 * predicate is by calling the same one. All this adds is main's lookup.
 */
function declaresInputNeeded(harnessId: HarnessId): boolean {
  return adapterDeclaresInputNeeded(getHarnessAdapter(harnessId));
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
  sessions: readonly SessionRecord[],
  selector: unknown,
): { ok: true; session: SessionRecord } | { ok: false; response: AgentResponse } {
  if (typeof selector !== "string") {
    return { ok: false, response: failure("INVALID_REQUEST", "A session id is required.") };
  }
  // Short ids are the only public session handles (decision 3): `session list`
  // prints them and `session peek` addresses by them. Full UUIDs never cross
  // the socket as an input — only requestActor's env `VOLLI_SESSION` uses them,
  // and that's the door contract, resolved separately.
  const matches = sessions.filter((session) => shortSessionId(session.id) === selector);
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

async function updateTerminalNative(
  locks: Map<string, Promise<void>>,
  sessionEngine: SessionEngine,
  session: SessionRecord,
  update: (
    detail: NonNullable<ReturnType<typeof readTerminalAttachmentDetail>>,
  ) => ReturnType<typeof readTerminalAttachmentDetail>,
  occurredAt: number,
): Promise<SessionRecord | null> {
  // `attachment.native_referenced` replaces the opaque native detail rather
  // than patching it. Hooks and wrapper announces use separate socket
  // connections, so their read → observe pairs can overlap and otherwise drop
  // each other's field. Serialize that tiny read-modify-write critical section
  // per durable Session; different Sessions still proceed independently.
  const previous = locks.get(session.id) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(session.id, current);
  await previous;
  try {
    const projection = await sessionEngine.getSession({ sessionId: session.id });
    if (projection === null) return null;
    const attachment = latestTerminalAttachment(projection.attachments);
    if (attachment === null || attachment.status !== "open") return null;
    const detail = readTerminalAttachmentDetail(attachment.native);
    if (detail === null) return null;
    const next = update(detail);
    if (next === null) return null;
    if (next === detail) return terminalSessionRecord(projection);
    await sessionEngine.observe({
      id: randomUUID(),
      kind: "attachment.native_referenced",
      sessionId: session.id,
      attachmentId: attachment.id,
      occurredAt,
      provenance: {
        source: { kind: "adapter", id: "terminal", detail: null },
        venue: { id: "local", kind: "local" },
      },
      native: terminalNativeReference(next),
    });
    const updated = await sessionEngine.getSession({ sessionId: session.id });
    return updated === null ? null : terminalSessionRecord(updated);
  } finally {
    release?.();
    if (locks.get(session.id) === current) locks.delete(session.id);
  }
}

/**
 * How many sessions main keeps an ordering watermark for. `VOLLI_SESSION`
 * outlives its PTY, so nothing here ever gets a reliable "this session is
 * finished" signal to delete on, and an unbounded map on the involuntary
 * channel's hot path is a leak with a long fuse. The cap is an order of
 * magnitude past any real number of concurrently firing sessions, and the entry
 * it evicts is the least recently heard from.
 */
const HARNESS_WATERMARK_LIMIT = 512;

/**
 * Records that a session has now been heard from at `firedAt`, evicting the
 * stalest watermark once the map is full. The delete-then-set is what moves the
 * entry to the young end — `Map` iterates in insertion order, which is the
 * whole LRU this needs and the only reason it costs nothing.
 */
function rememberFiredAt(
  watermarks: Map<string, number>,
  sessionId: string,
  firedAt: number,
): void {
  watermarks.delete(sessionId);
  watermarks.set(sessionId, firedAt);
  if (watermarks.size > HARNESS_WATERMARK_LIMIT) {
    const stalest = watermarks.keys().next();
    if (!stalest.done) watermarks.delete(stalest.value);
  }
}

export function createAgentCommandService(
  options: AgentCommandServiceOptions,
): AgentCommandService {
  const now = options.now ?? Date.now;
  /**
   * The newest fire-time main has ingested per session — the same watermark the
   * renderer keeps on its own `SessionHarnessState`, kept here too because main
   * does two things the renderer never sees: it writes the resume seed, and it
   * fires the one claim that cannot be taken back once it has interrupted a
   * human. Neither may act on a delivery a newer one has already answered.
   *
   * In memory rather than in the db, deliberately. A watermark is worth
   * something only while a session is live and firing; it is worth nothing after
   * a restart, when a surviving row would order today's events against a process
   * that no longer exists; and it is not worth a write per hook on the hottest
   * involuntary path in the app. Losing one degrades that session to arrival
   * order for one event, which is what every event got before this existed.
   */
  const watermarks = new Map<string, number>();
  // node:crypto's randomUUID is a standalone function (safe to reference
  // detached); the global `crypto.randomUUID` would lose its Crypto `this` when
  // called via this alias and throw "Value of 'this' must be of type Crypto".
  const newId = options.newId ?? randomUUID;
  const git = options.git ?? runGitCapturing;
  const worktreeExists = options.worktreeExists ?? existsSync;
  const sessionEngine = options.sessionEngine;
  const terminalUpdateLocks = new Map<string, Promise<void>>();

  return {
    async execute(request): Promise<AgentResponse> {
      const projects = listProjects(options.db);
      // Hooks arrive on a process-per-event hot path. They address one durable
      // Session directly, so avoid taking a complete multi-project snapshot
      // merely to find it. Other commands retain the established list snapshot
      // until their own command-specific resolution is made lazy.
      const sessions =
        request.cmd === "hook" ||
        request.cmd === "session.done" ||
        request.cmd === "session.blocked" ||
        request.cmd === "session.link" ||
        request.cmd === "session.harness"
          ? []
          : (
              await Promise.all(
                projects.map((project) =>
                  sessionEngine.listSessions({ projectId: project.id, scope: "all" }),
                ),
              )
            ).flatMap((projections) =>
              projections.flatMap((projection) => terminalSessionRecord(projection) ?? []),
            );
      if (request.cmd === "identify") {
        const sessionId = request.ctx.env.session;
        if (sessionId) {
          const session = sessions.find((candidate) => candidate.id === sessionId);
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
          : projectForCreate(options.db, projects, sessions, request);
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
        const resolved = projectForCreate(options.db, projects, sessions, request);
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
        const resolved = projectForCreate(options.db, projects, sessions, request);
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
        // An explicit --project alongside --ticket must agree: never silently
        // let the ticket's project win over what the caller explicitly asked
        // for. When both are present and disagree, refuse and name both.
        if (request.args["project"] !== undefined && ticketResolution?.ok) {
          const selected = projectForCreate(options.db, projects, sessions, request);
          if (!selected.ok) return selected.response;
          if (selected.project.id !== ticketResolution.project.id) {
            return failure(
              "CONTEXT_MISMATCH",
              `Ticket ${String(ticketSelector)} belongs to project ${ticketResolution.project.name}, not the requested project ${selected.project.name}.`,
            );
          }
        }
        const resolvedProject = ticketResolution?.ok
          ? ticketResolution.project
          : projectForCreate(options.db, projects, sessions, request);
        if (!("id" in resolvedProject)) {
          if (!resolvedProject.ok) return resolvedProject.response;
        }
        const project = "id" in resolvedProject ? resolvedProject : resolvedProject.project;
        const projectById = new Map(projects.map((entry) => [entry.id, entry]));
        const projectSessions = sessions
          .filter((session) => session.projectId === project.id)
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
              // What is RUNNING there, not what opened it: an agent reading
              // this list is deciding where to look, and the launch harness of
              // a terminal somebody has since re-used is the wrong answer.
              harness: effectiveHarnessId(session),
              ageMs: Math.max(0, now() - session.createdAt),
            };
          });
        return { v: 1, ok: true, data: { sessions: projectSessions } };
      }
      if (request.cmd === "session.peek") {
        const resolved = sessionForPublicId(sessions, request.args["id"]);
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
        const projection = await sessionEngine.getSession({ sessionId });
        const session = projection === null ? null : terminalSessionRecord(projection);
        if (!session) return failure("SESSION_NOT_FOUND", `No session matches ${sessionId}.`);
        const reasonValue = request.args["reason"];
        if (reasonValue !== undefined && typeof reasonValue !== "string") {
          return failure("INVALID_REQUEST", "The lifecycle reason must be text.");
        }
        const reason = typeof reasonValue === "string" ? reasonValue : null;
        const signal = request.cmd === "session.done" ? "done" : "blocked";
        const submitted = await sessionEngine.submit({
          commandId: newId(),
          sessionId: session.id,
          intent: { kind: "session.signal", signal, reason },
          provenance: {
            source: { kind: "adapter", id: "terminal", detail: null },
            venue: { id: "local", kind: "local" },
          },
        });
        if (submitted.receipt?.status !== "completed") {
          return failure("MUTATION_FAILED", "The Session signal was not durably completed.");
        }
        options.onMutation?.({
          ...(session.ticketId === null ? {} : { ticketId: session.ticketId }),
          projectId: session.projectId,
          kind: "session",
        });
        return {
          v: 1,
          ok: true,
          data: {
            session: shortSessionId(session.id),
            signal,
            reason,
            recorded: true,
          },
        };
      }
      if (request.cmd === "session.link") {
        // The harness reports its OWN resume/session UUID for the current Volli
        // session (interrupt/resume seed, issue #78/CONCEPT #21) — driven off
        // VOLLI_SESSION exactly like session.done, and typically wired to the
        // harness's session-start hook rather than run by hand.
        const sessionId = request.ctx.env.session;
        if (!sessionId) {
          return failure("CONTEXT_REQUIRED", "session link requires VOLLI_SESSION context.");
        }
        const projection = await sessionEngine.getSession({ sessionId });
        const session = projection === null ? null : terminalSessionRecord(projection);
        if (!session) return failure("SESSION_NOT_FOUND", `No session matches ${sessionId}.`);
        const idValue = request.args["id"];
        if (typeof idValue !== "string") {
          return failure("INVALID_REQUEST", "session link requires a harness session id.");
        }
        const harnessSessionId = idValue.trim();
        if (harnessSessionId.length === 0) {
          return failure("INVALID_REQUEST", "The harness session id must not be empty.");
        }
        if (harnessSessionId.length > 200) {
          return failure("INVALID_REQUEST", "The harness session id is too long (max 200 chars).");
        }
        const updated = await updateTerminalNative(
          terminalUpdateLocks,
          sessionEngine,
          session,
          (detail) => ({ ...detail, harnessSessionId }),
          now(),
        );
        if (updated === null)
          return failure("SESSION_ENDED", `Session ${shortSessionId(session.id)} has ended.`);
        return {
          v: 1,
          ok: true,
          data: { session: shortSessionId(session.id), harnessSessionId },
        };
      }
      if (request.cmd === "session.harness") {
        // The second involuntary channel: a harness's own PATH-shim wrapper,
        // one step before it execs, saying what is about to run and — when that
        // harness takes its session id on argv — asking for one. Addressed by
        // `VOLLI_SESSION` exactly as `session.link` and `hook` are.
        //
        // Why this exists at all: `sessions.harness_id` is written once at
        // INSERT and is the LAUNCH, which is a true and durable fact. But a
        // terminal outlives the agent that opened it — quit opencode, run
        // claude in the same pane — and everything that decides something about
        // the RUNNING agent (the resume command line, the needs-you
        // notification, the sidebar's label) was reading the launch. So the
        // launch is kept and this is recorded beside it.
        //
        // The wrapper is the one place that can say this. It runs on every
        // invocation of every harness, including a Declared one that fires no
        // hooks at all, so the announce covers the tiers the event channel
        // structurally cannot.
        //
        // And why the id is minted HERE rather than in the wrapper: a session
        // id is only worth anything once it is written down — `harness_session_id`
        // is what every future resume of this session reads — so a shell that
        // minted its own would still have to call in to report it. One call
        // does both. It is minted per LAUNCH, not per session: `VOLLI_SESSION`
        // is stamped once per PTY, and a harness that treats its session id as
        // single-use per workspace (cursor mkdirs a directory named after it)
        // fails outright on the second launch in one terminal.
        const sessionId = request.ctx.env.session;
        if (!sessionId) {
          return failure("CONTEXT_REQUIRED", "session harness requires VOLLI_SESSION context.");
        }
        const projection = await sessionEngine.getSession({ sessionId });
        const session = projection === null ? null : terminalSessionRecord(projection);
        if (!session) return failure("SESSION_NOT_FOUND", `No session matches ${sessionId}.`);
        // Ended is ended, the same rule `hook` applies and for the same reason:
        // `VOLLI_SESSION` is exported into the terminal's environment, so a tmux
        // server or a disowned daemon started inside a Volli session carries it
        // forever. Accepting an announce from one would rewrite the harness a
        // dead session resumes with, months later.
        if (session.endedAt !== null) {
          return failure("SESSION_ENDED", `Session ${shortSessionId(session.id)} has ended.`);
        }
        const slug = request.args["id"];
        if (typeof slug !== "string") {
          return failure("INVALID_REQUEST", "session harness requires a harness slug.");
        }
        // The same vocabulary check a fired hook passes — one definition of
        // "a harness Volli knows", not a second one that could drift from it.
        const announced = firingHarnessId(options.db, session, slug);
        if (!announced.ok) return announced.response;
        const harnessId = announced.harnessId;
        // The only honest place to count a launch. This call is made by the
        // wrapper Volli generated, one step before it execs, so it is proof
        // that our configuration was in the loop — which is exactly what has to
        // be true for the silence afterwards to mean anything. Counting at the
        // PTY spawn instead would also count `/opt/homebrew/bin/claude` typed by
        // hand, a launch that never saw our hooks, and manufacture a false
        // accusation out of a user's own shell habit.
        //
        // Ungated, unlike `active_harness_id` above: a relaunch of the same
        // harness is a new launch whose channel has proved nothing yet, and it
        // is the case the whole table exists to catch.
        recordHarnessLaunch(options.db, harnessId, now());
        // The WRITE is gated on a change: `active_harness_id` records which
        // harness is running, and re-storing the value already there is a
        // durable write bought for nothing.
        //
        // The BROADCAST is not, and that distinction is the point. This call is
        // proof that a launch just happened — the wrapper runs once per
        // invocation, out of the harness's own process — and the renderer's
        // grace window is anchored to it. Gating the broadcast on a changed
        // slug meant the second launch in one terminal (quit claude, run claude
        // again: the exact case the mint below exists for) was never announced,
        // so it inherited the first launch's `startedAt` and its already
        // `delivered` channel, and could never be judged silent. `changed`
        // stays ON the notice — the renderer still needs it to decide whether
        // to repoint the durable record's labels — but it stops being the gate.
        let changed = false;
        const nativeUpdate = await updateTerminalNative(
          terminalUpdateLocks,
          sessionEngine,
          session,
          (detail) => {
            changed = harnessId !== (detail.activeHarnessId ?? detail.harnessId);
            return detail.activeHarnessId === harnessId
              ? detail
              : { ...detail, activeHarnessId: harnessId };
          },
          now(),
        );
        if (nativeUpdate === null)
          return failure("SESSION_ENDED", `Session ${shortSessionId(session.id)} has ended.`);
        options.onSessionHarness?.({
          sessionId: session.id,
          projectId: session.projectId,
          ticketId: session.ticketId,
          harnessId,
          changed,
          at: now(),
        });
        // Only when the caller asked. The wrapper asks exactly when the adapter
        // it was rendered from takes an id on argv, and that is the only place
        // the answer is known — a registered manifest's adapter never reaches
        // main's own table, so main cannot re-derive it here. For a `reported`
        // or `none` harness a minted id would overwrite the resume seed the
        // harness's own events are about to write with one it never heard of.
        //
        // `randomUUID` directly, not the injectable `newId` seam: the FORMAT is
        // the contract, not an implementation detail a test may vary. Cursor
        // validates strict v4 (`4` in the third group, `[89ab]` in the fourth)
        // and refuses a v7.
        const minted = request.args["mint"] === true ? randomUUID() : null;
        if (minted !== null) {
          // Overwrites, always. The seed belongs to the launch that is starting
          // now; the previous one describes an agent this terminal has quit.
          const mintedUpdate = await updateTerminalNative(
            terminalUpdateLocks,
            sessionEngine,
            nativeUpdate,
            (detail) => ({ ...detail, harnessSessionId: minted }),
            now(),
          );
          if (mintedUpdate === null) {
            return failure("SESSION_ENDED", `Session ${shortSessionId(session.id)} has ended.`);
          }
        }
        return {
          v: 1,
          ok: true,
          data: {
            session: shortSessionId(session.id),
            harness: harnessId,
            changed,
            harnessSessionId: minted,
          },
        };
      }
      if (request.cmd === "hook") {
        // The involuntary channel (harness-events): a hook the wrapper
        // configured, not something the agent chose to run. `VOLLI_SESSION` is
        // both the addressing and the harness's own session id, so an event
        // resolves the session the same way `session.done` does.
        const sessionId = request.ctx.env.session;
        if (!sessionId) {
          return failure("CONTEXT_REQUIRED", "hook requires VOLLI_SESSION context.");
        }
        const projection = await sessionEngine.getSession({ sessionId });
        const session = projection === null ? null : terminalSessionRecord(projection);
        if (!session) return failure("SESSION_NOT_FOUND", `No session matches ${sessionId}.`);
        // A session row outlives its PTY, and `VOLLI_SESSION` outlives both: it
        // is exported into the session's environment, so anything that escapes
        // that environment carries it forever — a tmux server started inside a
        // Volli terminal, a disowned daemon, or simply a hook that fires as its
        // own shell is exiting. Without this guard such an event is accepted in
        // full: it rewrites the resume seed, records a verified delivery, fires
        // a native "needs you" notification, and the renderer registers a fresh
        // expectation for it — resurrecting a dead session in the sidebar.
        //
        // Ended is ended. The event is refused rather than swallowed, so a
        // harness that really is still reporting says so in its own exit code
        // instead of leaving Volli quietly wrong.
        if (session.endedAt !== null) {
          return failure("SESSION_ENDED", `Session ${shortSessionId(session.id)} has ended.`);
        }
        const event = request.args["event"];
        if (!isHarnessEvent(event)) {
          return failure(
            "INVALID_REQUEST",
            `Invalid harness event ${JSON.stringify(event)} (valid: ${HARNESS_EVENTS.join(", ")})`,
          );
        }
        const firing = firingHarnessId(options.db, session, request.args["harness"]);
        if (!firing.ok) return firing.response;
        const harnessSessionId = trimmedHarnessSessionId(request.args["harnessSessionId"]);
        if (harnessSessionId === undefined) {
          return failure("INVALID_REQUEST", "The harness session id is not usable.");
        }
        // THE ORDERING RULE, main's half. Each event arrives on its own
        // short-lived hook process over its own connection, so two that fire
        // close together race and `now()` stamps the winner of that race rather
        // than the agent's own sequence. `firedAt` is what the firing end could
        // prove about the order; `supersededHarnessEvent` is the single
        // definition of stale, shared verbatim with the renderer so the two ends
        // cannot drift into disagreeing about one session.
        //
        // What supersession withholds is STATE — anything a newer delivery has
        // already answered. What it never withholds is the PROOF that a delivery
        // happened: the ledger below, and the renderer's `delivered`. That
        // proof is order-free, a fact about what this harness can do rather than
        // a value a later fact replaces, and suppressing it would make Volli
        // forget a capability it had just watched being exercised.
        //
        // An absent or equal `firedAt` is never superseded — see
        // {@link HarnessEventOrder}. An older `volli` sends no stamp at all, and
        // such an event must land exactly as it did before, not vanish for
        // failing to prove its own age.
        const firedAt = harnessEventOrder(request.args["firedAt"]);
        const superseded = supersededHarnessEvent(watermarks.get(session.id) ?? null, firedAt);
        if (firedAt !== null && !superseded) rememberFiredAt(watermarks, session.id, firedAt);
        // A reported id is what replaces `session link` on the critical path.
        // Idempotent overwrite, exactly as `session.link` is — a harness that
        // rotates its id mid-session leaves the newest resume seed behind. Which
        // is precisely why a superseded one may not be written: newest by
        // arrival is not newest, and this row seeds every future resume.
        if (harnessSessionId !== null && !superseded) {
          await updateTerminalNative(
            terminalUpdateLocks,
            sessionEngine,
            session,
            (detail) => ({ ...detail, harnessSessionId }),
            now(),
          );
        }
        // The event arrived, so the harness can plainly deliver it: the ledger
        // learns that here, at the one place a delivery is observed, and before
        // anything is decided about this one. What comes back is what Volli now
        // knows about the capability — `absent` only for a harness it has no
        // record of at all.
        const status = recordHarnessDelivery(options.db, firing.harnessId, event, now());
        // The other half of the channel's two integers. Deliberately outside
        // every rule above it: a superseded event is still a delivery, and an
        // event nobody declared is still a delivery. This column answers "is
        // anything coming down this pipe", not "should this one be believed",
        // and withholding it would make a working channel look dead for the
        // sake of an event that merely arrived out of order.
        recordHarnessChannelEvent(options.db, firing.harnessId, now());
        // ONE event earns a notification: a human is blocking the agent's
        // progress. `subagent.completed` is telemetry — a subagent finishing is
        // not the parent finishing — and `permission.requested` is bound to the
        // same native signal as `input.needed` on every harness that has one, so
        // notifying on both would double every notification it earns.
        //
        // And only a verified capability interrupts a human. A declaration
        // cannot earn a notification (the plan doc's rule), which costs a real
        // delivery nothing — it verified itself one line above. `verified` is
        // about delivery, though, and says nothing about whether the harness can
        // report this at all, so the declaration is checked alongside it.
        //
        // The last condition is the disagreement rule. A notification is the
        // most expensive claim Volli makes — it interrupts a human and names an
        // agent — so it is made only where the two independent accounts agree:
        // the harness Volli launched this session with, and the hook that says
        // it fired. Anything in the session can invoke `volli hook` under a name
        // of its choosing, and a hand-typed second harness is indistinguishable
        // from a confused descendant. Everything cheaper follows the evidence
        // instead: the ledger and the fan-out are attributed to what fired.
        //
        // And it is withheld from a superseded delivery, which is the failure
        // that reads as noise rather than as a bug: an `input.needed` the agent
        // emitted before a `turn.started` that has already landed announces a
        // human is blocking something the agent moved past, and the user is
        // interrupted for a prompt they already answered. A notification cannot
        // be retracted, so it is the write that most needs to be sure.
        //
        // What the two accounts are compared AGAINST is the harness now
        // running, not the one the session launched with. Reading the launch
        // was the bug this rule was quietly causing: a user who quit opencode
        // and started claude got every one of claude's `input.needed` events
        // recorded in the ledger and none of them notified — silence in exactly
        // the case the feature exists for.
        if (
          event === "input.needed" &&
          status === "verified" &&
          declaresInputNeeded(firing.harnessId) &&
          firing.harnessId === effectiveHarnessId(session) &&
          !superseded
        ) {
          const ticket = session.ticketId ? getTicket(options.db, session.ticketId) : undefined;
          const ticketProject = ticket
            ? projects.find(({ id }) => id === ticket.projectId)
            : undefined;
          const subject =
            ticket && ticketProject
              ? displayTicketId(ticketProject.ticketPrefix, ticket.ticketNumber)
              : session.title;
          options.notify?.(
            `${subject} needs you`,
            `${harnessLabel(effectiveHarnessId(session))} is waiting on a human`,
          );
        }
        // A superseded event is still announced, carrying its own `firedAt`, and
        // the renderer applies the same rule to it independently. Filtering here
        // instead would make the renderer's correctness depend on this map being
        // intact — and it is evicted at a cap and empty after a relaunch, while
        // the renderer's watermark lives with the session it describes. Two
        // places apply one rule; neither is the other's guard.
        options.onHarnessEvent?.({
          sessionId: session.id,
          projectId: session.projectId,
          ticketId: session.ticketId,
          harnessId: firing.harnessId,
          event,
          harnessSessionId,
          at: now(),
          firedAt,
        });
        // The firing harness is echoed back so a caller (and a `doctor` reading
        // a transcript) can see which one Volli credited, rather than having to
        // infer it from the session. `superseded` rides the same seam, and is
        // the only trace a rejected delivery leaves anywhere: the symptom of
        // this rule misfiring is a session that sits showing a wait the user
        // already answered, and nothing else in the app would ever explain it.
        // Nothing consumes the field yet — `volli hook` discards its response by
        // design — so it is legible to a socket transcript and to whatever
        // diagnostic next needs it, and costs nothing until then.
        return {
          v: 1,
          ok: true,
          data: {
            session: shortSessionId(session.id),
            harness: firing.harnessId,
            event,
            harnessSessionId,
            superseded,
          },
        };
      }
      if (request.cmd === "doctor") {
        if (!options.doctorFacts) {
          return failure("APP_UNREACHABLE", "The harness runtime is not available this launch.");
        }
        // The caller reports what it sees from inside the environment under
        // test; main supplies only what it alone knows. Keeping those apart is
        // the point — an observation main reconstructed would be exactly the
        // kind of plausible, wrong answer this command exists to catch.
        const observation = parseDoctorObservation(request);
        if (observation === null) {
          return failure("INVALID_REQUEST", "doctor requires the caller's observed environment.");
        }
        if (request.args["fix"] === true && options.doctorRepair) {
          try {
            await options.doctorRepair();
          } catch (error) {
            return failure("MUTATION_FAILED", `Repair failed: ${errorMessage(error)}`);
          }
        }
        const checks = runDoctorChecks(observation, await options.doctorFacts());
        return {
          v: 1,
          ok: true,
          data: { checks, summary: doctorSummary(checks) },
        };
      }
      if (request.cmd === "ticket.list") {
        const resolved = projectForCreate(options.db, projects, sessions, request);
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
        // Orientation preamble (worktree-support §6): agents must never infer
        // their working directory — state it outright, same as main's own
        // post-ensure prepend, whenever the ticket has an active worktree.
        const orientation =
          resolved.ticket.worktreePath !== null && resolved.ticket.branch !== null
            ? worktreeOrientationPreamble({
                worktreePath: resolved.ticket.worktreePath,
                branch: resolved.ticket.branch,
                baseBranch: resolved.ticket.baseBranch,
                projectPath: resolved.project.path,
              }) + "\n\n"
            : "";
        // Attachments (CONCEPT decision #19): the brief is read-only — it never
        // materializes, only lists what session boot already did (or will do),
        // via the same deterministic relPath mapping main's `ensure` pipeline
        // uses. Relative paths are correct whether this session runs in the
        // worktree or the main checkout (cwd is the session root either way).
        const attachmentsSection = composeAttachmentsSection(
          attachmentsSectionInput(listAttachments(options.db, resolved.ticket.id)),
        );
        const attachmentsSuffix = attachmentsSection.length > 0 ? `\n\n${attachmentsSection}` : "";
        return {
          v: 1,
          ok: true,
          data: {
            prompt: `${orientation}Coordinate the board through the bundled \`volli\` CLI: run \`volli help\` for the full reference (and the volli skill, when installed, for norms).\n\n${ticketPrompt}${attachmentsSuffix}`,
          },
        };
      }
      if (request.cmd === "worktree.status") {
        // Context resolution (which ticket the agent means) stays this door's
        // concern; the git compose + the no-worktree / stamped-but-deleted
        // discrimination live behind the ticketId-in read verb (CONCEPT #42).
        const resolved = resolveWorktreeTicket(options.db, projects, sessions, request);
        if (!resolved.ok) return resolved.response;
        const read = readWorktreeStatus(
          { db: options.db, git, worktreeExists },
          resolved.ticket.id,
        );
        switch (read.kind) {
          case "missing-ticket":
            return failure("TICKET_NOT_FOUND", "The resolved ticket no longer exists.");
          case "no-worktree":
            return failure(
              "INVALID_REQUEST",
              `Ticket ${read.displayId} has no worktree. Move it to Doing to create one.`,
            );
          case "missing-on-disk":
            return failure(
              "INVALID_REQUEST",
              `Ticket ${read.displayId}'s worktree directory is missing on disk (expected at ${read.worktreePath}).`,
            );
          case "ok":
            return {
              v: 1,
              ok: true,
              data: {
                ticket: read.displayId,
                project: resolved.project.name,
                worktreePath: read.worktreePath,
                branch: read.branch,
                baseBranch: read.baseBranch,
                ...read.status,
              },
            };
        }
      }
      if (request.cmd === "worktree.diff") {
        const resolved = resolveWorktreeTicket(options.db, projects, sessions, request);
        if (!resolved.ok) return resolved.response;
        // Merge-base ("what the PR would contain") is the default; --working-tree
        // switches to the uncommitted view. Same two-mode diff.ts the rail uses.
        const mode: WorktreeDiffMode =
          request.args["workingTree"] === true ? "working-tree" : "merge-base";
        const read = readWorktreeDiff(
          { db: options.db, git, worktreeExists },
          resolved.ticket.id,
          mode,
        );
        switch (read.kind) {
          case "missing-ticket":
            return failure("TICKET_NOT_FOUND", "The resolved ticket no longer exists.");
          case "no-worktree":
            return failure(
              "INVALID_REQUEST",
              `Ticket ${read.displayId} has no worktree. Move it to Doing to create one.`,
            );
          case "missing-on-disk":
            return failure(
              "INVALID_REQUEST",
              `Ticket ${read.displayId}'s worktree directory is missing on disk (expected at ${read.worktreePath}).`,
            );
          case "diff-error":
            return failure("INVALID_REQUEST", read.error);
          case "ok": {
            // Cap the per-file rows so a sprawling diff never blows the token
            // ceiling; the rollup count keeps the omission honest. Totals stay
            // across ALL files.
            const CAP = 20;
            const shown = read.diff.files.slice(0, CAP);
            return {
              v: 1,
              ok: true,
              data: {
                ticket: read.displayId,
                mode,
                baseBranch: read.baseBranch,
                files: shown,
                insertions: read.diff.insertions,
                deletions: read.diff.deletions,
                totalFiles: read.diff.files.length,
                omittedFiles: read.diff.files.length - shown.length,
              },
            };
          }
        }
      }
      if (request.cmd === "ticket.update") {
        const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
        if (!resolved.ok) return resolved.response;
        const actor = requestActor(request, sessions);
        if (!actor.ok) return actor.response;
        const title = request.args["title"];
        const priority = request.args["priority"];
        const base = request.args["base"];
        const mutation = request.args["bodyMutation"];
        const addLabels = request.args["addLabels"] ?? [];
        const removeLabels = request.args["removeLabels"] ?? [];
        const updatePriorityError = invalidPriorityResponse(priority);
        if (updatePriorityError) return updatePriorityError;
        const requestedHarness = resolveRequestedHarness(options.db, request.args["harness"]);
        if (!requestedHarness.ok) return requestedHarness.response;
        if (
          (title !== undefined && (typeof title !== "string" || title.trim().length === 0)) ||
          (base !== undefined && (typeof base !== "string" || !isValidBranchName(base))) ||
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
                ...(requestedHarness.harnessId !== undefined
                  ? { preferredHarnessId: requestedHarness.harnessId }
                  : {}),
              },
              { now: updatedAt, actor: actor.actor },
            );
            if (isTicketPriority(priority) && priority !== resolved.ticket.priority) {
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
          const updated = run();
          options.onMutation?.({
            ticketId: resolved.ticket.id,
            projectId: resolved.project.id,
            kind: "ticket",
          });
          return {
            v: 1,
            ok: true,
            data: { ticket: agentTicket(updated, resolved.project) },
          };
        } catch (error) {
          return failure("MUTATION_FAILED", errorMessage(error));
        }
      }
      if (request.cmd === "ticket.archive") {
        const resolved = ticketForDisplayId(options.db, projects, request.args["id"]);
        if (!resolved.ok) return resolved.response;
        const actor = requestActor(request, sessions);
        if (!actor.ok) return actor.response;
        try {
          const archivedAt = now();
          archiveTicketCommand(options.db, resolved.ticket.id, {
            now: archivedAt,
            actor: actor.actor,
          });
          options.onMutation?.({
            ticketId: resolved.ticket.id,
            projectId: resolved.project.id,
            kind: "ticket",
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
        const actor = requestActor(request, sessions);
        if (!actor.ok) return actor.response;
        const to = request.args["to"];
        if (!isTicketStatus(to)) {
          return failure("INVALID_REQUEST", "ticket move requires a valid destination column.");
        }
        // A CLI move carries column semantics only (no drop index), so a move to
        // the column the ticket already occupies is an idempotent no-op — never
        // a reorder to the bottom, and no status event. Returned unchanged.
        if (resolved.ticket.status === to) {
          return {
            v: 1,
            ok: true,
            data: { ticket: agentTicket(resolved.ticket, resolved.project) },
          };
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
          // Backward-move interrupt (issue #78): the move committed above, so the
          // interrupt runs as its side effect. `resolved.ticket.status` is the
          // pre-move status (same-column no-ops already returned above).
          try {
            await interruptOnBackwardMove(
              {
                ticketId: resolved.ticket.id,
                fromStatus: resolved.ticket.status,
                toStatus: to,
              },
              options.interruptTicketSessions,
            );
          } catch (error) {
            console.error(
              `[volli] failed to interrupt sessions after moving ${resolved.ticket.id}: ${errorMessage(error)}`,
            );
          }
          // Guardrail is visibility, not caps (decision 2): an agent- or
          // automation-initiated entry into Doing fires a native notification.
          // A plain CLI move (no session env → user actor, "the door not the
          // keyboard") stays silent; same-column moves already returned above,
          // so reaching here with to === "doing" means the prior status wasn't.
          if (to === "doing" && actor.actor.kind !== "user") {
            const movedDisplay = displayTicketId(
              resolved.project.ticketPrefix,
              resolved.ticket.ticketNumber,
            );
            let body: string;
            if (actor.actor.kind === "automation") {
              body = "Moved by automation";
            } else {
              const via = actorSessionTicketDisplay(options.db, projects, actor.actor.ticketId);
              body = via ? `Moved via ${via}'s session` : "Moved via a session";
            }
            options.notify?.(`${movedDisplay} → ${TICKET_STATUS_LABELS[to]}`, body);
          }
          options.onMutation?.({
            ticketId: resolved.ticket.id,
            projectId: resolved.project.id,
            kind: "ticket",
          });
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
        const actor = requestActor(request, sessions);
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
          options.onMutation?.({
            ticketId: resolved.ticket.id,
            projectId: resolved.project.id,
            kind: "comment",
          });
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
      const resolved = projectForCreate(options.db, projects, sessions, request);
      if (!resolved.ok) return resolved.response;
      const createPriorityError = invalidPriorityResponse(request.args["priority"]);
      if (createPriorityError) return createPriorityError;
      const requestedHarness = resolveRequestedHarness(options.db, request.args["harness"]);
      if (!requestedHarness.ok) return requestedHarness.response;
      const title = request.args["title"];
      const status = request.args["status"] ?? "backlog";
      const priority = request.args["priority"] ?? "medium";
      const labels = request.args["labels"] ?? [];
      const base = request.args["base"];
      if (
        typeof title !== "string" ||
        title.trim().length === 0 ||
        !isTicketStatus(status) ||
        !isTicketPriority(priority) ||
        (base !== undefined && (typeof base !== "string" || !isValidBranchName(base))) ||
        !Array.isArray(labels) ||
        !labels.every((label) => typeof label === "string")
      ) {
        return failure("INVALID_REQUEST", "Invalid ticket create arguments.");
      }

      try {
        const createdAt = now();
        const actor = requestActor(request, sessions);
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
            preferredHarnessId: requestedHarness.harnessId,
            // An explicit per-ticket override only (decision 11). `null` means
            // "inherit the pinned project setting" — resolved late by worktree
            // automation at use time, NOT stamped here from a snapshot.
            baseBranch: typeof base === "string" ? base : null,
          },
          { now: createdAt, actor: actor.actor },
        );
        options.onMutation?.({
          ticketId: ticket.id,
          projectId: resolved.project.id,
          kind: "ticket",
        });
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
