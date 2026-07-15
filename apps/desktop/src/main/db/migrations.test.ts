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

describe("migrate — fresh install", () => {
  it("applies every migration and lands on the latest user_version", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(5);
    db.close();
  });

  it("creates the migration-003 tables, indexes, and ticket columns", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    expect(tableExists(db, "sessions")).toBe(true);
    expect(tableExists(db, "ticket_comments")).toBe(true);
    expect(indexExists(db, "sessions_ticket")).toBe(true);
    expect(indexExists(db, "sessions_project")).toBe(true);
    expect(indexExists(db, "ticket_comments_ticket")).toBe(true);
    expect(columnNames(db, "tickets")).toEqual(
      expect.arrayContaining(["worktree_path", "branch", "base_branch"]),
    );
    db.close();
  });

  it("drops tickets.harness_id (migration 004) while leaving sessions.harness_id intact", () => {
    const dbPath = tempDbPath();
    const db = openRawDb(dbPath);
    migrate(db, dbPath);

    expect(columnNames(db, "tickets")).not.toContain("harness_id");
    expect(columnNames(db, "sessions")).toContain("harness_id");
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

    expect(db.pragma("user_version", { simple: true })).toBe(5);
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
    migrate(db, dbPath); // second call: nothing pending

    expect(db.pragma("user_version", { simple: true })).toBe(5);
    // No v5-backup should exist — the second migrate() call had nothing to apply.
    expect(existsSync(`${dbPath}.backup-v5`)).toBe(false);
    db.close();
  });
});

describe("migrate — 004 to 005 upgrade path (ticket-number counter backfill)", () => {
  it("backfills next_ticket_number to MAX(ticket_number) + 1 per project", () => {
    const dbPath = tempDbPath();
    const db = buildV4DbWithRows(dbPath);

    migrate(db, dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(5);
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
