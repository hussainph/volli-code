import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openRawDb } from "./test-helpers";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { MIGRATIONS, migrate } from "./migrations";

/**
 * The version a fully-migrated database lands on, derived rather than typed
 * out: every migration added past this point would otherwise mean editing the
 * same literal in seventeen assertions that all mean "and it is up to date".
 */
const LATEST_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version;

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(): string {
  dir = mkdtempSync(join(tmpdir(), "volli-migrations-test-"));
  return join(dir, "volli.db");
}

/** Column names for a table, via `PRAGMA table_info` — used to assert migration 003's additive columns. */
function columnNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return row !== undefined;
}

function indexExists(db: Database.Database, index: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(index);
  return row !== undefined;
}

/** Hand-builds a v2 database (migrations 1+2 only) with rows already in it, mirroring a real pre-003 install. */
function buildV2DbWithRows(dbPath: string): Database.Database {
  const db = openRawDb(dbPath);
  db.pragma("foreign_keys = ON");
  for (const migration of MIGRATIONS.filter((m) => m.version <= 2)) {
    db.exec(migration.sql);
  }
  db.pragma("user_version = 2");

  db.prepare(
    `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
       VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO tickets (id, project_id, ticket_number, title, body, status, priority, uses_worktree, harness_id, position, row_version, created_at, updated_at)
       VALUES ('t1', 'p1', 1, 'Existing ticket', 'body text', 'todo', 'medium', 1, 'claude-code', 0, 1, 0, 0)`,
  ).run();
  return db;
}

/**
 * Hand-builds a v4 database (migrations 1–4) with two projects' worth of
 * tickets already in it, mirroring a real pre-005 install — used to exercise
 * migration 005's backfill against existing rows.
 */
function buildV4DbWithRows(dbPath: string): Database.Database {
  const db = openRawDb(dbPath);
  db.pragma("foreign_keys = ON");
  for (const migration of MIGRATIONS.filter((m) => m.version <= 4)) {
    db.exec(migration.sql);
  }
  db.pragma("user_version = 4");

  db.prepare(
    `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
       VALUES ('p1', 'Project One', '/repo/one', 'VC', 0, 0, 1, 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
       VALUES ('p2', 'Project Two', '/repo/two', 'PT', 1, 1, 1, 0, 0)`,
  ).run();

  const insertTicket = db.prepare(
    `INSERT INTO tickets (id, project_id, ticket_number, title, body, status, priority, uses_worktree, position, row_version, created_at, updated_at)
       VALUES (@id, @projectId, @ticketNumber, @title, '', 'todo', 'medium', 1, 0, 1, 0, 0)`,
  );
  // p1: tickets numbered 1..3, including a gap (2 was already hard-deleted in
  // this fixture) — the backfill must key off MAX, not COUNT.
  insertTicket.run({ id: "t1", projectId: "p1", ticketNumber: 1, title: "One" });
  insertTicket.run({ id: "t3", projectId: "p1", ticketNumber: 3, title: "Three" });
  // p2: a single ticket, never deleted from.
  insertTicket.run({ id: "t2", projectId: "p2", ticketNumber: 1, title: "Two-One" });

  return db;
}

/** Builds a populated v5 db so migration 006's honest legacy defaults are exercised. */
function buildV5DbWithSession(dbPath: string): Database.Database {
  const db = openRawDb(dbPath);
  db.pragma("foreign_keys = ON");
  for (const migration of MIGRATIONS.filter((m) => m.version <= 5)) {
    db.exec(migration.sql);
  }
  db.pragma("user_version = 5");
  db.prepare(
    `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
       VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO tickets (id, project_id, ticket_number, title, body, status, priority, uses_worktree, position, row_version, created_at, updated_at)
       VALUES ('t1', 'p1', 1, 'Ticket', '', 'todo', 'medium', 1, 0, 1, 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (id, project_id, ticket_id, harness_id, harness_session_id, title, cwd, created_at, ended_at)
       VALUES ('s1', 'p1', 't1', 'claude-code', NULL, 'Session 1', '/repo', 0, 1)`,
  ).run();
  return db;
}

/** Builds a populated v6 db to exercise the independently-versioned execution preferences. */
function buildV6DbWithTicket(dbPath: string): Database.Database {
  const db = openRawDb(dbPath);
  db.pragma("foreign_keys = ON");
  for (const migration of MIGRATIONS.filter((m) => m.version <= 6)) {
    db.exec(migration.sql);
  }
  db.pragma("user_version = 6");
  db.prepare(
    `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
       VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO tickets (id, project_id, ticket_number, title, body, status, priority, uses_worktree, position, row_version, created_at, updated_at)
       VALUES ('t1', 'p1', 1, 'Ticket', '', 'todo', 'medium', 1, 0, 1, 0, 0)`,
  ).run();
  return db;
}

