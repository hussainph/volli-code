/**
 * Hand-rolled migration runner (`PRAGMA user_version`, no ORM): all pending
 * migrations run in one transaction that also bumps `user_version`, and
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
 *    Project Session (no board involvement); `ON DELETE
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

/**
 * Migration 012: `sessions.exit_code` — the shell's exit code, stamped by the
 * PTY exit path in the same transaction as `ended_at`. Backs the sidebar's
 * honest outcome labels for concluded sessions ("Done"/"Failed" only when the
 * code was actually observed). NULL while live, for boot-sweep ends (the
 * process outcome was never seen), and for every historical row — readers must
 * treat NULL as "unknown", never as success.
 */
const MIGRATION_012_SESSION_EXIT_CODE = `
ALTER TABLE sessions ADD COLUMN exit_code INTEGER;
`;

/**
 * Migration 013: per-project theming (decisions #69/#72). Four nullable columns
 * on `projects`, one per surface plus the auto-tint seed — additive, every
 * existing row starts `NULL`, and `NULL` means *inherit the global theme*,
 * which is what makes "per-project theming is off by default" (#72) the
 * literal storage state rather than a UI convention.
 *
 * Deliberately FOUR columns rather than one JSON blob: resolution is per
 * surface, never per token (#69), so "what is overridden" must be answerable
 * by looking at the row. It also keeps a future `WHERE theme_app_slug IS NOT
 * NULL` sweep (find every project that overrides the app surface) an index-able
 * question instead of a JSON scan.
 *
 * What is NOT here: the resolved token set. `{global theme, project override}`
 * is authoritative and the tokens are derived at render time — VS Code's
 * most-complained-about theming bug is auto-switching persisting the resolved
 * theme over the user's authored intent. The global half lives in `app_state`
 * under the `theme` key (see `db/theme-repo.ts`), not in a column here.
 */
const MIGRATION_013_PROJECT_THEME_OVERRIDE = `
ALTER TABLE projects ADD COLUMN theme_app_slug TEXT;
ALTER TABLE projects ADD COLUMN theme_terminal_name TEXT;
ALTER TABLE projects ADD COLUMN theme_editor_id TEXT;
ALTER TABLE projects ADD COLUMN theme_seed TEXT;
`;

/**
 * Migration 014: per-project canvas + appearance (docs/plans/arc-theming-migration.md).
 * Two nullable columns, replacing what 013's four columns meant rather than
 * what they held: a project now overrides the CANVAS (the authored gradient)
 * and/or the APPEARANCE, independently, and `NULL` still means *inherit*.
 *
 * Three shapes worth naming, because each one is a road not taken:
 *
 *  - **`theme_canvas` is JSON, where 013 deliberately used flat columns.** A
 *    canvas is a gradient — a variable-length list of `{hex, x, y}` stops plus
 *    two scalars — so there is no column set that describes it, and no
 *    `WHERE theme_canvas = ?` question anyone asks. 013's argument (per-surface
 *    resolution must be answerable from the row) does not apply: the canvas
 *    resolves whole or not at all.
 *  - **There is no `canvases` table.** One canvas per scope, edited in place;
 *    a named, reusable library was considered and rejected. Nothing here
 *    references a row elsewhere, so a project's canvas cannot be orphaned or
 *    shared into a surprise.
 *  - **013's four columns stay.** SQLite's `DROP COLUMN` is unavailable on the
 *    versions this ships against, and the export document carries every
 *    `projects` column by construction (`db/export.ts`), so dropping them is
 *    neither safe nor free. They stop being READ (see `projects-repo.ts`) —
 *    dead data, not live data, which is decision 7's "reset to Ember, no
 *    seed→canvas conversion" expressed in the schema.
 *
 * The `CHECK` follows `tickets.status`'s precedent: the appearance vocabulary
 * is closed, and a hand-edited db that says `theme_appearance = 'sepia'` should
 * fail at the write, not paint something arbitrary three layers up. SQLite does
 * not re-validate existing rows when a checked column is added, which is exactly
 * right here — every existing row gets `NULL`, which the check admits.
 */
