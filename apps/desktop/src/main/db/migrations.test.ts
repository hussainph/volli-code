import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openRawDb } from "./test-helpers";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { MIGRATIONS, migrate } from "./migrations";

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

/** Builds a populated v10 db to exercise the additive ticket_attachments table (migration 011). */
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

    expect(db.pragma("user_version", { simple: true })).toBe(18);
    db.close();
  });

  it("creates identity-only Sessions and the durable control-plane tables", () => {
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

  it("creates ticket_attachments and its ticket index (migration 011)", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    expect(tableExists(db, "ticket_attachments")).toBe(true);
    expect(indexExists(db, "idx_ticket_attachments_ticket")).toBe(true);
    expect(columnNames(db, "ticket_attachments")).toEqual([
      "id",
      "ticket_id",
      "kind",
      "label",
      "file_name",
      "url",
      "created_at",
    ]);
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

    expect(db.pragma("user_version", { simple: true })).toBe(18);
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

    expect(db.pragma("user_version", { simple: true })).toBe(18);
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

    expect(db.pragma("user_version", { simple: true })).toBe(18);
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

    expect(db.pragma("user_version", { simple: true })).toBe(18);
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

    expect(db.pragma("user_version", { simple: true })).toBe(18);
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

    expect(db.pragma("user_version", { simple: true })).toBe(18);
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

    expect(db.pragma("user_version", { simple: true })).toBe(18);
    expect(db.prepare("SELECT title, pr_url FROM tickets WHERE id = 't1'").get()).toEqual({
      title: "Ticket",
      pr_url: null,
    });
    expect(existsSync(`${dbPath}.backup-v8`)).toBe(true);
    db.close();
  });
});

describe("migrate — 010 to 011 upgrade path (ticket attachments)", () => {
  it("adds ticket_attachments without touching an existing ticket", () => {
    const dbPath = tempDbPath();
    const db = buildV10DbWithTicket(dbPath);

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(18);
    expect(tableExists(db, "ticket_attachments")).toBe(true);
    expect(db.prepare("SELECT COUNT(*) as n FROM ticket_attachments").get()).toEqual({ n: 0 });
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

    expect(db.pragma("user_version", { simple: true })).toBe(18);
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

    expect(db.pragma("user_version", { simple: true })).toBe(18);
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

    expect(db.pragma("user_version", { simple: true })).toBe(18);
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

    expect(db.pragma("user_version", { simple: true })).toBe(18);
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

    expect(db.pragma("user_version", { simple: true })).toBe(18);
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

    expect(db.pragma("user_version", { simple: true })).toBe(18);
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
    expect(db.pragma("user_version", { simple: true })).toBe(18);
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
