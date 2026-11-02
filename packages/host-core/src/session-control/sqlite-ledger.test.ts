import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createSessionEngine } from "@volli/session-engine";
import {
  createSessionProjectionCheckpoint,
  LOCAL_RUNNER,
  roleImpliedByTicket,
  SESSION_PROJECTION_CHECKPOINT_VERSION,
} from "@volli/shared";
import type { SessionEvent, SessionLedger, SessionObservation, SessionUsage } from "@volli/shared";
import { insertProject } from "../db/projects-repo";
import { internSessionEventProvenance } from "../db/session-event-provenance";
import { openTestDb, testProject, testTicket } from "../db/test-helpers";
import type { TestDb } from "../db/test-helpers";
import { insertTicket } from "../db/tickets-repo";
import { workingSessionCount } from "../session-concurrency";
import { createSqliteSessionLedger } from "./sqlite-ledger";
import { localSessionRow, sessionBirthOwnerCompatible } from "../db/local-product";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

function setup(clock?: () => number): {
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
      clock: clock === undefined ? { now: () => 100 + id } : { now: clock },
      ids: { next: (kind) => `${kind}-${++id}` },
    }),
    projectId: project.id,
  };
}

const provenance = {
  source: { kind: "system" as const, id: "desktop", detail: null },
  venue: { id: "local", kind: "local" as const },
};

function provenanceId(): number {
  return internSessionEventProvenance(ctx.db, JSON.stringify(provenance));
}

/**
 * A relaunch's read: a fresh engine over the same ledger. Tests that rewrite
 * history beneath the insert-only contract use it, because a live engine may
 * answer from the fold it already holds (VC-1076), exactly as it is entitled
 * to for history nothing can rewrite.
 */
function rereadSession(ledger: SessionLedger, sessionId: string) {
  return createSessionEngine({
    ledger,
    clock: { now: () => 100 },
    ids: { next: (kind) => `${kind}-reread` },
  }).getSession({ sessionId });
}