const MIGRATION_014_PROJECT_CANVAS = `
ALTER TABLE projects ADD COLUMN theme_canvas TEXT;
ALTER TABLE projects ADD COLUMN theme_appearance TEXT
  CHECK (theme_appearance IS NULL OR theme_appearance IN ('light','dark','auto'));
`;

/**
 * Migration 015: the trust verdict for a registered harness (harness-events,
 * "Bring your own harness"). A manifest at
 * `~/.agents/harnesses/<slug>/harness.json` is the DECLARATION — the author's
 * file, editable at any moment, and no business of ours. What belongs here is
 * only what Volli itself decided about it.
 *
 * Which is why `manifest_sha256` is stored and the manifest's CONTENTS are not.
 * Mirroring command, argv and surfaces into columns would create a second copy
 * the author cannot edit, and "drop a file in and it works" would stop being
 * true the moment the two disagreed. The hash is enough to answer the only
 * question this table exists for: are these the bytes somebody actually ruled
 * on? Anything else is re-read from disk.
 *
 * `declared_events` and `verified_events` are both JSON arrays of canonical
 * event names, and the asymmetry between them is the point. Declared is a claim
 * and gates nothing; verified is a fact, written on first real delivery, and it
 * alone drives automatic board moves and notifications. A verdict recorded
 * against new bytes resets verified, because the old evidence was about a
 * command line that no longer exists.
 *
 * No `harness_id` foreign key anywhere: a slug is registered here BEFORE any
 * session has ever used it, and sessions keep their `harness_id` as free text
 * (migration 003) precisely so an unregistered harness still records history.
 *
 * Deliberately absent from `db/export.ts`, which otherwise carries every table:
 * a verdict is a decision about the files on THIS machine, and permission to
 * execute a command line is not something an export document should carry.
 */
const MIGRATION_015_REGISTERED_HARNESSES = `
CREATE TABLE registered_harnesses (
  slug            TEXT PRIMARY KEY,
  manifest_path   TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  decision        TEXT NOT NULL CHECK (decision IN ('trusted','blocked')),
  declared_events TEXT NOT NULL DEFAULT '[]',
  verified_events TEXT NOT NULL DEFAULT '[]',
  decided_at      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
`;

/**
 * Migration 016: what is RUNNING in a session's terminal, beside what that
 * session was launched with.
 *
 * `harness_id` is written once at INSERT and never updated, which is correct —
 * it is the launch, and the launch does not change. What was missing is the
 * other half: a terminal outlives the agent that opened it, so a user who quits
 * opencode and runs claude in the same pane leaves the row describing a process
 * that is gone. Additive and nullable rather than a rewrite of `harness_id`,
 * because both facts are wanted and `NULL` is the honest state of every row that
 * predates the announce — nothing has said what it is running, so the launch
 * harness remains the best available answer.
 */
const MIGRATION_016_SESSION_ACTIVE_HARNESS = `
ALTER TABLE sessions ADD COLUMN active_harness_id TEXT;
`;

/**
 * Migration 017: whether a harness's event channel is working *now*.
 *
 * `registered_harnesses.verified_events` (015) is monotonic on purpose — one
 * delivery pins a capability forever — which makes it structurally unable to
 * say that automation STOPPED working. A harness upgrade that renames a hook
 * field, a `volli doctor --fix` never run after a path change, a wrapper
 * removed by a dotfile sync: every one of those reads as perfectly healthy for
 * the rest of the install's life.
 *
 * So freshness gets its own two integers rather than a rewrite of a working
 * ledger. `last_launch_at` is stamped by the `session harness` announce — the
 * wrapper calling in one step before it execs, which is the only event that
 * proves Volli's configuration was in the loop; a PTY spawn would also count a
 * user running `/opt/homebrew/bin/claude` by hand and manufacture a false
 * accusation out of it. `last_event_at` is stamped by an arriving hook.
 *
 * No third column. The state — reporting / silent / unproven — is the
 * comparison of the two, computed at read time, and that is exactly what makes
 * it forget: a harness whose latest launch said nothing is silent on that
 * launch, whatever the previous hundred did. Storing the verdict would make it
 * monotonic again by the back door.
 *
 * Both columns are nullable and there is no row until something happens: a
 * harness nobody has launched has nothing to say about itself, and `NULL` is
 * that, distinct from zero.
 *
 * Absent from `db/export.ts` for migration 015's reason — this is an
 * observation about THIS machine's install, not domain data a document should
 * carry.
 */
