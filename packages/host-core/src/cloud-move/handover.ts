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

import { createRunnerPathRegistry } from "../cloud-store/paths";
import { prepared } from "../db/prepared";
import type { MigrationExportManifest } from "../migration-export/exporter";
import type { HandoverRecord } from "./journal";
import { exportRecords, type MovePlan } from "./plan";
import type { MoveSessionHistory } from "./ports";

/**
 * What a handover will write, read from the export before anything is
 * written: journaled first, so a roll back that interrupts it (a crash, the
 * person's own call) takes back exactly these rows.
 */
export async function plannedHandover(input: {
  exportDir: string;
  manifest: MigrationExportManifest;
  plan: MovePlan;
}): Promise<HandoverRecord> {
  const record: HandoverRecord = { checkouts: [], workingCopies: [], cursors: [], collisions: 0 };
  for await (const row of exportRecords(input.exportDir, input.manifest, "projectCheckoutPaths")) {
    record.checkouts.push({
      projectRepoId: row.projectRepoId as string,
      absPath: row.absPath as string,
    });
  }
  for await (const row of exportRecords(input.exportDir, input.manifest, "workingCopyPaths")) {
    record.workingCopies.push({
      ticketId: row.ticketId as string,
      projectRepoId: row.projectRepoId as string,
      absPath: row.absPath as string,
      workingCopyId: (row.workingCopyId as string | undefined) ?? null,
    });
  }
  record.cursors = input.plan.sessionList.map((session) => ({
    sessionId: session.sessionId,
    acceptedThrough: session.lastSequence,
  }));
  return record;
}

/**
 * Writes a planned handover. A registration the registry refuses (another
 * working copy or runner holds the folder, or the id) is counted in
 * `collisions`, never an error: the folder needs the person, and the rest of
 * the handover goes on. Answers the record with what was written.
 */
export function handOver(input: {
  db: Database.Database;
  history: MoveSessionHistory;
  userId: string;
  runnerId: string;
  projectId: string;
  planned: HandoverRecord;
}): HandoverRecord {
  const { db, planned } = input;
  const registry = createRunnerPathRegistry(db, { runnerId: input.runnerId });
  const written: HandoverRecord = {
    checkouts: [],
    workingCopies: [],
    cursors: planned.cursors,
    collisions: 0,
  };
  for (const checkout of planned.checkouts) {
    try {
      registry.checkouts.register({
        projectId: input.projectId,
        projectRepoId: checkout.projectRepoId,
        absPath: checkout.absPath,
        adoptedFromFrozen: true,
      });
      written.checkouts.push(checkout);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      written.collisions += 1;
    }
  }
  for (const copy of planned.workingCopies) {
    const ticket = prepared<[string], { branch: string | null; base_branch: string | null }>(
      db,
      "SELECT branch, base_branch FROM tickets WHERE id = ?",
    ).get(copy.ticketId);
    try {
      registry.workingCopies.register({
        ...copy,
        branch: ticket?.branch ?? null,
        baseBranch: ticket?.base_branch ?? null,
        adoptedFromFrozen: true,
      });
      written.workingCopies.push(copy);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      written.collisions += 1;
    }
  }
  input.history.seedCursors(input.userId, planned.cursors);
  return written;
}

/**
 * Takes back every drain cursor this runner holds for `userId` on the
 * project's Sessions: the moved ones (moved on or not) and those born in
 * Volli Cloud since. For when the project is the local copy's again (Go back
 * to local) or its cloud copy is purged (a roll back after the commit): this
 * runner serves none of them any more, and what it drained is in the local
 * ledger already. Answers the Sessions whose cursors went.
 */
export function releaseProjectCursors(
  db: Database.Database,
  userId: string,
  projectId: string,
): string[] {
  return db.transaction(() => {
    const held = prepared<[string, string], { session_id: string }>(
      db,
      `SELECT session_id FROM session_drain_cursors WHERE owner_user_id = ?
        AND session_id IN (SELECT id FROM sessions WHERE project_id = ?) ORDER BY session_id`,
    )
      .all(userId, projectId)
      .map((row) => row.session_id);
    prepared(
      db,
      `DELETE FROM session_drain_cursors WHERE owner_user_id = ?
        AND session_id IN (SELECT id FROM sessions WHERE project_id = ?)`,
    ).run(userId, projectId);
    return held;
  })();
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
   * Going back to local, for this project: every Session's cursor goes, the
   * moved ones (moved on or not) and those born in Volli Cloud since. What
   * this runner drained since the move is in the local ledger already.
   */
  everyCursor?: { projectId: string };
}): string[] {
  const { db, record, runnerId } = input;
  let kept: string[] = [];
  if (input.everyCursor !== undefined) {
    releaseProjectCursors(db, input.userId, input.everyCursor.projectId);
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
