import type Database from "better-sqlite3";

/**
 * Runner-local paths and identity provenance only. No foreign keys to the
 * frozen board: cloud resources need not have a local product row. Older
 * readers ignore these tables; the minimum-reader floor stays unchanged.
 */
const RUNNER_PATH_TABLES = `
CREATE TABLE IF NOT EXISTS project_checkout_paths (
  project_repo_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  abs_path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('main', 'managed_clone')),
  adopted_from_frozen INTEGER NOT NULL DEFAULT 0 CHECK (adopted_from_frozen IN (0, 1)),
  PRIMARY KEY (runner_id, project_repo_id)
);
CREATE TABLE IF NOT EXISTS working_copy_paths (
  working_copy_id TEXT,
  ticket_id TEXT NOT NULL,
  project_repo_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  abs_path TEXT NOT NULL,
  adopted_from_frozen INTEGER NOT NULL DEFAULT 0 CHECK (adopted_from_frozen IN (0, 1)),
  branch TEXT,
  base_branch TEXT,
  head_sha TEXT,
  kind TEXT NOT NULL DEFAULT 'worktree' CHECK (kind IN ('worktree', 'main_checkout')),
  PRIMARY KEY (runner_id, ticket_id, project_repo_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS working_copy_paths_identity
  ON working_copy_paths(runner_id, working_copy_id) WHERE working_copy_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS cloud_shadow_rows (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
`;

const WORKING_COPY_KIND_COLUMN =
  "ALTER TABLE working_copy_paths ADD COLUMN kind TEXT NOT NULL DEFAULT 'worktree' CHECK (kind IN ('worktree', 'main_checkout'));";
const JOB_JOURNAL_OWNER_COLUMN = "ALTER TABLE job_journal ADD COLUMN owner_user_id TEXT;";
export const RUNNER_PATHS_MIGRATION = RUNNER_PATH_TABLES + JOB_JOURNAL_OWNER_COLUMN;

/** Probe-gated so a re-offered lineage can apply the expansion safely. */
export function applyRunnerPathsMigration(db: Database.Database): void {
  db.exec(RUNNER_PATH_TABLES);
  const copyColumns = db.pragma("table_info(working_copy_paths)") as { name: string }[];
  if (!copyColumns.some(({ name }) => name === "kind")) db.exec(WORKING_COPY_KIND_COLUMN);
  const columns = db.pragma("table_info(job_journal)") as { name: string }[];
  if (!columns.some(({ name }) => name === "owner_user_id")) db.exec(JOB_JOURNAL_OWNER_COLUMN);
}