const MIGRATION_017_HARNESS_CHANNEL = `
CREATE TABLE harness_channel (
  harness_id     TEXT PRIMARY KEY,
  last_launch_at INTEGER,
  last_event_at  INTEGER
);
`;

/**
 * Migration 018: Sessions become an identity-only durable ledger.
 *
 * Versions 003–017 treated a Session as a terminal row.  That made a PTY's
 * launch configuration, exit status, and the Session itself one mutable
 * thing.  The control plane now owns the latter as immutable facts; a terminal
 * is simply one attachment to that Session.  This is an explicitly authorised
 * pre-release reset, so old terminal-shaped rows and the ticket lifecycle
 * facts derived from them are removed rather than invented into a new history.
 * Planner rows, comment bodies, and every non-Session ticket fact survive.
 */
const MIGRATION_018_SESSION_LEDGER = `
-- A comment is planner content, not a Session fact.  Preserve it while
-- deliberately clearing legacy session provenance before the old table goes.
UPDATE ticket_comments SET session_id = NULL WHERE session_id IS NOT NULL;
DELETE FROM ticket_events
 WHERE kind IN (
   'session_started',
   'session_ended',
   'session_resumed',
   'sessions_interrupted',
   'session_signal'
 );

CREATE TABLE sessions_v18 (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ticket_id  TEXT REFERENCES tickets(id) ON DELETE SET NULL,
  title      TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE ticket_comments_v18 (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions_v18(id) ON DELETE SET NULL,
  actor      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO ticket_comments_v18 (id, ticket_id, session_id, actor, body, created_at, updated_at)
  SELECT id, ticket_id, NULL, actor, body, created_at, updated_at
    FROM ticket_comments;
DROP TABLE ticket_comments;
DROP TABLE sessions;
ALTER TABLE sessions_v18 RENAME TO sessions;
ALTER TABLE ticket_comments_v18 RENAME TO ticket_comments;
CREATE INDEX ticket_comments_ticket ON ticket_comments(ticket_id, created_at);

CREATE INDEX sessions_project_created ON sessions(project_id, created_at DESC, id DESC);
CREATE INDEX sessions_ticket_created ON sessions(ticket_id, created_at DESC, id DESC);

CREATE TABLE session_attachments (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  adapter_id         TEXT NOT NULL CHECK (adapter_id <> ''),
  venue_id           TEXT NOT NULL CHECK (venue_id <> ''),
  venue_kind         TEXT NOT NULL CHECK (venue_kind IN ('local','cloud','remote','unknown')),
  continuity         TEXT NOT NULL CHECK (continuity IN ('fresh','native_resume','context_replay','recreate')),
  native_id          TEXT,
  native_detail      TEXT CHECK (native_detail IS NULL OR json_valid(native_detail)),
  observed_kind      TEXT NOT NULL CHECK (observed_kind IN ('opened','failed')),
  failure            TEXT CHECK (failure IS NULL OR json_valid(failure)),
  created_sequence   INTEGER NOT NULL CHECK (created_sequence > 0),
  UNIQUE (session_id, id)
);
CREATE INDEX session_attachments_session ON session_attachments(session_id, created_sequence, id);

CREATE TABLE session_commands (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  intent     TEXT NOT NULL CHECK (json_valid(intent)),
  route      TEXT CHECK (route IS NULL OR json_valid(route)),
  UNIQUE (session_id, id)
);
CREATE INDEX session_commands_session ON session_commands(session_id, created_at, id);

CREATE TABLE session_events (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence      INTEGER NOT NULL CHECK (sequence > 0),
  occurred_at   INTEGER NOT NULL,
  recorded_at   INTEGER NOT NULL,
  provenance    TEXT NOT NULL CHECK (json_valid(provenance)),
  attachment_id TEXT,
  command_id    TEXT,
  payload       TEXT NOT NULL CHECK (json_valid(payload)),
  UNIQUE (session_id, sequence),
  UNIQUE (session_id, id),
  FOREIGN KEY (session_id, attachment_id)
    REFERENCES session_attachments(session_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (session_id, command_id)
    REFERENCES session_commands(session_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX session_events_session_sequence ON session_events(session_id, sequence);
CREATE INDEX session_events_command ON session_events(command_id);
CREATE INDEX session_events_attachment ON session_events(attachment_id);

CREATE TABLE session_command_receipts (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  command_id  TEXT NOT NULL REFERENCES session_commands(id) ON DELETE CASCADE,
  sequence    INTEGER NOT NULL CHECK (sequence > 0),
  recorded_at INTEGER NOT NULL,
  receipt     TEXT NOT NULL CHECK (json_valid(receipt)),
  receipt_event_id TEXT,
  UNIQUE (command_id, sequence),
  FOREIGN KEY (session_id, command_id)
    REFERENCES session_commands(session_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (session_id, receipt_event_id)
    REFERENCES session_events(session_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX session_receipts_command_sequence ON session_command_receipts(command_id, sequence);
CREATE INDEX session_receipts_session_sequence ON session_command_receipts(session_id, sequence);
`;

