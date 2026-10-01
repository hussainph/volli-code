import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createSessionEngine } from "@volli/session-engine";
import type { SessionRole } from "@volli/shared";
import { insertProject } from "../db/projects-repo";
import { insertTicket } from "../db/tickets-repo";
import {
  listTicketEvents,
  recordTicketEvent,
  currentTicketEventCursor,
  firstMatchingTicketEventAfter,
} from "../db/events-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { watchSessionActivity } from "../session-control/activity-watch";
import { catchUpSessionResumptions, observeSessionResumptions } from "./session-resumptions";

let ctx: TestDb;
afterEach(() => ctx.cleanup());
const provenance = {
  source: { kind: "system" as const, id: "test", detail: null },
  venue: { id: "local", kind: "local" as const },
};

function fixture() {
  ctx = openTestDb();
  const project = testProject();
  insertProject(ctx.db, project);
  const ticket = testTicket(project.id);
  insertTicket(ctx.db, ticket);
  let id = 0;
  const engine = createSessionEngine({
    ledger: createSqliteSessionLedger(ctx.db),
    clock: { now: () => 1000 },
    ids: { next: (kind) => `${kind}-${++id}` },
  });
  async function create(role: SessionRole, parentSessionId: string | null = null) {
    const { session } = await engine.createSession({
      commandId: `create-${++id}`,
      projectId: project.id,
      ticketId: role === "project" ? null : ticket.id,
      role,
      parentSessionId,
      title: null,
      provenance,
    });
    return session.id;
  }
  async function resume(sessionId: string, stopFirst = true) {
    await engine.observe({
      id: `attach-${sessionId}`,
      sessionId,
      kind: "attachment.opened",
      occurredAt: 1,
      provenance,
      attachment: {
        id: `a-${sessionId}`,
        sessionId,
        adapterId: "pi",
        venue: provenance.venue,
        continuity: "fresh",
        native: null,
        authority: null,
      },
    });
    if (stopFirst)
      await engine.submit({
        commandId: `stop-${sessionId}`,
        sessionId,
        intent: { kind: "session.stop", reason: null, by: { kind: "user" } },
        provenance,
      });
    await engine.observe({
      id: `turn-${sessionId}`,
      sessionId,
      kind: "turn.started",
      occurredAt: 50,
      provenance,
      attachmentId: `a-${sessionId}`,
      turnId: `t-${sessionId}`,
    });
  }
  return { engine, create, resume, ticketId: ticket.id };
}

describe("Session resumption catch-up", () => {
  it("folds only Ticket Sessions with a start after a stop and repairs missing history exactly once at its original time", async () => {
    const f = fixture();
    const ticketSession = await f.create("ticket");
    const board = await f.create("project");
    const child = await f.create("subagent", ticketSession);
    const neverStopped = await f.create("ticket");
    const stopWithoutResume = await f.create("ticket");
    for (const sessionId of [ticketSession, board, child]) await f.resume(sessionId);
    await f.resume(neverStopped, false);
    await f.engine.submit({
      commandId: "stop-only",
      sessionId: stopWithoutResume,
      intent: { kind: "session.stop", reason: null, by: { kind: "user" } },
      provenance,
    });
    const getSession = vi.fn(f.engine.getSession);
    const publish = vi.fn();
    const report = vi.fn();
    recordTicketEvent(ctx.db, f.ticketId, { kind: "archived" }, 100);
    const cursor = currentTicketEventCursor(ctx.db);
    await catchUpSessionResumptions(ctx.db, { getSession }, { publish, report });
    expect(getSession.mock.calls).toEqual([[{ sessionId: ticketSession }]]);
    expect(listTicketEvents(ctx.db, f.ticketId)).toMatchObject([
      { createdAt: 50, payload: { kind: "session_resumed", sessionId: ticketSession } },
      { createdAt: 100, payload: { kind: "archived" } },
    ]);
    // The ticket-watch vocabulary cannot interpret the backfill as fresh news.
    expect(
      firstMatchingTicketEventAfter(
        ctx.db,
        [f.ticketId],
        ["status_changed", "commented", "signaled"],
        cursor,
      ),
    ).toBeUndefined();
    await catchUpSessionResumptions(ctx.db, { getSession }, { publish, report });
    expect(listTicketEvents(ctx.db, f.ticketId)).toHaveLength(2);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });

  it("reports failed candidate folds and continues to the next candidate", async () => {
    const f = fixture();
    const first = await f.create("ticket");
    const second = await f.create("ticket");
    await f.resume(first);
    await f.resume(second);
    const report = vi.fn();
    const getSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("fold failed"))
      .mockImplementation(f.engine.getSession);
    await catchUpSessionResumptions(ctx.db, { getSession }, { publish: vi.fn(), report });
    expect(report).toHaveBeenCalledTimes(1);
    expect(listTicketEvents(ctx.db, f.ticketId)).toHaveLength(1);
    ctx.db.close();
    await expect(
      catchUpSessionResumptions(ctx.db, { getSession }, { publish: vi.fn(), report }),
    ).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("contains a writer failure so the caller can continue its other observers", async () => {
    const f = fixture();
    const sessionId = await f.create("ticket");
    await f.resume(sessionId);
    const projection = (await f.engine.getSession({ sessionId }))!;
    const report = vi.fn();
    const runAttention = vi.fn();
    const schedule = vi.fn();
    const publishRow = vi.fn();
    const watch = watchSessionActivity(
      { ...f.engine, getSession: async () => projection },
      {
        publish: publishRow,
        observe: (current) => {
          observeSessionResumptions(ctx.db, current, { publish: vi.fn(), report });
          runAttention(current);
          schedule(current);
        },
      },
    );
    await watch.engine.submit({
      commandId: "retitle",
      sessionId,
      intent: { kind: "session.retitle", title: "New" },
      provenance,
    });
    ctx.db.close();
    await watch.flush();
    watch.stop();
    expect(report).toHaveBeenCalledTimes(1);
    expect(runAttention).toHaveBeenCalledWith(projection);
    expect(schedule).toHaveBeenCalledWith(projection);
    expect(publishRow).toHaveBeenCalledTimes(1);
  });
});
