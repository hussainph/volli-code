/**
 * The move journal's repository (`cloud_move_queues`, `cloud_moves`, migration
 * 68). Every state change is one guarded UPDATE (`WHERE state = <from>`), so
 * two runs of the engine can never both take a step, and a crash leaves the
 * row at the last step that completed.
 */
import type Database from "better-sqlite3";

import { prepared } from "../db/prepared";
import type { MoveState } from "./states";

/** Why a move is waiting rather than running. Cleared when it runs again. */
export type MovePause =
  /** A Session of the project is running a turn or a shell: the queue moves on and comes back. */
  | "not_idle"
  /** The backend did not answer: nothing is lost; the step runs again. */
  | "network"
  | "disk_full"
  /** Nobody, or someone else, is signed in: the move resumes for the same person only. */
  | "signed_out"
  /** The project's previous move is still being purged (the backend answers `import_in_progress`). */
  | "waiting_for_purge"
  /** Paused by the person, or the app quit mid-step. */
  | "paused";

/** Why a move was rolled back. Codes and counts, never content. */
export interface MoveFailure {
  code: string;
  message: string;
  /** The step that failed. */
  step: MoveState;
  at: number;
  /** Counts by refusal code, stream names, ids of the rows or Sessions a check names. */
  detail?: Record<string, unknown>;
}

/** A move's resumable progress. Every field is written once its part is durable. */
export interface MoveJournal {
  /** The published export's id and the sha256 of its `manifest.json`. */
  exportId?: string;
  exportManifestSha256?: string;
  /** Records the backend acknowledged, per importer stream, in the plan's order. */
  rows?: Record<string, number>;
  /** Objects uploaded, in the plan's order. */
  objects?: number;
  /** Sessions whose history (transcript packs, Pi logs) is uploaded, in the plan's order. */
  history?: number;
  /** The state a roll back started from. */
  rollbackFrom?: MoveState;
  /** The person confirmed losing the cloud copy's changes since the commit. */
  rollbackConfirmed?: boolean;
  /** The runner a move that starts over moves again onto. */
  againOnRunner?: string;
  /** The engine run that rolled it back called `uncommit` / `abort` already. */
  uncommitted?: boolean;
  aborted?: boolean;
}

export interface MoveRow {
  moveId: string;
  queueId: string;
  projectId: string;
  position: number;
  userId: string;
  workspaceId: string;
  runnerId: string;
  state: MoveState;
  paused: MovePause | null;
  journal: MoveJournal;
  failure: MoveFailure | null;
  report: Record<string, unknown> | null;
  appVersion: string;
  mapperVersion: number;
  manifestSha256: string | null;
  supersedes: string | null;
  createdAt: number;
  updatedAt: number;
  committedAt: number | null;
  confirmedAt: number | null;
  returnedAt: number | null;
}

/** The verified backup a queue's moves rely on. */
export interface QueueBackup {
  path: string;
  bytes: number;
  verifiedAt: number;
}

export type QueueState = "running" | "stopped" | "done";

export interface QueueRow {
  queueId: string;
  userId: string;
  workspaceId: string;
  runnerId: string;
  stopAtFirstProblem: boolean;
  includeRemoved: boolean;
  profileStep: "pending" | "done" | "skipped";
  backup: QueueBackup | null;
  state: QueueState;
  createdAt: number;
  updatedAt: number;
}

interface MoveDbRow {
  move_id: string;
  queue_id: string;
  project_id: string;
  position: number;
  user_id: string;
  workspace_id: string;
  runner_id: string;
  state: MoveState;
  paused: MovePause | null;
  journal_json: string;
  failure_json: string | null;
  report_json: string | null;
  app_version: string;
  mapper_version: number;
  manifest_sha256: string | null;
  supersedes: string | null;
  created_at: number;
  updated_at: number;
  committed_at: number | null;
  confirmed_at: number | null;
  returned_at: number | null;
}

interface QueueDbRow {
  queue_id: string;
  user_id: string;
  workspace_id: string;
  runner_id: string;
  stop_at_first_problem: number;
  include_removed: number;
  profile_step: QueueRow["profileStep"];
  backup_json: string | null;
  state: QueueState;
  created_at: number;
  updated_at: number;
}

const json = <T>(text: string | null): T | null => (text === null ? null : (JSON.parse(text) as T));

