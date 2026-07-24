import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { insertProject } from "../db/projects-repo";
import { deleteTicket, insertTicket } from "../db/tickets-repo";
import { listTicketEvents } from "../db/events-repo";
import { getSession, insertSession, listSessions, listTicketSessions } from "../db/sessions-repo";
import { openTestDb, testProject, testSession, testTicket } from "../db/test-helpers";
import type { TestDb } from "../db/test-helpers";
import { closeOutSession, persistSessionStart } from "./persistence";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

/** A migrated db with a project and one ticket — the FK context both write paths need. */
function setup(): { projectId: string; ticketId: string } {
  ctx = openTestDb();
  const project = testProject();
  insertProject(ctx.db, project);
  const ticket = testTicket(project.id, { id: "tk1" });
  insertTicket(ctx.db, ticket);
  return { projectId: project.id, ticketId: ticket.id };
}

describe("persistSessionStart", () => {
  it("persists an agent session's row and a session_started event carrying the harness id", () => {
    const { projectId, ticketId } = setup();
    const record = testSession(projectId, ticketId, {
      launchKind: "agent",
      placement: "tab",
      harnessId: "codex",
      title: "Session 1",
    });

    persistSessionStart(ctx.db, record, null, 500);

    expect(listTicketSessions(ctx.db, ticketId)).toEqual([record]);
    const started = listTicketEvents(ctx.db, ticketId).filter(
      (event) => event.payload.kind === "session_started",
    );
    expect(started).toHaveLength(1);
    expect(started[0]?.payload).toEqual({
      kind: "session_started",
      sessionId: record.id,
      title: "Session 1",
      launchKind: "agent",
      placement: "tab",
      harnessId: "codex",
    });
  });

  it("omits the harness id from a shell session's session_started event", () => {
    const { projectId, ticketId } = setup();
    const record = testSession(projectId, ticketId, {
      launchKind: "shell",
      placement: "tab",
      harnessId: "codex",
      title: "Session 1",
    });

    persistSessionStart(ctx.db, record, null, 500);

    const started = listTicketEvents(ctx.db, ticketId).find(
      (event) => event.payload.kind === "session_started",
    );
    expect(started?.payload).toEqual({
      kind: "session_started",
      sessionId: record.id,
      title: "Session 1",
      launchKind: "shell",
      placement: "tab",
    });
  });

  it("seeds the prior harnessSessionId onto the row and records session_resumed on a resume", () => {
    const { projectId, ticketId } = setup();
    const record = testSession(projectId, ticketId, { launchKind: "agent", title: "Session 2" });

    persistSessionStart(
      ctx.db,
      record,
      { previousSessionId: "prev-1", harnessSessionId: "seed-xyz" },
      500,
    );

    // The seed rides onto both the mutated record and its persisted row.
    expect(record.harnessSessionId).toBe("seed-xyz");
    expect(getSession(ctx.db, record.id)?.harnessSessionId).toBe("seed-xyz");
    const resumed = listTicketEvents(ctx.db, ticketId).filter(
      (event) => event.payload.kind === "session_resumed",
    );
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.payload).toEqual({
      kind: "session_resumed",
      sessionId: record.id,
      previousSessionId: "prev-1",
    });
  });

  it("leaves the record's own harnessSessionId untouched when the resume seed is null", () => {
    const { projectId, ticketId } = setup();
    const record = testSession(projectId, ticketId, { launchKind: "agent", title: "Session 2" });
    record.harnessSessionId = "keep-me";

    persistSessionStart(
      ctx.db,
      record,
      { previousSessionId: "prev-1", harnessSessionId: null },
      500,
    );

    expect(record.harnessSessionId).toBe("keep-me");
    expect(getSession(ctx.db, record.id)?.harnessSessionId).toBe("keep-me");
  });

  it("persists a scratch session's row with no ticket events (ticketId null)", () => {
    const { projectId, ticketId } = setup();
    const record = testSession(projectId, null, { launchKind: "shell", title: "Terminal 1" });

    persistSessionStart(ctx.db, record, null, 500);

    expect(listSessions(ctx.db, projectId)).toEqual([record]);
    expect(listTicketEvents(ctx.db, ticketId)).toEqual([]);
  });

  it("throws and leaves neither row nor events when the session insert violates its project FK", () => {
    const { ticketId } = setup();
    // A record whose projectId names no real project row → the insert's FK fails.
    const record = testSession("ghost", ticketId, { launchKind: "agent", title: "Session 1" });

    expect(() => persistSessionStart(ctx.db, record, null, 500)).toThrow();

    expect(getSession(ctx.db, record.id)).toBeUndefined();
    expect(listTicketEvents(ctx.db, ticketId)).toEqual([]);
  });
});

describe("closeOutSession", () => {
  it("ends a ticket-linked session's row and records session_ended", () => {
    const { projectId, ticketId } = setup();
    const record = testSession(projectId, ticketId, { launchKind: "agent" });
    insertSession(ctx.db, record);

    closeOutSession(ctx.db, record.id, 900, 7);

    const row = getSession(ctx.db, record.id);
    expect(row?.endedAt).toBe(900);
    expect(row?.exitCode).toBe(7);
    const ended = listTicketEvents(ctx.db, ticketId).filter(
      (event) => event.payload.kind === "session_ended",
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]?.payload).toEqual({ kind: "session_ended", sessionId: record.id });
  });

  it("ends the row with no event and no throw when the session's ticket was deleted", () => {
    const { projectId, ticketId } = setup();
    const record = testSession(projectId, ticketId, { launchKind: "agent" });
    insertSession(ctx.db, record);
    // Ticket deleted while the session lived → sessions.ticket_id is SET NULL
    // and its events cascade away, so the close-out must record no event.
    deleteTicket(ctx.db, ticketId);

    expect(() => closeOutSession(ctx.db, record.id, 900, 0)).not.toThrow();

    expect(getSession(ctx.db, record.id)?.endedAt).toBe(900);
    expect(listTicketEvents(ctx.db, ticketId)).toEqual([]);
  });

  it("never throws and logs the failure when the close-out cannot touch the db at all", () => {
    const { projectId, ticketId } = setup();
    const record = testSession(projectId, ticketId, { launchKind: "agent" });
    insertSession(ctx.db, record);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // A closed db makes the close-out transaction AND the bare fallback both
    // throw; the exit path must swallow it whole.
    ctx.db.close();

    expect(() => closeOutSession(ctx.db, record.id, 900, 0)).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("still ends the row via the bare fallback when only the transaction (the event write) fails", () => {
    const { projectId, ticketId } = setup();
    const record = testSession(projectId, ticketId, { launchKind: "agent" });
    insertSession(ctx.db, record);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Drop ticket_events so the in-transaction session_ended write throws and
    // rolls the endSession back — but the sessions table is intact, so the
    // best-effort bare endSession outside the transaction can still land.
    ctx.db.exec("DROP TABLE ticket_events");

    closeOutSession(ctx.db, record.id, 900, 3);

    const row = getSession(ctx.db, record.id);
    expect(row?.endedAt).toBe(900);
    expect(row?.exitCode).toBe(3);
    errorSpy.mockRestore();
  });
});
