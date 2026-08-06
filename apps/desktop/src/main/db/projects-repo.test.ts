import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDesktopSessionEngine } from "../session-control";
import { insertSession } from "../session-control/test-support";
import { testProject, testSession, testTicket, openTestDb } from "./test-helpers";
import type { TestDb } from "./test-helpers";
import {
  deleteProject,
  getProjectRuntimeRecord,
  insertProject,
  setProjectRuntimeRecord,
} from "./projects-repo";
import { insertTicket } from "./tickets-repo";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

describe("deleteProject", () => {
  it("cascades durable Sessions and every ledger row without foreign-key violations", async () => {
    ctx = openTestDb();
    const project = testProject({ id: "project-1" });
    const ticket = testTicket(project.id, { id: "ticket-1" });
    const session = testSession(project.id, ticket.id, { id: "session-1" });
    insertProject(ctx.db, project);
    insertTicket(ctx.db, ticket);
    insertSession(ctx.db, session);
    await createDesktopSessionEngine(ctx.db).submit({
      commandId: "signal-session-1",
      sessionId: session.id,
      intent: { kind: "session.signal", signal: "blocked", reason: "Needs approval" },
      provenance: {
        source: { kind: "user", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });

    for (const table of [
      "projects",
      "tickets",
      "sessions",
      "session_attachments",
      "session_commands",
      "session_events",
      "session_command_receipts",
    ]) {
      const row = ctx.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      };
      expect(row.count).toBeGreaterThan(0);
    }

    deleteProject(ctx.db, project.id);

    for (const table of [
      "projects",
      "tickets",
      "sessions",
      "session_attachments",
      "session_commands",
      "session_events",
      "session_command_receipts",
    ]) {
      expect(ctx.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(ctx.db.pragma("foreign_key_check")).toEqual([]);
  });
});

describe("project runtime records", () => {
  function project(id = "project-1") {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id }));
    return id;
  }

  function column(id: string): string | null {
    const row = ctx.db.prepare("SELECT runtime_preferences FROM projects WHERE id = ?").get(id) as {
      runtime_preferences: string | null;
    };
    return row.runtime_preferences;
  }

  it("stores one adapter's record and reads it back without disturbing its neighbours", () => {
    const id = project();

    setProjectRuntimeRecord(ctx.db, id, "opencode", '{"recordVersion":1,"observedAt":7}', 10);
    setProjectRuntimeRecord(ctx.db, id, "claude-code", '{"recordVersion":1,"observedAt":8}', 11);

    expect(getProjectRuntimeRecord(ctx.db, id, "opencode")).toBe(
      '{"recordVersion":1,"observedAt":7}',
    );
    expect(getProjectRuntimeRecord(ctx.db, id, "claude-code")).toBe(
      '{"recordVersion":1,"observedAt":8}',
    );
  });

  it("inherits — returns null — for a project, or an adapter, that overrides nothing", () => {
    const id = project();

    expect(getProjectRuntimeRecord(ctx.db, id, "opencode")).toBeNull();
    expect(getProjectRuntimeRecord(ctx.db, "ghost-project", "opencode")).toBeNull();

    setProjectRuntimeRecord(ctx.db, id, "opencode", '{"recordVersion":1}', 10);
    expect(getProjectRuntimeRecord(ctx.db, id, "claude-code")).toBeNull();
  });

  it("nulls the column when the last adapter key is cleared, leaving no {} residue", () => {
    const id = project();
    setProjectRuntimeRecord(ctx.db, id, "opencode", '{"recordVersion":1}', 10);
    setProjectRuntimeRecord(ctx.db, id, "claude-code", '{"recordVersion":1}', 11);

    setProjectRuntimeRecord(ctx.db, id, "opencode", null, 12);
    expect(column(id)).toBe('{"claude-code":{"recordVersion":1}}');

    setProjectRuntimeRecord(ctx.db, id, "claude-code", null, 13);
    expect(column(id)).toBeNull();
  });

  it("bumps row_version and updated_at like every other project write", () => {
    const id = project();
    const before = ctx.db.prepare("SELECT row_version FROM projects WHERE id = ?").get(id) as {
      row_version: number;
    };

    setProjectRuntimeRecord(ctx.db, id, "opencode", '{"recordVersion":1}', 4_242);

    expect(
      ctx.db.prepare("SELECT row_version, updated_at FROM projects WHERE id = ?").get(id),
    ).toEqual({ row_version: before.row_version + 1, updated_at: 4_242 });
  });

  it("is a no-op against a project that does not exist", () => {
    const id = project();

    setProjectRuntimeRecord(ctx.db, "ghost-project", "opencode", '{"recordVersion":1}', 10);

    expect(column(id)).toBeNull();
    expect(ctx.db.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual({ count: 1 });
  });

  it("inherits rather than throws when the column holds JSON of the wrong shape", () => {
    const id = project();
    // `json_valid` admits these; the CHECK cannot say "object keyed by adapter".
    for (const value of ["[]", '"text"', "null"]) {
      ctx.db.prepare("UPDATE projects SET runtime_preferences = ? WHERE id = ?").run(value, id);
      expect(getProjectRuntimeRecord(ctx.db, id, "opencode")).toBeNull();
    }

    // And a write over that garbage replaces it rather than merging into it.
    setProjectRuntimeRecord(ctx.db, id, "opencode", '{"recordVersion":1}', 10);
    expect(column(id)).toBe('{"opencode":{"recordVersion":1}}');
  });
});