// The port's guarantees — ordering, rollback, sequences, receipts, signals,
// usage scope, checkpoints — are the shared contract, run against this adapter
// in `sqlite-ledger.contract.test.ts`. These are what only SQLite has: its
// codecs, its corrupt-row tolerance, its projections and statement cache.
describe("SqliteSessionLedger", () => {
  it("stores and reads back the Role and the parent link as Session columns (VC-9)", async () => {
    const { control, projectId } = setup();
    const parent = await control.createSession({
      commandId: "create-parent",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Parent",
      provenance,
    });
    const helper = await control.createSession({
      commandId: "create-helper",
      projectId,
      ticketId: null,
      role: "subagent",
      parentSessionId: parent.session.id,
      title: "Helper",
      provenance,
    });

    const read = await control.getSession({ sessionId: helper.session.id });
    expect(read?.session).toMatchObject({
      role: "subagent",
      parentSessionId: parent.session.id,
    });
    expect((await control.getSession({ sessionId: parent.session.id }))?.session).toMatchObject({
      role: "project",
      parentSessionId: null,
    });
    // The listing reads the same columns, so a rail never has to fold events
    // to learn which of its rows is a helper and whose.
    expect(
      (await control.listSessions({ projectId, scope: "all" })).map(({ session }) => [
        session.id,
        session.parentSessionId,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [parent.session.id, null],
        [helper.session.id, parent.session.id],
      ]),
    );
  });

  it("round-trips a rebuildable projection checkpoint and rejects corrupt or ahead rows", async () => {
    const { control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-checkpoint",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Checkpoint",
      provenance,
    });
    const events = await control.listEvents({ sessionId: created.session.id });
    const checkpoint = createSessionProjectionCheckpoint(created.session, events);

    await control.saveProjectionCheckpoint(checkpoint);
    await expect(
      control.getProjectionCheckpoint({ sessionId: created.session.id }),
    ).resolves.toEqual(checkpoint);

    ctx.db
      .prepare(
        "UPDATE session_projection_checkpoints SET checkpoint = json_set(checkpoint, '$.sessionId', 'corrupt') WHERE session_id = ?",
      )
      .run(created.session.id);
    await expect(
      control.getProjectionCheckpoint({ sessionId: created.session.id }),
    ).resolves.toBeNull();

    await control.saveProjectionCheckpoint(checkpoint);
    ctx.db
      .prepare(
        "UPDATE session_projection_checkpoints SET through_sequence = 999 WHERE session_id = ?",
      )
      .run(created.session.id);
    await expect(
      control.getProjectionCheckpoint({ sessionId: created.session.id }),
    ).resolves.toBeNull();
  });

  // Call order and rollback are the shared contract's (sqlite-ledger.contract.test.ts).
  // Running the work before `transaction` even returns is this adapter's own.
  it("runs transaction work synchronously, before the call returns", async () => {
    const { ledger, control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "One",
      provenance,
    });
    const order: string[] = [];
    const first = ledger.transaction((tx) => {
      expect(tx.getSession(created.session.id)?.id).toBe(created.session.id);
      order.push("first");
    });
    const second = ledger.transaction((tx) => {
      expect(tx.getSession(created.session.id)?.id).toBe(created.session.id);
      order.push("second");
    });
    expect(order).toEqual(["first", "second"]);
    await Promise.all([first, second]);
  });

  it("round-trips the immutable Runtime Brief input through SQLite", async () => {
    const { control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-brief",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Brief",
      provenance,
    });

    await expect(
      control.getOrRecordSessionInput({
        sessionId: created.session.id,
        input: { kind: "runtime-brief", text: "original bytes" },
        provenance,
      }),
    ).resolves.toEqual({ kind: "runtime-brief", text: "original bytes" });

    expect(
      (await control.listEvents({ sessionId: created.session.id })).filter(
        (event) => event.payload.kind === "session.input.recorded",
      ),
    ).toEqual([
      expect.objectContaining({
        payload: {
          kind: "session.input.recorded",
          input: { kind: "runtime-brief", text: "original bytes" },
        },
      }),
    ]);
  });

  it("round-trips the prompt-resources input through SQLite", async () => {
    const { control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-resources",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Skills",
      provenance,
    });
    const input = {
      kind: "prompt-resources" as const,
      resources: [{ name: "svg-logo-designer", text: "# Logos\n\nDo the thing." }],
    };

    await expect(
      control.getOrRecordSessionInput({ sessionId: created.session.id, input, provenance }),
    ).resolves.toEqual(input);

    expect(
      (await control.listEvents({ sessionId: created.session.id })).filter(
        (event) => event.payload.kind === "session.input.recorded",
      ),
    ).toEqual([expect.objectContaining({ payload: { kind: "session.input.recorded", input } })]);
  });

  it("round-trips the immutable Agent Tool Surface without credential data", async () => {
    const { control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-tool-surface",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Tools",
      provenance,
    });
    const input = {
      kind: "tool-surface" as const,
      tools: ["read", "edit", "write", "execute", "ask_user", "web_fetch", "web_search"] as const,
    };

    await expect(
      control.getOrRecordSessionInput({ sessionId: created.session.id, input, provenance }),
    ).resolves.toEqual(input);

    expect(
      (await control.listEvents({ sessionId: created.session.id })).filter(
        (event) => event.payload.kind === "session.input.recorded",
      ),
    ).toEqual([expect.objectContaining({ payload: { kind: "session.input.recorded", input } })]);
  });

  it("round-trips durable model selection through SQLite", async () => {
    const { control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-model-selection",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Model selection",
      provenance,
    });
    const selection = {
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high" as const,
    };

    await control.submit({
      commandId: "select-model",
      sessionId: created.session.id,
      intent: { kind: "model.select", selection },
      provenance,
    });

    const projection = await control.getSession({ sessionId: created.session.id });
    expect(projection?.modelSelection).toEqual(selection);
    expect(projection?.commands.map((command) => command.intent.kind)).toEqual([
      "session.create",
      "model.select",
    ]);
    expect(
      projection?.receipts.some(
        (receipt) => receipt.status === "completed" && receipt.result.kind === "model.selected",
      ),
    ).toBe(true);
  });

  it("rejects an unsupported persisted model reasoning level", async () => {
    const { control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-invalid-model-selection",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Invalid model selection",
      provenance,
    });
    const selection = {
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high" as const,
    };
    await control.submit({
      commandId: "select-invalid-model",
      sessionId: created.session.id,
      intent: { kind: "model.select", selection },
      provenance,
    });
    const selected = (await control.listEvents({ sessionId: created.session.id })).find(
      (event) => event.payload.kind === "model.selected",
    );
    expect(selected).toBeDefined();
    ctx.db.prepare("UPDATE session_events SET payload = ? WHERE id = ?").run(
      JSON.stringify({
        kind: "model.selected",
        selection: { ...selection, reasoningLevel: "extreme" },
      }),
      selected!.id,
    );

    await expect(control.getSession({ sessionId: created.session.id })).rejects.toThrow(
      "payload.selection.reasoningLevel has an unsupported value",
    );
  });

  it("round-trips an explicit executor retry command and receipt", async () => {
    const { ledger, control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-retry",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Retry",
      provenance,
    });
    await ledger.transaction((transaction) => {
      const command = {
        id: "retry-command",
        sessionId: created.session.id,
        createdAt: 200,
        intent: { kind: "executor.retry" as const, attachmentId: "attachment-1" },
        route: { adapterId: "pi", attachmentId: "attachment-1" },
      };
      transaction.saveCommand(command);
      transaction.appendEvent({
        id: "retry-command-event",
        sessionId: created.session.id,
        sequence: 4,
        occurredAt: 200,
        recordedAt: 200,
        provenance,
        commandId: "retry-command",
        payload: {
          kind: "command.recorded",
          command,
        },
      });
      const receipt = {
        id: "retry-receipt",
        commandId: "retry-command",
        status: "accepted" as const,
        acceptedAt: 201,
        recordedAt: 201,
        sequence: 5,
        result: { kind: "executor.retried" as const, sessionId: created.session.id },
      };
      transaction.appendReceipt(receipt);
      transaction.appendEvent({
        id: "retry-receipt-event",
        sessionId: created.session.id,
        sequence: 5,
        occurredAt: 201,
        recordedAt: 201,
        provenance,
        commandId: "retry-command",
        payload: {
          kind: "command.receipt.recorded",
          receipt,
        },
      });
    });

    expect((await control.listEvents({ sessionId: created.session.id })).slice(-2)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          command: expect.objectContaining({
            intent: { kind: "executor.retry", attachmentId: "attachment-1" },
          }),
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          receipt: expect.objectContaining({
            result: { kind: "executor.retried", sessionId: created.session.id },
          }),
        }),
      }),
    ]);
  });

  it("replays omitted and null event envelope ids through a durable SQLite read", async () => {
    const { control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-null-envelope",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
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

  it("round-trips an interrupted turn as its own durable fact", async () => {
    const { ledger, control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-interrupted-turn",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Interrupted turn",
      provenance,
    });

    await ledger.transaction((transaction) => {
      transaction.appendEvent({
        id: "turn-interrupted-event",
        sessionId: created.session.id,
        sequence: 4,
        occurredAt: 200,
        recordedAt: 201,
        provenance,
        payload: {
          kind: "turn.interrupted",
          attachmentId: "attachment-1",
          turnId: "turn-1",
        },
      });
    });

    expect((await control.listEvents({ sessionId: created.session.id })).at(-1)?.payload).toEqual({
      kind: "turn.interrupted",
      attachmentId: "attachment-1",
      turnId: "turn-1",
    });
  });

  it("opens a recorded authority denial as inert evidence without rewriting its bytes", async () => {
    const { control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-legacy-denial",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Legacy history",
      provenance,
    });
    const raw = JSON.stringify({
      kind: "authority.denied",
      attachmentId: "attachment-1",
      turnId: null,
      tool: "bash",
      cause: "command.destructive-removal",
      reason: "Recorded refusal",
    });
    ctx.db
      .prepare(`INSERT INTO session_events
      (id, session_id, sequence, occurred_at, recorded_at, provenance_id, payload)
      VALUES ('legacy-denial', ?, 4, 200, 201, ?, ?)`)
      .run(created.session.id, provenanceId(), raw);
    expect(
      (await control.listEvents({ sessionId: created.session.id })).at(-1)?.payload,
    ).toMatchObject({
      kind: "adapter.observed",
      name: "Legacy authority.denied",
      native: null,
    });
    expect(
      (await control.getSession({ sessionId: created.session.id }))?.interactions.active,
    ).toEqual([]);
    expect(
      ctx.db.prepare("SELECT payload FROM session_events WHERE id = 'legacy-denial'").get(),
    ).toEqual({ payload: raw });
  });

  it("does not make an unrelated append transaction fail on pre-existing receipt corruption", async () => {
    const { control, projectId } = setup();
    const first = await control.createSession({
      commandId: "create-corrupt-prior",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
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
        role: "project",
        parentSessionId: null,
        title: "Unrelated",
        provenance,
      }),
    ).resolves.toMatchObject({ session: { title: "Unrelated" } });
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
      role: "ticket",
      parentSessionId: null,
      title: "Invalid signal",
      provenance,
    });
    ctx.db
      .prepare(
        `INSERT INTO session_events
           (id, session_id, sequence, occurred_at, recorded_at, provenance_id, attachment_id, command_id, payload)
         VALUES ('invalid-signal', ?, 4, 104, 104, ?, NULL, NULL, ?)`,
      )
      .run(
        created.session.id,
        provenanceId(),
        JSON.stringify({ kind: "session.signaled", signal: "unexpected", reason: "Corrupt row" }),
      );

    await expect(control.listLatestTicketSignals({ projectId })).resolves.toEqual([]);
  });

  it("reads latest ticket signals through the kind index with the same rows as the full event join (VC-1075)", async () => {
    let now = 1_000;
    const { control, projectId } = setup(() => now);
    insertProject(ctx.db, testProject({ id: "project-other" }));
    const tickets = ["ticket-a", "Ticket-b", "ticket-c", "ticket-d"];
    for (const id of tickets)
      insertTicket(ctx.db, testTicket(projectId, { id, usesWorktree: false }));
    insertTicket(ctx.db, testTicket("project-other", { id: "ticket-other", usesWorktree: false }));
    const sessions: string[] = [];
    const homes: [string, string | null][] = [
      ...tickets.flatMap((ticketId) => [
        [projectId, ticketId] as [string, string | null],
        [projectId, ticketId] as [string, string | null],
      ]),
      [projectId, "ticket-c"],
      [projectId, null],
      ["project-other", "ticket-other"],
    ];
    for (const [index, [home, ticketId]] of homes.entries()) {
      const created = await control.createSession({
        commandId: `create-${index}`,
        projectId: home,
        ticketId,
        role: ticketId === null ? "project" : "ticket",
        parentSessionId: null,
        title: `Session ${index}`,
        provenance,
      });
      sessions.push(created.session.id);
    }
    // A fixed pseudo-random walk: signals and unrelated facts interleave, the
    // clock jumps backwards and repeats, and one ticket (`ticket-d`'s second
    // Session aside) has Sessions that never signal at all.
    let seed = 7;
    const next = (bound: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % bound;
    };
    for (let step = 0; step < 120; step += 1) {
      const sessionId = sessions[next(sessions.length)]!;
      now += next(5) - 2;
      const roll = next(3);
      await control.submit({
        commandId: `step-${step}`,
        sessionId,
        intent:
          roll === 0
            ? { kind: "session.retitle", title: `Title ${step}` }
            : {
                kind: "session.signal",
                signal: roll === 1 ? "done" : "blocked",
                reason: step % 4 === 0 ? null : `step ${step}`,
              },
        provenance,
      });
    }
    // A malformed signal as one Session's latest signal row: both reads skip
    // it and fall back to that Session's previous well-formed signal.
    const corrupted = sessions[0]!;
    const head = ctx.db
      .prepare("SELECT MAX(sequence) AS sequence FROM session_events WHERE session_id = ?")
      .get(corrupted) as { sequence: number };
    ctx.db
      .prepare(
        `INSERT INTO session_events
           (id, session_id, sequence, occurred_at, recorded_at, provenance_id, attachment_id, command_id, payload)
         VALUES ('malformed-signal', ?, ?, 5000, 5000, ?, NULL, NULL, ?)`,
      )
      .run(
        corrupted,
        head.sequence + 1,
        provenanceId(),
        JSON.stringify({ kind: "session.signaled", signal: "unexpected", reason: null }),
      );

    // The pre-VC-1075 statement, verbatim: every event of every ticketed
    // Session, kind read from the payload. It is the reference, not the path.
    const reference = ctx.db
      .prepare(
        `WITH latest_session_signals AS (
           SELECT s.ticket_id AS ticket_id, s.id AS session_id,
                  json_extract(e.payload, '$.signal') AS signal,
                  json_extract(e.payload, '$.reason') AS reason,
                  e.occurred_at AS occurred_at, es.sequence AS accepted_sequence,
                  ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY e.sequence DESC) AS session_rank
             FROM sessions s
             JOIN session_events e ON e.session_id = s.id
             JOIN session_event_sequence es ON es.event_id = e.id
            WHERE s.project_id = @projectId
              AND s.ticket_id IS NOT NULL
              AND json_extract(e.payload, '$.kind') = 'session.signaled'
              AND json_extract(e.payload, '$.signal') IN ('done', 'blocked')
         ), latest_ticket_signals AS (
           SELECT ticket_id, session_id, signal, reason, occurred_at,
                  ROW_NUMBER() OVER (PARTITION BY ticket_id ORDER BY accepted_sequence DESC) AS ticket_rank
             FROM latest_session_signals WHERE session_rank = 1
         )
         SELECT ticket_id, session_id, signal, reason, occurred_at
           FROM latest_ticket_signals WHERE ticket_rank = 1
          ORDER BY ticket_id COLLATE BINARY ASC`,
      )
      .all({ projectId }) as {
      ticket_id: string;
      session_id: string;
      signal: "done" | "blocked";
      reason: string | null;
      occurred_at: number;
    }[];
    expect(reference.map((row) => row.ticket_id)).toEqual([
      "Ticket-b",
      "ticket-a",
      "ticket-c",
      "ticket-d",
    ]);
    await expect(control.listLatestTicketSignals({ projectId })).resolves.toEqual(
      reference.map((row) => ({
        ticketId: row.ticket_id,
        sessionId: row.session_id,
        signal: row.signal,
        reason: row.reason,
        createdAt: row.occurred_at,
      })),
    );
    await expect(control.listLatestTicketSignals({ projectId: "project-other" })).resolves.toEqual([
      expect.objectContaining({ ticketId: "ticket-other" }),
    ]);
  });

  it("accepts a write to a Session whose older receipt pairing is corrupt, and still refuses its own (VC-1075)", async () => {
    const { control, ledger, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-corrupt-own",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Prior",
      provenance,
    });
    ctx.db
      .prepare("UPDATE session_command_receipts SET receipt_event_id = NULL WHERE id = ?")
      .run(created.receipt.id);

    // Only the pairs a write makes are checked at its boundary, so older
    // history in the same Session no longer fails every later write.
    await expect(
      control.submit({
        commandId: "retitle-after-corruption",
        sessionId: created.session.id,
        intent: { kind: "session.retitle", title: "Later" },
        provenance,
      }),
    ).resolves.toMatchObject({ receipt: { commandId: "retitle-after-corruption" } });

    const before = ctx.db.prepare("SELECT COUNT(*) AS count FROM session_command_receipts").get();
    await expect(
      ledger.transaction((transaction) => {
        transaction.saveCommand({
          id: "command-unpaired",
          sessionId: created.session.id,
          createdAt: 500,
          intent: { kind: "session.retitle", title: "Unpaired" },
          route: null,
        });
        transaction.appendReceipt({
          ...created.receipt,
          id: "receipt-unpaired",
          commandId: "command-unpaired",
          sequence: 99,
          recordedAt: 500,
        });
      }),
    ).rejects.toThrow("Receipt receipt-unpaired has no matching event");
    expect(ctx.db.prepare("SELECT COUNT(*) AS count FROM session_command_receipts").get()).toEqual(
      before,
    );
  });

  it("writes LOCAL_RUNNER as the shipped local/local columns and provenance bytes", async () => {
    // The frozen desktop identity: older builds and boot recovery read these
    // exact values, so naming the literal must not move a byte on disk.
    const { control, projectId } = setup();
    const local = {
      source: { kind: "system" as const, id: "desktop", detail: null },
      venue: LOCAL_RUNNER,
    };
    const created = await control.createSession({
      commandId: "create",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "One",
      provenance: local,
    });
    const start = await control.submit({
      commandId: "start",
      sessionId: created.session.id,
      intent: { kind: "executor.start", adapterId: "terminal", continuity: "fresh" },
      provenance: local,
    });
    await control.observe({
      id: "opened",
      kind: "attachment.opened",
      sessionId: created.session.id,
      commandId: start.command.id,
      occurredAt: 200,
      provenance: local,
      attachment: {
        id: "attachment",
        sessionId: created.session.id,
        adapterId: "terminal",
        venue: LOCAL_RUNNER,
        continuity: "fresh",
        native: { id: null, detail: { kind: "volli.terminal.v1", cwd: "/repo" } },
        authority: null,
      },
    });
    expect(ctx.db.prepare("SELECT venue_id, venue_kind FROM session_attachments").get()).toEqual({
      venue_id: "local",
      venue_kind: "local",
    });
    expect(
      ctx.db
        .prepare(
          `SELECT DISTINCT p.provenance FROM session_events e
             JOIN session_provenances p ON p.id = e.provenance_id
            WHERE e.session_id = ?`,
        )
        .all(created.session.id),
    ).toEqual([
      {
        provenance:
          '{"source":{"kind":"system","id":"desktop","detail":null},"venue":{"id":"local","kind":"local"}}',
      },
    ]);
  });

  it("persists attachment evidence atomically and refuses a corrupt JSON row on read", async () => {
    const { control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
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
        authority: null,
      },
    });
    expect(
      ctx.db.prepare("SELECT created_sequence, observed_kind FROM session_attachments").get(),
    ).toEqual({ created_sequence: 5, observed_kind: "opened" });

    ctx.db.pragma("ignore_check_constraints = ON");
    ctx.db
      .prepare(
        `UPDATE session_provenances
            SET provenance = '{'
          WHERE id = (SELECT provenance_id FROM session_events WHERE id = ?)`,
      )
      .run(created.event.id);
    ctx.db.pragma("ignore_check_constraints = OFF");
    await expect(control.listEvents({ sessionId: created.session.id })).rejects.toThrow(
      "contains invalid JSON",
    );
  });

  it("fails loudly instead of dropping events whose provenance row is missing", async () => {
    const { control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-missing-provenance",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Missing provenance",
      provenance,
    });
    ctx.db.pragma("foreign_keys = OFF");
    ctx.db
      .prepare(
        `DELETE FROM session_provenances
          WHERE id = (SELECT provenance_id FROM session_events WHERE id = ?)`,
      )
      .run(created.event.id);

    await expect(control.listEvents({ sessionId: created.session.id })).rejects.toThrow(
      /missing.*provenance/i,
    );
  });

  it("round-trips interaction facts through strict SQLite decoding", async () => {
    const { control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-structured",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Structured",
      provenance,
    });
    const start = await control.submit({
      commandId: "start-structured",
      sessionId: created.session.id,
      intent: { kind: "executor.start", adapterId: "opencode", continuity: "fresh" },
      provenance,
    });
    const adapterProvenance = {
      source: { kind: "adapter" as const, id: "opencode", detail: null },
      venue: { id: "local", kind: "local" as const },
    };
    await control.observe({
      id: "opened-structured",
      kind: "attachment.opened",
      sessionId: created.session.id,
      commandId: start.command.id,
      occurredAt: 200,
      provenance: adapterProvenance,
      attachment: {
        id: "attachment-structured",
        sessionId: created.session.id,
        adapterId: "opencode",
        venue: { id: "local", kind: "local" },
        continuity: "fresh",
        native: { id: "native-1", detail: null },
        authority: null,
      },
    });
    await control.observe({
      id: "interaction-opened-structured",
      kind: "interaction.opened",
      sessionId: created.session.id,
      attachmentId: "attachment-structured",
      occurredAt: 202,
      provenance: adapterProvenance,
      interaction: {
        id: "permission-1",
        attachmentId: "attachment-structured",
        kind: "permission",
        title: "Allow write?",
        detail: null,
        // The shape every real adapter writes: `description` is `string | null`
        // and OpenCode's own permission options carry the null. Covering this
        // only with a string is what let a decoder that rejected null survive —
        // and rejecting it killed the event, so no permission was ever durable.
        options: [
          { id: "once", label: "Allow once", description: null },
          { id: "reject", label: "Reject", description: "Refuse this request" },
        ],
        multiple: false,
        native: { id: "native-permission-1", detail: null },
      },
    });
    const resolution = await control.submit({
      commandId: "resolve-structured",
      sessionId: created.session.id,
      intent: {
        kind: "interaction.resolve",
        attachmentId: "attachment-structured",
        interactionId: "permission-1",
        resolution: { optionIds: ["once"], response: null },
        reference: {
          id: "sha256:resolution",
          digest: "sha256:resolution",
          mediaType: "application/vnd.volli.ui-message+json;version=1",
        },
      },
      provenance,
    });
    await control.observe({
      id: "interaction-resolved-structured",
      kind: "interaction.resolved",
      sessionId: created.session.id,
      attachmentId: "attachment-structured",
      occurredAt: 203,
      provenance: adapterProvenance,
      commandId: resolution.command.id,
      interactionId: "permission-1",
      resolution: { optionIds: ["once"], response: null },
    });
    await control.observe({
      id: "resolution-receipt-structured",
      kind: "command.receipt",
      sessionId: created.session.id,
      attachmentId: "attachment-structured",
      occurredAt: 204,
      provenance: adapterProvenance,
      receipt: {
        id: "receipt-resolution-structured",
        commandId: resolution.command.id,
        status: "accepted",
        acceptedAt: 204,
        result: { kind: "interaction.resolved", sessionId: created.session.id },
      },
    });

    const projection = await control.getSession({ sessionId: created.session.id });
    expect(projection).toMatchObject({
      interactions: { active: [], resolved: [{ interaction: { id: "permission-1" } }] },
    });
    // Both option shapes survive the round trip to SQLite and back.
    expect(projection?.interactions.resolved[0]?.interaction.options).toEqual([
      { id: "once", label: "Allow once", description: null },
      { id: "reject", label: "Reject", description: "Refuse this request" },
    ]);
    expect(projection?.commands.at(-1)).toMatchObject({
      intent: { kind: "interaction.resolve", interactionId: "permission-1" },
    });
    expect(projection?.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          result: expect.objectContaining({ kind: "interaction.resolved" }),
        }),
      ]),
    );
    // A record written before interactions carried per-question detail decodes
    // back without the keys — not with an empty array, and not with one
    // synthesised from the flat fields. `readInteractionPrompts` is what turns
    // absence into a single prompt, and only at the read seam.
    const resolved = projection?.interactions.resolved[0];
    expect(resolved && "prompts" in resolved.interaction).toBe(false);
    expect(resolved && "answers" in resolved.resolution).toBe(false);
    expect(resolved?.resolution).toEqual({ optionIds: ["once"], response: null });
  });

  it("round-trips an interaction's prompts and a resolution's answers through SQLite", async () => {
    const { control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-prompts",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Prompts",
      provenance,
    });
    const start = await control.submit({
      commandId: "start-prompts",
      sessionId: created.session.id,
      intent: { kind: "executor.start", adapterId: "opencode", continuity: "fresh" },
      provenance,
    });
    const adapterProvenance = {
      source: { kind: "adapter" as const, id: "opencode", detail: null },
      venue: { id: "local", kind: "local" as const },
    };
    await control.observe({
      id: "opened-prompts",
      kind: "attachment.opened",
      sessionId: created.session.id,
      commandId: start.command.id,
      occurredAt: 300,
      provenance: adapterProvenance,
      attachment: {
        id: "attachment-prompts",
        sessionId: created.session.id,
        adapterId: "opencode",
        venue: { id: "local", kind: "local" },
        continuity: "fresh",
        native: { id: "native-2", detail: null },
        authority: null,
      },
    });
    const prompts = [
      {
        id: "prompt:0",
        label: "Which files?",
        detail: "Pick every file the change touches",
        options: [
          { id: "prompt:0:src", label: "src", description: null },
          { id: "prompt:0:docs", label: "docs", description: "Documentation only" },
        ],
        multiple: true,
        custom: false,
      },
      {
        id: "prompt:1",
        label: "Anything else?",
        detail: null,
        options: [{ id: "prompt:1:no", label: "No", description: null }],
        multiple: false,
        custom: true,
      },
    ];
    const interaction = {
      id: "question-1",
      attachmentId: "attachment-prompts",
      kind: "question" as const,
      title: "Two questions",
      detail: null,
      // The flat set stays the union of every prompt's options, because that is
      // what a reader written before prompts falls back to.
      options: [...prompts[0]!.options, ...prompts[1]!.options],
      multiple: true,
      prompts,
      native: { id: "native-question-1", detail: null },
    };
    await control.observe({
      id: "interaction-opened-prompts",
      kind: "interaction.opened",
      sessionId: created.session.id,
      attachmentId: "attachment-prompts",
      occurredAt: 301,
      provenance: adapterProvenance,
      interaction,
    });
    const answered = {
      optionIds: ["prompt:0:src", "prompt:1:no"],
      response: null,
      answers: [
        { promptId: "prompt:0", optionIds: ["prompt:0:src"], response: null },
        { promptId: "prompt:1", optionIds: ["prompt:1:no"], response: "nothing further" },
      ],
    };
    const resolution = await control.submit({
      commandId: "resolve-prompts",
      sessionId: created.session.id,
      intent: {
        kind: "interaction.resolve",
        attachmentId: "attachment-prompts",
        interactionId: "question-1",
        resolution: answered,
        reference: {
          id: "sha256:answers",
          digest: "sha256:answers",
          mediaType: "application/vnd.volli.ui-message+json;version=1",
        },
      },
      provenance,
    });
    await control.observe({
      id: "interaction-resolved-prompts",
      kind: "interaction.resolved",
      sessionId: created.session.id,
      attachmentId: "attachment-prompts",
      occurredAt: 302,
      provenance: adapterProvenance,
      commandId: resolution.command.id,
      interactionId: "question-1",
      resolution: answered,
    });

    const projection = await control.getSession({ sessionId: created.session.id });
    const resolved = projection?.interactions.resolved[0];
    // Encode then decode returns the identical record, both fields intact.
    expect(resolved?.interaction).toEqual(interaction);
    expect(resolved?.resolution).toEqual(answered);
    // The command intent carries the same answers to the adapter on replay.
    expect(projection?.commands.at(-1)).toMatchObject({
      intent: { kind: "interaction.resolve", resolution: answered },
    });
  });

  it("rejects an interaction whose prompts or answers are structurally wrong", async () => {
    const { control, projectId, ledger } = setup();
    const created = await control.createSession({
      commandId: "create-invalid",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Invalid",
      provenance,
    });
    const start = await control.submit({
      commandId: "start-invalid",
      sessionId: created.session.id,
      intent: { kind: "executor.start", adapterId: "opencode", continuity: "fresh" },
      provenance,
    });
    const adapterProvenance = {
      source: { kind: "adapter" as const, id: "opencode", detail: null },
      venue: { id: "local", kind: "local" as const },
    };
    await control.observe({
      id: "opened-invalid",
      kind: "attachment.opened",
      sessionId: created.session.id,
      commandId: start.command.id,
      occurredAt: 400,
      provenance: adapterProvenance,
      attachment: {
        id: "attachment-invalid",
        sessionId: created.session.id,
        adapterId: "opencode",
        venue: { id: "local", kind: "local" },
        continuity: "fresh",
        native: { id: "native-3", detail: null },
        authority: null,
      },
    });
    await control.observe({
      id: "interaction-opened-invalid",
      kind: "interaction.opened",
      sessionId: created.session.id,
      attachmentId: "attachment-invalid",
      occurredAt: 401,
      provenance: adapterProvenance,
      interaction: {
        id: "question-2",
        attachmentId: "attachment-invalid",
        kind: "question",
        title: "One question",
        detail: null,
        options: [{ id: "yes", label: "Yes", description: null }],
        multiple: false,
        prompts: [
          {
            id: "prompt:0",
            label: "One question",
            detail: null,
            options: [{ id: "yes", label: "Yes", description: null }],
            multiple: false,
            custom: false,
          },
        ],
        native: { id: "native-question-2", detail: null },
      },
    });
    await control.observe({
      id: "interaction-resolved-invalid",
      kind: "interaction.resolved",
      sessionId: created.session.id,
      attachmentId: "attachment-invalid",
      occurredAt: 402,
      provenance: adapterProvenance,
      interactionId: "question-2",
      resolution: {
        optionIds: ["yes"],
        response: null,
        answers: [{ promptId: "prompt:0", optionIds: ["yes"], response: null }],
      },
    });

    // Decode is a trust boundary: this data came off disk, so a stored record
    // whose optional structure is not the declared shape fails loudly rather
    // than projecting a half-read interaction.
    ctx.db.pragma("ignore_check_constraints = ON");
    const rewrite = (id: string, payload: unknown) =>
      ctx.db
        .prepare("UPDATE session_events SET payload = ? WHERE id = ?")
        .run(JSON.stringify(payload), id);
    const read = (id: string) =>
      JSON.parse(
        (
          ctx.db.prepare("SELECT payload FROM session_events WHERE id = ?").get(id) as {
            payload: string;
          }
        ).payload,
      ) as { interaction?: { prompts: unknown }; resolution?: { answers: unknown } };
    const project = () => rereadSession(ledger, created.session.id);

    const opened = read("interaction-opened-invalid");
    opened.interaction!.prompts = "prompt:0";
    rewrite("interaction-opened-invalid", opened);
    await expect(project()).rejects.toThrow("prompts must be an array");

    opened.interaction!.prompts = [{ id: "prompt:0", label: "One question", detail: null }];
    rewrite("interaction-opened-invalid", opened);
    await expect(project()).rejects.toThrow("prompts[0].options must be an array");

    opened.interaction!.prompts = [
      {
        id: "prompt:0",
        label: "One question",
        detail: null,
        options: [{ id: "yes", label: "Yes", description: null }],
        multiple: false,
        custom: "no",
      },
    ];
    rewrite("interaction-opened-invalid", opened);
    await expect(project()).rejects.toThrow("prompts[0].custom must be a boolean");

    opened.interaction!.prompts = [
      {
        id: "prompt:0",
        label: "One question",
        detail: null,
        options: [{ id: "yes", label: "Yes", description: null }],
        multiple: false,
        custom: false,
      },
    ];
    rewrite("interaction-opened-invalid", opened);

    const answered = read("interaction-resolved-invalid");
    answered.resolution!.answers = { "prompt:0": ["yes"] };
    rewrite("interaction-resolved-invalid", answered);
    await expect(project()).rejects.toThrow("answers must be an array");

    answered.resolution!.answers = [{ promptId: "prompt:0", optionIds: "yes", response: null }];
    rewrite("interaction-resolved-invalid", answered);
    await expect(project()).rejects.toThrow("answers[0].optionIds must be an array");

    answered.resolution!.answers = [{ promptId: 0, optionIds: ["yes"], response: null }];
    rewrite("interaction-resolved-invalid", answered);
    await expect(project()).rejects.toThrow("answers[0].promptId must be a string");
    ctx.db.pragma("ignore_check_constraints = OFF");
  });

  it("round-trips a cancelled interaction without a resolution and rejects an unknown reason", async () => {
    const { control, projectId, ledger } = setup();
    const created = await control.createSession({
      commandId: "create-cancelled",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Cancelled",
      provenance,
    });
    const start = await control.submit({
      commandId: "start-cancelled",
      sessionId: created.session.id,
      intent: { kind: "executor.start", adapterId: "opencode", continuity: "fresh" },
      provenance,
    });
    const adapterProvenance = {
      source: { kind: "adapter" as const, id: "opencode", detail: null },
      venue: { id: "local", kind: "local" as const },
    };
    await control.observe({
      id: "opened-cancelled",
      kind: "attachment.opened",
      sessionId: created.session.id,
      commandId: start.command.id,
      occurredAt: 500,
      provenance: adapterProvenance,
      attachment: {
        id: "attachment-cancelled",
        sessionId: created.session.id,
        adapterId: "opencode",
        venue: { id: "local", kind: "local" },
        continuity: "fresh",
        native: { id: "native-4", detail: null },
        authority: null,
      },
    });
    await control.observe({
      id: "interaction-opened-cancelled",
      kind: "interaction.opened",
      sessionId: created.session.id,
      attachmentId: "attachment-cancelled",
      occurredAt: 501,
      provenance: adapterProvenance,
      interaction: {
        id: "question-3",
        attachmentId: "attachment-cancelled",
        kind: "question",
        title: "Which files?",
        detail: null,
        options: [{ id: "all", label: "All of them", description: null }],
        multiple: true,
        native: { id: "native-question-3", detail: null },
      },
    });
    // The user walked away, so the fact carries Volli's own provenance rather
    // than the adapter's: no harness reported this.
    await control.observe({
      id: "interaction-cancelled",
      kind: "interaction.cancelled",
      sessionId: created.session.id,
      attachmentId: "attachment-cancelled",
      occurredAt: 502,
      provenance,
      interactionId: "question-3",
      reason: "abandoned",
    });

    const projection = await control.getSession({ sessionId: created.session.id });
    expect(projection?.interactions).toEqual({ active: [], resolved: [] });
    const events = await control.listEvents({ sessionId: created.session.id });
    expect(events.find(({ id }) => id === "interaction-cancelled")?.payload).toEqual({
      kind: "interaction.cancelled",
      attachmentId: "attachment-cancelled",
      interactionId: "question-3",
      reason: "abandoned",
    });

    ctx.db.pragma("ignore_check_constraints = ON");
    ctx.db.prepare("UPDATE session_events SET payload = ? WHERE id = ?").run(
      JSON.stringify({
        kind: "interaction.cancelled",
        attachmentId: "attachment-cancelled",
        interactionId: "question-3",
        reason: "resolved",
      }),
      "interaction-cancelled",
    );
    await expect(rereadSession(ledger, created.session.id)).rejects.toThrow(
      "reason has an unsupported value",
    );
    ctx.db.pragma("ignore_check_constraints = OFF");
  });

  it("drops a row whose payload kind this build does not recognise, keeping the rest of the Session readable", async () => {
    const { ledger, control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-retired-kind",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Retired kind",
      provenance,
    });
    // "capabilities.retired" stands in for a Session event kind this build has
    // since dropped support for, like the real capabilities.updated retirement
    // this groundwork exists for. Written with raw SQL because appendEvent
    // rejects it, and existing databases already carry rows like it.
    ctx.db
      .prepare(
        `INSERT INTO session_events
           (id, session_id, sequence, occurred_at, recorded_at, provenance_id, attachment_id, command_id, payload)
         VALUES ('retired-kind-event', ?, 4, 400, 400, ?, NULL, NULL, ?)`,
      )
      .run(created.session.id, provenanceId(), JSON.stringify({ kind: "capabilities.retired" }));
    await ledger.transaction((transaction) => {
      transaction.appendEvent({
        id: "after-retired-kind-event",
        sessionId: created.session.id,
        sequence: 5,
        occurredAt: 500,
        recordedAt: 500,
        provenance,
        payload: { kind: "session.archived" },
      });
    });

    const events = await control.listEvents({ sessionId: created.session.id });
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 5]);
    expect(events.map((event) => event.payload.kind)).toEqual([
      "command.recorded",
      "session.created",
      "command.receipt.recorded",
      "session.archived",
    ]);
  });

  it("fills a page past retired rows instead of returning it short", async () => {
    const { ledger, control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-retired-page",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Retired page",
      provenance,
    });
    // A whole page of retired kinds. The limit counts events this build can
    // return, so asking for one after sequence 3 must reach sequence 6 rather
    // than come back empty — a caller advances its cursor from the last event
    // it was handed, so an empty page would read as the end of the Session.
    for (const sequence of [4, 5]) {
      ctx.db
        .prepare(
          `INSERT INTO session_events
             (id, session_id, sequence, occurred_at, recorded_at, provenance_id, attachment_id, command_id, payload)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
        )
        .run(
          `retired-page-${sequence}`,
          created.session.id,
          sequence,
          sequence * 100,
          sequence * 100,
          provenanceId(),
          JSON.stringify({ kind: "capabilities.retired" }),
        );
    }
    await ledger.transaction((transaction) => {
      transaction.appendEvent({
        id: "after-retired-page",
        sessionId: created.session.id,
        sequence: 6,
        occurredAt: 600,
        recordedAt: 600,
        provenance,
        payload: { kind: "session.archived" },
      });
    });

    const page = await control.listEvents({
      sessionId: created.session.id,
      afterSequence: 3,
      limit: 1,
    });
    expect(page.map((event) => event.sequence)).toEqual([6]);
  });

  it("returns null from getEvent for a row whose payload kind this build does not recognise", async () => {
    const { ledger, control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-retired-kind-get-event",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Retired kind get event",
      provenance,
    });
    ctx.db
      .prepare(
        `INSERT INTO session_events
           (id, session_id, sequence, occurred_at, recorded_at, provenance_id, attachment_id, command_id, payload)
         VALUES ('retired-kind-get-event', ?, 4, 400, 400, ?, NULL, NULL, ?)`,
      )
      .run(created.session.id, provenanceId(), JSON.stringify({ kind: "capabilities.retired" }));

    const event = await ledger.transaction((transaction) =>
      transaction.getEvent("retired-kind-get-event"),
    );
    expect(event).toBeNull();
  });

  it("rejects appendEvent for an unrecognised payload kind, keeping the write path strict", async () => {
    const { ledger, control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-strict-write",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Strict write",
      provenance,
    });

    await expect(
      ledger.transaction((transaction) => {
        transaction.appendEvent({
          id: "unknown-kind-event",
          sessionId: created.session.id,
          sequence: 4,
          occurredAt: 400,
          recordedAt: 400,
          provenance,
          payload: { kind: "capabilities.retired" } as unknown as SessionEvent["payload"],
        });
      }),
    ).rejects.toThrow("is not a known Session event payload");
  });
});

function metered(overrides: Partial<SessionUsage> = {}): SessionUsage {
  return {
    cause: "assistant",
    providerId: "anthropic",
    modelId: "claude-opus-4-1",
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 400,
    cacheWriteTokens: 0,
    costUsd: 0.25,
    costBasis: "catalog-estimate",
    ...overrides,
  };
}

describe("the Session usage projection", () => {
  async function meteredSession(
    control: ReturnType<typeof createSessionEngine>,
    options: { projectId: string; ticketId: string | null; commandId: string },
  ): Promise<string> {
    const created = await control.createSession({
      commandId: options.commandId,
      projectId: options.projectId,
      ticketId: options.ticketId,
      role: roleImpliedByTicket(options.ticketId),
      parentSessionId: null,
      title: options.commandId,
      provenance,
    });
    return created.session.id;
  }

  async function record(
    control: ReturnType<typeof createSessionEngine>,
    sessionId: string,
    id: string,
    occurredAt: number,
    usage: SessionUsage,
  ): Promise<void> {
    await control.observe({
      id,
      kind: "usage.recorded",
      sessionId,
      occurredAt,
      provenance,
      attachmentId: null,
      turnId: null,
      usage,
    });
  }

  it("indexes a usage fact as it is appended, without re-reading the event log", async () => {
    const { control, projectId } = setup();
    insertTicket(ctx.db, testTicket(projectId, { id: "ticket-a", usesWorktree: false }));
    const sessionId = await meteredSession(control, {
      projectId,
      ticketId: "ticket-a",
      commandId: "create-metered",
    });

    await record(control, sessionId, "usage-1", 1_000, metered({ costUsd: 0.25 }));

    expect(
      ctx.db
        .prepare(
          `SELECT session_id, project_id, ticket_id, occurred_at, cause, provider_id, model_id,
                  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                  cost_usd, cost_basis
             FROM session_usage`,
        )
        .all(),
    ).toEqual([
      {
        session_id: sessionId,
        project_id: projectId,
        ticket_id: "ticket-a",
        occurred_at: 1_000,
        cause: "assistant",
        provider_id: "anthropic",
        model_id: "claude-opus-4-1",
        input_tokens: 100,
        output_tokens: 10,
        cache_read_tokens: 400,
        cache_write_tokens: 0,
        cost_usd: 0.25,
        cost_basis: "catalog-estimate",
      },
    ]);
  });

  it("keeps an unmeasured token count null rather than storing it as zero", async () => {
    const { control, projectId } = setup();
    const sessionId = await meteredSession(control, {
      projectId,
      ticketId: null,
      commandId: "create-unmeasured",
    });

    await record(
      control,
      sessionId,
      "usage-null",
      1_000,
      metered({
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsd: null,
        costBasis: "unavailable",
      }),
    );

    expect(
      ctx.db.prepare("SELECT cache_read_tokens, cost_usd, cost_basis FROM session_usage").get(),
    ).toEqual({ cache_read_tokens: null, cost_usd: null, cost_basis: "unavailable" });
  });

  // `sessions.ticket_id` is ON DELETE SET NULL. Reading attribution live would
  // move a deleted Ticket's whole bill into unticketed Project spend, which is
  // a quieter lie than showing an id that no longer resolves.
  it("keeps spend attributed to the Ticket it was spent on after that Ticket is deleted", async () => {
    const { control, projectId } = setup();
    insertTicket(ctx.db, testTicket(projectId, { id: "ticket-doomed", usesWorktree: false }));
    const sessionId = await meteredSession(control, {
      projectId,
      ticketId: "ticket-doomed",
      commandId: "create-doomed",
    });
    await record(control, sessionId, "u-doomed", 1_000, metered({ costUsd: 3 }));

    ctx.db.prepare("DELETE FROM tickets WHERE id = ?").run("ticket-doomed");

    const report = await control.reportUsage({ scope: { kind: "all" }, groupBy: "ticket" });
    expect(report.groups.map((group) => group.key)).toEqual(["ticket-doomed"]);
  });

  it("can be rebuilt from the facts alone, byte for byte", async () => {
    const { ledger, control, projectId } = setup();
    const sessionId = await meteredSession(control, {
      projectId,
      ticketId: null,
      commandId: "create-rebuildable",
    });
    await record(control, sessionId, "r1", 1_000, metered({ costUsd: 1 }));
    await record(control, sessionId, "r2", 2_000, metered({ costUsd: 2, modelId: "gpt-5" }));

    const live = await control.reportUsage({ scope: { kind: "all" }, groupBy: "model" });
    ctx.db.exec("DELETE FROM session_usage");
    await ledger.transaction((transaction) => {
      transaction.rebuildUsageProjection();
    });

    await expect(
      control.reportUsage({ scope: { kind: "all" }, groupBy: "model" }),
    ).resolves.toEqual(live);
  });

  /**
   * The case that decides whether "rebuildable" is true.
   *
   * Deleting the Ticket nulls `sessions.ticket_id`, so a rebuild that read
   * attribution from the Session row would move this bill into unticketed
   * spend — the projection would answer one thing before a rebuild and another
   * after, with no fact having changed. Attribution is on the event, so the
   * two answers are the same answer.
   */
  it("rebuilds a deleted Ticket's spend back onto that Ticket, not into unticketed", async () => {
    const { ledger, control, projectId } = setup();
    insertTicket(ctx.db, testTicket(projectId, { id: "ticket-gone", usesWorktree: false }));
    const sessionId = await meteredSession(control, {
      projectId,
      ticketId: "ticket-gone",
      commandId: "create-rebuild-after-delete",
    });
    await record(control, sessionId, "rd1", 1_000, metered({ costUsd: 4 }));
    const before = await control.reportUsage({ scope: { kind: "all" }, groupBy: "ticket" });

    ctx.db.prepare("DELETE FROM tickets WHERE id = ?").run("ticket-gone");
    await ledger.transaction((transaction) => {
      transaction.rebuildUsageProjection();
    });

    const after = await control.reportUsage({ scope: { kind: "all" }, groupBy: "ticket" });
    expect(after).toEqual(before);
    expect(after.groups.map((group) => group.key)).toEqual(["ticket-gone"]);
    // And the Ticket-scoped read still finds it, which is what an orchestrator
    // asking `volli cost --ticket` after a cleanup actually does.
    await expect(
      control.reportUsage({ scope: { kind: "ticket", ticketId: "ticket-gone" } }),
    ).resolves.toMatchObject({ total: { knownCostUsd: 4, requestCount: 1 } });
  });

  it("routes reads through the per-handle prepared-statement cache (VC-355)", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "project" }));
    const prepare = vi.spyOn(ctx.db, "prepare");
    const ledger = createSqliteSessionLedger(ctx.db);
    // Each distinct SQL text prepares once; repeats are cache hits.
    await ledger.transaction((t) => t.listSessions({ scope: "project", projectId: "project" }));
    await ledger.transaction((t) => t.countSessions({ scope: "project", projectId: "project" }));
    const preparesAfterWarmup = prepare.mock.calls.length;
    expect(preparesAfterWarmup).toBeGreaterThan(0);
    await ledger.transaction((t) => t.listSessions({ scope: "project", projectId: "project" }));
    await ledger.transaction((t) => t.countSessions({ scope: "project", projectId: "project" }));
    await ledger.transaction((t) => t.listSessions({ scope: "project", projectId: "project" }));
    expect(prepare.mock.calls.length).toBe(preparesAfterWarmup);
  });

  // The test above proves the cache works for two read statements. This one is
  // the Ticket's actual requirement — that this FILE no longer prepares outside
  // the cache — which two reads cannot show: the direct `.prepare(...)` calls
  // that VC-355 removed were on the receipt-link, receipt-pairing, and
  // foreign-key paths, all of which run only while WRITING an event.
  it("prepares no statement twice across a whole write/read cycle (VC-355)", async () => {
    const { ledger, control, projectId } = setup();
    const exercise = async (suffix: string): Promise<void> => {
      const created = await control.createSession({
        commandId: `create-prepared-${suffix}`,
        projectId,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: `Prepared ${suffix}`,
        provenance,
      });
      // A command with a receipt: this is what exercises the receipt link and
      // the receipt/event pairing assertions on the write path.
      await control.submit({
        commandId: `retitle-prepared-${suffix}`,
        sessionId: created.session.id,
        intent: { kind: "session.retitle", title: `Renamed ${suffix}` },
        provenance,
      });
      await ledger.transaction((transaction) => {
        transaction.listEvents({ sessionId: created.session.id });
        transaction.listProjectionEvents({ sessionId: created.session.id });
        transaction.latestEventSequence(created.session.id);
        transaction.getProjectionCheckpoint(created.session.id);
        transaction.listSessions({ scope: "project", projectId });
        transaction.countSessions({ scope: "project", projectId });
      });
      await control.getSession({ sessionId: created.session.id });
      await control.listSessions({ scope: "project", projectId });
    };

    await exercise("warmup");
    const prepare = vi.spyOn(ctx.db, "prepare");
    await exercise("measured");
    // Every statement this cycle needs was already prepared by the warm-up, so
    // a single call here means some site still calls `db.prepare` directly.
    expect(prepare.mock.calls.map(([sql]) => sql)).toEqual([]);
  });

  describe("listProjectionEvents (VC-355)", () => {
    // The contract compares only the facts: the port lets an adapter return full
    // events here. This one must not, because skipping the join is its point.
    it("returns the same facts in the same order without the provenance field", async () => {
      const { ledger, control, projectId } = setup();
      const created = await control.createSession({
        commandId: "create-projection-events",
        projectId,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: "Projection events",
        provenance,
      });
      await control.submit({
        commandId: "retitle-projection-events",
        sessionId: created.session.id,
        intent: { kind: "session.retitle", title: "Renamed" },
        provenance,
      });

      const { audit, fold } = await ledger.transaction((transaction) => ({
        audit: transaction.listEvents({ sessionId: created.session.id }),
        fold: transaction.listProjectionEvents({ sessionId: created.session.id }),
      }));

      expect(fold.length).toBeGreaterThan(1);
      expect(fold).toEqual(audit.map(({ provenance: _provenance, ...event }) => event));
      for (const event of fold) expect("provenance" in event).toBe(false);
      // The point of the split: the audit field is never fetched, so the same
      // rows fold to the same state without decoding one provenance per event.
      expect(createSessionProjectionCheckpoint(created.session, fold).projection).toEqual(
        createSessionProjectionCheckpoint(created.session, audit).projection,
      );
    });

    it("keeps the pagination contract when a page is entirely retired kinds", async () => {
      const { ledger, control, projectId } = setup();
      const created = await control.createSession({
        commandId: "create-projection-retired",
        projectId,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: "Projection retired",
        provenance,
      });
      for (const sequence of [4, 5]) {
        ctx.db
          .prepare(
            `INSERT INTO session_events
               (id, session_id, sequence, occurred_at, recorded_at, provenance_id, attachment_id, command_id, payload)
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
          )
          .run(
            `projection-retired-${sequence}`,
            created.session.id,
            sequence,
            sequence * 100,
            sequence * 100,
            provenanceId(),
            JSON.stringify({ kind: "capabilities.retired" }),
          );
      }
      await ledger.transaction((transaction) => {
        transaction.appendEvent({
          id: "after-projection-retired",
          sessionId: created.session.id,
          sequence: 6,
          occurredAt: 600,
          recordedAt: 600,
          provenance,
          payload: { kind: "session.archived" },
        });
      });

      const page = await ledger.transaction((transaction) =>
        transaction.listProjectionEvents({
          sessionId: created.session.id,
          afterSequence: 3,
          limit: 1,
        }),
      );
      expect(page.map((event) => event.sequence)).toEqual([6]);
    });

    it("reads facts whose interned provenance row would fail the audit read", async () => {
      const { ledger, control, projectId } = setup();
      const created = await control.createSession({
        commandId: "create-projection-unjoined",
        projectId,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: "Projection unjoined",
        provenance,
      });
      // Point one event at a provenance id that does not exist. Only a read
      // that JOINS provenance can notice, so this is the sharpest available
      // proof that the fold read does not perform that join.
      ctx.db.pragma("foreign_keys = OFF");
      ctx.db
        .prepare("UPDATE session_events SET provenance_id = 999999 WHERE session_id = ? ")
        .run(created.session.id);
      ctx.db.pragma("foreign_keys = ON");

      await expect(
        ledger.transaction((transaction) =>
          transaction.listEvents({ sessionId: created.session.id }),
        ),
      ).rejects.toThrow("missing its referenced provenance row");
      const fold = await ledger.transaction((transaction) =>
        transaction.listProjectionEvents({ sessionId: created.session.id }),
      );
      expect(fold.map((event) => event.payload.kind)).toEqual([
        "command.recorded",
        "session.created",
        "command.receipt.recorded",
      ]);
    });
  });
});

