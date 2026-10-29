/**
 * The scan half of the file-collision radar (VC-185, split from VC-89 slice 3).
 *
 * The arithmetic lives in `@volli/shared`'s `collisionMatrix` — pure, and
 * therefore testable without a repository. What is left here is the evidence
 * gathering: walk a project's live, not-Done tickets, take each materialized
 * worktree's complete current Change Set path list (committed + staged +
 * unstaged + untracked versus its base), and hand those paths to the matrix.
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
import type { CollisionMatrix, Project, Ticket } from "@volli/shared";

import { listTicketsByProject } from "../db/tickets-repo";
import { readWorktreeChangeSetPaths, type WorktreeReadPorts } from "./read";

/** Board scheduling facts and machine git pointers needed by the scan. */
export type CollisionTicket = Pick<
  Ticket,
  "id" | "projectId" | "ticketNumber" | "status" | "worktreePath" | "branch" | "baseBranch"
>;

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
 * How many worktrees the sweep reads at once. Each read is four git children
 * over three awaits, and every child still queues on the runner's own
 * process-wide slot gate (`GIT_MAX_CONCURRENT_CHILDREN`), so the sweep never has
 * more git processes running than that gate allows, and it shares the gate with
 * every other read the host is making.
 */
const COLLISION_SCAN_CONCURRENCY = 4;

/**
 * How long the sweep may run before it answers with what it has. The CLI waits
 * 10 s for any reply (`timeoutForCommand` in `packages/cli`), and a reply that
 * lands after the caller gave up is no answer at all, so the sweep stops well
 * inside that and names every worktree it did not finish.
 */
const COLLISION_SCAN_DEADLINE_MS = 6_000;

const DEADLINE_REASON = `Not scanned before the deadline (${COLLISION_SCAN_DEADLINE_MS / 1000} s).`;

/** One worktree the sweep set out to read, and where its answer lands. */
interface ScanTarget {
  readonly project: number;
  readonly ticket: CollisionTicket;
  readonly displayId: string;
}

/** What one target's read came to. */
type ScanOutcome =
  | { kind: "ok"; paths: readonly string[] }
  | { kind: "skipped"; reason: string }
  | { kind: "nothing" };

async function readTarget(deps: WorktreeReadPorts, { ticket }: ScanTarget): Promise<ScanOutcome> {
  const read = await readWorktreeChangeSetPaths(deps, ticket.id);
  switch (read.kind) {
    case "ok":
      return { kind: "ok", paths: read.paths };
    case "missing-on-disk":
      return {
        kind: "skipped",
        reason: `Its worktree folder is missing (expected at ${read.worktreePath}).`,
      };
    case "change-set-error":
      return { kind: "skipped", reason: read.error };
    // Keep local roster behavior unchanged. A Cloud registry can disappear
    // after the roster read; name that lost coverage instead of dropping it.
    default:
      return deps.machinePaths?.kind === "cloud"
        ? { kind: "skipped", reason: "Its registered Working copy is no longer available." }
        : { kind: "nothing" };
  }
}

/**
 * Scans every live, not-Done ticket worktree in the given projects and returns
 * their per-project collision matrices flattened without cross-project joins.
 *
 * Live tickets only: an archived ticket's worktree is retained (decision #76)
 * but its work is no longer being scheduled, so listing it as a collision would
 * be advice about a merge nobody is planning. The same holds for a Done ticket,
 * whose worktree is retained after its work merged: it is out of scope, so it
 * is in neither `worktrees` nor `skipped`. Scanning it would also be wrong, not
 * just slow — after a squash merge its branch is no ancestor of the base, so its
 * whole diff would read as live and overlap every active ticket that touches
 * the same files.
 *
 * Reads run a few at a time and the whole sweep is bounded by a deadline; a
 * worktree whose read had not finished by then, in flight or never started, is
 * named in `skipped` rather than dropped.
 */
export async function scanCollisions(
  deps: WorktreeReadPorts & {
    db: Database.Database;
    tickets?: readonly CollisionTicket[];
    deadline?: number;
  },
  projects: readonly Pick<Project, "id" | "ticketPrefix">[],
): Promise<CollisionScan> {
  const targets: ScanTarget[] = [];
  for (const [index, project] of projects.entries()) {
    const tickets =
      deps.tickets === undefined
        ? listTicketsByProject(deps.db, project.id)
        : deps.tickets.filter((ticket) => ticket.projectId === project.id);
    for (const ticket of tickets) {
      // A ticket with no worktree has no diff to collide with. Not a fault, and
      // not a skip — simply not part of this question.
      if (ticket.worktreePath === null) continue;
      if (ticket.status === "done") continue;
      targets.push({
        project: index,
        ticket,
        displayId: displayTicketId(project.ticketPrefix, ticket.ticketNumber),
      });
    }
  }

  // Outcomes are kept by position, so the answer is in board order however the
  // reads interleave. A slot still `undefined` at the deadline was cut off.
  const outcomes: (ScanOutcome | undefined)[] = Array.from({ length: targets.length });
  let expired = deps.deadline !== undefined && deps.deadline <= Date.now();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      // `expired` flips in the deadline's timer, between awaits.
      if (expired || next >= targets.length) return;
      const position = next;
      next += 1;
      const outcome = await readTarget(deps, targets[position]!);
      if (!expired) outcomes[position] = outcome;
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(
      () => {
        expired = true;
        resolve();
      },
      Math.min(COLLISION_SCAN_DEADLINE_MS, Math.max(0, (deps.deadline ?? Infinity) - Date.now())),
    );
  });
  try {
    await Promise.race([
      Promise.all(
        Array.from({ length: Math.min(COLLISION_SCAN_CONCURRENCY, targets.length) }, worker),
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    // Reads still in flight finish on their own (the runner bounds each child);
    // their answers arrive after this reply and are discarded.
    expired = true;
  }

  const worktrees: ScannedWorktree[] = [];
  const skipped: SkippedWorktree[] = [];
  // A relative path only has meaning inside this project. Keep each list
  // scoped, then make one matrix per project: flattening all touches first
  // would turn two unrelated repositories' package.json files into a false
  // scheduling collision.
  const touches: { ticket: string; paths: readonly string[] }[][] = projects.map(() => []);
  for (const [position, { project, ticket, displayId }] of targets.entries()) {
    const outcome = outcomes[position] ?? {
      kind: "skipped",
      reason:
        deps.deadline === undefined ? DEADLINE_REASON : "Not scanned before the command deadline.",
    };
    switch (outcome.kind) {
      case "ok":
        worktrees.push({
          ticket: displayId,
          branch: ticket.branch,
          baseBranch: ticket.baseBranch,
          files: outcome.paths.length,
        });
        touches[project]!.push({ ticket: displayId, paths: outcome.paths });
        break;
      case "skipped":
        skipped.push({ ticket: displayId, reason: outcome.reason });
        break;
      case "nothing":
        break;
    }
  }
  const matrices: CollisionMatrix[] = touches.map((list) => collisionMatrix(list));

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
