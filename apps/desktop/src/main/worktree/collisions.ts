/**
 * The scan half of the file-collision radar (VC-185, split from VC-89 slice 3).
 *
 * The arithmetic lives in `@volli/shared`'s `collisionMatrix` — pure, and
 * therefore testable without a repository. What is left here is the evidence
 * gathering: walk a project's live tickets, take each materialized worktree's
 * merge-base diff through the SAME {@link readWorktreeDiff} the `worktree diff`
 * verb answers with, and hand the paths to the matrix.
 *
 * Reusing that read rather than running git here is what keeps the radar and
 * the per-ticket diff from ever disagreeing about what a ticket touches — the
 * radar's whole value is that an orchestrator can trust it instead of opening
 * sixteen diffs by hand.
 *
 * A worktree that cannot be read is NAMED, never dropped. A radar that silently
 * skips a worktree reports "no collisions" for a collision it never looked at,
 * which is worse than reporting nothing at all: it is the same answer as the
 * healthy case. A ticket with no worktree is not in either list, because it has
 * no diff to collide with and saying so for every backlog row would bury the
 * signal.
 */

import type Database from "better-sqlite3";
import { collisionMatrix, displayTicketId } from "@volli/shared";
import type { CollisionMatrix, Project } from "@volli/shared";

import { listTicketsByProject } from "../db/tickets-repo";
import { readWorktreeDiff, type WorktreeReadDeps } from "./read";

/** One scanned worktree and how much of it the radar measured. */
export interface ScannedWorktree {
  readonly ticket: string;
  readonly branch: string | null;
  readonly baseBranch: string | null;
  /** How many paths this ticket's branch touches versus its base. */
  readonly files: number;
}

/** One worktree the scan could not measure, and why. */
export interface SkippedWorktree {
  readonly ticket: string;
  readonly reason: string;
}

/** What one project's radar sweep found. */
export interface CollisionScan extends CollisionMatrix {
  readonly worktrees: readonly ScannedWorktree[];
  readonly skipped: readonly SkippedWorktree[];
}

/**
 * Scans every live ticket worktree in the given projects and returns the
 * collision matrix over their diffs.
 *
 * Live tickets only: an archived ticket's worktree is retained (decision #76)
 * but its work is no longer being scheduled, so listing it as a collision would
 * be advice about a merge nobody is planning.
 */
export function scanCollisions(
  deps: WorktreeReadDeps & { db: Database.Database },
  projects: readonly Project[],
): CollisionScan {
  const worktrees: ScannedWorktree[] = [];
  const skipped: SkippedWorktree[] = [];
  const touches: { ticket: string; paths: string[] }[] = [];

  for (const project of projects) {
    for (const ticket of listTicketsByProject(deps.db, project.id)) {
      // A ticket with no worktree has no diff to collide with. Not a fault, and
      // not a skip — simply not part of this question.
      if (ticket.worktreePath === null) continue;
      const displayId = displayTicketId(project.ticketPrefix, ticket.ticketNumber);
      const read = readWorktreeDiff(deps, ticket.id, "merge-base");
      switch (read.kind) {
        case "ok": {
          const paths = read.diff.files.map((file) => file.path);
          worktrees.push({
            ticket: displayId,
            branch: ticket.branch,
            baseBranch: ticket.baseBranch,
            files: paths.length,
          });
          touches.push({ ticket: displayId, paths });
          break;
        }
        case "missing-on-disk":
          skipped.push({
            ticket: displayId,
            reason: `Its worktree folder is missing (expected at ${read.worktreePath}).`,
          });
          break;
        case "diff-error":
          skipped.push({ ticket: displayId, reason: read.error });
          break;
        // `missing-ticket` cannot happen for a row this loop just read, and a
        // `no-worktree` answer contradicts the guard above; either way there is
        // nothing to measure and nothing honest to say about it.
        default:
          break;
      }
    }
  }

  return { ...collisionMatrix(touches), worktrees, skipped };
}
