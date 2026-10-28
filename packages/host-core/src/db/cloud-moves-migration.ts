/**
 * VC-993: expand-only. The journal of "Move to Volli Cloud", runner-local
 * machine state (no board or Session rows):
 *
 * - `cloud_move_queues`: one "Move all" (or single-project) run: who moves,
 *   into which Workspace, from which of their runners, whether it stops at
 *   the first problem, the profile step and the verified backup it reuses.
 * - `cloud_moves`: one row per project move, the step it last completed
 *   (`state`), why it is waiting (`paused`), its resumable progress
 *   (`journal_json`) and its content-free failure and report. A row in a
 *   frozen state is the project's freeze marker: the board and Session write
 *   paths refuse while it holds (`cloud-move/freeze.ts`). Deleting nothing
 *   unfreezes it; the engine moves the row to a state outside the set.
 *
 * At most one live move per project (the partial unique index). No foreign
 * keys: a journal row outlives whatever it names. No older reader knows
 * these tables and none needs to: an N−1 build ignores the freeze (D11).
 */
export const CLOUD_MOVES_MIGRATION = `
CREATE TABLE IF NOT EXISTS cloud_move_queues (
  queue_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  stop_at_first_problem INTEGER NOT NULL CHECK (stop_at_first_problem IN (0, 1)),
  include_removed INTEGER NOT NULL CHECK (include_removed IN (0, 1)),
  profile_step TEXT NOT NULL CHECK (profile_step IN ('pending', 'done', 'skipped')),
  backup_json TEXT CHECK (backup_json IS NULL OR json_valid(backup_json)),
  state TEXT NOT NULL CHECK (state IN ('running', 'stopped', 'done')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cloud_moves (
  move_id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'frozen', 'exported', 'reserved', 'staged', 'objects', 'rows', 'history',
    'verified', 'committed', 'handed_over', 'checked', 'confirmed',
    'rolling_back', 'rolled_back', 'returning', 'returned', 'superseded'
  )),
  paused TEXT,
  journal_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(journal_json)),
  failure_json TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
  report_json TEXT CHECK (report_json IS NULL OR json_valid(report_json)),
  app_version TEXT NOT NULL,
  mapper_version INTEGER NOT NULL,
  manifest_sha256 TEXT,
  supersedes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  committed_at INTEGER,
  confirmed_at INTEGER,
  returned_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS cloud_moves_live_project ON cloud_moves(project_id)
  WHERE state NOT IN ('rolled_back', 'returned', 'superseded');
CREATE INDEX IF NOT EXISTS cloud_moves_queue ON cloud_moves(queue_id, position);
`;