/**
 * Migration 019: per-project runtime preferences — the project half of what
 * `app_state` holds globally under `volli:runtime-preferences:<adapterId>`.
 * One nullable JSON column, `NULL` = inherit, taking 014's shape rather than
 * 013's flat columns for 014's reason: the payload is a map keyed by adapter id
 * whose values are variable-shaped blobs, so no column set describes it and
 * nobody asks `WHERE runtime_preferences = ?`.
 *
 * **The value under each adapter key is the FULL stored record** —
 * `{recordVersion, preferences, observedAt, models, agents}` — not the user's
 * intent alone, and that is the part worth writing down. `resolve` (in the
 * since-deleted `main/runtime-catalog.ts`) answered chat out of the stored
 * record and never discovered, and a global `save` pre-filtered `models` down
 * to the GLOBALLY enabled set. An override that stored intent alone would
 * therefore resolve
 * against a global snapshot that need not contain a model this project enabled
 * — the project's own chosen model missing from the project's own picker. That
 * is a wrong answer, not a degraded one. Carrying the snapshot the project's
 * save actually observed costs a few KB per project and makes the override
 * answerable on its own.
 *
 * The `CHECK` follows 014's `theme_appearance`: a column whose whole contract
 * is "this is JSON" should fail at the write, not several layers up inside a
 * parser that then has to invent a policy for the corpse.
 */
const MIGRATION_019_PROJECT_RUNTIME_PREFERENCES = `
ALTER TABLE projects ADD COLUMN runtime_preferences TEXT
  CHECK (runtime_preferences IS NULL OR json_valid(runtime_preferences));
`;

/**
 * Migration 020: Blobs (VC-50, `docs/plans/attachments.md`) — the bytes behind
 * every user-supplied file, and the links naming where each one is attached.
 * Replaces migration 011's `ticket_attachments`, which owned both at once:
 * ticket-keyed, id-keyed, no deduplication, and structurally unable to be
 * referenced from a chat message. Dropping it costs nothing — `createAttachment`
 * never had a caller, so the table has never held a row in any build that
 * shipped. (Vibe Kanban shipped that same owner-keyed shape and had to migrate
 * off it for exactly this reason; we get to skip the migration.)
 *
 * `blobs` is content-addressed: the sha256 IS the primary key, so re-attaching
 * a file the user has already attached is an INSERT OR IGNORE rather than a
 * second copy, and the file store needs no traversal guard beyond "is this a
 * hash". `width`/`height` are NULL for anything that is not an image we could
 * measure — readers must treat NULL as "unknown", never as zero.
 *
 * `blob_links` is the thin row naming where a Blob hangs: exactly one of
 * `ticket_id` (spec material on the Ticket) or `session_id` (a file handed to
 * the agent mid-chat), enforced by CHECK rather than convention. Two explicit
 * nullable owners, not a generic owner_kind/owner_id pair — there are two
 * surfaces, and a third should be a schema change somebody reviews rather than
 * a new string value that slips in. `ON DELETE CASCADE` on both owners and on
 * `blob_hash` mirrors `ticket_comments`: a link never outlives either end.
 *
 * Note what is NOT cascaded: deleting the last link to a Blob leaves the Blob
 * row and its bytes, to be collected deliberately. An attachment removed by a
 * misclick should not take the bytes with it while an undo is still plausible.
 */
