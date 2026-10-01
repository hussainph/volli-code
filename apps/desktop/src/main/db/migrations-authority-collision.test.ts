import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { MIGRATIONS, migrate } from "./migrations";
import { openRawDb } from "./test-helpers";

// The two unreleased branches both stamped 53. Pin their original DDL here
// rather than building either lineage from the migration being repaired.
const DECISION_MODEL_053 = `
ALTER TABLE projects ADD COLUMN decision_model TEXT
  CHECK (decision_model IS NULL OR json_valid(decision_model));
`;
const DOGFOOD_APPROVALS_053 = `
CREATE TABLE IF NOT EXISTS authority_approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('session', 'project')),
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  rule TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (json_valid(provenance)),
  created_at INTEGER NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  last_used_session_id TEXT,
  revoked_at INTEGER,
  CHECK ((scope = 'session') = (session_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS authority_approvals_project
  ON authority_approvals(project_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS authority_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  authoriser TEXT NOT NULL,
  rule TEXT NOT NULL,
  summary TEXT NOT NULL,
  asked TEXT NOT NULL,
  approval_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS authority_decisions_session
  ON authority_decisions(session_id, created_at);
`;

let dir: string;
let db: Database.Database;

afterEach(() => {
  db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  dir = mkdtempSync(join(tmpdir(), "volli-authority-migration-"));
  const dbPath = join(dir, "volli.db");
  db = openRawDb(dbPath);
  db.pragma("foreign_keys = ON");
  return dbPath;
}

function base52(dbPath: string): void {
  migrate(db, dbPath, { toVersion: 52 });
  db.exec(`
    INSERT INTO projects (id, name, path, ticket_prefix, color_index, sort_order, created_at, updated_at)
      VALUES ('p1', 'Preserved project', '/repo', 'VC', 0, 0, 1, 2);
    INSERT INTO sessions (id, project_id, title, created_at)
      VALUES ('s1', 'p1', 'Preserved session', 3);
  `);
}

function schema(table: string): unknown[] {
  return db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? ORDER BY type, name")
    .all(table);
}

function expectConverged(): void {
  expect(db.pragma("user_version", { simple: true })).toBe(55);
  expect((db.pragma("table_info(projects)") as { name: string }[]).map((c) => c.name)).toContain(
    "decision_model",
  );
  for (const table of ["authority_approvals", "authority_decisions"]) {
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
    ).toEqual({ name: table });
  }
  expect(db.pragma("foreign_key_check")).toEqual([]);
  expect(() =>
    db
      .prepare(
        `INSERT INTO projects
          (id, name, path, ticket_prefix, color_index, sort_order, created_at, updated_at, decision_model)
          VALUES ('invalid', 'Invalid', '/invalid', 'NO', 0, 0, 0, 0, 'invalid')`,
      )
      .run(),
  ).toThrow("CHECK constraint failed");
}