/**
 * The concurrency budget's narrowing (VC-403).
 *
 * The budget asks one question — who is working — and used to answer it by
 * folding every Session of every project. These hold the ledger's replacement:
 * an indexed read of the Sessions holding an OPEN attachment, which is a
 * superset of the working ones and never a subset, so the count that folds
 * only these is the same count.
 */
describe("listAttachedSessions (VC-403)", () => {
  /** Opens an attachment on a fresh Session and hands back both ids. */
  async function sessionWithAttachment(
    control: ReturnType<typeof createSessionEngine>,
    projectId: string,
    name: string,
    adapterId: "terminal" | "opencode",
  ): Promise<{ sessionId: string; attachmentId: string }> {
    const created = await control.createSession({
      commandId: `create-${name}`,
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: name,
      provenance,
    });
    const start = await control.submit({
      commandId: `start-${name}`,
      sessionId: created.session.id,
      intent: { kind: "executor.start", adapterId, continuity: "fresh" },
      provenance,
    });
    const attachmentId = `attachment-${name}`;
    await control.observe({
      id: `opened-${name}`,
      kind: "attachment.opened",
      sessionId: created.session.id,
      commandId: start.command.id,
      occurredAt: 200,
      provenance,
      attachment: {
        id: attachmentId,
        sessionId: created.session.id,
        adapterId,
        venue: { id: "local", kind: "local" },
        continuity: "fresh",
        native:
          adapterId === "terminal"
            ? { id: null, detail: { kind: "volli.terminal.v1", cwd: "/repo" } }
            : null,
        authority: null,
      },
    });
    return { sessionId: created.session.id, attachmentId };
  }

  it("agrees with the fold it replaces, for terminals and chats alike", async () => {
    const { ledger, control, projectId } = setup();
    const terminal = await sessionWithAttachment(control, projectId, "terminal", "terminal");
    const chat = await sessionWithAttachment(control, projectId, "chat", "opencode");
    await control.createSession({
      commandId: "create-quiet",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Never attached",
      provenance,
    });

    // The narrow read and the full listing must agree about who is attached:
    // every Session the fold shows holding an open attachment is here, and
    // nothing else is. This is the property the budget's correctness rests on.
    const folded = await control.listSessions({ projectId, scope: "all" });
    const attachedByFold = folded
      .filter((projection) =>
        projection.attachments.some((attachment) => attachment.status === "open"),
      )
      .map((projection) => projection.session.id);
    const narrow = await ledger.transaction((transaction) =>
      transaction.listAttachedSessions().map(({ id }) => id),
    );

    expect(narrow.toSorted()).toEqual(attachedByFold.toSorted());
    expect(narrow.toSorted()).toEqual([terminal.sessionId, chat.sessionId].toSorted());
  });

  it("counts the same as folding the whole fleet, which is the point", async () => {
    const { control, projectId } = setup();
    const live = await sessionWithAttachment(control, projectId, "live", "terminal");
    const exited = await sessionWithAttachment(control, projectId, "exited", "terminal");
    await control.observe({
      id: "closed-exited",
      kind: "attachment.closed",
      sessionId: exited.sessionId,
      occurredAt: 300,
      provenance,
      attachmentId: exited.attachmentId,
      outcome: "completed",
    });
    // Sessions that never attached at all: the bulk of any real machine, and
    // the whole set the narrowing drops.
    for (const name of ["quiet-one", "quiet-two", "quiet-three"]) {
      await control.createSession({
        commandId: `create-${name}`,
        projectId,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: name,
        provenance,
      });
    }

    // The invariant the budget rests on: counting the narrow read and counting
    // the entire fleet give the same number, because every Session the narrow
    // read omits contributes zero. If this ever parts, the budget is fast and
    // wrong, which is worse than slow and right.
    const narrow = workingSessionCount({ projections: await control.listAttachedSessions() });
    const whole = workingSessionCount({
      projections: await control.listSessions({ projectId, scope: "all" }),
    });

    expect(narrow).toBe(whole);
    // Not vacuously equal at zero: the live terminal is counted, the exited one
    // is not, and the three that never attached are not.
    expect(narrow).toBe(1);
    expect(live.sessionId).not.toBe(exited.sessionId);
  });
});