const MIGRATION_020_BLOBS = `
CREATE TABLE blobs (
  hash          TEXT PRIMARY KEY CHECK (length(hash) = 64),
  mime          TEXT NOT NULL CHECK (mime <> ''),
  size_bytes    INTEGER NOT NULL CHECK (size_bytes >= 0),
  original_name TEXT NOT NULL CHECK (original_name <> ''),
  width         INTEGER,
  height        INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE TABLE blob_links (
  id         TEXT PRIMARY KEY,
  blob_hash  TEXT NOT NULL REFERENCES blobs(hash) ON DELETE CASCADE,
  ticket_id  TEXT REFERENCES tickets(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  label      TEXT NOT NULL CHECK (label <> ''),
  created_at INTEGER NOT NULL,
  CHECK ((ticket_id IS NULL) <> (session_id IS NULL))
);
CREATE INDEX idx_blob_links_ticket ON blob_links(ticket_id, created_at);
CREATE INDEX idx_blob_links_session ON blob_links(session_id, created_at);
CREATE INDEX idx_blob_links_blob ON blob_links(blob_hash);

DROP TABLE ticket_attachments;
`;

/**
 * Migration 021: the two homes Web Access needs, deliberately apart.
 *
 * **`secrets` holds ciphertext and nothing else.** One row per named secret,
 * the name being Volli's own constant rather than anything a caller composes,
 * and the payload being whatever the OS keychain handed back through Electron's
 * `safeStorage`. It is its own table for one reason worth stating: the settings
 * beside it are read by surfaces that answer the renderer, and a secret sharing
 * their row is a secret one careless `SELECT *` puts on screen. Nothing here is
 * readable without the key material the OS holds, so a copied `volli.db` is not
 * a copied credential.
 *
 * (Migration 023 retired the ciphertext half of that: the payload is now the key
 * itself, and the reason this table is separate from `app_state` is the whole of
 * what keeps it off the renderer's wire. The paragraph above is left as written
 * because it is what this statement did on the day it ran.)
 *
 * **`app_state` was the obvious home for the settings and is the wrong one.**
 * Every row of it rides the `volli:data-bootstrap` payload to the renderer, and
 * `volli:app-state-set` lets the renderer write any key it likes with any string
 * it likes. A provider endpoint that could be written that way would be an
 * endpoint that never passed `admitSearchEndpoint`, which is the check that
 * makes a self-hosted URL safe to have at all. So the settings live in their own
 * main-owned table, reachable only through the validating channel.
 *
 * One row, pinned by the `id = 1` check: this is a profile-wide setting, and a
 * table that could hold two of them is a table someone has to write a
 * tie-breaker for.
 */
const MIGRATION_021_WEB_ACCESS = `
CREATE TABLE secrets (
  name       TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE web_access_settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  provider    TEXT NOT NULL CHECK (provider IN ('off', 'brave', 'searxng')),
  searxng_url TEXT,
  updated_at  INTEGER NOT NULL
);
`;

/**
 * Widen the provider CHECK to admit Exa.
 *
 * The table is rebuilt because SQLite cannot alter a CHECK constraint in place.
 * The constraint is kept rather than dropped: it is what stops a provider name
 * this version cannot resolve from being written, and the read side already
 * falls back to `off` for a name it does not know, so the two together mean a
 * downgrade reads Exa as Off instead of failing.
 *
 * Nothing here touches `secrets`. A key stored under `web-access.exa.api-key`
 * is its own row and survives independently of which provider is selected.
 */
