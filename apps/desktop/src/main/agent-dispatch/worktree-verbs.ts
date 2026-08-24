/**
 * The two read-only worktree verbs, and the ticket resolution they share.
 *
 * Context resolution (which ticket the agent means) is this door's concern;
 * the git compose and the no-worktree / stamped-but-deleted discrimination
 * live behind the ticketId-in read verbs (CONCEPT #42). Both verbs resolve an
 * ARCHIVED ticket too, which nothing else here does: retention deliberately
 * retains worktrees past archive (decision #76).
 */

import type Database from "better-sqlite3";
import { displayTicketId, resolveAgentContext } from "@volli/shared";
import type { AgentRequest, AgentResponse, Project, Ticket } from "@volli/shared";
import type { WorktreeDiffMode } from "../../ipc/contract";

import { listArchivedTicketsByProject, listTicketsByProject } from "../db/tickets-repo";
import { readWorktreeDiff, readWorktreeStatus } from "../worktree";
import { isInside } from "../worktree/paths";
import { failure } from "./context";
import type { AgentCommandContext, EnvSessionIdentity } from "./context";
import { ticketForDisplayId } from "./resolution";

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
  envSession: EnvSessionIdentity | null,
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
    // The ladder only ever looks `VOLLI_SESSION` up by exact id, so the one
    // resolved identity is the whole session index it needs — and it covers a
    // structured Session no terminal snapshot would contain.
    sessions:
      envSession === null
        ? []
        : [
            {
              id: envSession.id,
              projectId: envSession.projectId,
              ticketDisplayId: envSession.ticketId
                ? (ticketDisplayById.get(envSession.ticketId) ?? null)
                : null,
            },
          ],
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

/**
 * The refusal a worktree read verb returns when the ticket has no worktree.
 *
 * It used to say "Move it to Doing to create one" for every ticket, which was
 * false twice over (VC-98): a board move has never run `ensure` — only a
 * Session boot and, since VC-98, switching worktree scope on do — and a
 * main-checkout ticket has no worktree to create at all. An agent that believed
 * the old sentence moved the ticket, saw nothing appear, and carried on in the
 * main checkout. Each arm now names what actually materializes a worktree.
 */
function noWorktreeRefusal(displayId: string, usesWorktree: boolean): string {
  return usesWorktree
    ? `Ticket ${displayId} has no worktree yet. One is created when a session starts for it.`
    : `Ticket ${displayId} runs in the project's main checkout, so it has no worktree.`;
}

/** `volli worktree status` — a ticket's branch, base, and sync state. */
export async function worktreeStatusVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects, envSession, git, worktreeExists } = context;
  // Context resolution (which ticket the agent means) stays this door's
  // concern; the git compose + the no-worktree / stamped-but-deleted
  // discrimination live behind the ticketId-in read verb (CONCEPT #42).
  const resolved = resolveWorktreeTicket(options.db, projects, envSession, request);
  if (!resolved.ok) return resolved.response;
  const read = readWorktreeStatus({ db: options.db, git, worktreeExists }, resolved.ticket.id);
  switch (read.kind) {
    case "missing-ticket":
      return failure("TICKET_NOT_FOUND", "The resolved ticket no longer exists.");
    case "no-worktree":
      return failure("INVALID_REQUEST", noWorktreeRefusal(read.displayId, read.usesWorktree));
    case "missing-on-disk":
      return failure(
        "INVALID_REQUEST",
        `Ticket ${read.displayId}'s worktree folder is missing (expected at ${read.worktreePath}).`,
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

/** `volli worktree diff` — a ticket's diff, the PR range by default. */
export async function worktreeDiffVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects, envSession, git, worktreeExists } = context;
  const resolved = resolveWorktreeTicket(options.db, projects, envSession, request);
  if (!resolved.ok) return resolved.response;
  // Merge-base ("what the PR would contain") is the default; --working-tree
  // switches to the uncommitted view. Same two-mode diff.ts the rail uses.
  const mode: WorktreeDiffMode =
    request.args["workingTree"] === true ? "working-tree" : "merge-base";
  const read = readWorktreeDiff({ db: options.db, git, worktreeExists }, resolved.ticket.id, mode);
  switch (read.kind) {
    case "missing-ticket":
      return failure("TICKET_NOT_FOUND", "The resolved ticket no longer exists.");
    case "no-worktree":
      return failure("INVALID_REQUEST", noWorktreeRefusal(read.displayId, read.usesWorktree));
    case "missing-on-disk":
      return failure(
        "INVALID_REQUEST",
        `Ticket ${read.displayId}'s worktree folder is missing (expected at ${read.worktreePath}).`,
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
