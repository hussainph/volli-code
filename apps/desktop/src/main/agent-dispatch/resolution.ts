/**
 * How a raw socket request becomes the subject a verb acts on — or a refusal.
 *
 * Everything here is shared by verbs in more than one domain module: the
 * context ladder that decides which project an agent means, the display-id
 * lookup every ticket verb starts from, who the caller is for attribution, and
 * the two argument checks whose refusal text has to read the same wherever it
 * is raised. A helper only one domain needs lives with that domain instead.
 *
 * Every one of these takes what it reads as an argument. That is the whole
 * point of the decomposition: the projects list and the `VOLLI_SESSION`
 * identity used to be in scope for anything in the file, and now they are
 * named at each signature that wants them.
 */

import type Database from "better-sqlite3";
import {
  displayTicketId,
  isTicketPriority,
  resolveAgentContext,
  TICKET_PRIORITIES,
} from "@volli/shared";
import type {
  AgentErrorCode,
  AgentRequest,
  AgentResponse,
  Project,
  Ticket,
  TicketEventActor,
} from "@volli/shared";

import { getTicket, listArchivedTicketsByProject, listTicketsByProject } from "../db/tickets-repo";
import { failure } from "./context";
import type { EnvSessionIdentity } from "./context";

/**
 * A raw socket request can carry a priority the CLI parser would have rejected;
 * enumerate the valid vocabulary (from {@link TICKET_PRIORITIES}) so the error
 * teaches instead of a bare "invalid arguments". Returns null when the priority
 * is absent or valid.
 */
export function invalidPriorityResponse(priority: unknown): AgentResponse | null {
  if (priority === undefined || isTicketPriority(priority)) return null;
  return failure(
    "INVALID_REQUEST",
    `Invalid priority ${JSON.stringify(priority)} (valid: ${TICKET_PRIORITIES.join(", ")})`,
  );
}

/**
 * A CLI count option (`--events`/`--comments`/`--limit`/`--lines`) is honored
 * only when it's a positive integer; 0, negatives, and NaN fall back to the
 * command's default — never `slice(-0)`, which would return the whole history.
 */
export function positiveIntOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export type ProjectResolution =
  | { ok: true; project: Project }
  | { ok: false; response: AgentResponse };

export function finalizeContext(
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
 * paths); sessions are never scanned here — `VOLLI_SESSION` arrives already
 * resolved as {@link EnvSessionIdentity}.
 */