const MIGRATION_022_WEB_ACCESS_EXA = `
CREATE TABLE web_access_settings_new (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  provider    TEXT NOT NULL CHECK (provider IN ('off', 'brave', 'searxng', 'exa')),
  searxng_url TEXT,
  updated_at  INTEGER NOT NULL
);

INSERT INTO web_access_settings_new (id, provider, searxng_url, updated_at)
  SELECT id, provider, searxng_url, updated_at FROM web_access_settings;

DROP TABLE web_access_settings;

ALTER TABLE web_access_settings_new RENAME TO web_access_settings;
`;

/**
 * Migration 024: per-project agent configuration (VC-111) — the Configure
 * surface's own three columns.
 *
 * 024, not the 023 it was written as: VC-158's keychain migration landed on
 * main first with that number, and a canary install that already ran it sits
 * at `user_version = 23` — renumbering THEIRS would have skipped the web-key
 * move on every such install. A dev profile that ran this branch's build
 * before the merge holds the agent-config schema AT 23 instead; for that one
 * database this migration fails on the duplicate column and the pre-migration
 * backup is the recovery, which is the acceptable cost on the lineage that
 * never shipped.
 *
 * Columns rather than an `app_state` blob keyed by project id, which is what
 * Model Access does globally and what this nearly became. The deciding
 * difference is ownership: these values describe ONE project and die with it,
 * and `app_state` has no foreign key, so a `volli:agent-config:<projectId>`
 * row would outlive the project it configured — a leak nothing ever collects,
 * and a stale answer waiting for the next project that happens to reuse the id.
 * On the row they cascade for free.
 *
 * `NULL` is inherit on all three, exactly as 013, 014 and 019 mean it, so a
 * project upgraded across this migration behaves precisely as it did before.
 *
 * The shapes:
 *  - `skill_modes` — a JSON object mapping a skill slug to `"manual"` or
 *    `"off"`. Only DEPARTURES are stored: an absent slug means the skill's own
 *    frontmatter decides, so a skill installed after this was last written is
 *    governed by its author rather than silently hidden — which is what an
 *    allow list would have done.
 *
 *    A map rather than the deny-list array this started as, because there are
 *    three states and the middle one is the valuable one. `manual` withholds a
 *    skill from the model's metadata index while leaving it invokable by name,
 *    and that index is ~94% of a fresh Session's Volli-composed prompt, re-sent
 *    as the stable prefix of every turn. A two-state switch could only ask
 *    "delete this?" when the question worth asking is "pay for this on every
 *    turn?".
 *  - `session_harness` — a harness id. Unconstrained by CHECK on purpose:
 *    harnesses are user-registrable (migration 015), so the legal set is a
 *    table, not a literal, and a CHECK here would refuse a harness the user
 *    installed.
 *  - `session_model` — a JSON `ModelSelection`. `json_valid` for 019's reason:
 *    a column whose whole contract is "this is JSON" should fail at the write
 *    rather than several layers up in a parser that then has to invent a
 *    policy for the corpse.
 */
const MIGRATION_024_PROJECT_AGENT_CONFIG = `
ALTER TABLE projects ADD COLUMN skill_modes TEXT
  CHECK (skill_modes IS NULL OR json_valid(skill_modes));
ALTER TABLE projects ADD COLUMN session_harness TEXT;
ALTER TABLE projects ADD COLUMN session_model TEXT
  CHECK (session_model IS NULL OR json_valid(session_model));
`;

/**
 * Migration 023: the two search keys stop being keychain material.
 *
 * `safeStorage` was the app's only tie to the macOS Keychain, and it guarded the
 * least sensitive secret Volli holds while producing its loudest interruption:
 * macOS binds a keychain item's ACL to the code identity that created it, so
 * every differently-signed build — a dev Electron, a local `release/`, an
 * updated `/Applications` copy — raised "Volli Code wants to access key … in
 * your keychain", on every Session attach, forever. Meanwhile the credentials
 * that actually matter (the provider OAuth tokens) sit in Pi's 0600
 * `~/.pi/agent/auth.json`, the same plain-file model opencode and Codex use.
 * This schema follows the secret that matters rather than the one that shouted.
 *
 * So `secrets.ciphertext BLOB` becomes `secrets.value TEXT`, holding the key as
 * typed. What is given up is the one property the ciphertext bought: a copied
 * `volli.db` is now a copied key. What is kept is the property that was doing
 * the work all along — this table is not `app_state`, so nothing here rides the
 * bootstrap payload to the renderer, and the file itself lives in a user-only
 * `Application Support` directory beside the auth.json that already made this
 * trade.
 *
 * The old rows are moved rather than dropped, because only `safeStorage` can
 * open them and only the machine that wrote them can ask it to. They wait in
 * `legacy_safe_storage_secrets` for exactly one attempt at that
 * (`web/legacy-safe-storage.ts`), which is also the last time this app touches a
 * keychain. The table is named for what it is so the next reader does not have
 * to guess why a second secrets table exists; it empties itself and is expected
 * to stay empty. The user's "Volli Code Safe Storage" keychain item is left
 * alone — another profile may still be using it, and deleting a keychain entry
 * is not this migration's business.
 */
