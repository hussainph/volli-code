import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDesktopSessionEngine } from "../session-control";
import { insertProject } from "./projects-repo";
import { openRawDb, testProject } from "./test-helpers";
import { migrate } from "./migrations";

let directory: string | undefined;
let db: Database.Database | undefined;
afterEach(() => {
  db?.close();
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  db = undefined;
  directory = undefined;
});
async function version55() {
  directory = mkdtempSync(join(tmpdir(), "volli-notice-migration-"));
  const path = join(directory, "volli.db");
  db = openRawDb(path);
  db.pragma("foreign_keys = ON");
  migrate(db, path, { toVersion: 55 });
  insertProject(db, testProject({ id: "project" }));
  let id = 0;
  const engine = createDesktopSessionEngine(db, { now: () => 100, nextId: () => `id-${++id}` });
  const created = await engine.createSession({
    commandId: "create",
    projectId: "project",
    ticketId: null,
    role: "project",
    parentSessionId: null,
    title: "Reader",
    provenance: {
      source: { kind: "system", id: "test", detail: null },
      venue: { id: "local", kind: "local" },
    },
  });
  return { db, path, engine, sessionId: created.session.id };
}

describe("host notice outbox migration", () => {
  it("upgrades a populated v55 database without changing Session history, and is idempotent", async () => {
    const f = await version55();
    const before = await f.engine.getSession({ sessionId: f.sessionId });
    expect(migrate(f.db, f.path)).toBe(true);
    expect(f.db.pragma("user_version", { simple: true })).toBe(56);
    expect(f.db.prepare("SELECT * FROM host_notice_outbox").all()).toEqual([]);
    expect(await f.engine.getSession({ sessionId: f.sessionId })).toEqual(before);
    expect(f.db.pragma("foreign_key_check")).toEqual([]);
    expect(migrate(f.db, f.path)).toBe(false);
  });

  it("requires exactly one JSON payload or terminal receipt and cascades with its Session", async () => {
    const f = await version55();
    migrate(f.db, f.path);
    const insert = f.db.prepare(
      "INSERT INTO host_notice_outbox(command_id, session_id, notice, receipt) VALUES (?, ?, ?, ?)",
    );
    expect(() => insert.run("empty", f.sessionId, null, null)).toThrow();
    expect(() => insert.run("both", f.sessionId, "{}", "{}")).toThrow();
    expect(() => insert.run("invalid", f.sessionId, "not json", null)).toThrow();
    expect(() => insert.run("missing-reader", "missing-session", "{}", null)).toThrow();
    insert.run("pending", f.sessionId, "{}", null);
    insert.run("settled", f.sessionId, null, '{"status":"accepted"}');
    f.db.prepare("DELETE FROM sessions WHERE id = ?").run(f.sessionId);
    expect(f.db.prepare("SELECT * FROM host_notice_outbox").all()).toEqual([]);
    expect(f.db.pragma("foreign_key_check")).toEqual([]);
  });
});
