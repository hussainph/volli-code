import type Database from "better-sqlite3";
import type { SessionLocation, SessionLocationResolver } from "@volli/session-engine";
import type { Session } from "@volli/shared";

import { broadcastDataChanged } from "../broadcast";
import { getProjectById } from "../db/projects-repo";
import { getTicket } from "../db/tickets-repo";
import { ensure } from "../worktree";
import { worktreeDeps } from "../worktree-runtime";

const LOCAL: SessionLocation["venue"] = { id: "local", kind: "local" };

/**
 * Resolves immutable Session identity to its trusted project/worktree directory.
 *
 * `prepare` is the chat's half of the guarantee `pty/manager.ts` makes before it
 * spawns, through the same `ensure` pipeline: a ticket that runs in an isolated
 * checkout gets that checkout materialized, and one that cannot fails instead of
 * quietly binding the main repo (#38). `resolve` stays a plain read — `ensure`
 * is git work plus a durable event, and only the attach binds a directory.
 */
export function createDesktopSessionLocationResolver(
  db: Database.Database,
): SessionLocationResolver {
  const site = (session: Session) => {
    const project = getProjectById(db, session.projectId);
    if (!project) throw new Error(`Project ${session.projectId} was not found`);
    if (session.ticketId === null) return { project, ticket: null };
    const ticket = getTicket(db, session.ticketId);
    if (!ticket || ticket.projectId !== project.id) {
      throw new Error(`Ticket ${session.ticketId} was not found in project ${project.id}`);
    }
    return { project, ticket };
  };

  return {
    async resolve(session) {
      const { project, ticket } = site(session);
      return { directory: ticket?.worktreePath ?? project.path, venue: LOCAL };
    },

    async prepare(session) {
      const { project, ticket } = site(session);
      if (ticket === null || !ticket.usesWorktree) {
        return { directory: project.path, venue: LOCAL };
      }
      const outcome = await ensure(worktreeDeps(db), ticket.id);
      if (!outcome.ok) {
        // The path is the whole diagnosis when it is a stale stamp pointing at a
        // checkout somebody deleted, so it is named whenever the ticket has one.
        const at = ticket.worktreePath === null ? "" : ` at ${ticket.worktreePath}`;
        throw new Error(`Couldn't prepare the worktree${at} — ${outcome.error}`);
      }
      const { identity, created } = outcome.value;
      if (identity.worktreePath === null) throw new Error("Worktree path was not resolved");
      // A fresh `git worktree add` just stamped worktree_path/branch/base_branch
      // on the ticket; a reused one changed nothing. Same targeting the terminal
      // uses, so the booting ticket's own rail refreshes promptly.
      if (created) {
        broadcastDataChanged({ ticketId: ticket.id, projectId: project.id, kind: "worktree" });
      }
      return { directory: identity.worktreePath, venue: LOCAL };
    },
  };
}