const MIGRATION_023_WEB_KEYS_LEAVE_THE_KEYCHAIN = `
CREATE TABLE legacy_safe_storage_secrets (
  name       TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO legacy_safe_storage_secrets (name, ciphertext, updated_at)
  SELECT name, ciphertext, updated_at FROM secrets;

DROP TABLE secrets;

CREATE TABLE secrets (
  name       TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
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
  {
    version: 12,
    name: "sessions.exit_code — observed shell exit code for concluded sessions",
    sql: MIGRATION_012_SESSION_EXIT_CODE,
  },
  {
    version: 13,
    name: "projects theme override — per-surface app/terminal/editor slugs + auto-tint seed",
    sql: MIGRATION_013_PROJECT_THEME_OVERRIDE,
  },
  {
    version: 14,
    name: "projects theme canvas + appearance — the per-project half of the Arc canvas",
    sql: MIGRATION_014_PROJECT_CANVAS,
  },
  {
    version: 15,
    name: "registered_harnesses — the trust verdict and event ledger for a manifest",
    sql: MIGRATION_015_REGISTERED_HARNESSES,
  },
  {
    version: 16,
    name: "sessions.active_harness_id — the harness actually running, beside the launch one",
    sql: MIGRATION_016_SESSION_ACTIVE_HARNESS,
  },
  {
    version: 17,
    name: "harness_channel — is this harness's event channel working right now",
    sql: MIGRATION_017_HARNESS_CHANNEL,
  },
  {
    version: 18,
    name: "session control plane ledger — terminal attachments are evidence, not Session state",
    sql: MIGRATION_018_SESSION_LEDGER,
  },
  {
    version: 19,
    name: "projects.runtime_preferences — the per-project override of the global runtime record",
    sql: MIGRATION_019_PROJECT_RUNTIME_PREFERENCES,
  },
  {
    version: 20,
    name: "blobs + blob_links — content-addressed attachment bytes, replacing ticket_attachments",
    sql: MIGRATION_020_BLOBS,
  },
  {
    version: 21,
    name: "web access — the BYO search provider setting, and ciphertext kept apart from it",
    sql: MIGRATION_021_WEB_ACCESS,
  },
  {
    version: 22,
    name: "web access — Exa as a second keyed search provider",
    sql: MIGRATION_022_WEB_ACCESS_EXA,
  },
  {
    version: 23,
    name: "web access — search keys leave the OS keychain for the profile's own store",
    sql: MIGRATION_023_WEB_KEYS_LEAVE_THE_KEYCHAIN,
  },
  {
    version: 24,
    name: "projects agent config — the per-project skills, harness and model Configure writes",
    sql: MIGRATION_024_PROJECT_AGENT_CONFIG,
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

  const applyPendingMigrations = db.transaction(() => {
    for (const migration of pending) {
      db.exec(migration.sql);
      // Interpolated, not bound: PRAGMA statements don't accept `?`
      // parameters, and `migration.version` is an internal integer literal
      // from MIGRATIONS above, never renderer-supplied input.
      db.pragma(`user_version = ${migration.version}`);
    }

    const foreignKeyViolations = db.pragma("foreign_key_check") as unknown[];
    if (foreignKeyViolations.length > 0) {
      throw new Error(
        `Foreign-key check failed after migrations: ${JSON.stringify(foreignKeyViolations)}`,
      );
    }
  });
  applyPendingMigrations();
}
