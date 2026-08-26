/**
 * The scan half of the file-collision radar (VC-185, split from VC-89 slice 3).
 *
 * The arithmetic lives in `@volli/shared`'s `collisionMatrix` — pure, and
 * therefore testable without a repository. What is left here is the evidence
 * gathering: walk a project's live tickets, take each materialized worktree's
 * complete current Change Set path list (committed + staged + unstaged +
 * untracked versus its base), and hand those paths to the matrix.
 *
 * Reusing the Change Set's base and porcelain rules rather than running an
 * ad-hoc diff here is what keeps the radar from declaring a clean matrix while
 * an active session has the same uncommitted file open in another worktree.
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
import { readWorktreeChangeSetPaths, type WorktreeReadDeps } from "./read";

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

/** What one project-scoped radar sweep found (or a safely flattened multi-project sweep). */
export interface CollisionScan extends CollisionMatrix {
  readonly worktrees: readonly ScannedWorktree[];
  readonly skipped: readonly SkippedWorktree[];
}

/**
 * Scans every live ticket worktree in the given projects and returns their
 * per-project collision matrices flattened without cross-project joins.
 *
 * Live tickets only: an archived ticket's worktree is retained (decision #76)
 * but its work is no longer being scheduled, so listing it as a collision would
 * be advice about a merge nobody is planning.
 */
export async function scanCollisions(
  deps: WorktreeReadDeps & { db: Database.Database },
  projects: readonly Project[],
): Promise<CollisionScan> {
  const worktrees: ScannedWorktree[] = [];
  const skipped: SkippedWorktree[] = [];
  const matrices: CollisionMatrix[] = [];

  for (const project of projects) {
    // A relative path only has meaning inside this project. Keep this list
    // scoped, then make one matrix per project: flattening all touches first
    // would turn two unrelated repositories' package.json files into a false
    // scheduling collision.
    const touches: { ticket: string; paths: readonly string[] }[] = [];
    for (const ticket of listTicketsByProject(deps.db, project.id)) {
      // A ticket with no worktree has no diff to collide with. Not a fault, and
      // not a skip — simply not part of this question.
      if (ticket.worktreePath === null) continue;
      const displayId = displayTicketId(project.ticketPrefix, ticket.ticketNumber);
      const read = await readWorktreeChangeSetPaths(deps, ticket.id);
      switch (read.kind) {
        case "ok": {
          const { paths } = read;
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
        case "change-set-error":
          skipped.push({ ticket: displayId, reason: read.error });
          break;
        // `missing-ticket` cannot happen for a row this loop just read, and a
        // `no-worktree` answer contradicts the guard above; either way there is
        // nothing to measure and nothing honest to say about it.
        default:
          break;
      }
    }
    matrices.push(collisionMatrix(touches));
  }

  // Each matrix is already deterministic. Re-sort the flattened project sweep
  // too, so a caller sees stable bytes regardless of project registration order
  // without ever joining claims across project boundaries.
  const overlaps = matrices
    .flatMap((matrix) => matrix.overlaps)
    .toSorted(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.tickets.join("\u0000").localeCompare(right.tickets.join("\u0000")),
    );
  const pairs = matrices
    .flatMap((matrix) => matrix.pairs)
    .toSorted(
      (left, right) =>
        right.paths.length - left.paths.length ||
        left.tickets[0].localeCompare(right.tickets[0]) ||
        left.tickets[1].localeCompare(right.tickets[1]),
    );

  return { overlaps, pairs, worktrees, skipped };
}
