import { existsSync } from "node:fs";

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
 *
 * `reaffirm` is the same pipeline reached the other way round: it starts from a
 * directory that is already bound and only runs when that directory has stopped
 * existing, which is the whole reason it is cheap enough to sit in front of a
 * turn. Recreating goes through `prepare` rather than around it — `ensure` is
 * single-flight and its reconcile already owns "registered, directory missing →
 * prune, then recreate at the same path" — so a worktree comes back where it
 * was, on the branch it was on, with the work that was committed to it intact.
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

  const prepare = async (session: Session): Promise<SessionLocation> => {
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
  };

  return {
    async resolve(session) {
      const { project, ticket } = site(session);
      return { directory: ticket?.worktreePath ?? project.path, venue: LOCAL };
    },

    prepare,

    async reaffirm(session, directory) {
      // One `existsSync` in the ordinary case, which is every case but the
      // broken one: the whole point of asking before a turn is that asking
      // costs nothing when nothing is wrong.
      if (existsSync(directory)) return;
      // `prepare` names the worktree and the git reason when `ensure` refuses,
      // so a failure here already reads as Volli's own; it is left to throw.
      await prepare(session);
      if (existsSync(directory)) return;
      // `prepare` succeeded and the bound directory is still not there: either
      // the ticket now points somewhere else, or this Session runs in a project
      // root, which nothing can recreate. Say so rather than let a harness say
      // it worse, one prompt from now.
      throw new Error(`The Session's directory ${directory} is gone and couldn't be recreated.`);
    },
  };
}