/** Builds a populated v7 db to exercise the additive setup_command column (migration 008). */
function buildV7DbWithProject(dbPath: string): Database.Database {
  const db = openRawDb(dbPath);
  db.pragma("foreign_keys = ON");
  for (const migration of MIGRATIONS.filter((m) => m.version <= 7)) {
    db.exec(migration.sql);
  }
  db.pragma("user_version = 7");
  db.prepare(
    `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
       VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
  ).run();
  return db;
}

/** Builds a populated v8 db to exercise the additive tickets.pr_url column (migration 009). */
function buildV8DbWithTicket(dbPath: string): Database.Database {
  const db = openRawDb(dbPath);
  db.pragma("foreign_keys = ON");
  for (const migration of MIGRATIONS.filter((m) => m.version <= 8)) {
    db.exec(migration.sql);
  }
  db.pragma("user_version = 8");
  db.prepare(
    `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
       VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO tickets (id, project_id, ticket_number, title, body, status, priority, uses_worktree, position, row_version, created_at, updated_at)
       VALUES ('t1', 'p1', 1, 'Ticket', '', 'todo', 'medium', 1, 0, 1, 0, 0)`,
  ).run();
  return db;
}

/** Builds a populated v10 db to exercise the attachment-storage upgrade path. */
function buildV10DbWithTicket(dbPath: string): Database.Database {
  const db = openRawDb(dbPath);
  db.pragma("foreign_keys = ON");
  for (const migration of MIGRATIONS.filter((m) => m.version <= 10)) {
    db.exec(migration.sql);
  }
  db.pragma("user_version = 10");
  db.prepare(
    `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
       VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO tickets (id, project_id, ticket_number, title, body, status, priority, uses_worktree, position, row_version, created_at, updated_at)
       VALUES ('t1', 'p1', 1, 'Ticket', '', 'todo', 'medium', 1, 0, 1, 0, 0)`,
  ).run();
  return db;
}

describe("migrate — fresh install", () => {
  it("applies every migration and lands on the latest user_version", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it("creates identity-only Sessions and the durable session-engine tables", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    expect(tableExists(db, "sessions")).toBe(true);
    expect(tableExists(db, "ticket_comments")).toBe(true);
    expect(tableExists(db, "session_attachments")).toBe(true);
    expect(tableExists(db, "session_commands")).toBe(true);
    expect(tableExists(db, "session_events")).toBe(true);
    expect(tableExists(db, "session_command_receipts")).toBe(true);
    expect(indexExists(db, "sessions_ticket_created")).toBe(true);
    expect(indexExists(db, "sessions_project_created")).toBe(true);
    expect(indexExists(db, "ticket_comments_ticket")).toBe(true);
    expect(columnNames(db, "sessions")).toEqual([
      "id",
      "project_id",
      "ticket_id",
      "title",
      "created_at",
    ]);
    expect(columnNames(db, "tickets")).toEqual(
      expect.arrayContaining(["worktree_path", "branch", "base_branch"]),
    );
    db.close();
  });

  it("adds projects.setup_command as a nullable column (migration 008)", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    expect(columnNames(db, "projects")).toContain("setup_command");
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
    ).run();
    expect(db.prepare("SELECT setup_command FROM projects WHERE id = 'p1'").get()).toEqual({
      setup_command: null,
    });
    db.close();
  });

  it("adds projects.authority_policy as a nullable JSON column (migration 025)", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    expect(columnNames(db, "projects")).toContain("authority_policy");
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
    ).run();
    // NULL is the default and means "inherit every built-in default", so an
    // existing project needs no backfill to be governed correctly.
    expect(db.prepare("SELECT authority_policy FROM projects WHERE id = 'p1'").get()).toEqual({
      authority_policy: null,
    });
    db.close();
  });

  it("refuses an authority_policy that is not JSON (migration 025)", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
    ).run();
    // A column whose whole contract is "this is JSON" fails at the write, not
    // several layers up in a parser that would then have to invent a policy for
    // the corpse.
    expect(() =>
      db.prepare("UPDATE projects SET authority_policy = 'enforce' WHERE id = 'p1'").run(),
    ).toThrow();
    db.close();
  });

  it("adds tickets.pr_url as a nullable column (migration 009)", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    expect(columnNames(db, "tickets")).toContain("pr_url");
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO tickets (id, project_id, ticket_number, title, body, status, priority, uses_worktree, position, row_version, created_at, updated_at)
         VALUES ('t1', 'p1', 1, 'Ticket', '', 'todo', 'medium', 1, 0, 1, 0, 0)`,
    ).run();
    expect(db.prepare("SELECT pr_url FROM tickets WHERE id = 't1'").get()).toEqual({
      pr_url: null,
    });
    db.close();
  });

  it("adds tickets.retention_keep defaulting to 0 (migration 010)", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    expect(columnNames(db, "tickets")).toContain("retention_keep");
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO tickets (id, project_id, ticket_number, title, body, status, priority, uses_worktree, position, row_version, created_at, updated_at)
         VALUES ('t1', 'p1', 1, 'Ticket', '', 'done', 'medium', 1, 0, 1, 0, 0)`,
    ).run();
    expect(db.prepare("SELECT retention_keep FROM tickets WHERE id = 't1'").get()).toEqual({
      retention_keep: 0,
    });
    db.close();
  });

  it("replaces ticket_attachments with blobs + blob_links (migration 020)", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    // Migration 011's table is gone — it never held a row in any shipped build.
    expect(tableExists(db, "ticket_attachments")).toBe(false);
    expect(tableExists(db, "blobs")).toBe(true);
    expect(tableExists(db, "blob_links")).toBe(true);
    expect(indexExists(db, "idx_blob_links_ticket")).toBe(true);
    expect(indexExists(db, "idx_blob_links_session")).toBe(true);
    expect(indexExists(db, "idx_blob_links_blob")).toBe(true);
    expect(columnNames(db, "blobs")).toEqual([
      "hash",
      "mime",
      "size_bytes",
      "original_name",
      "width",
      "height",
      "created_at",
    ]);
    expect(columnNames(db, "blob_links")).toEqual([
      "id",
      "blob_hash",
      "ticket_id",
      "session_id",
      "label",
      "created_at",
    ]);
    db.close();
  });

  it("refuses a blob_link that names both owners, or neither (migration 020)", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);
    const hash = "a".repeat(64);
    db.prepare(
      "INSERT INTO blobs (hash, mime, size_bytes, original_name, created_at) VALUES (?, 'image/png', 1, 'a.png', 1)",
    ).run(hash);

    const insert = (ticketId: string | null, sessionId: string | null) =>
      db
        .prepare(
          "INSERT INTO blob_links (id, blob_hash, ticket_id, session_id, label, created_at) VALUES (?, ?, ?, ?, 'l', 1)",
        )
        .run("l1", hash, ticketId, sessionId);

    expect(() => insert(null, null)).toThrow();
    expect(() => insert("t1", "s1")).toThrow();
    db.close();
  });

  it("moves terminal exit state out of the canonical Sessions table", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    expect(columnNames(db, "sessions")).not.toContain("exit_code");
    db.close();
  });

  it("drops tickets.harness_id and keeps terminal metadata out of Sessions", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    expect(columnNames(db, "tickets")).not.toContain("harness_id");
    expect(columnNames(db, "tickets")).toContain("preferred_harness_id");
    expect(columnNames(db, "sessions")).not.toContain("harness_id");
    db.close();
  });

  it("skips the pre-migration backup copy on a brand-new database", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    expect(existsSync(`${dbPath}.backup-v0`)).toBe(false);
    db.close();
  });

  it("defaults a fresh project's next_ticket_number to 1 (migration 005)", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
    ).run();
    const project = db.prepare("SELECT next_ticket_number FROM projects WHERE id = 'p1'").get() as {
      next_ticket_number: number;
    };

    expect(project.next_ticket_number).toBe(1);
    db.close();
  });
});

describe("migrate — 002 to 004 upgrade path", () => {
  it("migrates an existing populated db to the latest version without touching its rows", () => {
    const dbPath = tempDbPath();
    const db = buildV2DbWithRows(dbPath);

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    const project = db.prepare("SELECT * FROM projects WHERE id = 'p1'").get() as {
      name: string;
    };
    expect(project.name).toBe("Project");
    const ticket = db.prepare("SELECT * FROM tickets WHERE id = 't1'").get() as {
      title: string;
      worktree_path: string | null;
      branch: string | null;
      base_branch: string | null;
    };
    expect(ticket.title).toBe("Existing ticket");
    expect(ticket.worktree_path).toBeNull();
    expect(ticket.branch).toBeNull();
    expect(ticket.base_branch).toBeNull();

    expect(tableExists(db, "sessions")).toBe(true);
    expect(tableExists(db, "ticket_comments")).toBe(true);
    expect(db.prepare("SELECT COUNT(*) as n FROM sessions").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) as n FROM ticket_comments").get()).toEqual({ n: 0 });

    db.close();
  });

  it("drops the pre-existing tickets.harness_id column on upgrade", () => {
    const dbPath = tempDbPath();
    const db = buildV2DbWithRows(dbPath);

    migrate(db, dbPath);

    expect(columnNames(db, "tickets")).not.toContain("harness_id");
    db.close();
  });

  it("checkpoints and copies a backup of the pre-migration db before altering it", () => {
    const dbPath = tempDbPath();
    const db = buildV2DbWithRows(dbPath);

    migrate(db, dbPath);

    expect(existsSync(`${dbPath}.backup-v2`)).toBe(true);
    db.close();
  });

  it("is a no-op when the db is already at the latest version", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);
    // Backups are named `backup-v<from>`, and `<from>` is wherever the first
    // migrate() call landed — read it back instead of hardcoding the latest
    // version, so this guard can't go stale on the next migration bump.
    const latestVersion = db.pragma("user_version", { simple: true }) as number;
    migrate(db, dbPath); // second call: nothing pending

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    // No backup should exist for the already-latest version — the second
    // migrate() call had nothing to apply.
    expect(existsSync(`${dbPath}.backup-v${latestVersion}`)).toBe(false);
    db.close();
  });
});

describe("migrate — 004 to 005 upgrade path (ticket-number counter backfill)", () => {
  it("backfills next_ticket_number to MAX(ticket_number) + 1 per project", () => {
    const dbPath = tempDbPath();
    const db = buildV4DbWithRows(dbPath);

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    const projects = db
      .prepare("SELECT id, next_ticket_number FROM projects ORDER BY id")
      .all() as { id: string; next_ticket_number: number }[];
    // p1's highest surviving ticket is numbered 3 (2 was already gone in this
    // fixture) — the backfill must land one past that gap, not one past a count.
    expect(projects).toEqual([
      { id: "p1", next_ticket_number: 4 },
      { id: "p2", next_ticket_number: 2 },
    ]);
    db.close();
  });

  it("backfills an empty project (no tickets) to 1", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((m) => m.version <= 4)) {
      db.exec(migration.sql);
    }
    db.pragma("user_version = 4");
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('empty', 'Empty', '/repo/empty', 'EM', 0, 0, 1, 0, 0)`,
    ).run();

    migrate(db, dbPath);

    const project = db
      .prepare("SELECT next_ticket_number FROM projects WHERE id = 'empty'")
      .get() as { next_ticket_number: number };
    expect(project.next_ticket_number).toBe(1);
    db.close();
  });

  it("checkpoints and copies a v4 backup before altering the schema", () => {
    const dbPath = tempDbPath();
    const db = buildV4DbWithRows(dbPath);

    migrate(db, dbPath);

    expect(existsSync(`${dbPath}.backup-v4`)).toBe(true);
    db.close();
  });
});