describe("origin storage and checkpoint upgrade", () => {
  it("extracts command origin for slim folds and invalidates v2 checkpoints", async () => {
    const { ledger, control, projectId } = setup();
    const origin = {
      kind: "automation",
      automationRunId: "run-exact",
      automationName: "Review",
    } as const;
    const created = await control.createSession({
      commandId: "origin-create",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: null,
      provenance: {
        ...provenance,
        source: { ...provenance.source, detail: { sessionOrigin: origin } },
      },
    });
    await control.observe({
      id: "origin-attachment",
      sessionId: created.session.id,
      occurredAt: 20,
      provenance,
      kind: "attachment.opened",
      attachment: {
        id: "origin-a",
        sessionId: created.session.id,
        adapterId: "pi",
        venue: provenance.venue,
        continuity: "fresh",
        native: null,
        authority: null,
      },
    });
    await control.submit({
      commandId: "origin-stop",
      sessionId: created.session.id,
      provenance,
      intent: { kind: "session.stop", reason: null, by: { kind: "user" } },
    });
    await control.observe({
      id: "origin-detached",
      sessionId: created.session.id,
      occurredAt: 28,
      provenance,
      kind: "attachment.closed",
      attachmentId: "origin-a",
      outcome: "interrupted",
    });
    const resumed = await control.submit({
      commandId: "origin-reattach",
      sessionId: created.session.id,
      provenance: {
        ...provenance,
        source: { ...provenance.source, detail: { sessionOrigin: origin } },
      },
      intent: { kind: "executor.start", adapterId: "terminal", continuity: "fresh" },
    });
    await control.observe({
      id: "origin-reattachment",
      sessionId: created.session.id,
      commandId: resumed.command.id,
      occurredAt: 29,
      provenance,
      kind: "attachment.opened",
      attachment: {
        id: "origin-b",
        sessionId: created.session.id,
        adapterId: "terminal",
        venue: provenance.venue,
        continuity: "fresh",
        native: null,
        authority: null,
      },
    });
    await ledger.transaction((tx) => {
      const sequence = tx.latestEventSequence(created.session.id) + 1;
      const command = {
        id: "origin-submit",
        sessionId: created.session.id,
        createdAt: 30,
        intent: {
          kind: "message.submit" as const,
          reference: { id: "message", mediaType: null, digest: null },
        },
        route: null,
      };
      tx.saveCommand(command);
      tx.appendEvent({
        id: "origin-command",
        sessionId: created.session.id,
        sequence,
        occurredAt: 30,
        recordedAt: 30,
        commandId: command.id,
        provenance: {
          ...provenance,
          source: { ...provenance.source, detail: { sessionOrigin: origin } },
        },
        payload: { kind: "command.recorded", command },
      });
      tx.appendEvent({
        id: "origin-turn",
        sessionId: created.session.id,
        sequence: sequence + 1,
        occurredAt: 31,
        recordedAt: 31,
        provenance,
        attachmentId: "origin-b",
        commandId: null,
        payload: { kind: "turn.started", attachmentId: "origin-b", turnId: "origin-t" },
      });
    });
    const audit = await control.listEvents({ sessionId: created.session.id });
    await ledger.transaction((tx) => {
      const slim = tx.listProjectionEvents({ sessionId: created.session.id });
      expect(slim[0]?.commandOrigin).toEqual(origin);
      expect("provenance" in slim[0]!).toBe(false);
      expect(audit[0]?.provenance.source.detail).toEqual({ sessionOrigin: origin });
      const checkpoint = createSessionProjectionCheckpoint(created.session, audit);
      expect(checkpoint.version).toBe(4);
      tx.saveProjectionCheckpoint(checkpoint);
    });
    ctx.db
      .prepare("UPDATE session_projection_checkpoints SET schema_version = 2 WHERE session_id = ?")
      .run(created.session.id);
    await ledger.transaction((tx) =>
      expect(tx.getProjectionCheckpoint(created.session.id)).toBeNull(),
    );
    const rebuilt = await control.getSession({ sessionId: created.session.id });
    expect(rebuilt?.latestTurnOrigin).toEqual(origin);
    expect(rebuilt?.resumptions).toEqual([{ attachmentId: "origin-b", origin, startedAt: 29 }]);
    expect(rebuilt).toEqual(createSessionProjectionCheckpoint(created.session, audit).projection);
  });
});

