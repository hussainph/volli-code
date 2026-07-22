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

/**
 * Migration 001: the v1 schema — see docs/CONCEPT.md decisions #28–#30. A
 * SNAPSHOT, not the current schema: applied migrations are immutable, so later
 * evolution lives in the migrations below it (002 adds `tickets.archived_at`
 * and replaces `tickets_project_status` with the two partial indexes).
 */
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

/**
 * Migration 002: ticket archival (CONCEPT #16/#92). `archived_at` (nullable
 * epoch ms) is the lifecycle marker, orthogonal to `status` — an archived
 * ticket keeps its column (Done stays Done) but leaves the board. It is NOT a
 * soft-delete flag smeared across every query: only the board reads filter it,
 * and they do so through a PARTIAL index that doesn't even contain archived
 * rows, so the hot path stays lean. The old full board index is replaced by
 * that partial one; a second partial index backs the on-demand Archive view.
 * The sole destructive act, delete-from-archive, is a real `DELETE` — no flag.
 */
const MIGRATION_002_TICKET_ARCHIVAL = `
ALTER TABLE tickets ADD COLUMN archived_at INTEGER;

DROP INDEX tickets_project_status;
CREATE INDEX tickets_board ON tickets(project_id, status, position)
  WHERE archived_at IS NULL;
CREATE INDEX tickets_archived ON tickets(project_id, archived_at)
  WHERE archived_at IS NOT NULL;
`;

/**
 * Migration 003: the ticket-detail MVP (docs/plans/ticket-detail-mvp.md,
 * decisions #14/#18/#22). Three additions, all additive/nullable — no
 * existing column is touched:
 *  - `sessions`: a durable trace + resume seed for a terminal session,
 *    distinct from its live in-memory PTY state. `ticket_id NULL` means a
 *    project-scoped scratch session (no board involvement); `ON DELETE
 *    CASCADE` off `project_id` and `ON DELETE SET NULL` off `ticket_id` mean
 *    a session outlives an archived-then-deleted ticket, purely as
 *    project-level history.
 *  - `ticket_comments`: the ticket's work log (content), kept separate from
 *    the append-only `ticket_events` audit trail; a comment also fires a
 *    `commented` event so it's discoverable from the event log without
 *    duplicating its body there. `session_id ON DELETE SET NULL` keeps an
 *    agent-posted comment after its session record is gone.
 *  - `tickets.worktree_path/branch/base_branch`: first-class worktree
 *    identity (vision anchor: worktrees are pure code isolation, settable
 *    now even though creation automation lands later). All three start
 *    `NULL` on every existing row.
 */
const MIGRATION_003_TICKET_DETAIL = `
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ticket_id          TEXT REFERENCES tickets(id) ON DELETE SET NULL,
  harness_id         TEXT NOT NULL,
  harness_session_id TEXT,
  title              TEXT NOT NULL,
  cwd                TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  ended_at           INTEGER
);
CREATE INDEX sessions_ticket ON sessions(ticket_id, created_at);
CREATE INDEX sessions_project ON sessions(project_id, created_at);

CREATE TABLE ticket_comments (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  actor      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX ticket_comments_ticket ON ticket_comments(ticket_id, created_at);

ALTER TABLE tickets ADD COLUMN worktree_path TEXT;
ALTER TABLE tickets ADD COLUMN branch TEXT;
ALTER TABLE tickets ADD COLUMN base_branch TEXT;
`;

/**
 * Migration 004: harness identity moves to sessions only. A ticket is no
 * longer itself bound to a single agent harness — `sessions.harness_id`
 * (added in migration 003) already records which harness drove each session,
 * and that's the only place harness identity belongs now. Drops the
 * now-unused `tickets.harness_id` column (SQLite's `ALTER TABLE ... DROP
 * COLUMN` is supported by the bundled better-sqlite3/SQLite build).
 */
