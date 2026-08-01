import { afterEach, describe, expect, it } from "vite-plus/test";
import { createSessionEngine } from "@volli/session-engine";
import type { SessionLedger, SessionObservation } from "@volli/shared";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket } from "../db/test-helpers";
import type { TestDb } from "../db/test-helpers";
import { insertTicket } from "../db/tickets-repo";
import { createSqliteSessionLedger } from "./sqlite-ledger";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

function setup(): {
  ledger: SessionLedger;
  control: ReturnType<typeof createSessionEngine>;
  projectId: string;
} {
  ctx = openTestDb();
  const project = testProject({ id: "project" });
  insertProject(ctx.db, project);
  let id = 0;
  const ledger = createSqliteSessionLedger(ctx.db);
  return {
    ledger,
    control: createSessionEngine({
      ledger,
      clock: { now: () => 100 + id },
      ids: { next: (kind) => `${kind}-${++id}` },
    }),
    projectId: project.id,
  };
}

const provenance = {
  source: { kind: "system" as const, id: "desktop", detail: null },
  venue: { id: "local", kind: "local" as const },
};

describe("SqliteSessionLedger", () => {
  it("commits a complete create fact set once, replays it idempotently, and orders cloned reads", async () => {
    const { control, projectId } = setup();
    const first = await control.createSession({
      commandId: "create-a",
      projectId,
      ticketId: null,
      title: "One",
      provenance,
    });
    const replay = await control.createSession({
      commandId: "create-a",
      projectId,
      ticketId: null,
      title: "One",
      provenance,
    });
    const second = await control.createSession({
      commandId: "create-b",
      projectId,
      ticketId: null,
      title: "Two",
      provenance,
    });

    expect(replay).toEqual(first);
    expect(
      (await control.listSessions({ projectId, scope: "all" })).map((item) => item.session.id),
    ).toEqual([second.session.id, first.session.id]);
    const page = await control.listEvents({
      sessionId: first.session.id,
      afterSequence: 1,
      limit: 2,
    });
    expect(page.map((event) => event.sequence)).toEqual([2, 3]);
    page[0]!.payload = { kind: "session.archived" };
    expect((await control.listEvents({ sessionId: first.session.id }))[1]!.payload.kind).toBe(
      "session.created",
    );
  });

  it("serializes async transactions and rolls a failed transaction back", async () => {
    const { ledger, control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create",
      projectId,
      ticketId: null,
      title: "One",
      provenance,
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = ledger.transaction(async (tx) => {
      expect(tx.getSession(created.session.id)?.id).toBe(created.session.id);
      await gate;
    });
    const second = ledger.transaction((tx) => {
      expect(tx.getSession(created.session.id)?.id).toBe(created.session.id);
    });
    await Promise.resolve();
    release?.();
    await Promise.all([first, second]);

    await expect(
      ledger.transaction((tx) => {
        tx.appendEvent({
          id: "bad-event",
          sessionId: created.session.id,
          sequence: 99,
          occurredAt: 1,
          recordedAt: 1,
          provenance,
          payload: { kind: "session.archived" },
        });
      }),
    ).rejects.toThrow("sequence must be monotonic");
    expect(await control.listEvents({ sessionId: created.session.id })).toHaveLength(3);
  });

  it("replays omitted and null event envelope ids through a durable SQLite read", async () => {
    const { control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-null-envelope",
      projectId,
      ticketId: null,
      title: "Null envelope",
      provenance,
    });
    const observation = {
      id: "null-envelope-observation",
      sessionId: created.session.id,
      occurredAt: 200,
      provenance,
      kind: "adapter.observed" as const,
      name: "session-wide",
      native: null,
    };

    const recorded = await control.observe(observation as SessionObservation);
    const replayed = await control.observe({
      ...observation,
      attachmentId: null,
      commandId: null,
    });

    expect(replayed).toMatchObject({
      id: recorded.id,
      sessionId: recorded.sessionId,
      sequence: recorded.sequence,
      payload: recorded.payload,
    });
    expect(replayed.attachmentId ?? null).toBeNull();
    expect(replayed.commandId ?? null).toBeNull();
  });

  it("does not make an unrelated append transaction fail on pre-existing receipt corruption", async () => {
    const { control, projectId } = setup();
    const first = await control.createSession({
      commandId: "create-corrupt-prior",
      projectId,
      ticketId: null,
      title: "Prior",
      provenance,
    });
    ctx.db
      .prepare("UPDATE session_command_receipts SET receipt_event_id = NULL WHERE id = ?")
      .run(first.receipt.id);

    await expect(
      control.createSession({
        commandId: "create-unrelated",
        projectId,
        ticketId: null,
        title: "Unrelated",
        provenance,
      }),
    ).resolves.toMatchObject({ session: { title: "Unrelated" } });
  });

  it("reads only the latest explicit signal for each ticket without projecting all Session history", async () => {
    const { control, projectId } = setup();
    insertTicket(ctx.db, testTicket(projectId, { id: "ticket-a", usesWorktree: false }));
    const first = await control.createSession({
      commandId: "create-signal-first",
      projectId,
      ticketId: "ticket-a",
      title: "First",
      provenance,
    });
    await control.submit({
      commandId: "signal-first",
      sessionId: first.session.id,
      intent: { kind: "session.signal", signal: "done", reason: "First result" },
      provenance,
    });
    const second = await control.createSession({
      commandId: "create-signal-second",
      projectId,
      ticketId: "ticket-a",
      title: "Second",
      provenance,
    });
    await control.submit({
      commandId: "signal-second",
      sessionId: second.session.id,
      intent: { kind: "session.signal", signal: "blocked", reason: "Latest result" },
      provenance,
    });

    await expect(control.listLatestTicketSignals({ projectId })).resolves.toEqual([
      {
        ticketId: "ticket-a",
        sessionId: second.session.id,
        signal: "blocked",
        reason: "Latest result",
        createdAt: 114,
      },
    ]);
  });

  it("ignores a malformed persisted signal instead of failing the ticket projection", async () => {
    const { control, projectId } = setup();
    insertTicket(
      ctx.db,
      testTicket(projectId, { id: "ticket-invalid-signal", usesWorktree: false }),
    );
    const created = await control.createSession({
      commandId: "create-invalid-signal",
      projectId,
      ticketId: "ticket-invalid-signal",
      title: "Invalid signal",
      provenance,
    });
    ctx.db
      .prepare(
        `INSERT INTO session_events
           (id, session_id, sequence, occurred_at, recorded_at, provenance, attachment_id, command_id, payload)
         VALUES ('invalid-signal', ?, 4, 104, 104, ?, NULL, NULL, ?)`,
      )
      .run(
        created.session.id,
        JSON.stringify(provenance),
        JSON.stringify({ kind: "session.signaled", signal: "unexpected", reason: "Corrupt row" }),
      );

    await expect(control.listLatestTicketSignals({ projectId })).resolves.toEqual([]);
  });

  it("persists attachment evidence atomically and refuses a corrupt JSON row on read", async () => {
    const { control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create",
      projectId,
      ticketId: null,
      title: "One",
      provenance,
    });
    const start = await control.submit({
      commandId: "start",
      sessionId: created.session.id,
      intent: { kind: "executor.start", adapterId: "terminal", continuity: "fresh" },
      provenance,
    });
    await control.observe({
      id: "opened",
      kind: "attachment.opened",
      sessionId: created.session.id,
      commandId: start.command.id,
      occurredAt: 200,
      provenance,
      attachment: {
        id: "attachment",
        sessionId: created.session.id,
        adapterId: "terminal",
        venue: { id: "local", kind: "local" },
        continuity: "fresh",
        native: { id: null, detail: { kind: "volli.terminal.v1", cwd: "/repo" } },
      },
    });
    expect(
      ctx.db.prepare("SELECT created_sequence, observed_kind FROM session_attachments").get(),
    ).toEqual({ created_sequence: 5, observed_kind: "opened" });

    ctx.db.pragma("ignore_check_constraints = ON");
    ctx.db.prepare("UPDATE session_events SET provenance = '{' WHERE id = ?").run(created.event.id);
    ctx.db.pragma("ignore_check_constraints = OFF");
    await expect(control.listEvents({ sessionId: created.session.id })).rejects.toThrow(
      "contains invalid JSON",
    );
  });
});