describe("additive birth owner without a Session SQL column", () => {
  it("retains ownership in base reads, listings, and replay via the birth fact", async () => {
    const { control, projectId } = setup();
    const request = {
      commandId: "owner-birth",
      projectId,
      ticketId: null,
      role: "project" as const,
      parentSessionId: null,
      title: null,
      ownerUserId: "owner-a",
      provenance,
    };
    const created = await control.createSession(request);
    expect((await control.getBaseSession({ sessionId: created.session.id }))?.ownerUserId).toBe(
      "owner-a",
    );
    expect((await control.listSessions({ projectId, scope: "all" }))[0]?.session.ownerUserId).toBe(
      "owner-a",
    );
    expect((await control.createSession(request)).session).toEqual(created.session);
    expect(ctx.db.prepare("PRAGMA table_info(sessions)").all()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "owner_user_id" })]),
    );
  });
});

describe("birth payload memo (VC-1076)", () => {
  const request = (commandId: string, ownerUserId: string) => ({
    commandId,
    projectId: "project",
    ticketId: null,
    role: "project" as const,
    parentSessionId: null,
    title: null,
    requestedSessionId: "reused-session",
    ownerUserId,
    provenance,
  });

  it("keeps nothing a rolled-back transaction read", async () => {
    const { ledger, control } = setup();
    let rolled = 0;
    // A create that reads its own birth and then rolls back must not leave
    // that birth behind for the id: a retry may be born differently.
    const failing = createSessionEngine({
      ledger: {
        transaction: (work) =>
          ledger.transaction((transaction) => {
            work(transaction);
            expect(transaction.getSession("reused-session")?.ownerUserId).toBe("owner-a");
            throw new Error("rolled back");
          }),
      },
      clock: { now: () => 100 },
      ids: { next: (kind) => `${kind}-rolled-${++rolled}` },
    });
    await expect(failing.createSession(request("create-a", "owner-a"))).rejects.toThrow(
      "rolled back",
    );

    await control.createSession(request("create-b", "owner-b"));
    expect((await control.getBaseSession({ sessionId: "reused-session" }))?.ownerUserId).toBe(
      "owner-b",
    );
    expect(
      (await control.listSessions({ projectId: "project", scope: "all" }))[0]?.session,
    ).toEqual(expect.objectContaining({ id: "reused-session", ownerUserId: "owner-b" }));
  });

  it("answers repeat reads from the memo, identically", async () => {
    const { control } = setup();
    const created = await control.createSession(request("create-memo", "owner-a"));
    const first = await control.listSessions({ projectId: "project", scope: "all" });
    // Birth facts are immutable, so the memo may answer instead of the log.
    // Proved by changing the log beneath it, which production never does.
    ctx.db
      .prepare(
        `UPDATE session_events SET payload = json_set(payload, '$.session.ownerUserId', 'moved')
          WHERE session_id = ? AND json_extract(payload, '$.kind') = 'session.created'`,
      )
      .run(created.session.id);
    expect((await control.getBaseSession({ sessionId: created.session.id }))?.ownerUserId).toBe(
      "owner-a",
    );
    expect(
      (await control.listSessions({ projectId: "project", scope: "all" }))[0]?.session,
    ).toEqual(first[0]?.session);
  });

  it("replaces a checkpoint row an older build wrote at another schema version on listing", async () => {
    const { control } = setup();
    const created = await control.createSession(request("create-version", "owner-a"));
    await control.listSessions({ projectId: "project", scope: "all" });
    ctx.db
      .prepare("UPDATE session_projection_checkpoints SET schema_version = 1 WHERE session_id = ?")
      .run(created.session.id);
    // A fresh engine: the first one's listing cache would answer unread.
    const relaunched = createSessionEngine({
      ledger: createSqliteSessionLedger(ctx.db),
      clock: { now: () => 100 },
      ids: { next: (kind) => `${kind}-relaunched` },
    });
    const [folded] = await relaunched.listSessions({ projectId: "project", scope: "all" });
    expect(
      ctx.db
        .prepare("SELECT schema_version FROM session_projection_checkpoints WHERE session_id = ?")
        .get(created.session.id),
    ).toEqual({ schema_version: SESSION_PROJECTION_CHECKPOINT_VERSION });
    // A listing row is the Session's projection without its history (VC-848).
    const full = await control.getSession({ sessionId: created.session.id });
    expect(full).not.toBeNull();
    const { commands: _commands, receipts: _receipts, ...listed } = full!;
    expect(folded).toEqual(listed);
  });
});

