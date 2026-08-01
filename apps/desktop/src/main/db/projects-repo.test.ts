import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDesktopSessionEngine } from "../session-control";
import { insertSession } from "../session-control/test-support";
import { testProject, testSession, testTicket, openTestDb } from "./test-helpers";
import type { TestDb } from "./test-helpers";
import { deleteProject, insertProject } from "./projects-repo";
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
