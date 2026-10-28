/**
 * The freeze: a project with a move in a frozen state takes no board or
 * Session write on this Mac. The marker is the move's own journal row
 * (`cloud_moves`), so no board row is ever edited to freeze a project, and
 * moving the row out of the frozen states (roll back, go back to local) is
 * the whole of unfreezing it.
 *
 * The write paths that ask: the board's commands (`board/commands.ts`), the
 * ticket commands every other door shares (`ticket-commands.ts`), the Session
 * engine's create and submit (`session-services.ts`) and a Session's start
 * and every turn's reaffirm (`session-runtime/location.ts`). Reads are never
 * refused: the frozen project stays fully readable.
 *
 * An N−1 build does not know the table and ignores the freeze (D11).
 */
import type Database from "better-sqlite3";

import { prepared } from "../db/prepared";
import { FROZEN_STATES, type MoveState } from "./states";

const FROZEN_LIST = [...FROZEN_STATES].map((state) => `'${state}'`).join(", ");

/** Why a frozen project refused a write. */
export class ProjectFrozenError extends Error {
  readonly code = "project_moving";
  readonly projectId: string;
  readonly state: MoveState;

  constructor(projectId: string, state: MoveState) {
    super(
      state === "confirmed"
        ? "This project moved to Volli Cloud. Its copy on this Mac is read-only."
        : "This project is moving to Volli Cloud. It is read-only until the move finishes or is rolled back.",
    );
    this.name = "ProjectFrozenError";
    this.projectId = projectId;
    this.state = state;
  }
}

/** Whether the journal table exists: a database migrated before it has no freeze. */
function hasJournal(db: Database.Database): boolean {
  return (
    prepared<[], { name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cloud_moves'",
    ).get() !== undefined
  );
}

/** The frozen move holding `projectId`, or null when the project is writable. */
export function projectFreeze(db: Database.Database, projectId: string): MoveState | null {
  if (!hasJournal(db)) return null;
  const row = prepared<[string], { state: MoveState }>(
    db,
    `SELECT state FROM cloud_moves WHERE project_id = ? AND state IN (${FROZEN_LIST}) LIMIT 1`,
  ).get(projectId);
  return row?.state ?? null;
}

/** Refuses a write to a frozen project. */
export function assertProjectWritable(db: Database.Database, projectId: string): void {
  const state = projectFreeze(db, projectId);
  if (state !== null) throw new ProjectFrozenError(projectId, state);
}

/** Refuses a write to a Session of a frozen project. An unknown Session is left to its caller. */
export function assertSessionWritable(db: Database.Database, sessionId: string): void {
  const row = prepared<[string], { project_id: string }>(
    db,
    "SELECT project_id FROM sessions WHERE id = ?",
  ).get(sessionId);
  if (row !== undefined) assertProjectWritable(db, row.project_id);
}