describe("generic SQL Session scopes", () => {
  it("binds scope values and applies the predicate to the actual source id column", async () => {
    const { control, projectId } = setup();
    const wantedId = "bound-' OR 1=1 --";
    const wanted = await control.createSession({
      commandId: "wanted",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: null,
      requestedSessionId: wantedId,
      provenance,
    });
    const hidden = await control.createSession({
      commandId: "hidden",
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: null,
      provenance,
    });
    const scoped = createSqliteSessionLedger(ctx.db, {
      predicate: (idColumn) => `${idColumn} = @scopeSessionId`,
      bindings: { scopeSessionId: wantedId },
    });
    await scoped.transaction((tx) => {
      expect(tx.getSession(wantedId)).toEqual(wanted.session);
      expect(tx.getSession(hidden.session.id)).toBeNull();
      expect(tx.listSessions({ projectId, scope: "all" })).toEqual([wanted.session]);
      expect(tx.countSessions({ projectId, scope: "all" })).toBe(1);
      expect(tx.listSessionStarts({ sinceMs: 0 })).toEqual([wanted.session.createdAt]);
    });
  });
});

describe("birth-owner SQL filtering before decoding", () => {
  it("keeps cursorless stamped/restored history out of local reads and only accepts compatible cloud birth owners", async () => {
    const { control, projectId } = setup();
    const create = (commandId: string, ownerUserId?: string) =>
      control.createSession({
        commandId,
        projectId,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: null,
        ...(ownerUserId === undefined ? {} : { ownerUserId }),
        provenance,
      });
    const legacy = await create("legacy");
    const own = await create("cloud-a", "a");
    const foreign = await create("cloud-b", "b");
    const malformed = await create("malformed", "a");
    ctx.db
      .prepare(`UPDATE session_events SET payload = json_set(payload, '$.session.ownerUserId', NULL)
      WHERE session_id = ? AND json_extract(payload, '$.kind') = 'session.created'`)
      .run(malformed.session.id);
    const local = createSqliteSessionLedger(ctx.db, { predicate: localSessionRow });
    await local.transaction((tx) => {
      expect(tx.listSessions({ projectId, scope: "all" })).toEqual([legacy.session]);
      expect(tx.countSessions({ projectId, scope: "all" })).toBe(1);
      expect(tx.getSession(own.session.id)).toBeNull();
      expect(tx.getSession(foreign.session.id)).toBeNull();
      // A present JSON null is not an absent/importable owner. Filter it
      // before the known-kind codec would correctly report corruption.
      expect(tx.getSession(malformed.session.id)).toBeNull();
    });
    const compatible = createSqliteSessionLedger(ctx.db, {
      predicate: (idColumn) => sessionBirthOwnerCompatible(idColumn, "@scopeOwner"),
      bindings: { scopeOwner: "a" },
    });
    await compatible.transaction((tx) => {
      expect(tx.listSessions({ projectId, scope: "all" })).toEqual([own.session, legacy.session]);
      expect(tx.countSessions({ projectId, scope: "all" })).toBe(2);
      expect(tx.getSession(foreign.session.id)).toBeNull();
      expect(tx.getSession(malformed.session.id)).toBeNull();
    });
  });
});
