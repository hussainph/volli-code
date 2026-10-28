/**
 * The handover: runner-local writes only, after the commit,
 * so the folder and the Sessions belong to the cloud project on this Mac.
 *
 * - The project's checkout and every Working copy are registered explicitly
 *   for this runner, by id, from the export's runner streams (the folder and
 *   worktrees the frozen rows name). Adoption from the frozen rows stays the
 *   fallback for anything not registered here.
 * - Every moved Session's drain cursor is seeded at its imported head
 *   (`MoveSessionHistory.seedCursors`), so a cloud launch's engine sees and
 *   resumes it and owes the backend only what happens after the move.
 *
 * No board row changes and git is untouched. Each write is an upsert by id,
 * so the step runs again safely; what it wrote is journaled so a roll back
 * takes back exactly that ({@link releaseHandover}).
 */
import type Database from "better-sqlite3";

import { createRunnerPathRegistry, RunnerPathCollision } from "../cloud-store/paths";
import { prepared } from "../db/prepared";
import type { MigrationExportManifest } from "../migration-export/exporter";
import type { HandoverRecord } from "./journal";
import { exportRecords, type MovePlan } from "./plan";
import type { MoveSessionHistory } from "./ports";

export async function handOver(input: {
  db: Database.Database;
  history: MoveSessionHistory;
  userId: string;
  runnerId: string;
  exportDir: string;
  manifest: MigrationExportManifest;
  plan: MovePlan;
}): Promise<HandoverRecord> {
  const { db } = input;
  const registry = createRunnerPathRegistry(db, { runnerId: input.runnerId });
  const record: HandoverRecord = { checkouts: [], workingCopies: [], cursors: [], collisions: 0 };

  for await (const row of exportRecords(input.exportDir, input.manifest, "projectCheckoutPaths")) {
    try {
      registry.checkouts.register({
        projectId: row.projectId as string,
        projectRepoId: row.projectRepoId as string,
        absPath: row.absPath as string,
        adoptedFromFrozen: true,
      });
      record.checkouts.push({
        projectRepoId: row.projectRepoId as string,
        absPath: row.absPath as string,
      });
    } catch (error) {
      if (!(error instanceof RunnerPathCollision)) throw error;
      record.collisions += 1;
    }
  }
  for await (const row of exportRecords(input.exportDir, input.manifest, "workingCopyPaths")) {
    const ticket = prepared<[string], { branch: string | null; base_branch: string | null }>(
      db,
      "SELECT branch, base_branch FROM tickets WHERE id = ?",
    ).get(row.ticketId as string);
    try {
      registry.workingCopies.register({
        ticketId: row.ticketId as string,
        projectRepoId: row.projectRepoId as string,
        absPath: row.absPath as string,
        workingCopyId: row.workingCopyId as string,
        branch: ticket?.branch ?? null,
        baseBranch: ticket?.base_branch ?? null,
        adoptedFromFrozen: true,
      });
      record.workingCopies.push({
        ticketId: row.ticketId as string,
        projectRepoId: row.projectRepoId as string,
        absPath: row.absPath as string,
      });
    } catch (error) {
      if (!(error instanceof RunnerPathCollision)) throw error;
      record.collisions += 1;
    }
  }

  record.cursors = input.plan.sessionList.map((session) => ({
    sessionId: session.sessionId,
    acceptedThrough: session.lastSequence,
  }));
  input.history.seedCursors(input.userId, record.cursors);
  return record;
}

/**
 * Takes back what {@link handOver} wrote: the path registrations still as it
 * wrote them, and the drain cursors no new fact moved. Answers the Sessions
 * that kept a cursor because they took new facts in Volli Cloud since.
 */
export function releaseHandover(input: {
  db: Database.Database;
  history: MoveSessionHistory;
  userId: string;
  runnerId: string;
  record: HandoverRecord;
  /**
   * Going back to local: every moved Session's cursor goes, moved on or not.
   * What this runner drained since the move is in the local ledger already.
   */
  everyCursor?: boolean;
}): string[] {
  const { db, record, runnerId } = input;
  let kept: string[] = [];
  if (input.everyCursor === true) {
    db.transaction(() => {
      for (const { sessionId } of record.cursors) {
        prepared(
          db,
          "DELETE FROM session_drain_cursors WHERE session_id = ? AND owner_user_id = ?",
        ).run(sessionId, input.userId);
      }
    })();
  } else {
    kept = input.history.releaseCursors(input.userId, record.cursors);
  }
  db.transaction(() => {
    for (const checkout of record.checkouts) {
      prepared(
        db,
        "DELETE FROM project_checkout_paths WHERE runner_id = ? AND project_repo_id = ? AND abs_path = ?",
      ).run(runnerId, checkout.projectRepoId, checkout.absPath);
    }
    for (const copy of record.workingCopies) {
      prepared(
        db,
        `DELETE FROM working_copy_paths
          WHERE runner_id = ? AND ticket_id = ? AND project_repo_id = ? AND abs_path = ?`,
      ).run(runnerId, copy.ticketId, copy.projectRepoId, copy.absPath);
    }
  })();
  return kept;
}