describe("migrate — 005 to 006 upgrade path (pre-ledger terminal rows)", () => {
  it("resets historical terminal rows rather than fabricating durable Session history", () => {
    const dbPath = tempDbPath();
    const db = buildV5DbWithSession(dbPath);

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(existsSync(`${dbPath}.backup-v5`)).toBe(true);
    db.close();
  });
});

describe("migrate — 006 to 007 upgrade path (execution preferences)", () => {
  it("adds independent ticket harness and project base-branch defaults", () => {
    const dbPath = tempDbPath();
    const db = buildV6DbWithTicket(dbPath);

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare("SELECT preferred_harness_id FROM tickets WHERE id = 't1'").get()).toEqual({
      preferred_harness_id: "claude-code",
    });
    expect(db.prepare("SELECT base_branch FROM projects WHERE id = 'p1'").get()).toEqual({
      base_branch: null,
    });
    expect(existsSync(`${dbPath}.backup-v6`)).toBe(true);
    db.close();
  });
});

describe("migrate — 007 to 008 upgrade path (worktree setup command)", () => {
  it("adds a nullable setup_command to an existing project without touching it", () => {
    const dbPath = tempDbPath();
    const db = buildV7DbWithProject(dbPath);

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare("SELECT name, setup_command FROM projects WHERE id = 'p1'").get()).toEqual({
      name: "Project",
      setup_command: null,
    });
    expect(existsSync(`${dbPath}.backup-v7`)).toBe(true);
    db.close();
  });
});

describe("migrate — 008 to 009 upgrade path (durable draft-PR url)", () => {
  it("adds a nullable pr_url to an existing ticket without touching it", () => {
    const dbPath = tempDbPath();
    const db = buildV8DbWithTicket(dbPath);

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare("SELECT title, pr_url FROM tickets WHERE id = 't1'").get()).toEqual({
      title: "Ticket",
      pr_url: null,
    });
    expect(existsSync(`${dbPath}.backup-v8`)).toBe(true);
    db.close();
  });
});

describe("migrate — 010 to 020 upgrade path (attachment storage)", () => {
  it("lands blobs + blob_links without touching an existing ticket", () => {
    const dbPath = tempDbPath();
    const db = buildV10DbWithTicket(dbPath);

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(tableExists(db, "blobs")).toBe(true);
    expect(db.prepare("SELECT COUNT(*) as n FROM blob_links").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT title FROM tickets WHERE id = 't1'").get()).toEqual({
      title: "Ticket",
    });
    expect(existsSync(`${dbPath}.backup-v10`)).toBe(true);
    db.close();
  });
});

describe("migrate — 011 to 012 upgrade path (legacy terminal rows)", () => {
  it("resets an existing terminal row at the ledger boundary", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((m) => m.version <= 11)) {
      db.exec(migration.sql);
    }
    db.pragma("user_version = 11");
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, project_id, ticket_id, harness_id, title, cwd, created_at, ended_at)
         VALUES ('s1', 'p1', NULL, 'claude-code', 'Session 1', '/repo', 0, 5)`,
    ).run();

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(existsSync(`${dbPath}.backup-v11`)).toBe(true);
    db.close();
  });
});

describe("migrate — 012 to 013 upgrade path (per-surface theme override)", () => {
  it("adds four nullable theme columns to an existing project, all inheriting", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((m) => m.version <= 12)) {
      db.exec(migration.sql);
    }
    db.pragma("user_version = 12");
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
    ).run();

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    // Decision #69: the override is PER SURFACE, and NULL = inherit — so an
    // upgraded project keeps the global theme on every surface.
    expect(
      db
        .prepare(
          "SELECT theme_app_slug, theme_terminal_name, theme_editor_id, theme_seed FROM projects WHERE id = 'p1'",
        )
        .get(),
    ).toEqual({
      theme_app_slug: null,
      theme_terminal_name: null,
      theme_editor_id: null,
      theme_seed: null,
    });
    expect(existsSync(`${dbPath}.backup-v12`)).toBe(true);
    db.close();
  });

  it("leaves a fresh database's projects table with the theme columns", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    expect(columnNames(db, "projects")).toEqual(
      expect.arrayContaining([
        "theme_app_slug",
        "theme_terminal_name",
        "theme_editor_id",
        "theme_seed",
      ]),
    );
    db.close();
  });
});

describe("migrate — 013 to 014 upgrade path (per-project canvas + appearance)", () => {
  it("adds two nullable columns to an existing project, both inheriting", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((m) => m.version <= 13)) {
      db.exec(migration.sql);
    }
    db.pragma("user_version = 13");
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
    ).run();

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    // NULL = inherit, exactly as 013 meant it: an upgraded project keeps the
    // global canvas and the global appearance.
    expect(
      db.prepare("SELECT theme_canvas, theme_appearance FROM projects WHERE id = 'p1'").get(),
    ).toEqual({ theme_canvas: null, theme_appearance: null });
    expect(existsSync(`${dbPath}.backup-v13`)).toBe(true);
    db.close();
  });

  it("keeps 013's four columns rather than dropping them", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    // They stop being READ (projects-repo.ts), but SQLite's DROP COLUMN is not
    // safe here and `db/export.ts` carries every projects column by
    // construction — so dead data, not deleted data.
    expect(columnNames(db, "projects")).toEqual(
      expect.arrayContaining([
        "theme_app_slug",
        "theme_terminal_name",
        "theme_editor_id",
        "theme_seed",
        "theme_canvas",
        "theme_appearance",
      ]),
    );
    db.close();
  });

  it("refuses an appearance outside the three-word vocabulary", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
    ).run();

    expect(() =>
      db.prepare("UPDATE projects SET theme_appearance = 'sepia' WHERE id = 'p1'").run(),
    ).toThrow();
    for (const value of ["light", "dark", "auto", null]) {
      expect(() =>
        db.prepare("UPDATE projects SET theme_appearance = ? WHERE id = 'p1'").run(value),
      ).not.toThrow();
    }
    db.close();
  });

  it("does not add a canvases table — one canvas per scope, edited in place", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    expect(tableExists(db, "canvases")).toBe(false);
    db.close();
  });
});

describe("migrate — 014 to 015 upgrade path (registered harnesses)", () => {
  it("adds the trust table to an existing database, empty", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((m) => m.version <= 14)) db.exec(migration.sql);
    db.pragma("user_version = 14");

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(tableExists(db, "registered_harnesses")).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM registered_harnesses").get()).toEqual({ n: 0 });
    expect(existsSync(`${dbPath}.backup-v14`)).toBe(true);
    db.close();
  });

  it("stores the verdict and the hash it was made about, and no copy of the manifest", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    expect(columnNames(db, "registered_harnesses")).toEqual([
      "slug",
      "manifest_path",
      "manifest_sha256",
      "decision",
      "declared_events",
      "verified_events",
      "decided_at",
      "created_at",
      "updated_at",
    ]);
    db.close();
  });

  it("refuses a verdict outside the two-word vocabulary", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    const insert = (decision: string): void => {
      db.prepare(
        `INSERT INTO registered_harnesses
           (slug, manifest_path, manifest_sha256, decision, decided_at, created_at, updated_at)
         VALUES ('my-harness', '/m.json', 'a1', ?, 0, 0, 0)`,
      ).run(decision);
    };
    expect(() => insert("maybe")).toThrow();
    expect(() => insert("trusted")).not.toThrow();
    db.close();
  });
});

describe("migrate — 015 to 018 upgrade path (terminal reset)", () => {
  it("backs up then removes terminal-shaped rows while retaining the project", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((m) => m.version <= 15)) db.exec(migration.sql);
    db.pragma("user_version = 15");
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, project_id, ticket_id, harness_id, title, cwd, created_at, ended_at)
         VALUES ('s1', 'p1', NULL, 'opencode', 'Session 1', '/repo', 0, NULL)`,
    ).run();

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT name FROM projects WHERE id = 'p1'").get()).toEqual({
      name: "Project",
    });
    expect(existsSync(`${dbPath}.backup-v15`)).toBe(true);
    db.close();
  });

  it("has no mutable terminal metadata columns on a fresh Sessions table", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);
    expect(columnNames(db, "sessions")).toEqual([
      "id",
      "project_id",
      "ticket_id",
      "title",
      "created_at",
    ]);
    db.close();
  });
});