describe("053 collision: decision models and remembered authority approvals", () => {
  it("gives a fresh database both schemas at 054, with unique migration numbers", () => {
    const dbPath = fixture();
    expect(migrate(db, dbPath)).toBe(true);
    expectConverged();
    expect(new Set(MIGRATIONS.map((m) => m.version)).size).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.find((m) => m.version === 53)?.sql.trim()).toBe(DECISION_MODEL_053.trim());
    expect(migrate(db, dbPath)).toBe(false);
  });

  it("upgrades main + #653 stamped 53 without changing the decision model or existing rows", () => {
    const dbPath = fixture();
    base52(dbPath);
    db.exec(DECISION_MODEL_053);
    db.prepare("UPDATE projects SET decision_model = ?").run('{"kind":"none"}');
    db.pragma("user_version = 53");
    const project = db.prepare("SELECT * FROM projects").all();
    const session = db.prepare("SELECT * FROM sessions").all();
    const projectSchema = schema("projects");
    expect(migrate(db, dbPath)).toBe(true);
    expectConverged();
    expect(db.prepare("SELECT * FROM projects").all()).toEqual(project);
    expect(db.prepare("SELECT * FROM sessions").all()).toEqual(session);
    expect(schema("projects")).toEqual(projectSchema);
  });

  it("repairs old dogfood stamped 53 while preserving approval and decision history and schemas", () => {
    const dbPath = fixture();
    base52(dbPath);
    db.exec(DOGFOOD_APPROVALS_053);
    db.exec(`
      INSERT INTO authority_approvals
        (id, project_id, scope, session_id, operation, key, rule, provenance, created_at,
         use_count, last_used_at, last_used_session_id, revoked_at)
        VALUES ('a1', 'p1', 'session', 's1', 'write', '/outside', 'path.outside-workspace',
                '{"sessionId":"s1"}', 4, 7, 5, 's1', 6);
      INSERT INTO authority_decisions
        (id, project_id, session_id, tool_call_id, tool, authoriser, rule, summary, asked,
         approval_id, created_at)
        VALUES ('d1', 'p1', 's1', 'call1', 'write', 'user', 'path.outside-workspace',
                'Write outside', '/outside/file', 'a1', 5);
    `);
    db.pragma("user_version = 53");
    const project = db.prepare("SELECT * FROM projects").get();
    const session = db.prepare("SELECT * FROM sessions").all();
    const approvals = db.prepare("SELECT * FROM authority_approvals").all();
    const decisions = db.prepare("SELECT * FROM authority_decisions").all();
    const approvalSchema = schema("authority_approvals");
    const decisionSchema = schema("authority_decisions");
    expect(migrate(db, dbPath)).toBe(true);
    expectConverged();
    expect(db.prepare("SELECT * FROM projects").get()).toEqual({
      ...project!,
      decision_model: null,
    });
    expect(db.prepare("SELECT * FROM sessions").all()).toEqual(session);
    expect(db.prepare("SELECT * FROM authority_approvals").all()).toEqual(approvals);
    expect(db.prepare("SELECT * FROM authority_decisions").all()).toEqual(decisions);
    expect(schema("authority_approvals")).toEqual(approvalSchema);
    expect(schema("authority_decisions")).toEqual(decisionSchema);
    expect(migrate(db, dbPath)).toBe(false);
  });

  it.each(["authority_approvals", "authority_decisions"])(
    "repairs a partial dogfood schema missing %s independently",
    (missingTable) => {
      const dbPath = fixture();
      base52(dbPath);
      db.exec(DOGFOOD_APPROVALS_053);
      db.exec(`DROP TABLE ${missingTable}`);
      db.pragma("user_version = 53");
      const remainingTable =
        missingTable === "authority_approvals" ? "authority_decisions" : "authority_approvals";
      const remainingSchema = schema(remainingTable);
      expect(migrate(db, dbPath)).toBe(true);
      expectConverged();
      expect(schema(remainingTable)).toEqual(remainingSchema);
    },
  );

  it("reoffers approval history without losing completed requests or mutation receipts", () => {
    const dbPath = fixture();
    base52(dbPath);
    migrate(db, dbPath);
    db.exec(`
      INSERT INTO authority_approval_commands VALUES ('cmd', '{"kind":"approval.revoke"}', '{"status":"accepted"}');
      INSERT INTO authority_approval_events VALUES ('event', 'cmd', '{"kind":"approval.revoked"}', 5);
      INSERT INTO authority_approval_completions VALUES ('p1', 's1', 'call', '["grant"]', 6);
    `);
    const tables = [
      "authority_approval_commands",
      "authority_approval_events",
      "authority_approval_completions",
    ];
    const rows = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const schemas = tables.map(schema);
    db.pragma("user_version = 54");
    expect(migrate(db, dbPath)).toBe(true);
    expect(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(rows);
    expect(tables.map(schema)).toEqual(schemas);
    expectConverged();
  });

  it("never rewinds a stamped version when asked for an older ceiling or seeing a future database", () => {
    const dbPath = fixture();
    base52(dbPath);
    db.exec(DOGFOOD_APPROVALS_053);
    db.pragma("user_version = 53");
    expect(migrate(db, dbPath, { toVersion: 52 })).toBe(false);
    expect(db.pragma("user_version", { simple: true })).toBe(53);
    expect(migrate(db, dbPath)).toBe(true);
    expectConverged();
    db.pragma("user_version = 55");
    expect(migrate(db, dbPath)).toBe(false);
    expect(db.pragma("user_version", { simple: true })).toBe(55);
  });
});
