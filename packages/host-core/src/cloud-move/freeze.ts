/**
 * The freeze: a project with a move in a frozen state takes no board or
 * Session write on this Mac. The marker is the move's own journal row
 * (`cloud_moves`), so no board row is ever edited to freeze a project, and
 * moving the row out of the frozen states (roll back, go back to local) is
 * the whole of unfreezing it.
 *
 * The write paths that ask, and nothing else: the board's commands
 * (`board/commands.ts`) and the ticket commands every other door shares
 * (`ticket-commands.ts`); the Session engine's create and submit
 * (`session-services.ts`: stopping work always passes, and so does a write
 * Volli Cloud claims once the project is shown there,
 * {@link cloudClaimsSessionWrite}); the Automation service's edits and the
 * MCP settings writes; project remove and relink; and the pull-request poll
 * and worktree reclaim. Reads are never refused: the frozen project stays
 * fully readable.
 *
 * The check runs before the write's own transaction, not inside it: one
 * process writes the profile, and a move freezes only after a project is
 * idle, so nothing can start between the two (a cross-process writer would
 * need it inside; tracked with the MCP settings gate, VC-1008).
 *
 * An N−1 build does not know the table and ignores the freeze.
 */
import type Database from "better-sqlite3";

import { sessionBirthOwnerCompatible } from "../db/local-product";
import { prepared } from "../db/prepared";
import { COMMITTED_STATES, FROZEN_STATES, type MoveState } from "./states";

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

/** The signed-in owner a cloud launch serves on this profile, by database handle. */
const cloudOwners = new WeakMap<Database.Database, string>();

/**
 * Names the person a cloud launch serves on this profile (`null`: none, a
 * local launch). Only their Sessions can be Volli Cloud's writes here
 * ({@link cloudClaimsSessionWrite}); a local launch has no claims at all, so
 * a moved Session never resumes from the archived local copy. Called by the
 * cloud product store as it composes its Session owner.
 */
export function bindCloudSessionOwner(db: Database.Database, ownerUserId: string | null): void {
  if (ownerUserId === null) cloudOwners.delete(db);
  else cloudOwners.set(db, ownerUserId);
}

/**
 * Whether a cloud launch here serves the person a moved project now belongs
 * to: the person bound ({@link bindCloudSessionOwner}) is the one who moved
 * it, and the move has committed. Then the project on this Mac is the cloud
 * project's working state (its runner-local configuration, such as MCP
 * servers, included), not the frozen local copy. A local launch, a launch
 * for someone else, or a move that has not committed answers false.
 */
export function cloudServesProject(db: Database.Database, projectId: string): boolean {
  const owner = cloudOwners.get(db);
  if (owner === undefined || !hasJournal(db)) return false;
  const row = prepared<[string], { state: MoveState; user_id: string }>(
    db,
    `SELECT state, user_id FROM cloud_moves WHERE project_id = ? AND state IN (${FROZEN_LIST}) LIMIT 1`,
  ).get(projectId);
  return row !== undefined && COMMITTED_STATES.has(row.state) && row.user_id === owner;
}

/** A Session write the freeze is asked about: a birth in a project, or a write to a Session. */
export type SessionWrite =
  | { kind: "birth"; projectId: string; ownerUserId: string | undefined }
  | { kind: "session"; sessionId: string };

/**
 * Whether a Session write is Volli Cloud's, not the local product's, so the
 * freeze does not hold it. A moved project keeps its ids: once Volli Cloud
 * shows it, its Sessions sit in the same project id here but belong to the
 * cloud project, which this Mac's runner serves for the signed-in person.
 *
 * All three must hold:
 * - the project's move has committed (`COMMITTED_STATES`: shown in Volli
 *   Cloud, handed over, checked, finished). While it moves, rolls back or
 *   goes back to local, every write but a stop is held;
 * - a cloud launch serves someone here ({@link bindCloudSessionOwner});
 * - the write is theirs: a birth whose request names them, or a Session
 *   whose drain cursor is theirs and whose birth names no one else.
 */
export function cloudClaimsSessionWrite(db: Database.Database, write: SessionWrite): boolean {
  const owner = cloudOwners.get(db);
  if (owner === undefined) return false;
  const projectId =
    write.kind === "birth"
      ? write.projectId
      : prepared<[string], { project_id: string }>(
          db,
          "SELECT project_id FROM sessions WHERE id = ?",
        ).get(write.sessionId)?.project_id;
  if (projectId === undefined) return false;
  const state = projectFreeze(db, projectId);
  if (state === null || !COMMITTED_STATES.has(state)) return false;
  if (write.kind === "birth") return write.ownerUserId === owner;
  return (
    prepared<[{ sessionId: string; owner: string }], { id: string }>(
      db,
      `SELECT session_id AS id FROM session_drain_cursors
        WHERE session_id = @sessionId AND owner_user_id = @owner
          AND ${sessionBirthOwnerCompatible("session_drain_cursors.session_id", "@owner")}`,
    ).get({ sessionId: write.sessionId, owner }) !== undefined
  );
}

/**
 * Refuses a local product write to a Session of a frozen project. A Session
 * the cloud claims ({@link cloudClaimsSessionWrite}) and an unknown Session
 * are left to their callers.
 */
export function assertSessionWritable(db: Database.Database, sessionId: string): void {
  if (cloudClaimsSessionWrite(db, { kind: "session", sessionId })) return;
  const row = prepared<[string], { project_id: string }>(
    db,
    "SELECT project_id FROM sessions WHERE id = ?",
  ).get(sessionId);
  if (row !== undefined) assertProjectWritable(db, row.project_id);
}