describe("migrate — 016 to 017 upgrade path (harness channel)", () => {
  it("adds the channel table to an existing database, empty, without disturbing the ledger", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((m) => m.version <= 16)) db.exec(migration.sql);
    db.pragma("user_version = 16");
    db.prepare(
      `INSERT INTO registered_harnesses
         (slug, manifest_path, manifest_sha256, decision, declared_events, verified_events,
          decided_at, created_at, updated_at)
       VALUES ('my-harness', '/m.json', 'a1', 'trusted', '["input.needed"]', '["input.needed"]', 0, 0, 0)`,
    ).run();

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(tableExists(db, "harness_channel")).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM harness_channel").get()).toEqual({ n: 0 });
    expect(
      db
        .prepare("SELECT verified_events FROM registered_harnesses WHERE slug = 'my-harness'")
        .get(),
    ).toEqual({ verified_events: '["input.needed"]' });
    expect(existsSync(`${dbPath}.backup-v16`)).toBe(true);
    db.close();
  });

  // Two integers and the id they belong to. A third column holding the derived
  // word would be the monotonic ledger all over again.
  it("stores the two timestamps and nothing derived from them", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    expect(columnNames(db, "harness_channel")).toEqual([
      "harness_id",
      "last_launch_at",
      "last_event_at",
    ]);
    db.close();
  });

  it("admits a row that has only ever launched, and only ever reported", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    db.prepare(
      "INSERT INTO harness_channel (harness_id, last_launch_at) VALUES ('claude-code', 10)",
    ).run();
    db.prepare(
      "INSERT INTO harness_channel (harness_id, last_event_at) VALUES ('codex', 20)",
    ).run();

    expect(db.prepare("SELECT * FROM harness_channel ORDER BY harness_id").all()).toEqual([
      { harness_id: "claude-code", last_launch_at: 10, last_event_at: null },
      { harness_id: "codex", last_launch_at: null, last_event_at: 20 },
    ]);
    db.close();
  });
});

describe("migrate — 017 to 018 Session ledger reset", () => {
  it("rolls back every pending migration when the session-ledger reset fails", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 16)) {
      db.exec(migration.sql);
    }
    db.pragma("user_version = 16");
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
       VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO tickets (id, project_id, ticket_number, title, body, status, priority, uses_worktree, position, row_version, created_at, updated_at)
       VALUES ('t1', 'p1', 1, 'Ticket', '', 'todo', 'medium', 1, 0, 1, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO ticket_events (id, ticket_id, kind, actor, payload, created_at)
       VALUES ('e1', 't1', 'session_started', 'user', '{}', 0)`,
    ).run();
    // Migration 018 deletes legacy session events. Fail precisely there, after
    // 017 would have created harness_channel under the old per-step runner.
    db.exec(`
      CREATE TRIGGER reject_session_ledger_reset
      BEFORE DELETE ON ticket_events
      BEGIN
        SELECT RAISE(ABORT, 'forced session-ledger migration failure');
      END;
    `);

    expect(() => migrate(db, dbPath)).toThrow("forced session-ledger migration failure");

    expect(db.pragma("user_version", { simple: true })).toBe(16);
    expect(tableExists(db, "harness_channel")).toBe(false);
    expect(db.prepare("SELECT id FROM ticket_events").all()).toEqual([{ id: "e1" }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("migrates v17 with foreign keys enabled, retains planner/comment content, and removes only legacy Session facts", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 17)) {
      db.exec(migration.sql);
    }
    db.pragma("user_version = 17");
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
       VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO tickets (id, project_id, ticket_number, title, body, status, priority, uses_worktree, position, row_version, created_at, updated_at)
       VALUES ('t1', 'p1', 1, 'Ticket', 'planner body', 'todo', 'medium', 1, 0, 1, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO sessions
         (id, project_id, ticket_id, harness_id, title, cwd, created_at, ended_at, launch_kind, placement, exit_code, active_harness_id)
       VALUES ('s1', 'p1', 't1', 'claude-code', 'Legacy', '/repo', 1, 2, 'agent', 'tab', 0, 'claude-code')`,
    ).run();
    db.prepare(
      `INSERT INTO ticket_comments (id, ticket_id, session_id, actor, body, created_at, updated_at)
       VALUES ('c1', 't1', 's1', 'agent', 'Keep this body', 3, 3)`,
    ).run();
    const event = db.prepare(
      `INSERT INTO ticket_events (id, ticket_id, kind, actor, payload, created_at)
       VALUES (?, 't1', ?, 'user', '{}', 4)`,
    );
    event.run("planner", "retitled");
    for (const kind of [
      "session_started",
      "session_ended",
      "session_resumed",
      "sessions_interrupted",
      "session_signal",
    ]) {
      event.run(kind, kind);
    }

    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);

    migrate(db, dbPath);

    expect(existsSync(`${dbPath}.backup-v17`)).toBe(true);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(
      db.prepare("SELECT session_id, body FROM ticket_comments WHERE id = 'c1'").get(),
    ).toEqual({
      session_id: null,
      body: "Keep this body",
    });
    expect(db.prepare("SELECT kind FROM ticket_events ORDER BY id").all()).toEqual([
      { kind: "retitled" },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});

