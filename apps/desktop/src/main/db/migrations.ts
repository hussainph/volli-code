/**
 * Hand-rolled migration runner (`PRAGMA user_version`, no ORM): each pending
 * migration runs in its own transaction that also bumps `user_version`, and
 * migrating an existing (non-fresh) database — `user_version > 0` — first
 * checkpoints the WAL and copies the db file to `<dbPath>.backup-v<from>`,
 * so a bad migration never destroys the pre-migration data. A brand-new
 * database (`user_version` starts at `0`) skips the backup step — there is
 * nothing to protect yet.
 */
import { copyFileSync } from "node:fs";
import type Database from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Migration 001: the full schema — see docs/CONCEPT.md decisions #28–#30. */
const MIGRATION_001_INITIAL_SCHEMA = `
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  path          TEXT NOT NULL UNIQUE,
  ticket_prefix TEXT NOT NULL,
  color_index   INTEGER NOT NULL,
  sort_order    INTEGER NOT NULL,
  row_version   INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE tickets (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ticket_number INTEGER NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL CHECK (status IN ('backlog','todo','doing','needs_review','done')),
  priority      TEXT NOT NULL CHECK (priority IN ('low','medium','high')),
  uses_worktree INTEGER NOT NULL DEFAULT 1,
  harness_id    TEXT NOT NULL,
  position      INTEGER NOT NULL,
  row_version   INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (project_id, ticket_number)
);
CREATE INDEX tickets_project_status ON tickets(project_id, status, position);

CREATE TABLE labels (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE ticket_labels (
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  label_id  TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_id, label_id)
);

CREATE TABLE ticket_events (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  actor      TEXT NOT NULL DEFAULT 'user',
  payload    TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX ticket_events_ticket ON ticket_events(ticket_id, created_at);

CREATE TABLE app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial schema", sql: MIGRATION_001_INITIAL_SCHEMA },
];

/** Applies every migration whose `version` is greater than the db's current `user_version`, in order. */
export function migrate(db: Database.Database, dbPath: string): void {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  const pending = MIGRATIONS.filter((migration) => migration.version > currentVersion).toSorted(
    (a, b) => a.version - b.version,
  );
  if (pending.length === 0) return;

  // Only an already-populated database needs a safety copy — a fresh
  // `user_version = 0` db has nothing pre-migration to protect.
  if (currentVersion > 0) {
    db.pragma("wal_checkpoint(TRUNCATE)");
    copyFileSync(dbPath, `${dbPath}.backup-v${currentVersion}`);
  }

  for (const migration of pending) {
    const applyMigration = db.transaction(() => {
      db.exec(migration.sql);
      // Interpolated, not bound: PRAGMA statements don't accept `?`
      // parameters, and `migration.version` is an internal integer literal
      // from MIGRATIONS above, never renderer-supplied input.
      db.pragma(`user_version = ${migration.version}`);
    });
    applyMigration();
  }
}
