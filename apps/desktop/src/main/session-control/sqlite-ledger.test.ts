import { afterEach, describe, expect, it } from "vite-plus/test";
import { createSessionEngine } from "@volli/session-engine";
import type { SessionEvent, SessionLedger, SessionObservation } from "@volli/shared";
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

  it("reads Session start stamps across every project from the window's edge", async () => {
    const { control, projectId } = setup();
    const other = testProject({ id: "project-2", name: "Other", ticketPrefix: "OT" });
    insertProject(ctx.db, other);
    // The injected clock steps by one per id, so each create lands on its own
    // stamp: 101, 102, 103 in creation order.
    const first = await control.createSession({
      commandId: "create-a",
      projectId,
      ticketId: null,
      title: "One",
      provenance,
    });
    const elsewhere = await control.createSession({
      commandId: "create-b",
      projectId: other.id,
      ticketId: null,
      title: "Two",
      provenance,
    });

    const starts = await control.listSessionStarts({ sinceMs: 0 });
    expect(starts).toEqual([first.session.createdAt, elsewhere.session.createdAt]);
    await expect(
      control.listSessionStarts({ sinceMs: elsewhere.session.createdAt }),
    ).resolves.toEqual([elsewhere.session.createdAt]);
    await expect(
      control.listSessionStarts({ sinceMs: elsewhere.session.createdAt + 1 }),
    ).resolves.toEqual([]);
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

  it("round-trips the immutable Runtime Brief input through SQLite", async () => {
    const { control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-brief",
      projectId,
      ticketId: null,
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

  it("round-trips durable model selection through SQLite", async () => {
    const { control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-model-selection",
      projectId,
      ticketId: null,
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

  it("round-trips an authority denial as its own durable fact, before its turn has even opened", async () => {
    const { ledger, control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-authority-denied",
      projectId,
      ticketId: null,
      title: "Authority denied",
      provenance,
    });

    await ledger.transaction((transaction) => {
      transaction.appendEvent({
        id: "authority-denied-event",
        sessionId: created.session.id,
        sequence: 4,
        occurredAt: 200,
        recordedAt: 201,
        provenance,
        payload: {
          kind: "authority.denied",
          attachmentId: "attachment-1",
          // A refusal need not wait for the first turn to open.
          turnId: null,
          tool: "bash",
          cause: "command.destructive-removal",
          reason: "rm -rf ~ discards more than this Session's workspace.",
        },
      });
    });

    expect((await control.listEvents({ sessionId: created.session.id })).at(-1)?.payload).toEqual({
      kind: "authority.denied",
      attachmentId: "attachment-1",
      turnId: null,
      tool: "bash",
      cause: "command.destructive-removal",
      reason: "rm -rf ~ discards more than this Session's workspace.",
    });
  });

  it("rejects an authority denial payload whose tool is not a string, like its readString neighbours", async () => {
    const { ledger, control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-authority-malformed",
      projectId,
      ticketId: null,
      title: "Authority malformed",
      provenance,
    });

    await ledger.transaction((transaction) => {
      transaction.appendEvent({
        id: "authority-denied-malformed-event",
        sessionId: created.session.id,
        sequence: 4,
        occurredAt: 200,
        recordedAt: 201,
        provenance,
        payload: {
          kind: "authority.denied",
          attachmentId: "attachment-1",
          turnId: "turn-1",
          tool: "bash",
          cause: "command.destructive-removal",
          reason: "refused",
        },
      });
    });
    ctx.db
      .prepare("UPDATE session_events SET payload = json_set(payload, '$.tool', 7) WHERE id = ?")
      .run("authority-denied-malformed-event");

    await expect(control.listEvents({ sessionId: created.session.id })).rejects.toThrow(
      "tool must be a string",
    );
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
        authority: null,
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

  it("round-trips interaction facts through strict SQLite decoding", async () => {
    const { control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-structured",
      projectId,
      ticketId: null,
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
    const { control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-invalid",
      projectId,
      ticketId: null,
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
    const project = () => control.getSession({ sessionId: created.session.id });

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
    const { control, projectId } = setup();
    const created = await control.createSession({
      commandId: "create-cancelled",
      projectId,
      ticketId: null,
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
    await expect(control.getSession({ sessionId: created.session.id })).rejects.toThrow(
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
           (id, session_id, sequence, occurred_at, recorded_at, provenance, attachment_id, command_id, payload)
         VALUES ('retired-kind-event', ?, 4, 400, 400, ?, NULL, NULL, ?)`,
      )
      .run(
        created.session.id,
        JSON.stringify(provenance),
        JSON.stringify({ kind: "capabilities.retired" }),
      );
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
             (id, session_id, sequence, occurred_at, recorded_at, provenance, attachment_id, command_id, payload)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
        )
        .run(
          `retired-page-${sequence}`,
          created.session.id,
          sequence,
          sequence * 100,
          sequence * 100,
          JSON.stringify(provenance),
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
      title: "Retired kind get event",
      provenance,
    });
    ctx.db
      .prepare(
        `INSERT INTO session_events
           (id, session_id, sequence, occurred_at, recorded_at, provenance, attachment_id, command_id, payload)
         VALUES ('retired-kind-get-event', ?, 4, 400, 400, ?, NULL, NULL, ?)`,
      )
      .run(
        created.session.id,
        JSON.stringify(provenance),
        JSON.stringify({ kind: "capabilities.retired" }),
      );

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