describe("migrate — 018 to 019 upgrade path (per-project runtime preferences)", () => {
  it("adds one nullable JSON column to an existing project, inheriting the global record", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((m) => m.version <= 18)) {
      db.exec(migration.sql);
    }
    db.pragma("user_version = 18");
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
    ).run();

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    // NULL = inherit, as 013 and 014 mean it: an upgraded project keeps
    // whatever `app_state` holds globally for every adapter.
    expect(db.prepare("SELECT runtime_preferences FROM projects WHERE id = 'p1'").get()).toEqual({
      runtime_preferences: null,
    });
    expect(existsSync(`${dbPath}.backup-v18`)).toBe(true);
    db.close();
  });

  it("refuses a runtime_preferences value that is not JSON", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
    ).run();

    expect(() =>
      db.prepare("UPDATE projects SET runtime_preferences = 'not json' WHERE id = 'p1'").run(),
    ).toThrow();
    for (const value of ['{"opencode":{"recordVersion":1}}', "{}", null]) {
      expect(() =>
        db.prepare("UPDATE projects SET runtime_preferences = ? WHERE id = 'p1'").run(value),
      ).not.toThrow();
    }
    db.close();
  });

  it("keeps the global app_state key rather than moving it onto the row", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    // The column is an OVERRIDE. The global record stays exactly where it was,
    // so a project that sets nothing keeps resolving what it resolved before.
    expect(columnNames(db, "projects")).toEqual(
      expect.arrayContaining(["runtime_preferences", "theme_canvas"]),
    );
    expect(tableExists(db, "app_state")).toBe(true);
    db.close();
  });
});

describe("migrate — 019 to 020 upgrade path (web access)", () => {
  it("adds both tables to an existing database, empty, and touches nothing else", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((m) => m.version <= 19)) {
      db.exec(migration.sql);
    }
    db.pragma("user_version = 19");
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
    ).run();

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    // Off is the resting state, and it is the ABSENCE of a row rather than a
    // seeded one: an install that never opened the page has configured nothing.
    expect(db.prepare("SELECT COUNT(*) AS n FROM web_access_settings").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM secrets").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT name FROM projects WHERE id = 'p1'").get()).toEqual({
      name: "Project",
    });
    expect(existsSync(`${dbPath}.backup-v19`)).toBe(true);
    db.close();
  });

  it("holds one settings row and only the providers this version knows", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    db.prepare(
      "INSERT INTO web_access_settings (id, provider, searxng_url, updated_at) VALUES (1, 'brave', NULL, 0)",
    ).run();
    // A profile-wide setting: a table that could hold two of them is a table
    // somebody has to write a tie-breaker for.
    expect(() =>
      db
        .prepare(
          "INSERT INTO web_access_settings (id, provider, searxng_url, updated_at) VALUES (2, 'off', NULL, 0)",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db.prepare("UPDATE web_access_settings SET provider = 'yandex' WHERE id = 1").run(),
    ).toThrow();
    db.close();
  });

  it("keeps secrets out of the store that ships to the renderer", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    // `app_state` is handed to the renderer wholesale on bootstrap and is
    // writable by it; `secrets` is neither, which is the whole reason it exists
    // — and, since migration 023 put the key itself in `value`, the whole of
    // what protects it.
    expect(tableExists(db, "secrets")).toBe(true);
    expect(columnNames(db, "secrets")).toEqual(["name", "value", "updated_at"]);
    db.close();
  });
});

/** A v22 database holding what a profile with a keychain-stored Exa key held. */
function buildV22DbWithACiphertext(dbPath: string): Database.Database {
  const db = openRawDb(dbPath);
  db.pragma("foreign_keys = ON");
  for (const migration of MIGRATIONS.filter((m) => m.version <= 22)) {
    db.exec(migration.sql);
  }
  db.pragma("user_version = 22");
  db.prepare("INSERT INTO secrets (name, ciphertext, updated_at) VALUES (?, ?, ?)").run(
    "web-access.exa.api-key",
    Buffer.from("v10-not-actually-openable-here", "utf8"),
    1700,
  );
  db.prepare(
    "INSERT INTO web_access_settings (id, provider, searxng_url, updated_at) VALUES (1, 'exa', NULL, 1700)",
  ).run();
  return db;
}

describe("migrate — 022 to 023 upgrade path (search keys leave the keychain)", () => {
  it("parks the old ciphertext instead of dropping or reinterpreting it", () => {
    const dbPath = tempDbPath();
    const db = buildV22DbWithACiphertext(dbPath);

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    // Only `safeStorage` can open these bytes, so SQL cannot carry them across.
    // They wait for the one runtime pass that can (`web/legacy-safe-storage.ts`)
    // rather than being dropped here or re-read as if they were a key.
    expect(db.prepare("SELECT name, ciphertext FROM legacy_safe_storage_secrets").all()).toEqual([
      {
        name: "web-access.exa.api-key",
        ciphertext: Buffer.from("v10-not-actually-openable-here", "utf8"),
      },
    ]);
    // And the profile is left with no key rather than an unreadable one — until
    // that pass runs, this is a Settings page asking for a re-paste.
    expect(db.prepare("SELECT COUNT(*) AS n FROM secrets").get()).toEqual({ n: 0 });
    // The provider choice is untouched: a key is a separate fact from which
    // provider was picked.
    expect(db.prepare("SELECT provider FROM web_access_settings WHERE id = 1").get()).toEqual({
      provider: "exa",
    });
    db.close();
  });

  it("leaves a profile that never stored a key with two empty tables", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);

    migrate(db, dbPath);

    expect(db.prepare("SELECT COUNT(*) AS n FROM legacy_safe_storage_secrets").get()).toEqual({
      n: 0,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM secrets").get()).toEqual({ n: 0 });
    db.close();
  });
});

