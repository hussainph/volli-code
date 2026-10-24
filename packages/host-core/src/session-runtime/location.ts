import { existsSync } from "node:fs";

import type Database from "better-sqlite3";
import type { SessionLocation, SessionLocationResolver } from "@volli/session-engine";
import { harnessAdapters, scrubInheritedSessionEnv } from "@volli/shared";
import type { Session, SessionExecutionVenue } from "@volli/shared";

import type { HostEventBus } from "../ports";
import { getProjectById, isProjectAttached } from "../db/projects-repo";
import { getTicket } from "../db/tickets-repo";
import {
  acquireWorktreeStartLease,
  ensure,
  runPendingWorktreeSetup,
  UNDER_DELETION_REFUSAL,
} from "../worktree";
import { worktreeDeps } from "../worktree-runtime";

const LOCAL: SessionLocation["venue"] = { id: "local", kind: "local" };

/** Why a Session of a removed project does not start (VC-822). */
const PROJECT_REMOVED_REFUSAL =
  "This Session's project was removed from Volli. Add its folder again to use it.";

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
 *
 * `prepare` also runs the project's setup command when the worktree still owes
 * it (VC-835) — the terminal runs it in its shell, and a chat has no shell, so
 * it runs here, before the binding exists and so before the first turn. A
 * setup that fails fails the start with its exit code; it is claimed before it
 * runs, so the Retry starts the agent rather than running it again.
 *
 * Both of them are also agent STARTS, so both take the worktree start lease
 * (VC-284). A Session can be bound to a directory this app now
 * calls an orphan — deleting a ticket only clears `sessions.ticket_id` — so
 * "an agent is about to work in here" and "a cleanup is about to remove here"
 * are two acts over one directory, and the lease is what serializes them. It is
 * held only across the materialization; the turn that follows is visible to the
 * activity guard the destructive paths ask.
 */
/**
 * Holds the worktree START lease across one materialization, or refuses
 * (VC-284). Starts do not exclude each other, so the nested
 * acquisition `reaffirm` → `prepare` makes is free; only a destructive act
 * holding the path refuses one.
 */
async function withStartLease<T>(directory: string, work: () => Promise<T>): Promise<T> {
  const lease = acquireWorktreeStartLease(directory);
  if (lease === null) throw new Error(UNDER_DELETION_REFUSAL);
  try {
    return await work();
  } finally {
    lease.release();
  }
}

export function createSessionLocationResolver(
  db: Database.Database,
  ports: { events: HostEventBus },
  options: { dataDir: string; venue?: SessionExecutionVenue },
): SessionLocationResolver {
  const venue = options.venue ?? LOCAL;
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
    if (!isProjectAttached(db, project.id)) throw new Error(PROJECT_REMOVED_REFUSAL);
    if (ticket === null || !ticket.usesWorktree) {
      return withStartLease(project.path, async () => ({ directory: project.path, venue }));
    }
    // The lease covers the whole materialization: `ensure` is git work plus a
    // durable event, and a cleanup must not be able to take the directory
    // between it succeeding and the binding existing.
    return withStartLease(ticket.worktreePath ?? project.path, async () => {
      const deps = worktreeDeps(db, ports, options);
      const outcome = await ensure(deps, ticket.id);
      if (!outcome.ok) {
        // The path is the whole diagnosis when it is a stale stamp pointing at a
        // checkout somebody deleted, so it is named whenever the ticket has one.
        const at = ticket.worktreePath === null ? "" : ` at ${ticket.worktreePath}`;
        throw new Error(`Couldn't prepare the worktree${at} — ${outcome.error}`);
      }
      const { identity, created, restamped, setupPending } = outcome.value;
      if (identity.worktreePath === null) throw new Error("Worktree path was not resolved");
      // A fresh `git worktree add` just stamped worktree_path/branch/base_branch
      // on the ticket, or a reuse adopted the same-ticket branch actually
      // checked out there; a reuse that changed nothing stays quiet. Same
      // targeting the terminal uses, so the booting ticket's own rail refreshes
      // promptly.
      if (created || restamped) {
        ports.events.publish("data-changed", {
          ticketId: ticket.id,
          projectId: project.id,
          kind: "worktree",
        });
      }
      if (setupPending) {
        const setup = await runPendingWorktreeSetup(deps, {
          ticketId: ticket.id,
          worktreePath: identity.worktreePath,
          // Read now, not from the Session's start: the command a person sees
          // in Configure is the one that runs.
          setupCommand: getProjectById(db, project.id)?.setupCommand ?? null,
          shellPath: process.env["SHELL"] || "/bin/sh",
          // The app's environment (its adopted login PATH included) less every
          // marker saying an agent session is already running in it, as a
          // terminal's shell starts from.
          env: scrubInheritedSessionEnv(process.env, harnessAdapters),
        });
        if (setup.kind === "failed") {
          throw new Error(
            `Couldn't prepare the worktree at ${identity.worktreePath} — ${setup.message}`,
          );
        }
      }
      return { directory: identity.worktreePath, venue };
    });
  };

  return {
    async resolve(session) {
      const { project, ticket } = site(session);
      return { directory: ticket?.worktreePath ?? project.path, venue };
    },

    prepare,

    async reaffirm(session, directory) {
      if (!isProjectAttached(db, session.projectId)) throw new Error(PROJECT_REMOVED_REFUSAL);
      // A turn is about to write into this directory, so it is a start like any
      // other, and the lease is taken before the question rather than after it:
      // a directory a cleanup is removing right now must never be reaffirmed as
      // somewhere to work.
      await withStartLease(directory, async () => {
        // One `existsSync` in the ordinary case, which is every case but the
        // broken one: the whole point of asking before a turn is that asking
        // costs nothing when nothing is wrong.
        if (existsSync(directory)) return;
        // `prepare` names the worktree and the git reason when `ensure` refuses,
        // so a failure here already reads as Volli's own; it is left to throw.
        await prepare(session);
        if (existsSync(directory)) return;
        // `prepare` succeeded and the bound directory is still not there:
        // either the ticket now points somewhere else, or this Session runs in
        // a project root, which nothing can recreate. Say so rather than let a
        // harness say it worse, one prompt from now.
        throw new Error(`The Session's directory ${directory} is gone and couldn't be recreated.`);
      });
    },
  };
}