const MIGRATION_004_DROP_TICKET_HARNESS = `
ALTER TABLE tickets DROP COLUMN harness_id;
`;

/**
 * Migration 005: a durable per-project ticket-number counter (found during
 * PR #34 review — commit 83a7298 introduced real hard-delete from the
 * archive). `nextTicketNumberForProject` used to be `MAX(ticket_number) + 1`
 * over the table's *remaining* rows, so deleting a project's highest-numbered
 * ticket freed its number: the next ticket created reused a dead ticket's
 * display id, and its worktree branch `volli/<PREFIX>-<n>-<slug>` could
 * collide with the deleted ticket's still-live worktree (worktrees are
 * archived, never deleted). `projects.next_ticket_number` fixes this — an
 * ever-increasing counter that only ever moves forward, bumped atomically
 * with every ticket insert, so a hard-delete can no longer roll it back.
 * `DEFAULT 1` covers every project created after this migration (its INSERT
 * never sets the column); the backfill below seeds it for every existing
 * project from its current tickets, so an upgrade never hands out a number
 * already used by a live, archived, or since-deleted row.
 */
const MIGRATION_005_TICKET_NUMBER_COUNTER = `
ALTER TABLE projects ADD COLUMN next_ticket_number INTEGER NOT NULL DEFAULT 1;

UPDATE projects
   SET next_ticket_number = (
     SELECT COALESCE(MAX(t.ticket_number), 0) + 1
       FROM tickets t
      WHERE t.project_id = projects.id
   );
`;

/**
 * Migration 006: truthful session-history metadata. Before this migration a
 * bare shell (including every split) inherited `claude-code` as its
 * `harness_id`, so the ticket rail presented every terminal as Claude Code.
 * `launch_kind` separates agent launches from shells; `placement` records the
 * renderer intent (top-level tab or split). Existing rows are deliberately
 * `unknown` for both fields because their original launch/layout intent cannot
 * be reconstructed safely from the old columns.
 */
const MIGRATION_006_SESSION_METADATA = `
ALTER TABLE sessions ADD COLUMN launch_kind TEXT NOT NULL DEFAULT 'unknown'
  CHECK (launch_kind IN ('agent','shell','unknown'));
ALTER TABLE sessions ADD COLUMN placement TEXT NOT NULL DEFAULT 'unknown'
  CHECK (placement IN ('tab','split','unknown'));
`;

/**
 * Migration 007: execution preferences from the agent-surface contract. The
 * preferred harness is distinct from durable session identity: it chooses a
 * future kickoff default, while each actual run still records its harness on
 * `sessions`. A nullable project base branch pins automation independently of
 * whichever branch the root checkout happens to have active.
 */
const MIGRATION_007_EXECUTION_PREFERENCES = `
ALTER TABLE tickets ADD COLUMN preferred_harness_id TEXT NOT NULL DEFAULT 'claude-code';
ALTER TABLE projects ADD COLUMN base_branch TEXT;
`;

/**
 * Migration 008: per-project worktree setup command (worktree-support §6/§8).
 * When set, `projects.setup_command` is typed into a fresh ticket worktree's
 * terminal — sentinel-gated (`worktree/setup.ts`) — before the harness command
 * runs, so a checkout is prepared (deps installed, env built) in-band with the
 * session it belongs to. Nullable and set independently of durable session
 * identity, mirroring the `base_branch` precedent (migration 007): a project
 * that never configures one simply skips the setup phase. Additive; every
 * existing row starts `NULL`.
 */
const MIGRATION_008_WORKTREE_SETUP = `
ALTER TABLE projects ADD COLUMN setup_command TEXT;
`;

/**
 * Migration 009: durable pull-request truth (done-flow §"Persistence, IPC,
 * events", decision #5). `tickets.pr_url` (nullable) records the draft PR the
 * push flow opened — or re-discovered — for the ticket's branch. It is the
 * foundation the merge-watch (#76) and Archive (#16) features build on and the
 * value the Details rail's "Open PR" affordance reads. Additive and nullable,
 * like the migration-003 worktree identity it sits beside; every existing row
 * starts `NULL`.
 */