export function projectForCreate(
  db: Database.Database,
  projects: readonly Project[],
  envSession: EnvSessionIdentity | null,
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
  const envSessionId = request.ctx.env.session;
  if (envSessionId !== undefined) {
    if (!envSession) {
      return {
        ok: false,
        response: failure("SESSION_NOT_FOUND", `No session matches ${envSessionId}`),
      };
    }
    const project = projects.find(({ id }) => id === envSession.projectId);
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
 * session ticket (a Project Session) or it no longer resolves.
 */
export function actorSessionTicketDisplay(
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

/**
 * `allowArchived` lets a read-only worktree verb serve an archived ticket
 * (retention deliberately retains worktrees past archive — decision #76): every
 * other caller defaults to false and keeps refusing with ARCHIVED_TICKET.
 */
export function ticketForDisplayId(
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
 * Who the caller IS at the door — authenticated, or not (VC-163).
 *
 * Attribution used to happen here and authentication never did. This door read
 * `VOLLI_SESSION` out of the request environment and believed it, and read the
 * ABSENCE of that variable as `{ kind: "user" }` — the highest-trust actor in
 * the system, granted on no evidence whatsoever. Every process running as the
 * signed-in user reached the socket, and every one of them was the user.
 *
 * Now the token decides, and there are exactly three outcomes:
 *
 * - A token this launch minted, naming the Session the caller claims → the
 *   authenticated session actor.
 * - Anything else — no token, a forged one, a revoked one, or a valid one for a
 *   DIFFERENT Session than the claim → `unauthenticated`. Never `session`,
 *   which would make the token decorative, and never `user`, which is the
 *   grant-by-absence this ticket exists to remove.
 * - A token whose Session the Engine can no longer resolve → an error.
 *
 * What the caller may then DO is not decided here. Read-tier verbs take any
 * actor; coordination-tier verbs are judged against the per-project policy in
 * `admission.ts`. These two answer identity, and only identity.
 *
 * Scope the guarantee honestly: see `session-tokens.ts`. A token defeats an
 * injected string and cross-session confusion. It does not defeat a hostile
 * process running as the same user, which is why the control tier is absent
 * from this socket rather than gated on this check.
 */
/**
 * The attribution a verb is entitled to, or the refusal to hand it one.
 *
 * `AgentCommandContext.actor` is `null` for the three verbs whose table entry
 * skips identity resolution, so a verb that WRITES ticket history has to say
 * that it expects one. Every current caller declares `envSession: "resolve"`
 * and can therefore never see the refusal — but the alternative was a non-null
 * assertion at each write site, which would turn a future table edit into a
 * silent `undefined` in durable history instead of a legible refusal.
 */
export function attributedActor(
  actor: TicketEventActor | null,
): { ok: true; actor: TicketEventActor } | { ok: false; response: AgentResponse } {
  return actor === null
    ? {
        ok: false,
        response: failure(
          "INVALID_REQUEST",
          "This verb writes attributed history but its dispatch entry resolves no identity.",
        ),
      }
    : { ok: true, actor };
}

/**
 * Who the caller is, from the token alone — no database, no Session Engine.
 *
 * Split from {@link requestActor} because the two questions have different
 * costs and different consumers. ADMISSION needs only the kind, and needs it
 * for every verb including `hook`, which arrives on a process-per-event hot
 * path and must not pay for an identity lookup it does not use. ATTRIBUTION
 * needs the Session's ticket as well, and only the verbs that write ticket
 * events need that.
 */
export type DoorActor =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "unauthenticated" };

export function doorActor(
  request: AgentRequest,
  verifyToken: (token: string | undefined) => string | null,
): DoorActor {
  const authenticated = verifyToken(request.ctx.env.token);
  if (authenticated === null) return { kind: "unauthenticated" };
  // A token proves WHICH Session holds it, so a claim that disagrees with it is
  // not a claim this door reconciles: it takes neither side and authenticates
  // nobody. Believing the token over the claim would let a caller act on its
  // own authority while addressing another Session's context; believing the
  // claim over the token is the forgery the token exists to stop.
  const claimed = request.ctx.env.session;
  if (claimed !== undefined && claimed !== authenticated) return { kind: "unauthenticated" };
  return { kind: "session", sessionId: authenticated };
}

/**
 * The actor a write is ATTRIBUTED to, for the verbs that write ticket history.
 *
 * Takes the already-decided {@link DoorActor} rather than re-deriving one, so
 * the actor a write is stamped with is by construction the actor the admission
 * gate admitted. Two derivations could disagree, and the disagreement would be
 * invisible in exactly the case that matters.
 *
 * The one refusal here is a token that authenticates a Session the Engine can
 * no longer resolve. That caller IS authenticated, so answering "you are
 * anonymous" would misdescribe the fault and hide a Session that ended
 * underneath a live attachment.
 */
export function requestActor(
  door: DoorActor,
  envSession: EnvSessionIdentity | null,
): { ok: true; actor: TicketEventActor } | { ok: false; response: AgentResponse } {
  if (door.kind === "unauthenticated") return { ok: true, actor: { kind: "unauthenticated" } };
  return envSession
    ? {
        ok: true,
        actor: { kind: "session", sessionId: envSession.id, ticketId: envSession.ticketId },
      }
    : {
        ok: false,
        response: failure("SESSION_NOT_FOUND", `No session matches ${door.sessionId}.`),
      };
}