describe("migrate — 022 to 024 upgrade path (per-project agent configuration)", () => {
  it("adds three nullable columns to an existing project, every one meaning inherit", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((m) => m.version <= 22)) {
      db.exec(migration.sql);
    }
    db.pragma("user_version = 22");
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
    ).run();

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    // NULL = inherit, as 013/014/019 all mean it. An upgraded project behaves
    // exactly as it did before the column existed.
    expect(
      db
        .prepare("SELECT skill_modes, session_harness, session_model FROM projects WHERE id = 'p1'")
        .get(),
    ).toEqual({ skill_modes: null, session_harness: null, session_model: null });
    expect(existsSync(`${dbPath}.backup-v22`)).toBe(true);
    db.close();
  });

  it("reconciles a branch-lineage database — agent columns at 23, web keys never ran", () => {
    // The VC-111 dogfood profile: its original migration 23 was the
    // agent-config DDL, so the columns exist, `user_version` says 23, and the
    // web-keys rebuild never happened. A plain-SQL 024 re-added the column
    // and killed the boot ("duplicate column name: skill_modes"); the
    // reconciler must instead skip the DDL, carry the configured rules
    // across, and run the rebuild this database is actually missing.
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((m) => m.version <= 22)) {
      db.exec(migration.sql);
    }
    const agentConfig = MIGRATIONS.find((m) => m.version === 24);
    if (agentConfig === undefined) throw new Error("migration 024 missing");
    db.exec(agentConfig.sql);
    db.pragma("user_version = 23");
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
    ).run();
    db.prepare(`UPDATE projects SET skill_modes = ? WHERE id = 'p1'`).run('{"tdd":"off"}');
    db.prepare(`INSERT INTO secrets (name, ciphertext, updated_at) VALUES ('brave', ?, 5)`).run(
      Buffer.from([1, 2, 3]),
    );

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    // The configured rules survive — reconciliation must never cost data.
    expect(db.prepare("SELECT skill_modes FROM projects WHERE id = 'p1'").get()).toEqual({
      skill_modes: '{"tdd":"off"}',
    });
    // The web-keys rebuild ran: ciphertext rows moved to the legacy table and
    // the live table is value-shaped and empty.
    const secretsColumns = (db.pragma("table_info(secrets)") as { name: string }[]).map(
      (column) => column.name,
    );
    expect(secretsColumns).toContain("value");
    expect(secretsColumns).not.toContain("ciphertext");
    expect(db.prepare("SELECT COUNT(*) AS n FROM secrets").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT name, updated_at FROM legacy_safe_storage_secrets").all()).toEqual([
      { name: "brave", updated_at: 5 },
    ]);
    db.close();
  });

  it("adds the columns to a main-lineage database already past the web-keys move", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((m) => m.version <= 23)) {
      db.exec(migration.sql);
    }
    db.pragma("user_version = 23");
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
    ).run();

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(
      db
        .prepare("SELECT skill_modes, session_harness, session_model FROM projects WHERE id = 'p1'")
        .get(),
    ).toEqual({ skill_modes: null, session_harness: null, session_model: null });
    // Already value-shaped — the reconciler must not rebuild secrets again.
    expect(
      (db.pragma("table_info(secrets)") as { name: string }[]).map((column) => column.name),
    ).toContain("value");
    db.close();
  });

  it("refuses a skill_modes or session_model value that is not JSON", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
    ).run();

    for (const column of ["skill_modes", "session_model"]) {
      expect(() =>
        db.prepare(`UPDATE projects SET ${column} = 'not json' WHERE id = 'p1'`).run(),
      ).toThrow();
    }
    expect(() =>
      db.prepare(`UPDATE projects SET skill_modes = ? WHERE id = 'p1'`).run('{"tdd":"off"}'),
    ).not.toThrow();
    expect(() =>
      db
        .prepare(`UPDATE projects SET session_model = ? WHERE id = 'p1'`)
        .run('{"providerId":"anthropic","modelId":"opus","reasoningLevel":"high"}'),
    ).not.toThrow();
    db.close();
  });

  it("cascades with the project, unlike an app_state blob keyed by project id", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, dbPath);
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at, skill_modes)
         VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0, '{"tdd":"off"}')`,
    ).run();

    db.prepare("DELETE FROM projects WHERE id = 'p1'").run();

    expect(db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 0 });
    db.close();
  });
});

/** A migrated db holding one project, one ticket, one session, one automation, one run (migration 026's suite). */
function seededAutomationsDb(dbPath: string): Database.Database {
  const db = openRawDb(dbPath);
  db.pragma("foreign_keys = ON");
  migrate(db, dbPath);
  db.prepare(
    `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'Project', '/repo', 'VC', 0, 0, 1, 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO tickets (id, project_id, ticket_number, title, body, status, priority, uses_worktree, position, row_version, created_at, updated_at)
         VALUES ('t1', 'p1', 1, 'Ticket', '', 'todo', 'medium', 1, 0, 1, 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (id, project_id, ticket_id, title, created_at)
         VALUES ('s1', 'p1', 't1', 'Chat', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO automations (id, project_id, name, instructions, runtime, created_at, updated_at)
         VALUES ('a1', 'p1', 'Review', '/review go', NULL, 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO automation_runs
      (id, automation_id, automation_name, ticket_id, session_id, provider_id, model_id, reasoning_level, created_at)
     VALUES ('r1', 'a1', 'Review', 't1', 's1', 'anthropic', 'claude-opus', 'high', 0)`,
  ).run();
  return db;
}

/** The schema on current main: migration 025 is authority policy, not Automations. */
function buildCurrentV25Db(dbPath: string): Database.Database {
  const db = openRawDb(dbPath);
  db.pragma("foreign_keys = ON");
  const throughCurrentMain = MIGRATIONS.filter((candidate) => candidate.version <= 25);
  for (const migration of throughCurrentMain) {
    if (migration.apply !== undefined) migration.apply(db);
    else db.exec(migration.sql);
  }
  db.pragma("user_version = 25");
  db.prepare(
    `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
       VALUES ('p25', 'Current main', '/repo/current', 'VC', 0, 0, 1, 0, 0)`,
  ).run();
  return db;
}

/**
 * The short-lived VC-126 branch originally used version 025 for Automations
 * before main assigned that number to `projects.authority_policy`. A developer
 * who ran that branch has both Automation tables and `user_version = 25`, but
 * no authority column — this fixture makes migration 026 converge that lineage.
 */
function buildLegacyAutomationV25Db(dbPath: string): Database.Database {
  const db = openRawDb(dbPath);
  db.pragma("foreign_keys = ON");
  for (const migration of MIGRATIONS.filter((candidate) => candidate.version <= 24)) {
    if (migration.apply !== undefined) migration.apply(db);
    else db.exec(migration.sql);
  }
  db.exec(`
    CREATE TABLE automations (
      id           TEXT PRIMARY KEY,
      project_id   TEXT REFERENCES projects(id) ON DELETE CASCADE,
      name         TEXT NOT NULL CHECK (name <> ''),
      instructions TEXT NOT NULL CHECK (instructions <> ''),
      runtime      TEXT CHECK (runtime IS NULL OR json_valid(runtime)),
      row_version  INTEGER NOT NULL DEFAULT 1,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX idx_automations_project ON automations(project_id, name);
    CREATE TABLE automation_runs (
      id              TEXT PRIMARY KEY,
      automation_id   TEXT REFERENCES automations(id) ON DELETE SET NULL,
      ticket_id       TEXT REFERENCES tickets(id) ON DELETE SET NULL,
      session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      provider_id     TEXT NOT NULL CHECK (provider_id <> ''),
      model_id        TEXT NOT NULL CHECK (model_id <> ''),
      reasoning_level TEXT NOT NULL CHECK (reasoning_level <> ''),
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX idx_automation_runs_ticket ON automation_runs(ticket_id, created_at);
    CREATE INDEX idx_automation_runs_automation ON automation_runs(automation_id, created_at);
    CREATE INDEX idx_automation_runs_session ON automation_runs(session_id);
  `);
  db.pragma("user_version = 25");
  db.prepare(
    `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
       VALUES ('legacy-project', 'Legacy', '/repo/legacy', 'VC', 0, 0, 1, 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO tickets (id, project_id, ticket_number, title, body, status, priority, uses_worktree, position, row_version, created_at, updated_at)
       VALUES ('legacy-ticket', 'legacy-project', 1, 'Ticket', '', 'todo', 'medium', 1, 0, 1, 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (id, project_id, ticket_id, title, created_at)
       VALUES ('legacy-session', 'legacy-project', 'legacy-ticket', 'Chat', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO automations (id, project_id, name, instructions, runtime, created_at, updated_at)
       VALUES ('legacy-automation', 'legacy-project', 'Review', '/review', NULL, 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO automation_runs
      (id, automation_id, ticket_id, session_id, provider_id, model_id, reasoning_level, created_at)
     VALUES ('legacy-run', 'legacy-automation', 'legacy-ticket', 'legacy-session', 'anthropic', 'opus', 'high', 0)`,
  ).run();
  return db;
}

describe("migration 026 — Automations command ledger and projections", () => {
  it("upgrades a database at current main's user_version 25 instead of skipping Automations", () => {
    const dbPath = tempDbPath();
    const db = buildCurrentV25Db(dbPath);
    expect(tableExists(db, "automations")).toBe(false);
    expect(tableExists(db, "automation_runs")).toBe(false);

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(tableExists(db, "automations")).toBe(true);
    expect(tableExists(db, "automation_runs")).toBe(true);
    expect(tableExists(db, "automation_commands")).toBe(true);
    expect(db.prepare("SELECT authority_policy FROM projects WHERE id = 'p25'").get()).toEqual({
      authority_policy: null,
    });
    db.close();
  });

  it("converges the branch-local Automation 025 lineage with main's authority policy", () => {
    const dbPath = tempDbPath();
    const db = buildLegacyAutomationV25Db(dbPath);

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(columnNames(db, "projects")).toContain("authority_policy");
    expect(tableExists(db, "automation_commands")).toBe(true);
    expect(
      db
        .prepare(
          "SELECT automation_id, automation_name, ticket_id, session_id FROM automation_runs WHERE id = 'legacy-run'",
        )
        .get(),
    ).toEqual({
      automation_id: "legacy-automation",
      automation_name: "Review",
      ticket_id: "legacy-ticket",
      session_id: "legacy-session",
    });
    db.close();
  });

  it("creates both tables, refuses empty names/instructions and non-JSON runtime", () => {
    const dbPath = tempDbPath();
    const db = seededAutomationsDb(dbPath);

    expect(tableExists(db, "automations")).toBe(true);
    expect(tableExists(db, "automation_runs")).toBe(true);
    expect(tableExists(db, "automation_commands")).toBe(true);
    expect(tableExists(db, "automation_events")).toBe(true);
    expect(tableExists(db, "automation_command_receipts")).toBe(true);
    expect(tableExists(db, "automation_run_deliveries")).toBe(true);
    db.prepare(
      "INSERT INTO automation_commands (id, intent, created_at) VALUES ('c1', '{}', 0)",
    ).run();
    db.prepare(
      "INSERT INTO automation_events (id, command_id, kind, payload, created_at) VALUES ('e1', 'c1', 'command.recorded', '{}', 0)",
    ).run();
    expect(() =>
      db.prepare("UPDATE automation_events SET kind = 'edited' WHERE id = 'e1'").run(),
    ).toThrow();
    expect(() => db.prepare("DELETE FROM automation_commands WHERE id = 'c1'").run()).toThrow();
    expect(() => db.prepare("UPDATE automations SET name = '' WHERE id = 'a1'").run()).toThrow();
    expect(() =>
      db.prepare("UPDATE automations SET instructions = '' WHERE id = 'a1'").run(),
    ).toThrow();
    expect(() =>
      db.prepare("UPDATE automations SET runtime = 'not json' WHERE id = 'a1'").run(),
    ).toThrow();
    expect(() =>
      db
        .prepare("UPDATE automations SET runtime = ? WHERE id = 'a1'")
        .run('{"providerId":"anthropic","modelId":"opus","reasoningLevel":"high"}'),
    ).not.toThrow();
    db.close();
  });

  it("scopes a project Automation to its project (cascade) while a global one carries NULL", () => {
    const dbPath = tempDbPath();
    const db = seededAutomationsDb(dbPath);
    db.prepare(
      `INSERT INTO automations (id, project_id, name, instructions, created_at, updated_at)
         VALUES ('a2', NULL, 'Global', '/tdd', 0, 0)`,
    ).run();

    db.prepare("DELETE FROM projects WHERE id = 'p1'").run();

    const remaining = db.prepare("SELECT id FROM automations ORDER BY id").all();
    expect(remaining).toEqual([{ id: "a2" }]);
    db.close();
  });

  it("keeps a Run's Automation id/name provenance when its Automation goes, but follows its Session", () => {
    const dbPath = tempDbPath();
    const db = seededAutomationsDb(dbPath);

    db.prepare("DELETE FROM automations WHERE id = 'a1'").run();
    db.prepare("DELETE FROM tickets WHERE id = 't1'").run();
    expect(
      db
        .prepare(
          "SELECT automation_id, automation_name, ticket_id FROM automation_runs WHERE id = 'r1'",
        )
        .get(),
    ).toEqual({
      automation_id: "a1",
      automation_name: "Review",
      ticket_id: null,
    });

    db.prepare("DELETE FROM sessions WHERE id = 's1'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM automation_runs").get()).toEqual({ n: 0 });
    db.close();
  });

  it("stores the resolved model as its own columns, never as a reference", () => {
    const dbPath = tempDbPath();
    const db = seededAutomationsDb(dbPath);

    expect(columnNames(db, "automation_runs")).toEqual([
      "id",
      "automation_id",
      "automation_name",
      "ticket_id",
      "session_id",
      "provider_id",
      "model_id",
      "reasoning_level",
      "created_at",
    ]);
    expect(() =>
      db.prepare("UPDATE automation_runs SET provider_id = '' WHERE id = 'r1'").run(),
    ).toThrow();
    db.close();
  });
});

/**
 * A database at the version current main ships — every migration through
 * Automations, and nothing of VC-87's.
 *
 * Built by replaying the real migrations up to 26 rather than by pasting a
 * schema, so the fixture cannot drift from what a user's profile actually
 * holds. It carries one Session with one event, because the coverage floor is
 * derived from history and a profile with none is a different case.
 */
function buildCurrentV26Db(dbPath: string): Database.Database {
  const db = openRawDb(dbPath);
  db.pragma("foreign_keys = ON");
  for (const migration of MIGRATIONS.filter((candidate) => candidate.version <= 26)) {
    if (migration.apply !== undefined) migration.apply(db);
    else db.exec(migration.sql);
  }
  db.pragma("user_version = 26");
  db.prepare(
    `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
       VALUES ('p26', 'Current main', '/repo/current', 'VC', 0, 0, 1, 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (id, project_id, ticket_id, title, created_at)
       VALUES ('s26', 'p26', NULL, 'Worked before metering', 1_000)`,
  ).run();
  db.prepare(
    `INSERT INTO session_events (id, session_id, sequence, occurred_at, recorded_at, provenance, payload)
       VALUES ('e26', 's26', 1, 7_000, 7_000, '{}', '{"kind":"session.created"}')`,
  ).run();
  return db;
}

describe("migration 027 — the Session usage projection", () => {
  it("upgrades a database at current main's user_version 26 instead of skipping usage", () => {
    const dbPath = tempDbPath();
    const db = buildCurrentV26Db(dbPath);
    expect(tableExists(db, "session_usage")).toBe(false);

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(tableExists(db, "session_usage")).toBe(true);
    expect(tableExists(db, "session_usage_coverage")).toBe(true);
    // Automations, which owned 026, survives the upgrade untouched.
    expect(tableExists(db, "automations")).toBe(true);
    expect(db.prepare("SELECT id FROM projects").all()).toEqual([{ id: "p26" }]);
    db.close();
  });

  /**
   * The bug a marker exists to prevent: an existing profile's past spend is
   * unrecoverable, so the index starts empty. Without a floor the first read
   * says "no metered model calls yet" and the second, days later, prints a
   * total that looks complete and covers only the days since the upgrade.
   */
  it("marks an existing profile's history as covered only from its newest fact", () => {
    const dbPath = tempDbPath();
    const db = buildCurrentV26Db(dbPath);

    migrate(db, dbPath);

    expect(db.prepare("SELECT metered_from FROM session_usage_coverage").get()).toEqual({
      metered_from: 7_000,
    });
    db.close();
  });

  it("leaves a fresh profile with no boundary at all", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);

    migrate(db, dbPath);

    expect(db.prepare("SELECT metered_from FROM session_usage_coverage").get()).toEqual({
      metered_from: 0,
    });
    db.close();
  });

  it("keeps exactly one coverage row, so no reader can find two floors", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    expect(() =>
      db.prepare("INSERT INTO session_usage_coverage (id, metered_from) VALUES (2, 0)").run(),
    ).toThrow();
    db.close();
  });
});

describe("migration 028 — the typed verdict channel", () => {
  it("creates ticket_signals with the latest-per-kind index", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    expect(tableExists(db, "ticket_signals")).toBe(true);
    expect(indexExists(db, "ticket_signals_latest")).toBe(true);
    expect(columnNames(db, "ticket_signals")).toEqual([
      "id",
      "ticket_id",
      "session_id",
      "actor",
      "kind",
      "verdict",
      "detail",
      "created_at",
    ]);
    db.close();
  });

  /**
   * The vocabulary is fixed in the schema, not merely at the door. A signal
   * whose kind nobody can query is the `VERDICT:` comment convention again, so
   * the last writer that could refuse an invented one does.
   */
  it("refuses a kind or verdict outside the fixed vocabulary", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'P', '/p', 'VC', 0, 0, 1, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO tickets (id, project_id, ticket_number, title, body, status, priority, uses_worktree, position, row_version, created_at, updated_at)
         VALUES ('t1', 'p1', 1, 'Ticket', '', 'todo', 'medium', 1, 0, 1, 0, 0)`,
    ).run();
    const insert = (kind: string, verdict: string) =>
      db
        .prepare(
          `INSERT INTO ticket_signals (id, ticket_id, session_id, actor, kind, verdict, detail, created_at)
             VALUES (?, 't1', NULL, 'session', ?, ?, NULL, 1)`,
        )
        .run(`${kind}-${verdict}`, kind, verdict);

    expect(() => insert("gut-feel", "pass")).toThrow();
    expect(() => insert("review", "probably")).toThrow();
    expect(() => insert("review", "pass")).not.toThrow();
    db.close();
  });
});

describe("migration 029 — durable Ticket Event sequence", () => {
  it("backfills commit order and never reuses a cursor after deletion", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((candidate) => candidate.version <= 28)) {
      if (migration.apply !== undefined) migration.apply(db);
      else db.exec(migration.sql);
    }
    db.pragma("user_version = 28");
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'P', '/p', 'VC', 0, 0, 1, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO tickets (id, project_id, ticket_number, title, body, status, priority, uses_worktree, position, row_version, created_at, updated_at)
         VALUES ('t1', 'p1', 1, 'Ticket', '', 'todo', 'medium', 1, 0, 1, 0, 0)`,
    ).run();
    const insertEvent = db.prepare(
      `INSERT INTO ticket_events (id, ticket_id, kind, actor, payload, created_at)
       VALUES (?, 't1', ?, 'user', '{}', 100)`,
    );
    insertEvent.run("event-a", "archived");
    insertEvent.run("event-b", "unarchived");

    migrate(db, dbPath);

    expect(
      db.prepare("SELECT sequence, event_id FROM ticket_event_sequence ORDER BY sequence").all(),
    ).toEqual([
      { sequence: 1, event_id: "event-a" },
      { sequence: 2, event_id: "event-b" },
    ]);

    db.prepare("DELETE FROM ticket_events WHERE id = 'event-b'").run();
    insertEvent.run("event-c", "archived");
    expect(
      db.prepare("SELECT sequence, event_id FROM ticket_event_sequence ORDER BY sequence").all(),
    ).toEqual([
      { sequence: 1, event_id: "event-a" },
      { sequence: 3, event_id: "event-c" },
    ]);
    db.close();
  });

  it("keeps event identity immutable while allowing body-edit timestamp coalescing", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'P', '/p', 'VC', 0, 0, 1, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO tickets (id, project_id, ticket_number, title, body, status, priority, uses_worktree, position, row_version, created_at, updated_at)
         VALUES ('t1', 'p1', 1, 'Ticket', '', 'todo', 'medium', 1, 0, 1, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO ticket_events (id, ticket_id, kind, actor, payload, created_at)
       VALUES ('event-a', 't1', 'body_edited', 'user', '{}', 1)`,
    ).run();

    expect(() =>
      db.prepare("UPDATE ticket_events SET kind = 'archived' WHERE id = 'event-a'").run(),
    ).toThrow("ticket event identity is immutable");
    expect(() =>
      db.prepare("UPDATE ticket_events SET created_at = 2 WHERE id = 'event-a'").run(),
    ).not.toThrow();
    db.close();
  });
});

describe("migration 030 — birth-frozen Ticket Session delegation grants", () => {
  it("stores canonical scoped grants, ancestry, and one-way claim completion", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, dbPath);
    db.prepare(
      `INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, row_version, created_at, updated_at)
         VALUES ('p1', 'P', '/p', 'VC', 0, 0, 1, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO tickets (id, project_id, ticket_number, title, body, status, priority, uses_worktree, position, row_version, created_at, updated_at)
         VALUES ('t1', 'p1', 1, 'Ticket', '', 'todo', 'medium', 1, 0, 1, 0, 0)`,
    ).run();
    for (const id of ["parent", "child"]) {
      db.prepare(
        `INSERT INTO sessions (id, project_id, ticket_id, title, created_at)
         VALUES (?, 'p1', 't1', NULL, 0)`,
      ).run(id);
    }

    expect(tableExists(db, "session_delegations")).toBe(true);
    expect(tableExists(db, "session_verb_grants")).toBe(true);
    expect(tableExists(db, "session_delegation_claims")).toBe(true);
    db.prepare(
      `INSERT INTO session_delegations (session_id, ticket_id, parent_session_id, depth)
       VALUES ('parent', 't1', NULL, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO session_verb_grants (session_id, verb, scope, max_depth, max_children)
       VALUES ('parent', 'session.start', 'own-ticket', 1, 3)`,
    ).run();
    db.prepare(
      `INSERT INTO session_delegations (session_id, ticket_id, parent_session_id, depth)
       VALUES ('child', 't1', 'parent', 1)`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO session_verb_grants (session_id, verb, scope, max_depth, max_children)
           VALUES ('child', 'session_start', 'own-ticket', 1, 3)`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO session_verb_grants (session_id, verb, scope, max_depth, max_children)
           VALUES ('child', 'session.start', 'own-ticket', 3, 4)`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare("UPDATE session_verb_grants SET max_children = 4 WHERE session_id = 'parent'")
        .run(),
    ).toThrow("session verb grant is immutable");

    db.prepare(
      `INSERT INTO session_delegation_claims
         (parent_session_id, tool_call_id, ticket_id, child_session_id, created_at)
       VALUES ('parent', 'call-1', 't1', NULL, 0)`,
    ).run();
    expect(() =>
      db
        .prepare(
          `UPDATE session_delegation_claims
              SET child_session_id = 'child'
            WHERE parent_session_id = 'parent' AND tool_call_id = 'call-1'`,
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE session_delegation_claims
              SET child_session_id = NULL
            WHERE parent_session_id = 'parent' AND tool_call_id = 'call-1'`,
        )
        .run(),
    ).toThrow("session delegation claim is immutable once completed");
    db.close();
  });
});