const MIGRATION_009_TICKET_PR_URL = `
ALTER TABLE tickets ADD COLUMN pr_url TEXT;
`;

/**
 * Migration 010: the retention "Keep" pin (CONCEPT #16, issue #76).
 * `tickets.retention_keep` (0/1, default 0) is an EXPLICIT per-ticket exemption
 * from BOTH retention paths — the PR-merge archive prompt AND the Done-TTL sweep
 * (Vibe Kanban's source-verified bug is a TTL sweep that ignores its own pinned
 * flag; the keep pin here must be honored by both). Unlike the transient
 * merge/conflict/archive-ready state (computed, never stored — decision #42),
 * the pin is durable user intent, so it is a real column. Additive; every
 * existing row starts `0` (not kept).
 */
const MIGRATION_010_RETENTION_KEEP = `
ALTER TABLE tickets ADD COLUMN retention_keep INTEGER NOT NULL DEFAULT 0;
`;

/**
 * Migration 011: ticket attachments (issue #77). `ticket_attachments` is spec
 * material — a file or URL — attached to a ticket, materialized into the
 * agent's worktree at session boot (a later PR; this migration is storage
 * only). One row shape covers both variants (`kind` discriminates, like
 * `ticket_comments`' single-table shape): a `file` row sets `file_name` (the
 * original basename, bytes stored separately under Electron `userData` —
 * `apps/desktop/src/main/attachment-store.ts`) and leaves `url` NULL; a `url`
 * row sets `url` and leaves `file_name` NULL. `label` is always non-empty —
 * the repo layer defaults it before insert and the CHECK enforces it at rest.
 * `ON DELETE CASCADE` off `ticket_id` mirrors `ticket_comments`: an
 * attachment cannot outlive its ticket.
 */
const MIGRATION_011_TICKET_ATTACHMENTS = `
CREATE TABLE ticket_attachments (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('file','url')),
  label      TEXT NOT NULL CHECK (label <> ''),
  file_name  TEXT,
  url        TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ticket_attachments_ticket ON ticket_attachments(ticket_id);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial schema", sql: MIGRATION_001_INITIAL_SCHEMA },
  { version: 2, name: "ticket archival", sql: MIGRATION_002_TICKET_ARCHIVAL },
  {
    version: 3,
    name: "ticket detail: sessions, comments, worktree identity",
    sql: MIGRATION_003_TICKET_DETAIL,
  },
  {
    version: 4,
    name: "drop tickets.harness_id — harness identity lives on sessions only",
    sql: MIGRATION_004_DROP_TICKET_HARNESS,
  },
  {
    version: 5,
    name: "projects.next_ticket_number — monotonic ticket-number counter",
    sql: MIGRATION_005_TICKET_NUMBER_COUNTER,
  },
  {
    version: 6,
    name: "sessions launch-kind and placement metadata",
    sql: MIGRATION_006_SESSION_METADATA,
  },
  {
    version: 7,
    name: "ticket harness and project base-branch execution preferences",
    sql: MIGRATION_007_EXECUTION_PREFERENCES,
  },
  {
    version: 8,
    name: "projects.setup_command — per-project worktree setup command",
    sql: MIGRATION_008_WORKTREE_SETUP,
  },
  {
    version: 9,
    name: "tickets.pr_url — durable draft-PR url for the Done flow",
    sql: MIGRATION_009_TICKET_PR_URL,
  },
  {
    version: 10,
    name: "tickets.retention_keep — per-ticket retention Keep pin",
    sql: MIGRATION_010_RETENTION_KEEP,
  },
  {
    version: 11,
    name: "ticket_attachments — file/url attachments on a ticket",
    sql: MIGRATION_011_TICKET_ATTACHMENTS,
  },
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