function moveOf(row: MoveDbRow): MoveRow {
  return {
    moveId: row.move_id,
    queueId: row.queue_id,
    projectId: row.project_id,
    position: row.position,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    runnerId: row.runner_id,
    state: row.state,
    paused: row.paused,
    journal: JSON.parse(row.journal_json) as MoveJournal,
    failure: json<MoveFailure>(row.failure_json),
    report: json<Record<string, unknown>>(row.report_json),
    appVersion: row.app_version,
    mapperVersion: row.mapper_version,
    manifestSha256: row.manifest_sha256,
    supersedes: row.supersedes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    committedAt: row.committed_at,
    confirmedAt: row.confirmed_at,
    returnedAt: row.returned_at,
  };
}

function queueOf(row: QueueDbRow): QueueRow {
  return {
    queueId: row.queue_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    runnerId: row.runner_id,
    stopAtFirstProblem: row.stop_at_first_problem === 1,
    includeRemoved: row.include_removed === 1,
    profileStep: row.profile_step,
    backup: json<QueueBackup>(row.backup_json),
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A guarded update found the row in another state: another run took the step. */
export class MoveStateConflictError extends Error {
  constructor(moveId: string, expected: MoveState) {
    super(`Move ${moveId} is no longer ${expected}.`);
    this.name = "MoveStateConflictError";
  }
}

export interface NewMove {
  moveId: string;
  projectId: string;
  position: number;
  supersedes?: string | null;
}

export interface MoveJournalStore {
  createQueue(queue: Omit<QueueRow, "createdAt" | "updatedAt">, moves: readonly NewMove[]): void;
  queue(queueId: string): QueueRow | null;
  /** Queues still running, oldest first: what a launch resumes. */
  runningQueues(): QueueRow[];
  setQueue(
    queueId: string,
    patch: Partial<Pick<QueueRow, "state" | "backup" | "profileStep" | "runnerId">>,
  ): void;
  move(moveId: string): MoveRow | null;
  /** The move holding `projectId` now (not rolled back, returned or superseded). */
  liveMove(projectId: string): MoveRow | null;
  moves(queueId: string): MoveRow[];
  /** Every move in one of `states`, oldest first: what a launch finishes. */
  movesIn(states: readonly MoveState[]): MoveRow[];
  /** Adds a move to an existing queue (a project moved again under a new move id). */
  addMove(queueId: string, move: NewMove): void;
  /** Moves `moveId` from `from` to `to` with `patch`, or throws {@link MoveStateConflictError}. */
  advance(moveId: string, from: MoveState, to: MoveState, patch?: MovePatch): MoveRow;
  /** Records progress inside the current state. */
  patch(moveId: string, patch: MovePatch): MoveRow;
}

export interface MovePatch {
  paused?: MovePause | null;
  journal?: Partial<MoveJournal>;
  failure?: MoveFailure | null;
  report?: Record<string, unknown> | null;
  manifestSha256?: string | null;
  committedAt?: number | null;
  confirmedAt?: number | null;
  returnedAt?: number | null;
}

export function sqliteMoveJournal(
  db: Database.Database,
  options: { now: () => number; appVersion: string; mapperVersion: number },
): MoveJournalStore {
  const { now } = options;
  const read = (moveId: string): MoveRow | null => {
    const row = prepared<[string], MoveDbRow>(
      db,
      "SELECT * FROM cloud_moves WHERE move_id = ?",
    ).get(moveId);
    return row === undefined ? null : moveOf(row);
  };

  const insertMove = (
    queue: Pick<QueueRow, "queueId" | "userId" | "workspaceId" | "runnerId">,
    move: NewMove,
  ) => {
    const at = now();
    prepared(
      db,
      `INSERT INTO cloud_moves (move_id, queue_id, project_id, position, user_id, workspace_id,
         runner_id, state, paused, journal_json, app_version, mapper_version, supersedes,
         created_at, updated_at)
       VALUES (@moveId, @queueId, @projectId, @position, @userId, @workspaceId, @runnerId,
         'queued', NULL, '{}', @appVersion, @mapperVersion, @supersedes, @at, @at)`,
    ).run({
      moveId: move.moveId,
      queueId: queue.queueId,
      projectId: move.projectId,
      position: move.position,
      userId: queue.userId,
      workspaceId: queue.workspaceId,
      runnerId: queue.runnerId,
      appVersion: options.appVersion,
      mapperVersion: options.mapperVersion,
      supersedes: move.supersedes ?? null,
      at,
    });
  };

  const write = (
    moveId: string,
    from: MoveState | null,
    to: MoveState | null,
    patch: MovePatch,
  ) => {
    const current = read(moveId);
    if (current === null || (from !== null && current.state !== from)) {
      throw new MoveStateConflictError(moveId, from ?? current?.state ?? "queued");
    }
    const journal =
      patch.journal === undefined ? current.journal : { ...current.journal, ...patch.journal };
    const pick = <K extends keyof MovePatch>(key: K, value: MoveRow[K & keyof MoveRow]) =>
      patch[key] === undefined ? value : patch[key];
    const result = prepared(
      db,
      `UPDATE cloud_moves SET state = @to, paused = @paused, journal_json = @journal,
         failure_json = @failure, report_json = @report, manifest_sha256 = @manifest,
         committed_at = @committedAt, confirmed_at = @confirmedAt, returned_at = @returnedAt,
         updated_at = @at
       WHERE move_id = @moveId AND state = @from`,
    ).run({
      moveId,
      from: current.state,
      to: to ?? current.state,
      paused: pick("paused", current.paused) ?? null,
      journal: JSON.stringify(journal),
      failure: JSON.stringify(pick("failure", current.failure) ?? null),
      report: JSON.stringify(pick("report", current.report) ?? null),
      manifest: pick("manifestSha256", current.manifestSha256) ?? null,
      committedAt: pick("committedAt", current.committedAt) ?? null,
      confirmedAt: pick("confirmedAt", current.confirmedAt) ?? null,
      returnedAt: pick("returnedAt", current.returnedAt) ?? null,
      at: now(),
    });
    if (result.changes !== 1) throw new MoveStateConflictError(moveId, current.state);
    return read(moveId)!;
  };

  return {
    createQueue(queue, moves) {
      const at = now();
      db.transaction(() => {
        prepared(
          db,
          `INSERT INTO cloud_move_queues (queue_id, user_id, workspace_id, runner_id,
             stop_at_first_problem, include_removed, profile_step, backup_json, state,
             created_at, updated_at)
           VALUES (@queueId, @userId, @workspaceId, @runnerId, @stop, @removed, @profileStep,
             @backup, @state, @at, @at)`,
        ).run({
          queueId: queue.queueId,
          userId: queue.userId,
          workspaceId: queue.workspaceId,
          runnerId: queue.runnerId,
          stop: queue.stopAtFirstProblem ? 1 : 0,
          removed: queue.includeRemoved ? 1 : 0,
          profileStep: queue.profileStep,
          backup: queue.backup === null ? null : JSON.stringify(queue.backup),
          state: queue.state,
          at,
        });
        for (const move of moves) insertMove(queue, move);
      })();
    },
    queue(queueId) {
      const row = prepared<[string], QueueDbRow>(
        db,
        "SELECT * FROM cloud_move_queues WHERE queue_id = ?",
      ).get(queueId);
      return row === undefined ? null : queueOf(row);
    },
    runningQueues() {
      return prepared<[], QueueDbRow>(
        db,
        "SELECT * FROM cloud_move_queues WHERE state = 'running' ORDER BY created_at, queue_id",
      )
        .all()
        .map(queueOf);
    },
    setQueue(queueId, patch) {
      const current = this.queue(queueId);
      if (current === null) throw new Error(`Move queue ${queueId} does not exist.`);
      prepared(
        db,
        `UPDATE cloud_move_queues SET state = @state, backup_json = @backup,
           profile_step = @profileStep, runner_id = @runnerId, updated_at = @at
         WHERE queue_id = @queueId`,
      ).run({
        queueId,
        runnerId: patch.runnerId ?? current.runnerId,
        state: patch.state ?? current.state,
        backup: JSON.stringify(patch.backup === undefined ? current.backup : patch.backup),
        profileStep: patch.profileStep ?? current.profileStep,
        at: now(),
      });
    },
    move: read,
    liveMove(projectId) {
      const row = prepared<[string], MoveDbRow>(
        db,
        `SELECT * FROM cloud_moves WHERE project_id = ?
           AND state NOT IN ('rolled_back', 'returned', 'superseded')`,
      ).get(projectId);
      return row === undefined ? null : moveOf(row);
    },
    moves(queueId) {
      return prepared<[string], MoveDbRow>(
        db,
        "SELECT * FROM cloud_moves WHERE queue_id = ? ORDER BY position, created_at",
      )
        .all(queueId)
        .map(moveOf);
    },
    movesIn(states) {
      if (states.length === 0) return [];
      return (
        db
          .prepare(
            `SELECT * FROM cloud_moves WHERE state IN (${states.map(() => "?").join(", ")})
              ORDER BY created_at, move_id`,
          )
          .all(...states) as MoveDbRow[]
      ).map(moveOf);
    },
    addMove(queueId, move) {
      const queue = this.queue(queueId);
      if (queue === null) throw new Error(`Move queue ${queueId} does not exist.`);
      insertMove(queue, move);
    },
    advance(moveId, from, to, patch = {}) {
      return write(moveId, from, to, patch);
    },
    patch(moveId, patch) {
      return write(moveId, null, null, patch);
    },
  };
}
