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

/** No executor binding is open: these rows rest at not-live. */
const noOpenBindings = () => [];

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
  async function resume(sessionId: string, stopFirst = true, reopen = true) {
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
    if (!reopen) {
      // Admitted before stop, observed after it: not a successful reopening.
      await engine.observe({
        id: `racing-turn-${sessionId}`,
        sessionId,
        kind: "turn.started",
        occurredAt: 50,
        attachmentId: `a-${sessionId}`,
        turnId: `t-${sessionId}`,
        provenance,
      });
      return;
    }
    await engine.observe({
      id: `closed-${sessionId}`,
      sessionId,
      kind: "attachment.closed",
      occurredAt: 25,
      attachmentId: `a-${sessionId}`,
      outcome: "interrupted",
      provenance,
    });
    await engine.submit({
      commandId: `reattach-${sessionId}`,
      sessionId,
      intent: { kind: "executor.start", adapterId: "pi", continuity: "context_replay" },
      provenance: {
        ...provenance,
        source: {
          ...provenance.source,
          detail: { sessionOrigin: { kind: "volli", reason: "relaunch-recovery" } },
        },
      },
    });
    await engine.observe({
      id: `reopened-${sessionId}`,
      commandId: `reattach-${sessionId}`,
      sessionId,
      kind: "attachment.opened",
      occurredAt: 50,
      provenance,
      attachment: {
        id: `b-${sessionId}`,
        sessionId,
        adapterId: "pi",
        venue: provenance.venue,
        continuity: "context_replay",
        native: null,
        authority: null,
      },
    });
  }
  return { engine, create, resume, ticketId: ticket.id };
}

describe("Session resumption catch-up", () => {
  it("folds Ticket-bound Sessions including children with a later attachment and no turn and repairs missing history exactly once at its original time", async () => {
    const f = fixture();
    const ticketSession = await f.create("ticket");
    const board = await f.create("project");
    const child = await f.create("subagent", ticketSession);
    const neverStopped = await f.create("ticket");
    const stopWithoutResume = await f.create("ticket");
    for (const sessionId of [ticketSession, board, child]) await f.resume(sessionId);
    await f.resume(neverStopped, false);
    await f.resume(stopWithoutResume, true, false);
    const getSession = vi.fn(f.engine.getSession);
    const publish = vi.fn();
    const report = vi.fn();
    recordTicketEvent(ctx.db, f.ticketId, { kind: "archived" }, 100);
    const cursor = currentTicketEventCursor(ctx.db);
    await catchUpSessionResumptions(ctx.db, { getSession }, { publish, report });
    expect(getSession.mock.calls.map(([query]) => query.sessionId).toSorted()).toEqual(
      [ticketSession, child, neverStopped].toSorted(),
    );
    const history = listTicketEvents(ctx.db, f.ticketId);
    expect(history).toHaveLength(4);
    expect(history.at(-1)).toMatchObject({ createdAt: 100, payload: { kind: "archived" } });
    expect(history.slice(0, 3)).toEqual(
      expect.arrayContaining(
        [ticketSession, child, neverStopped].map((sessionId) =>
          expect.objectContaining({
            createdAt: 50,
            payload: {
              kind: "session_resumed",
              sessionId,
              attachmentId: `b-${sessionId}`,
              origin: { kind: "volli", reason: "relaunch-recovery" },
            },
          }),
        ),
      ),
    );
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
    expect(listTicketEvents(ctx.db, f.ticketId)).toHaveLength(4);
    expect(publish).toHaveBeenCalledTimes(3);
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
        listOpenNativeBindings: noOpenBindings,
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
