import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import {
  SessionEngineConflictError,
  SessionEngineNotFoundError,
  createSessionEngine,
  createInMemorySessionLedger,
} from "./index";
import {
  CHECKPOINT_REFRESH_EVENTS,
  SESSION_LISTING_CACHE_LIMIT,
  SESSION_LISTING_FOLD_CHUNK,
} from "./session-engine";
import { createSessionProjectionCheckpoint, roleImpliedByTicket } from "@volli/shared";
import type {
  AcceptedCommandReceipt,
  ListSessionsQuery,
  Session,
  SessionAttachment,
  SessionCommand,
  SessionEvent,
  SessionEventProvenance,
  SessionLedgerIds,
  SessionLedger,
  SessionLedgerTransaction,
  SessionObservation,
  SessionProjectionCheckpoint,
  SessionProjectionEvent,
  SessionUsage,
  UnstampedCommandReceipt,
} from "@volli/shared";

const localVenue = { id: "machine-1", kind: "local" as const };
const userProvenance: SessionEventProvenance = {
  source: { kind: "user", id: "host-user", detail: null },
  venue: localVenue,
};
const adapterProvenance: SessionEventProvenance = {
  source: { kind: "adapter", id: "opencode", detail: { channel: "plugin" } },
  venue: localVenue,
};

function ids(): SessionLedgerIds {
  let sequence = 0;
  return { next: (kind) => `${kind}-${++sequence}` };
}

function composition() {
  let now = 100;
  const ledger = createInMemorySessionLedger();
  const plane = createSessionEngine({ ledger, clock: { now: () => now++ }, ids: ids() });
  return { ledger, plane };
}

function createRequest(commandId = "command-create") {
  return {
    commandId,
    projectId: "project-1",
    ticketId: "ticket-1",
    role: "ticket" as const,
    parentSessionId: null,
    title: "Durable Session",
    provenance: userProvenance,
  };
}

function attachment(sessionId: string, id = "attachment-1"): SessionAttachment {
  return {
    id,
    sessionId,
    adapterId: "opencode",
    venue: localVenue,
    continuity: "fresh",
    native: { id: "native-1", detail: { native: true } },
    authority: null,
  };
}

function sessionRecord(id = "session-seed"): Session {
  return {
    id,
    projectId: "project-1",
    ticketId: null,
    role: "project",
    parentSessionId: null,
    title: null,
    createdAt: 0,
  };
}

function command(id: string, sessionId: string, intent: SessionCommand["intent"]): SessionCommand {
  return { id, sessionId, createdAt: 0, intent, route: null };
}

function acceptedReceipt(
  id: string,
  commandId: string,
  result: AcceptedCommandReceipt["result"],
): AcceptedCommandReceipt {
  return { id, commandId, status: "accepted", acceptedAt: 0, recordedAt: 0, sequence: 0, result };
}

function observedReceipt(receipt: AcceptedCommandReceipt): UnstampedCommandReceipt {
  const { recordedAt: _recordedAt, sequence: _sequence, ...observed } = receipt;
  return observed;
}

function createdEvent(id: string, session: Session, commandId = "command-create"): SessionEvent {
  return {
    id,
    sessionId: session.id,
    sequence: 1,
    occurredAt: 0,
    recordedAt: 0,
    provenance: userProvenance,
    commandId,
    payload: { kind: "session.created", session },
  };
}

describe("SessionEngine creation and explicit commands", () => {
  it("stores the Role a Session is created under, independent of its Ticket (VC-9)", async () => {
    const { plane } = composition();

    // A subagent on a Ticket: the Ticket is inherited from its parent, so
    // `ticketId` alone can no longer say which Role this is.
    const { session } = await plane.createSession({
      ...createRequest(),
      role: "subagent",
      parentSessionId: "parent-session",
    });

    expect(session.role).toBe("subagent");
    expect(session.ticketId).toBe("ticket-1");
    expect(session.parentSessionId).toBe("parent-session");
    const projection = await plane.getSession({ sessionId: session.id });
    expect(projection?.session.role).toBe("subagent");
    // The birth facts travel on the immutable event, not only the live row:
    // the Role and the parent link, so a host rebuilding from events keeps both.
    const created = (await plane.listEvents({ sessionId: session.id })).find(
      ({ payload }) => payload.kind === "session.created",
    );
    expect(
      created?.payload.kind === "session.created" ? created.payload.session : null,
    ).toMatchObject({ role: "subagent", parentSessionId: "parent-session" });
  });

  it("honors a client-requested Session id, and keeps the ledger derivation absent one (VC-358)", async () => {
    const { plane } = composition();
    const requested = "0f1a2b3c-4d5e-4f6a-8b7c-9d0e1f2a3b4c";

    // Without a request, the ledger's own `ids.next("session")` derivation is
    // untouched — the default this ticket must not move.
    expect((await plane.createSession(createRequest("command-default-id"))).session.id).toBe(
      "session-1",
    );

    const promoted = await plane.createSession({
      ...createRequest("command-requested-id"),
      requestedSessionId: requested,
    });
    expect(promoted.session.id).toBe(requested);
    // The id travels on the immutable identity fact, not only the live row.
    const created = (await plane.listEvents({ sessionId: requested })).find(
      ({ payload }) => payload.kind === "session.created",
    );
    expect(created?.payload.kind === "session.created" && created.payload.session.id).toBe(
      requested,
    );
  });

  it("replays a requested-id create idempotently, and refuses a different requested id (VC-358)", async () => {
    const { plane } = composition();
    const requested = "0f1a2b3c-4d5e-4f6a-8b7c-9d0e1f2a3b4c";
    const first = await plane.createSession({
      ...createRequest("command-promote"),
      requestedSessionId: requested,
    });

    const replay = await plane.createSession({
      ...createRequest("command-promote"),
      requestedSessionId: requested,
    });
    expect(replay).toEqual(first);

    await expect(
      plane.createSession({
        ...createRequest("command-promote"),
        requestedSessionId: "11111111-2222-4333-8444-555555555555",
      }),
    ).rejects.toBeInstanceOf(SessionEngineConflictError);
  });

  it("records one immutable Runtime Brief when concurrent callers disagree", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());

    const [first, second] = await Promise.all([
      plane.getOrRecordSessionInput({
        sessionId: session.id,
        input: { kind: "runtime-brief", text: "original ticket body" },
        provenance: userProvenance,
      }),
      plane.getOrRecordSessionInput({
        sessionId: session.id,
        input: { kind: "runtime-brief", text: "edited ticket body" },
        provenance: userProvenance,
      }),
    ]);

    expect(first).toEqual({ kind: "runtime-brief", text: "original ticket body" });
    expect(second).toEqual(first);
    expect(
      (await plane.listEvents({ sessionId: session.id })).filter(
        ({ payload }) => payload.kind === "session.input.recorded",
      ),
    ).toHaveLength(1);
  });

  it("refuses to record a Runtime Brief for a missing Session", async () => {
    const { plane } = composition();

    await expect(
      plane.getOrRecordSessionInput({
        sessionId: "missing-session",
        input: { kind: "runtime-brief", text: "orphaned brief" },
        provenance: userProvenance,
      }),
    ).rejects.toBeInstanceOf(SessionEngineNotFoundError);
  });

  it("records submitted intent as a canonical event even before an adapter receipt exists", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const result = await plane.submit({
      commandId: "command-recorded",
      sessionId: session.id,
      intent: {
        kind: "message.submit",
        reference: { id: "message-recorded", mediaType: null, digest: null },
      },
      provenance: userProvenance,
    });

    expect(result.commandEvent).toMatchObject({
      sessionId: session.id,
      payload: { kind: "command.recorded", command: result.command },
    });
  });

  it("atomically creates a Session, acceptance receipt, immutable identity fact, and idempotent result", async () => {
    const { plane } = composition();
    const first = await plane.createSession(createRequest());
    const second = await plane.createSession(createRequest());

    expect(first).toMatchObject({
      session: { id: "session-1", createdAt: 100, ticketId: "ticket-1" },
      command: { sessionId: "session-1" },
      receipt: { id: "receipt-5", status: "completed", commandId: "command-create", sequence: 3 },
      commandEvent: {
        id: "event-2",
        sequence: 1,
        payload: { kind: "command.recorded", command: first.command },
      },
      event: {
        id: "event-3",
        sequence: 2,
        commandId: "command-create",
        provenance: userProvenance,
        payload: { kind: "session.created", session: first.session },
      },
    });
    expect(second).toEqual(first);
    expect((await plane.createSession(createRequest("command-create-next"))).session.id).toBe(
      "session-6",
    );
    await expect(plane.getSession({ sessionId: first.session.id })).resolves.toMatchObject({
      status: "open",
    });
    for (const request of [
      { ...createRequest(), projectId: "project-2" },
      { ...createRequest(), ticketId: null },
      { ...createRequest(), role: "subagent" as const, parentSessionId: "parent-session" },
      { ...createRequest(), parentSessionId: "other-parent" },
      { ...createRequest(), title: "different" },
    ]) {
      await expect(plane.createSession(request)).rejects.toBeInstanceOf(SessionEngineConflictError);
    }
    await plane.submit({
      commandId: "command-create-conflict",
      sessionId: first.session.id,
      intent: { kind: "session.archive" },
      provenance: userProvenance,
    });
    await expect(
      plane.createSession(createRequest("command-create-conflict")),
    ).rejects.toBeInstanceOf(SessionEngineConflictError);
  });

  it("persists adapter-bound intent without manufacturing a receipt, then appends adapter receipts as facts", async () => {
    const { ledger, plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const start = await plane.submit({
      commandId: "command-start",
      sessionId: session.id,
      intent: { kind: "executor.start", adapterId: "opencode", continuity: "fresh" },
      provenance: userProvenance,
    });
    expect(start.receipt).toBeNull();
    await expect(
      ledger.transaction((transaction) => transaction.listReceipts(start.command.id)),
    ).resolves.toEqual([]);

    const receipt = acceptedReceipt("receipt-start", start.command.id, {
      kind: "executor.start.requested",
      sessionId: session.id,
    });
    const acceptedEvent = await plane.observe({
      id: "observation-receipt-accepted",
      sessionId: session.id,
      occurredAt: 200,
      provenance: adapterProvenance,
      kind: "command.receipt",
      receipt: observedReceipt(receipt),
    });
    expect(acceptedEvent.attachmentId).toBeNull();
    await plane.observe({
      id: "observation-receipt-completed",
      sessionId: session.id,
      occurredAt: 201,
      provenance: adapterProvenance,
      kind: "command.receipt",
      receipt: {
        id: "receipt-completed",
        commandId: start.command.id,
        status: "completed",
        result: { kind: "executor.start.requested", sessionId: session.id },
      },
    });
    await expect(
      ledger.transaction((transaction) => transaction.listReceipts(start.command.id)),
    ).resolves.toHaveLength(2);
    await plane.observe({
      id: "observation-receipt-replayed",
      sessionId: session.id,
      occurredAt: 202,
      provenance: adapterProvenance,
      kind: "command.receipt",
      receipt: observedReceipt(receipt),
    });
    await expect(
      plane.observe({
        id: "observation-receipt-divergent",
        sessionId: session.id,
        occurredAt: 203,
        provenance: adapterProvenance,
        kind: "command.receipt",
        receipt: {
          id: receipt.id,
          commandId: receipt.commandId,
          status: "completed",
          result: receipt.result,
        },
      }),
    ).rejects.toThrow("already recorded differently");
    await expect(plane.listEvents({ sessionId: session.id })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commandId: start.command.id,
          payload: {
            kind: "command.receipt.recorded",
            receipt: expect.objectContaining({ id: receipt.id }),
          },
        }),
      ]),
    );
    expect(
      await plane.submit({
        commandId: "command-start",
        sessionId: session.id,
        intent: { kind: "executor.start", adapterId: "opencode", continuity: "fresh" },
        provenance: userProvenance,
      }),
    ).toMatchObject({
      receipt: {
        id: "receipt-completed",
        status: "completed",
        result: receipt.result,
      },
    });
  });

  it("archives explicitly with an internal receipt and rejects new commands after archive", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const archived = await plane.submit({
      commandId: "command-archive",
      sessionId: session.id,
      intent: { kind: "session.archive" },
      provenance: userProvenance,
    });
    expect(archived.receipt).toMatchObject({
      status: "completed",
      result: { kind: "session.archived", sessionId: session.id },
    });
    await expect(plane.getSession({ sessionId: session.id })).resolves.toMatchObject({
      status: "archived",
    });
    const rejectedMessage = await plane.submit({
      commandId: "command-message",
      sessionId: session.id,
      intent: {
        kind: "message.submit",
        reference: { id: "message", mediaType: null, digest: null },
      },
      provenance: userProvenance,
    });
    expect(rejectedMessage).toMatchObject({
      commandEvent: { payload: { kind: "command.recorded" } },
      receipt: { status: "rejected", code: "session_archived" },
      receiptEvent: { payload: { kind: "command.receipt.recorded" } },
    });
    await expect(
      plane.submit({
        commandId: "command-message",
        sessionId: session.id,
        intent: {
          kind: "message.submit",
          reference: { id: "message", mediaType: null, digest: null },
        },
        provenance: userProvenance,
      }),
    ).resolves.toEqual(rejectedMessage);
    await expect(
      plane.submit({
        commandId: "command-archive-again",
        sessionId: session.id,
        intent: { kind: "session.archive" },
        provenance: userProvenance,
      }),
    ).resolves.toMatchObject({ receipt: { status: "rejected", code: "session_already_archived" } });
    expect(
      (await plane.listEvents({ sessionId: session.id })).filter(
        (event) => event.payload.kind === "session.archived",
      ),
    ).toHaveLength(1);
  });

  it("retitles through immutable internal facts, replays, and rejects after archive", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const retitled = await plane.submit({
      commandId: "command-retitle",
      sessionId: session.id,
      intent: { kind: "session.retitle", title: "Renamed durable Session" },
      provenance: userProvenance,
    });

    expect(retitled).toMatchObject({
      commandEvent: { payload: { kind: "command.recorded" } },
      receipt: {
        status: "completed",
        result: { kind: "session.retitled", sessionId: session.id },
      },
      receiptEvent: { payload: { kind: "command.receipt.recorded" } },
    });
    await expect(plane.getSession({ sessionId: session.id })).resolves.toMatchObject({
      session: { title: "Renamed durable Session" },
    });
    expect(session.title).toBe("Durable Session");
    await expect(
      plane.submit({
        commandId: "command-retitle",
        sessionId: session.id,
        intent: { kind: "session.retitle", title: "Renamed durable Session" },
        provenance: userProvenance,
      }),
    ).resolves.toEqual(retitled);
    await plane.submit({
      commandId: "command-archive-after-retitle",
      sessionId: session.id,
      intent: { kind: "session.archive" },
      provenance: userProvenance,
    });
    await expect(
      plane.submit({
        commandId: "command-retitle-after-archive",
        sessionId: session.id,
        intent: { kind: "session.retitle", title: null },
        provenance: userProvenance,
      }),
    ).resolves.toMatchObject({ receipt: { status: "rejected", code: "session_archived" } });
    const retitleFacts = (await plane.listEvents({ sessionId: session.id })).filter(
      (event) => event.payload.kind === "session.retitled",
    );
    expect(retitleFacts).toHaveLength(1);
    expect(retitleFacts[0]?.payload).toEqual({
      kind: "session.retitled",
      title: "Renamed durable Session",
    });
  });

  it("selects a model as a durable completed Session command", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const selection = {
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high" as const,
    };

    const selected = await plane.submit({
      commandId: "command-model-select",
      sessionId: session.id,
      intent: { kind: "model.select", selection },
      provenance: userProvenance,
    });

    expect(selected).toMatchObject({
      commandEvent: { payload: { kind: "command.recorded" } },
      receipt: {
        status: "completed",
        result: { kind: "model.selected", sessionId: session.id },
      },
      receiptEvent: { payload: { kind: "command.receipt.recorded" } },
    });
    await expect(plane.getSession({ sessionId: session.id })).resolves.toMatchObject({
      modelSelection: selection,
    });
    expect(
      (await plane.listEvents({ sessionId: session.id }))
        .filter((event) => event.commandId === "command-model-select")
        .map((event) => event.payload.kind),
    ).toEqual(["command.recorded", "model.selected", "command.receipt.recorded"]);
    await expect(
      plane.submit({
        commandId: "command-model-select",
        sessionId: session.id,
        intent: { kind: "model.select", selection },
        provenance: userProvenance,
      }),
    ).resolves.toEqual(selected);
    await expect(
      plane.submit({
        commandId: "command-model-select",
        sessionId: session.id,
        intent: {
          kind: "model.select",
          selection: { ...selection, reasoningLevel: "medium" },
        },
        provenance: userProvenance,
      }),
    ).rejects.toThrow("different intent");
  });

  it("writes the tier a selection resolved from beside it, and only then (VC-259)", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const selection = {
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high" as const,
    };

    // Idle path: the fact is written in-engine, tier included.
    await plane.submit({
      commandId: "command-model-select-fast",
      sessionId: session.id,
      intent: { kind: "model.select", selection, tier: "fast" },
      provenance: userProvenance,
    });
    await expect(plane.getSession({ sessionId: session.id })).resolves.toMatchObject({
      modelSelection: selection,
      modelTier: "fast",
    });
    const selected = (await plane.listEvents({ sessionId: session.id })).find(
      (event) => event.payload.kind === "model.selected",
    );
    expect(selected?.payload).toEqual({ kind: "model.selected", selection, tier: "fast" });

    // Live path: the adapter accepted, and the completion carries the same tier.
    const running = attachment(session.id);
    await plane.observe({
      id: "model-select-tier-open",
      sessionId: session.id,
      occurredAt: 1,
      provenance: adapterProvenance,
      kind: "attachment.opened",
      attachment: running,
    });
    const submitted = await plane.submit({
      commandId: "command-model-select-deep",
      sessionId: session.id,
      intent: { kind: "model.select", selection, tier: "deep" },
      provenance: userProvenance,
    });
    expect(submitted.receipt).toBeNull();
    const completed = await plane.completeModelSelection({
      sessionId: session.id,
      commandId: "command-model-select-deep",
      attachmentId: running.id,
      occurredAt: 2,
      provenance: adapterProvenance,
    });
    expect(completed.event.payload).toEqual({ kind: "model.selected", selection, tier: "deep" });
    await expect(plane.getSession({ sessionId: session.id })).resolves.toMatchObject({
      modelTier: "deep",
    });
  });

  it("rejects model changes while a turn is active", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const running = attachment(session.id);
    await plane.observe({
      id: "model-select-open",
      sessionId: session.id,
      occurredAt: 1,
      provenance: adapterProvenance,
      kind: "attachment.opened",
      attachment: running,
    });
    await plane.observe({
      id: "model-select-turn",
      sessionId: session.id,
      occurredAt: 2,
      provenance: adapterProvenance,
      kind: "turn.started",
      attachmentId: running.id,
      turnId: "turn-model-select",
    });

    const selected = await plane.submit({
      commandId: "command-model-select-busy",
      sessionId: session.id,
      intent: {
        kind: "model.select",
        selection: {
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          reasoningLevel: "high",
        },
      },
      provenance: userProvenance,
    });

    expect(selected.receipt).toMatchObject({ status: "rejected", code: "turn_active" });
    await expect(plane.getSession({ sessionId: session.id })).resolves.toMatchObject({
      modelSelection: null,
    });
  });

  it("routes an idle live model change and completes its fact and receipt atomically", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const running = attachment(session.id);
    await plane.observe({
      id: "model-select-live-open",
      sessionId: session.id,
      occurredAt: 1,
      provenance: adapterProvenance,
      kind: "attachment.opened",
      attachment: running,
    });
    const selection = {
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high" as const,
    };

    const submitted = await plane.submit({
      commandId: "command-model-select-live",
      sessionId: session.id,
      intent: { kind: "model.select", selection },
      provenance: userProvenance,
    });

    expect(submitted).toMatchObject({
      command: {
        route: { adapterId: running.adapterId, attachmentId: running.id },
      },
      receipt: null,
      receiptEvent: null,
    });
    await expect(plane.getSession({ sessionId: session.id })).resolves.toMatchObject({
      modelSelection: null,
    });

    const completed = await plane.completeModelSelection({
      sessionId: session.id,
      commandId: submitted.command.id,
      attachmentId: running.id,
      occurredAt: 3,
      provenance: adapterProvenance,
    });

    expect(completed).toMatchObject({
      event: { payload: { kind: "model.selected", selection } },
      receipt: {
        status: "completed",
        result: { kind: "model.selected", sessionId: session.id },
      },
      receiptEvent: { payload: { kind: "command.receipt.recorded" } },
    });
    expect(
      (await plane.listEvents({ sessionId: session.id }))
        .filter((event) => event.commandId === submitted.command.id)
        .map((event) => event.payload.kind),
    ).toEqual(["command.recorded", "model.selected", "command.receipt.recorded"]);
    await expect(plane.getSession({ sessionId: session.id })).resolves.toMatchObject({
      modelSelection: selection,
    });
    await expect(
      plane.completeModelSelection({
        sessionId: session.id,
        commandId: submitted.command.id,
        attachmentId: running.id,
        occurredAt: 4,
        provenance: adapterProvenance,
      }),
    ).resolves.toEqual(completed);
  });

  it("refuses to complete a routed model selection without its exact adapter provenance", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const running = attachment(session.id);
    await plane.observe({
      id: "model-select-provenance-open",
      sessionId: session.id,
      occurredAt: 1,
      provenance: adapterProvenance,
      kind: "attachment.opened",
      attachment: running,
    });
    await plane.submit({
      commandId: "command-model-select-provenance",
      sessionId: session.id,
      intent: {
        kind: "model.select",
        selection: {
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          reasoningLevel: "high",
        },
      },
      provenance: userProvenance,
    });

    await expect(
      plane.completeModelSelection({
        sessionId: session.id,
        commandId: "command-model-select-provenance",
        attachmentId: running.id,
        occurredAt: 3,
        provenance: userProvenance,
      }),
    ).rejects.toThrow("was not completed by adapter");
  });

  it("refuses an observed model-selection receipt from a different attachment", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const routed = attachment(session.id, "attachment-model-route");
    await plane.observe({
      id: "model-route-open",
      sessionId: session.id,
      occurredAt: 1,
      provenance: adapterProvenance,
      kind: "attachment.opened",
      attachment: routed,
    });
    const submitted = await plane.submit({
      commandId: "command-model-route",
      sessionId: session.id,
      intent: {
        kind: "model.select",
        selection: {
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          reasoningLevel: "high",
        },
      },
      provenance: userProvenance,
    });
    await plane.observe({
      id: "model-route-close",
      sessionId: session.id,
      occurredAt: 2,
      provenance: adapterProvenance,
      kind: "attachment.closed",
      attachmentId: routed.id,
      outcome: "interrupted",
    });
    const other = attachment(session.id, "attachment-model-other");
    await plane.observe({
      id: "model-other-open",
      sessionId: session.id,
      occurredAt: 3,
      provenance: adapterProvenance,
      kind: "attachment.opened",
      attachment: other,
    });

    await expect(
      plane.observe({
        id: "model-receipt-from-other",
        sessionId: session.id,
        occurredAt: 4,
        provenance: adapterProvenance,
        attachmentId: other.id,
        kind: "command.receipt",
        receipt: {
          id: "model-receipt-from-other",
          commandId: submitted.command.id,
          status: "accepted",
          acceptedAt: 4,
          result: { kind: "model.selected", sessionId: session.id },
        },
      }),
    ).rejects.toThrow("does not match routed attachment");
  });

  it("refuses model-selection completion without its exact Session command route", async () => {
    const { plane } = composition();

    await expect(
      plane.completeModelSelection({
        sessionId: "missing-session",
        commandId: "missing-command",
        attachmentId: "missing-attachment",
        occurredAt: 1,
        provenance: adapterProvenance,
      }),
    ).rejects.toBeInstanceOf(SessionEngineNotFoundError);

    const { session } = await plane.createSession(createRequest());
    await expect(
      plane.completeModelSelection({
        sessionId: session.id,
        commandId: "command-create",
        attachmentId: "missing-attachment",
        occurredAt: 2,
        provenance: adapterProvenance,
      }),
    ).rejects.toThrow(
      "Command command-create is not a routed model selection for attachment missing-attachment",
    );
  });

  it("rejects model-selection completion when a later receipt corrupts completed history", async () => {
    const { ledger, plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const running = attachment(session.id, "attachment-model-history");
    await plane.observe({
      id: "model-history-open",
      sessionId: session.id,
      occurredAt: 1,
      provenance: adapterProvenance,
      kind: "attachment.opened",
      attachment: running,
    });
    const submitted = await plane.submit({
      commandId: "command-model-history",
      sessionId: session.id,
      intent: {
        kind: "model.select",
        selection: {
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          reasoningLevel: "high",
        },
      },
      provenance: userProvenance,
    });
    await plane.completeModelSelection({
      sessionId: session.id,
      commandId: submitted.command.id,
      attachmentId: running.id,
      occurredAt: 2,
      provenance: adapterProvenance,
    });
    await ledger.transaction((transaction) => {
      const sequence = transaction.listEvents({ sessionId: session.id }).at(-1)!.sequence + 1;
      const receipt = {
        id: "receipt-model-history-corrupt",
        commandId: submitted.command.id,
        status: "rejected" as const,
        code: "late_rejection",
        detail: null,
        recordedAt: 3,
        sequence,
      };
      transaction.appendReceipt(receipt);
      transaction.appendEvent({
        id: "event-model-history-corrupt",
        sessionId: session.id,
        sequence,
        occurredAt: 3,
        recordedAt: 3,
        provenance: adapterProvenance,
        attachmentId: running.id,
        commandId: submitted.command.id,
        payload: { kind: "command.receipt.recorded", receipt },
      });
    });

    await expect(
      plane.completeModelSelection({
        sessionId: session.id,
        commandId: submitted.command.id,
        attachmentId: running.id,
        occurredAt: 4,
        provenance: adapterProvenance,
      }),
    ).rejects.toThrow("has invalid completed model-selection history");
  });

  it("records an explicit Session signal as an immutable fact with an internal receipt", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());

    const signaled = await plane.submit({
      commandId: "command-signal",
      sessionId: session.id,
      intent: { kind: "session.signal", signal: "blocked", reason: "Needs input" },
      provenance: userProvenance,
    });

    expect(signaled).toMatchObject({
      commandEvent: { payload: { kind: "command.recorded" } },
      receipt: {
        status: "completed",
        result: { kind: "session.signaled", sessionId: session.id },
      },
      receiptEvent: { payload: { kind: "command.receipt.recorded" } },
    });
    await expect(plane.getSession({ sessionId: session.id })).resolves.toMatchObject({
      signal: { signal: "blocked", reason: "Needs input" },
    });
  });

  // VC-86: the stop intent completes in-engine like a signal — one durable
  // command, one stopped event carrying its actor, one internal receipt.
  it("records a stop with its actor as an immutable fact with an internal receipt", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());

    const stopped = await plane.submit({
      commandId: "command-stop",
      sessionId: session.id,
      intent: {
        kind: "session.stop",
        reason: "Wedged for 3h",
        by: { kind: "session", sessionId: "supervisor-1" },
      },
      provenance: userProvenance,
    });

    expect(stopped).toMatchObject({
      commandEvent: { payload: { kind: "command.recorded" } },
      receipt: {
        status: "completed",
        result: { kind: "session.stopped", sessionId: session.id },
      },
      receiptEvent: { payload: { kind: "command.receipt.recorded" } },
    });
    await expect(plane.getSession({ sessionId: session.id })).resolves.toMatchObject({
      stopped: {
        reason: "Wedged for 3h",
        by: { kind: "session", sessionId: "supervisor-1" },
      },
    });
  });

  it("resumes getSession and listSessions from checkpoint tails without mutating reads", async () => {
    const stored = createInMemorySessionLedger();
    const cursors: Array<number | undefined> = [];
    const auditReads: string[] = [];
    const ledger: SessionLedger = {
      transaction: (work) =>
        stored.transaction((transaction) =>
          work(
            new Proxy(transaction, {
              get(target, property, receiver) {
                // The fold path must use the provenance-free read (VC-355), so
                // the cursors are observed there and any use of the audit read
                // by a projection is recorded as a regression.
                if (property === "listEvents") {
                  return (query: Parameters<SessionLedgerTransaction["listEvents"]>[0]) => {
                    auditReads.push(query.sessionId);
                    return transaction.listEvents(query);
                  };
                }
                if (property !== "listProjectionEvents") {
                  return Reflect.get(target, property, receiver);
                }
                return (query: Parameters<SessionLedgerTransaction["listProjectionEvents"]>[0]) => {
                  cursors.push(query.afterSequence);
                  return transaction.listProjectionEvents(query);
                };
              },
            }),
          ),
        ),
    };
    const plane = createSessionEngine({ ledger, clock: { now: () => 100 }, ids: ids() });
    const created = await plane.createSession(createRequest("command-checkpoint-list"));

    cursors.length = 0;
    const first = await plane.listSessions({ projectId: "project-1", scope: "all" });
    expect(cursors).toEqual([undefined]);
    expect(first).toHaveLength(1);
    await expect(
      plane.getProjectionCheckpoint({ sessionId: created.session.id }),
    ).resolves.toBeNull();

    const events = await plane.listEvents({ sessionId: created.session.id });
    const checkpoint = createSessionProjectionCheckpoint(created.session, events);
    await plane.saveProjectionCheckpoint(checkpoint);
    await plane.submit({
      commandId: "command-checkpoint-tail",
      sessionId: created.session.id,
      intent: { kind: "session.signal", signal: "done", reason: "Tail" },
      provenance: userProvenance,
    });

    cursors.length = 0;
    await expect(plane.getSession({ sessionId: created.session.id })).resolves.toMatchObject({
      signal: { signal: "done", reason: "Tail" },
    });
    expect(cursors).toEqual([checkpoint.throughSequence]);

    cursors.length = 0;
    auditReads.length = 0;
    await expect(
      plane.listSessions({ projectId: "project-1", scope: "all" }),
    ).resolves.toHaveLength(1);
    expect(cursors).toEqual([checkpoint.throughSequence]);
    // A listing folds every Session it returns, so paying one provenance
    // decode per event here is the cost the split exists to remove.
    expect(auditReads).toEqual([]);
    expect(
      (await plane.getProjectionCheckpoint({ sessionId: created.session.id }))?.throughSequence,
    ).toBe(checkpoint.throughSequence);
  });

  it("validates in-memory projection checkpoints at their write boundary", async () => {
    const { plane } = composition();
    await expect(plane.latestEventSequence({ sessionId: "missing-session" })).resolves.toBe(0);
    const created = await plane.createSession(createRequest("command-checkpoint-validation"));
    const events = await plane.listEvents({ sessionId: created.session.id });
    const checkpoint = createSessionProjectionCheckpoint(created.session, events);
    const missingProjection = { ...checkpoint, projection: undefined };
    const missingSession = {
      ...checkpoint,
      sessionId: "missing-session",
      projection: {
        ...checkpoint.projection,
        session: { ...checkpoint.projection.session, id: "missing-session" },
      },
    };
    const invalid = [
      { ...checkpoint, version: 2 },
      { ...checkpoint, sessionId: "another-session" },
      missingProjection,
      { ...checkpoint, throughSequence: 0.5 },
      { ...checkpoint, throughSequence: -1 },
      { ...checkpoint, pendingExecutorStarts: null },
      missingSession,
    ] as unknown as SessionProjectionCheckpoint[];

    for (const candidate of invalid) {
      await expect(plane.saveProjectionCheckpoint(candidate)).rejects.toThrow(
        "Session projection checkpoint is invalid",
      );
    }
    await expect(
      plane.saveProjectionCheckpoint({
        ...checkpoint,
        throughSequence: checkpoint.throughSequence + 1,
      }),
    ).rejects.toThrow("Session projection checkpoint is ahead of durable history");

    await plane.saveProjectionCheckpoint(checkpoint);
    const older = createSessionProjectionCheckpoint(created.session, []);
    await plane.saveProjectionCheckpoint(older);
    await expect(
      plane.getProjectionCheckpoint({ sessionId: created.session.id }),
    ).resolves.toMatchObject({ throughSequence: checkpoint.throughSequence });
  });

  it("resumes a checkpoint with the live row while retaining projected title", async () => {
    const stored = createInMemorySessionLedger();
    let ticketDeleted = false;
    const ledger: SessionLedger = {
      transaction: (work) =>
        stored.transaction((transaction) =>
          work(
            new Proxy(transaction, {
              get(target, property, receiver) {
                if (property !== "getSession") return Reflect.get(target, property, receiver);
                return (sessionId: string) => {
                  const session = transaction.getSession(sessionId);
                  return session && ticketDeleted ? { ...session, ticketId: null } : session;
                };
              },
            }),
          ),
        ),
    };
    const plane = createSessionEngine({ ledger, clock: { now: () => 100 }, ids: ids() });
    const created = await plane.createSession(createRequest("command-checkpoint-live-row"));
    await plane.submit({
      commandId: "command-checkpoint-live-title",
      sessionId: created.session.id,
      intent: { kind: "session.retitle", title: "Projected checkpoint title" },
      provenance: userProvenance,
    });
    const events = await plane.listEvents({ sessionId: created.session.id });
    await plane.saveProjectionCheckpoint(
      createSessionProjectionCheckpoint(created.session, events),
    );

    ticketDeleted = true;

    await expect(plane.getSession({ sessionId: created.session.id })).resolves.toMatchObject({
      session: {
        ticketId: null,
        title: "Projected checkpoint title",
      },
      bornTicketless: false,
    });
  });

  it("reports a checkpoint it could not use instead of silently refolding forever", async () => {
    const stored = createInMemorySessionLedger();
    const failure = new Error("checkpoint row could not be decoded");
    let failReads = false;
    const ledger: SessionLedger = {
      transaction: (work) =>
        stored.transaction((transaction) =>
          work(
            new Proxy(transaction, {
              get(target, property, receiver) {
                if (property !== "getProjectionCheckpoint") {
                  return Reflect.get(target, property, receiver);
                }
                return (sessionId: string) => {
                  if (failReads) throw failure;
                  return transaction.getProjectionCheckpoint(sessionId);
                };
              },
            }),
          ),
        ),
    };
    const reported: unknown[] = [];
    const plane = createSessionEngine({
      ledger,
      clock: { now: () => 100 },
      ids: ids(),
      onProjectionCheckpointFailure: (error) => reported.push(error),
    });
    const created = await plane.createSession(createRequest("command-checkpoint-report"));

    failReads = true;
    // The read still answers from the immutable log: a cache failure is never
    // allowed to fail a read, which is exactly why it has to be reported.
    await expect(plane.getSession({ sessionId: created.session.id })).resolves.toMatchObject({
      session: { id: created.session.id },
    });
    expect(reported).toEqual([failure]);
  });

  it("keeps a read working when the host's own failure reporter throws", async () => {
    const stored = createInMemorySessionLedger();
    const ledger: SessionLedger = {
      transaction: (work) =>
        stored.transaction((transaction) =>
          work(
            new Proxy(transaction, {
              get(target, property, receiver) {
                if (property !== "getProjectionCheckpoint") {
                  return Reflect.get(target, property, receiver);
                }
                return () => {
                  throw new Error("unreadable checkpoint");
                };
              },
            }),
          ),
        ),
    };
    const plane = createSessionEngine({
      ledger,
      clock: { now: () => 100 },
      ids: ids(),
      onProjectionCheckpointFailure: () => {
        throw new Error("diagnostics sink is broken");
      },
    });
    const created = await plane.createSession(createRequest("command-checkpoint-sink"));
    await expect(plane.getSession({ sessionId: created.session.id })).resolves.toMatchObject({
      session: { id: created.session.id },
    });
  });

  it("keeps recording facts when refreshing the derived checkpoint fails", async () => {
    // `observe` refreshes the checkpoint once the durable cache has drifted a
    // whole window behind the log (VC-356). That write is a cache write, so it
    // must behave like one: a Session that can never refresh is slower on its
    // next fold and otherwise completely unaffected. The facts still land, in
    // order, and the host hears about the failure rather than losing it.
    const stored = createInMemorySessionLedger();
    const failure = new Error("checkpoint table is read-only");
    const ledger: SessionLedger = {
      transaction: (work) =>
        stored.transaction((transaction) =>
          work(
            new Proxy(transaction, {
              get(target, property, receiver) {
                if (property !== "saveProjectionCheckpoint") {
                  return Reflect.get(target, property, receiver);
                }
                return () => {
                  throw failure;
                };
              },
            }),
          ),
        ),
    };
    const reported: unknown[] = [];
    const plane = createSessionEngine({
      ledger,
      clock: { now: () => 100 },
      ids: ids(),
      onProjectionCheckpointFailure: (error) => reported.push(error),
    });
    const { session } = await plane.createSession(createRequest("command-refresh-failure"));
    const opened = attachment(session.id);
    await plane.observe({
      id: "observation-refresh-opened",
      sessionId: session.id,
      occurredAt: 200,
      provenance: adapterProvenance,
      kind: "attachment.opened",
      attachment: opened,
    });

    // Past one refresh window, so at least one refresh is certainly attempted.
    const facts = CHECKPOINT_REFRESH_EVENTS + 4;
    for (let index = 0; index < facts; index += 1) {
      await plane.observe({
        id: `observation-refresh-${index}`,
        sessionId: session.id,
        occurredAt: 300 + index,
        provenance: adapterProvenance,
        attachmentId: opened.id,
        kind: "attachment.native_referenced",
        native: { id: `native-${index}`, detail: null },
      });
    }

    expect(reported.length).toBeGreaterThan(0);
    expect(reported.every((error) => error === failure)).toBe(true);

    // The log is untouched by the cache's failure: every fact is present, in
    // one unbroken ascending sequence.
    const events = await plane.listEvents({ sessionId: session.id });
    const referenced = events.filter(
      (event) => event.payload.kind === "attachment.native_referenced",
    );
    expect(referenced).toHaveLength(facts);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index + 1));
    await expect(plane.getSession({ sessionId: session.id })).resolves.toMatchObject({
      liveExecutor: { id: opened.id, native: { id: `native-${facts - 1}` } },
    });
  });

  it("lists deep Session projections through explicit project scopes in stable descending order", async () => {
    const ledger = createInMemorySessionLedger();
    const plane = createSessionEngine({ ledger, clock: { now: () => 100 }, ids: ids() });
    const ticketFirst = await plane.createSession(createRequest("command-list-ticket-first"));
    const projectSession = await plane.createSession({
      ...createRequest("command-list-project"),
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Board Session",
    });
    const ticketLater = await plane.createSession({
      ...createRequest("command-list-ticket-later"),
      title: "Ticket Session",
    });
    await plane.createSession({
      ...createRequest("command-list-other-project"),
      projectId: "project-2",
      ticketId: null,
      role: "project",
      parentSessionId: null,
    });
    await plane.submit({
      commandId: "command-list-retitle",
      sessionId: ticketLater.session.id,
      intent: { kind: "session.retitle", title: "Projected title" },
      provenance: userProvenance,
    });

    const all = await plane.listSessions({ projectId: "project-1", scope: "all" });
    expect(all.map(({ session: listed }) => listed.id)).toEqual([
      projectSession.session.id,
      ticketLater.session.id,
      ticketFirst.session.id,
    ]);
    const listedLater = all.find(({ session: listed }) => listed.id === ticketLater.session.id);
    expect(listedLater?.session.title).toBe("Projected title");
    expect(
      listedLater?.commands.some(
        (sessionCommand) =>
          sessionCommand.intent.kind === "session.retitle" &&
          sessionCommand.intent.title === "Projected title",
      ),
    ).toBe(true);
    expect(
      listedLater?.receipts.some(
        (receipt) => receipt.status === "completed" && receipt.result.kind === "session.retitled",
      ),
    ).toBe(true);
    await expect(
      plane.listSessions({ projectId: "project-1", scope: "ticket", ticketId: "ticket-1" }),
    ).resolves.toMatchObject([
      { session: { id: ticketLater.session.id } },
      { session: { id: ticketFirst.session.id } },
    ]);
    await expect(
      plane.listSessions({ projectId: "project-1", scope: "project" }),
    ).resolves.toMatchObject([{ session: { id: projectSession.session.id, ticketId: null } }]);
    await expect(plane.countSessions({ projectId: "project-1", scope: "all" })).resolves.toBe(3);
    await expect(
      plane.countSessions({ projectId: "project-1", scope: "ticket", ticketId: "ticket-1" }),
    ).resolves.toBe(2);
    await expect(plane.countSessions({ projectId: "project-1", scope: "project" })).resolves.toBe(
      1,
    );
    await plane.submit({
      commandId: "command-signal-ticket-first",
      sessionId: ticketFirst.session.id,
      intent: { kind: "session.signal", signal: "done", reason: "Earlier Session" },
      provenance: userProvenance,
    });
    await plane.submit({
      commandId: "command-signal-ticket-later",
      sessionId: ticketLater.session.id,
      intent: { kind: "session.signal", signal: "blocked", reason: "Later Session" },
      provenance: userProvenance,
    });
    await plane.submit({
      commandId: "command-signal-project",
      sessionId: projectSession.session.id,
      intent: { kind: "session.signal", signal: "done", reason: "Not ticket scoped" },
      provenance: userProvenance,
    });
    await expect(plane.listLatestTicketSignals({ projectId: "project-1" })).resolves.toEqual([
      {
        ticketId: "ticket-1",
        sessionId: ticketLater.session.id,
        signal: "blocked",
        reason: "Later Session",
        createdAt: 100,
      },
    ]);
  });

  it("lists Session start stamps from every project, ascending, from the window's edge", async () => {
    const ledger = createInMemorySessionLedger();
    let now = 10;
    const plane = createSessionEngine({ ledger, clock: { now: () => now }, ids: ids() });
    await plane.createSession(createRequest("command-starts-old"));
    now = 20;
    await plane.createSession({
      ...createRequest("command-starts-other-project"),
      projectId: "project-2",
      ticketId: null,
      role: "project",
      parentSessionId: null,
    });
    now = 30;
    await plane.createSession(createRequest("command-starts-recent"));

    // Every project, because the chart this backs is about the person rather
    // than about any one project.
    await expect(plane.listSessionStarts({ sinceMs: 0 })).resolves.toEqual([10, 20, 30]);
    // Inclusive lower bound, and nothing older comes with it.
    await expect(plane.listSessionStarts({ sinceMs: 20 })).resolves.toEqual([20, 30]);
    await expect(plane.listSessionStarts({ sinceMs: 31 })).resolves.toEqual([]);
  });

  it("lists each ticket's latest signal in stable ticket order without projecting unsignaled Sessions", async () => {
    const { plane } = composition();
    const ticketBFirst = await plane.createSession({
      ...createRequest("command-latest-b-first"),
      ticketId: "ticket-b",
    });
    const ticketBLatest = await plane.createSession({
      ...createRequest("command-latest-b-latest"),
      ticketId: "ticket-b",
    });
    const ticketBOlderIgnored = await plane.createSession({
      ...createRequest("command-latest-b-older-ignored"),
      ticketId: "ticket-b",
    });
    const ticketA = await plane.createSession({
      ...createRequest("command-latest-a"),
      ticketId: "ticket-a",
    });
    await plane.createSession({
      ...createRequest("command-latest-unsignaled"),
      ticketId: "ticket-c",
    });

    await plane.submit({
      commandId: "signal-latest-b-older-ignored",
      sessionId: ticketBOlderIgnored.session.id,
      intent: { kind: "session.signal", signal: "done", reason: "Oldest" },
      provenance: userProvenance,
    });
    await plane.submit({
      commandId: "signal-latest-b-first",
      sessionId: ticketBFirst.session.id,
      intent: { kind: "session.signal", signal: "done", reason: "Older" },
      provenance: userProvenance,
    });
    await plane.submit({
      commandId: "signal-latest-b-latest",
      sessionId: ticketBLatest.session.id,
      intent: { kind: "session.signal", signal: "blocked", reason: "Newer" },
      provenance: userProvenance,
    });
    await plane.submit({
      commandId: "signal-latest-a",
      sessionId: ticketA.session.id,
      intent: { kind: "session.signal", signal: "done", reason: "Alphabetical first" },
      provenance: userProvenance,
    });

    const signals = await plane.listLatestTicketSignals({ projectId: "project-1" });

    expect(signals.map(({ ticketId }) => ticketId)).toEqual(["ticket-a", "ticket-b"]);
    expect(signals).toMatchObject([
      { sessionId: ticketA.session.id, signal: "done", reason: "Alphabetical first" },
      { sessionId: ticketBLatest.session.id, signal: "blocked", reason: "Newer" },
    ]);
  });

  it("uses SQLite BINARY ordering to break equal-time ticket signal ties", async () => {
    const { ledger, plane } = composition();
    const bmpId = "session-\uE000";
    const nonBmpId = "session-\u{10000}";
    await ledger.transaction((transaction) => {
      for (const sessionId of [bmpId, nonBmpId]) {
        transaction.insertSession({ ...sessionRecord(sessionId), ticketId: "ticket-1" });
        transaction.appendEvent({
          id: `signal-${sessionId}`,
          sessionId,
          sequence: 1,
          occurredAt: 100,
          recordedAt: 100,
          provenance: userProvenance,
          payload: {
            kind: "session.signaled",
            signal: "done",
            reason: sessionId,
          },
        });
      }
    });

    await expect(plane.listLatestTicketSignals({ projectId: "project-1" })).resolves.toEqual([
      {
        ticketId: "ticket-1",
        sessionId: nonBmpId,
        signal: "done",
        reason: nonBmpId,
        createdAt: 100,
      },
    ]);
  });

  it("records native continuation evidence only for known open attachments and replays it exactly", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const opened = attachment(session.id);
    await plane.observe({
      id: "observation-native-opened",
      sessionId: session.id,
      occurredAt: 200,
      provenance: adapterProvenance,
      kind: "attachment.opened",
      attachment: opened,
    });
    const native = {
      id: "native-continuation",
      detail: { adapter: { cursor: ["opaque", 3], resume: { token: true } } },
    };
    const observation = {
      id: "observation-native-reference",
      sessionId: session.id,
      occurredAt: 201,
      provenance: adapterProvenance,
      kind: "attachment.native_referenced" as const,
      attachmentId: opened.id,
      native,
    };

    const recorded = await plane.observe(observation);
    expect(recorded).toMatchObject({
      attachmentId: opened.id,
      payload: { kind: "attachment.native_referenced", attachmentId: opened.id, native },
    });
    await expect(plane.getSession({ sessionId: session.id })).resolves.toMatchObject({
      liveExecutor: { id: opened.id, native },
    });
    await expect(plane.observe(observation)).resolves.toEqual(recorded);
    await expect(plane.observe({ ...observation, provenance: userProvenance })).rejects.toThrow(
      "already recorded with different evidence",
    );
    await expect(
      plane.observe({ ...observation, native: { id: null, detail: ["different"] } }),
    ).rejects.toThrow("already recorded with different evidence");
    await expect(
      plane.observe({
        ...observation,
        id: "observation-native-unknown",
        attachmentId: "missing-attachment",
      }),
    ).rejects.toThrow("Attachment missing-attachment is unknown");
    await plane.observe({
      id: "observation-native-closed",
      sessionId: session.id,
      occurredAt: 202,
      provenance: adapterProvenance,
      kind: "attachment.closed",
      attachmentId: opened.id,
      outcome: "completed",
    });
    await expect(
      plane.observe({ ...observation, id: "observation-native-after-close" }),
    ).rejects.toThrow(`Attachment ${opened.id} is already closed`);
  });

  it("rejects user and system native evidence before either can be appended", async () => {
    const { ledger, plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const opened = attachment(session.id);
    await plane.observe({
      id: "observation-native-user-opened",
      sessionId: session.id,
      occurredAt: 200,
      provenance: adapterProvenance,
      kind: "attachment.opened",
      attachment: opened,
    });

    await expect(
      plane.observe({
        id: "observation-native-user",
        sessionId: session.id,
        occurredAt: 201,
        provenance: userProvenance,
        kind: "attachment.native_referenced",
        attachmentId: opened.id,
        native: { id: "native-user", detail: null },
      }),
    ).rejects.toThrow(
      `Native reference for attachment ${opened.id} must be produced by adapter ${opened.adapterId}`,
    );
    await expect(
      plane.observe({
        id: "observation-native-system",
        sessionId: session.id,
        occurredAt: 202,
        provenance: {
          source: { kind: "system", id: "host-system", detail: null },
          venue: localVenue,
        },
        kind: "attachment.native_referenced",
        attachmentId: opened.id,
        native: { id: "native-system", detail: null },
      }),
    ).rejects.toThrow(
      `Native reference for attachment ${opened.id} must be produced by adapter ${opened.adapterId}`,
    );
    await expect(
      ledger.transaction((transaction) =>
        transaction
          .listEvents({ sessionId: session.id })
          .filter((event) => event.payload.kind === "attachment.native_referenced"),
      ),
    ).resolves.toEqual([]);
  });

  it("rejects native evidence from a different adapter before it can be appended", async () => {
    const { ledger, plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const opened = attachment(session.id);
    await plane.observe({
      id: "observation-native-wrong-adapter-opened",
      sessionId: session.id,
      occurredAt: 200,
      provenance: adapterProvenance,
      kind: "attachment.opened",
      attachment: opened,
    });

    await expect(
      plane.observe({
        id: "observation-native-wrong-adapter",
        sessionId: session.id,
        occurredAt: 201,
        provenance: {
          source: { kind: "adapter", id: "codex", detail: null },
          venue: localVenue,
        },
        kind: "attachment.native_referenced",
        attachmentId: opened.id,
        native: { id: "native-wrong-adapter", detail: null },
      }),
    ).rejects.toThrow(
      `Native reference for attachment ${opened.id} must be produced by adapter ${opened.adapterId}`,
    );
    await expect(
      ledger.transaction((transaction) =>
        transaction
          .listEvents({ sessionId: session.id })
          .filter((event) => event.payload.kind === "attachment.native_referenced"),
      ),
    ).resolves.toEqual([]);
  });

  it("records adapter-owned interaction facts and rejects mismatched evidence", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const opened = attachment(session.id);
    await plane.observe({
      id: "observation-structured-opened",
      sessionId: session.id,
      occurredAt: 200,
      provenance: adapterProvenance,
      kind: "attachment.opened",
      attachment: opened,
    });
    const interaction = {
      id: "permission-1",
      attachmentId: opened.id,
      kind: "permission" as const,
      title: "Allow write?",
      detail: null,
      options: [{ id: "once", label: "Allow once", description: null }],
      multiple: false,
      native: { id: "native-permission-1", detail: null },
    };
    await plane.observe({
      id: "observation-interaction-opened",
      sessionId: session.id,
      occurredAt: 202,
      provenance: adapterProvenance,
      kind: "interaction.opened",
      interaction,
    });
    await plane.observe({
      id: "observation-interaction-resolved",
      sessionId: session.id,
      occurredAt: 203,
      provenance: adapterProvenance,
      kind: "interaction.resolved",
      attachmentId: opened.id,
      interactionId: interaction.id,
      resolution: { optionIds: ["once"], response: null },
    });

    await expect(plane.getSession({ sessionId: session.id })).resolves.toMatchObject({
      interactions: {
        active: [],
        resolved: [{ interaction, resolution: { optionIds: ["once"], response: null } }],
      },
    });
    await expect(
      plane.observe({
        id: "observation-interaction-opened-wrong-adapter",
        sessionId: session.id,
        occurredAt: 204,
        provenance: {
          ...adapterProvenance,
          source: { ...adapterProvenance.source, id: "codex" },
        },
        kind: "interaction.opened",
        interaction: { ...interaction, id: "permission-2" },
      }),
    ).rejects.toThrow("must be produced by adapter opencode");
    await expect(
      plane.observe({
        id: "observation-interaction-resolved-twice",
        sessionId: session.id,
        occurredAt: 206,
        provenance: adapterProvenance,
        kind: "interaction.resolved",
        attachmentId: opened.id,
        interactionId: interaction.id,
        resolution: { optionIds: ["once"], response: null },
      }),
    ).rejects.toThrow("is not open");
  });

  it("lets a cancellation land after the attachment closed, and only on an interaction still open", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const opened = attachment(session.id);
    await plane.observe({
      id: "observation-cancel-attachment-opened",
      sessionId: session.id,
      occurredAt: 200,
      provenance: adapterProvenance,
      kind: "attachment.opened",
      attachment: opened,
    });
    const interaction = {
      id: "question-1",
      attachmentId: opened.id,
      kind: "question" as const,
      title: "Which files should I read?",
      detail: null,
      options: [{ id: "prompt:0/option:0", label: "All of them", description: null }],
      multiple: true,
      native: { id: "native-question-1", detail: null },
    };
    await plane.observe({
      id: "observation-cancel-interaction-opened",
      sessionId: session.id,
      occurredAt: 201,
      provenance: adapterProvenance,
      kind: "interaction.opened",
      interaction,
    });
    await plane.observe({
      id: "observation-cancel-attachment-closed",
      sessionId: session.id,
      occurredAt: 202,
      provenance: adapterProvenance,
      kind: "attachment.closed",
      attachmentId: opened.id,
      outcome: "interrupted",
    });
    // Closing the binding leaves the question standing, so a Session whose
    // executor is gone still has a card up. This is the one observation that
    // can take it down, and it is exactly then that it has to.
    await expect(
      plane.observe({
        id: "observation-cancel-after-close",
        sessionId: session.id,
        occurredAt: 203,
        provenance: userProvenance,
        kind: "interaction.cancelled",
        attachmentId: opened.id,
        interactionId: interaction.id,
        reason: "abandoned",
      }),
    ).resolves.toMatchObject({
      attachmentId: opened.id,
      payload: {
        kind: "interaction.cancelled",
        attachmentId: opened.id,
        interactionId: interaction.id,
        reason: "abandoned",
      },
    });
    // Neither list: nothing was decided, so there is no resolution to read back.
    await expect(plane.getSession({ sessionId: session.id })).resolves.toMatchObject({
      interactions: { active: [], resolved: [] },
    });
    await expect(
      plane.observe({
        id: "observation-cancel-twice",
        sessionId: session.id,
        occurredAt: 204,
        provenance: userProvenance,
        kind: "interaction.cancelled",
        attachmentId: opened.id,
        interactionId: interaction.id,
        reason: "abandoned",
      }),
    ).rejects.toThrow(`Interaction ${interaction.id} is not open on attachment ${opened.id}`);
  });

  it("makes command replay idempotent without a receipt, while rejecting collisions and unknown Sessions", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const request = {
      commandId: "command-start",
      sessionId: session.id,
      intent: {
        kind: "executor.start" as const,
        adapterId: "opencode",
        continuity: "fresh" as const,
      },
      provenance: userProvenance,
    };
    expect(await plane.submit(request)).toMatchObject({ receipt: null });
    expect(await plane.submit(request)).toMatchObject({ receipt: null });
    await expect(
      plane.submit({ ...request, intent: { kind: "executor.stop", attachmentId: "attachment-1" } }),
    ).rejects.toThrow("different intent");
    await expect(
      plane.submit({
        commandId: "command-missing",
        sessionId: "missing",
        intent: { kind: "session.archive" },
        provenance: userProvenance,
      }),
    ).rejects.toThrow("Session missing was not found");
  });

  it("binds create-command evidence to its created Session and rejects external create or archive receipts", async () => {
    const { plane } = composition();
    const first = await plane.createSession(createRequest("command-create-first"));
    const second = await plane.createSession(createRequest("command-create-second"));
    await expect(
      plane.observe({
        id: "cross-session-create-receipt",
        sessionId: second.session.id,
        occurredAt: 1,
        provenance: adapterProvenance,
        kind: "command.receipt",
        receipt: {
          id: "receipt-cross-session-create",
          commandId: first.command.id,
          status: "accepted",
          acceptedAt: 1,
          result: { kind: "session.created", sessionId: second.session.id },
        },
      }),
    ).rejects.toThrow("does not belong");
    await expect(
      plane.observe({
        id: "cross-session-create-receipt-replay",
        sessionId: second.session.id,
        occurredAt: 2,
        provenance: adapterProvenance,
        kind: "command.receipt",
        receipt: {
          id: first.receipt.id,
          commandId: first.command.id,
          status: "completed",
          result: { kind: "session.created", sessionId: first.session.id },
        },
      }),
    ).rejects.toThrow("does not belong");
    await expect(
      plane.observe({
        id: "external-create-receipt",
        sessionId: first.session.id,
        occurredAt: 3,
        provenance: adapterProvenance,
        kind: "command.receipt",
        receipt: {
          id: "receipt-external-create",
          commandId: first.command.id,
          status: "accepted",
          acceptedAt: 3,
          result: { kind: "session.created", sessionId: first.session.id },
        },
      }),
    ).rejects.toThrow("cannot be externally observed");
    const archived = await plane.submit({
      commandId: "command-archive-external",
      sessionId: first.session.id,
      intent: { kind: "session.archive" },
      provenance: userProvenance,
    });
    await expect(
      plane.observe({
        id: "external-archive-receipt",
        sessionId: first.session.id,
        occurredAt: 4,
        provenance: adapterProvenance,
        kind: "command.receipt",
        receipt: {
          id: "receipt-external-archive",
          commandId: archived.command.id,
          status: "completed",
          result: { kind: "session.archived", sessionId: first.session.id },
        },
      }),
    ).rejects.toThrow("cannot be externally observed");
  });

  it("rejects non-receipt evidence without a Command owned by this Session", async () => {
    const { plane } = composition();
    const first = await plane.createSession(createRequest("command-create-first"));
    const second = await plane.createSession(createRequest("command-create-second"));
    await expect(
      plane.observe({
        id: "missing-command-causation",
        sessionId: first.session.id,
        occurredAt: 1,
        provenance: adapterProvenance,
        commandId: "missing-command",
        kind: "adapter.observed",
        attachmentId: null,
        name: "signal",
        native: null,
      }),
    ).rejects.toThrow("does not belong");
    await expect(
      plane.observe({
        id: "cross-session-create-causation",
        sessionId: second.session.id,
        occurredAt: 2,
        provenance: adapterProvenance,
        commandId: first.command.id,
        kind: "adapter.observed",
        attachmentId: null,
        name: "signal",
        native: null,
      }),
    ).rejects.toThrow("does not belong");
  });

  it("freezes adapter delivery routing and records deterministic rejections when no target is available", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const unavailableMessage = await plane.submit({
      commandId: "command-message-no-executor",
      sessionId: session.id,
      intent: {
        kind: "message.submit",
        reference: { id: "message-no-executor", mediaType: null, digest: null },
      },
      provenance: userProvenance,
    });
    expect(unavailableMessage).toMatchObject({
      receipt: { status: "rejected", code: "no_live_executor" },
    });
    await expect(
      plane.observe({
        id: "receipt-no-delivery-route",
        sessionId: session.id,
        occurredAt: 0,
        provenance: adapterProvenance,
        kind: "command.receipt",
        receipt: {
          id: "receipt-no-delivery-route",
          commandId: unavailableMessage.command.id,
          status: "unreconciled",
          detail: "Provider observed an unavailable command",
        },
      }),
    ).rejects.toThrow("has a terminal receipt");
    if (!unavailableMessage.receipt || unavailableMessage.receipt.status !== "rejected") {
      throw new Error("Expected a locally rejected message receipt");
    }
    const {
      recordedAt: _recordedAt,
      sequence: _sequence,
      ...replayedRejection
    } = unavailableMessage.receipt;
    await expect(
      plane.observe({
        id: "replay-no-delivery-route",
        sessionId: session.id,
        occurredAt: 0,
        provenance: adapterProvenance,
        kind: "command.receipt",
        receipt: replayedRejection,
      }),
    ).rejects.toThrow("has no adapter delivery route");
    await expect(
      plane.submit({
        commandId: "command-stop-missing",
        sessionId: session.id,
        intent: { kind: "executor.stop", attachmentId: "missing-attachment" },
        provenance: userProvenance,
      }),
    ).resolves.toMatchObject({ receipt: { status: "rejected", code: "attachment_unavailable" } });

    const firstAttachment = attachment(session.id, "attachment-a");
    await plane.observe({
      id: "open-a",
      sessionId: session.id,
      occurredAt: 1,
      provenance: adapterProvenance,
      kind: "attachment.opened",
      attachment: firstAttachment,
    });
    await plane.observe({
      id: "interaction-a",
      sessionId: session.id,
      attachmentId: firstAttachment.id,
      occurredAt: 1,
      provenance: adapterProvenance,
      kind: "interaction.opened",
      interaction: {
        id: "permission-a",
        attachmentId: firstAttachment.id,
        kind: "permission",
        title: "Allow write?",
        detail: null,
        options: [{ id: "once", label: "Allow once", description: null }],
        multiple: false,
        native: { id: "native-permission-a", detail: null },
      },
    });
    const interactionResolution = await plane.submit({
      commandId: "command-resolve-a",
      sessionId: session.id,
      intent: {
        kind: "interaction.resolve",
        attachmentId: firstAttachment.id,
        interactionId: "permission-a",
        resolution: { optionIds: ["once"], response: null },
        reference: { id: "resolution-a", mediaType: null, digest: null },
      },
      provenance: userProvenance,
    });
    expect(interactionResolution.command.route).toEqual({
      adapterId: firstAttachment.adapterId,
      attachmentId: firstAttachment.id,
    });
    await expect(
      plane.submit({
        commandId: "command-resolve-missing",
        sessionId: session.id,
        intent: {
          kind: "interaction.resolve",
          attachmentId: firstAttachment.id,
          interactionId: "missing-interaction",
          resolution: { optionIds: [], response: null },
          reference: { id: "resolution-missing", mediaType: null, digest: null },
        },
        provenance: userProvenance,
      }),
    ).resolves.toMatchObject({
      receipt: { status: "rejected", code: "interaction_unavailable" },
    });
    await expect(
      plane.submit({
        commandId: "command-start-while-live",
        sessionId: session.id,
        intent: { kind: "executor.start", adapterId: "codex", continuity: "fresh" },
        provenance: userProvenance,
      }),
    ).resolves.toMatchObject({
      command: { route: null },
      receipt: { status: "rejected", code: "live_executor_exists" },
    });
    const submitted = await plane.submit({
      commandId: "command-routed-message",
      sessionId: session.id,
      intent: {
        kind: "message.submit",
        reference: { id: "message-routed", mediaType: null, digest: null },
      },
      provenance: userProvenance,
    });
    expect(submitted.command.route).toEqual({
      adapterId: firstAttachment.adapterId,
      attachmentId: firstAttachment.id,
    });
    await plane.observe({
      id: "close-a",
      sessionId: session.id,
      occurredAt: 2,
      provenance: adapterProvenance,
      kind: "attachment.closed",
      attachmentId: firstAttachment.id,
      outcome: "interrupted",
    });
    await expect(
      plane.submit({
        commandId: "command-resolve-closed",
        sessionId: session.id,
        intent: {
          kind: "interaction.resolve",
          attachmentId: firstAttachment.id,
          interactionId: "permission-a",
          resolution: { optionIds: ["once"], response: null },
          reference: { id: "resolution-closed", mediaType: null, digest: null },
        },
        provenance: userProvenance,
      }),
    ).resolves.toMatchObject({
      receipt: { status: "rejected", code: "attachment_unavailable" },
    });
    await expect(
      plane.submit({
        commandId: "command-stop-closed",
        sessionId: session.id,
        intent: { kind: "executor.stop", attachmentId: firstAttachment.id },
        provenance: userProvenance,
      }),
    ).resolves.toMatchObject({
      commandEvent: { payload: { kind: "command.recorded" } },
      receipt: { status: "rejected", code: "attachment_unavailable" },
      receiptEvent: { payload: { kind: "command.receipt.recorded" } },
    });
    const secondAttachment = attachment(session.id, "attachment-b");
    await plane.observe({
      id: "open-b",
      sessionId: session.id,
      occurredAt: 3,
      provenance: adapterProvenance,
      kind: "attachment.opened",
      attachment: secondAttachment,
    });
    await expect(
      plane.observe({
        id: "receipt-from-b",
        sessionId: session.id,
        occurredAt: 4,
        provenance: adapterProvenance,
        attachmentId: secondAttachment.id,
        kind: "command.receipt",
        receipt: {
          id: "receipt-from-b",
          commandId: submitted.command.id,
          status: "completed",
          result: { kind: "message.submitted", sessionId: session.id },
        },
      }),
    ).rejects.toThrow("does not match routed attachment");
    await expect(
      plane.observe({
        id: "receipt-unbound-user",
        sessionId: session.id,
        occurredAt: 5,
        provenance: userProvenance,
        kind: "command.receipt",
        receipt: {
          id: "receipt-unbound-user",
          commandId: submitted.command.id,
          status: "accepted",
          acceptedAt: 5,
          result: { kind: "message.submitted", sessionId: session.id },
        },
      }),
    ).rejects.toThrow("was not produced by adapter opencode");
    await expect(
      plane.submit({
        commandId: submitted.command.id,
        sessionId: session.id,
        intent: submitted.command.intent as Extract<
          SessionCommand["intent"],
          { kind: "message.submit" }
        >,
        provenance: userProvenance,
      }),
    ).resolves.toEqual(submitted);
  });

  it("serializes pending executor starts and lets rejected or failed starts release the next attempt", async () => {
    const firstAttempt = composition();
    const { session } = await firstAttempt.plane.createSession(createRequest());
    const first = await firstAttempt.plane.submit({
      commandId: "command-start-pending-a",
      sessionId: session.id,
      intent: { kind: "executor.start", adapterId: "opencode", continuity: "fresh" },
      provenance: userProvenance,
    });
    expect(first.receipt).toBeNull();
    const blockedBeforeReceipt = await firstAttempt.plane.submit({
      commandId: "command-start-pending-b",
      sessionId: session.id,
      intent: { kind: "executor.start", adapterId: "claude", continuity: "fresh" },
      provenance: userProvenance,
    });
    expect(blockedBeforeReceipt).toMatchObject({
      command: { route: null },
      receipt: { status: "rejected", code: "executor_start_pending" },
    });
    await firstAttempt.plane.observe({
      id: "observation-start-pending-a-unreconciled",
      sessionId: session.id,
      occurredAt: 1,
      provenance: adapterProvenance,
      kind: "command.receipt",
      receipt: {
        id: "receipt-start-pending-a-unreconciled",
        commandId: first.command.id,
        status: "unreconciled",
        detail: "Provider outcome is not known yet",
      },
    });
    await expect(
      firstAttempt.plane.submit({
        commandId: "command-start-pending-c",
        sessionId: session.id,
        intent: { kind: "executor.start", adapterId: "claude", continuity: "fresh" },
        provenance: userProvenance,
      }),
    ).resolves.toMatchObject({ receipt: { status: "rejected", code: "executor_start_pending" } });
    await firstAttempt.plane.observe({
      id: "observation-start-pending-a-rejected",
      sessionId: session.id,
      occurredAt: 2,
      provenance: adapterProvenance,
      kind: "command.receipt",
      receipt: {
        id: "receipt-start-pending-a-rejected",
        commandId: first.command.id,
        status: "rejected",
        code: "adapter_rejected",
        detail: null,
      },
    });
    await expect(
      firstAttempt.plane.submit({
        commandId: "command-start-after-adapter-rejection",
        sessionId: session.id,
        intent: { kind: "executor.start", adapterId: "claude", continuity: "fresh" },
        provenance: userProvenance,
      }),
    ).resolves.toMatchObject({
      command: { route: { adapterId: "claude", attachmentId: null } },
      receipt: null,
    });
    await expect(
      firstAttempt.plane.observe({
        id: "receipt-locally-rejected-start-accepted",
        sessionId: session.id,
        occurredAt: 3,
        provenance: {
          ...adapterProvenance,
          source: { kind: "adapter", id: "claude", detail: null },
        },
        kind: "command.receipt",
        receipt: {
          id: "receipt-locally-rejected-start-accepted",
          commandId: blockedBeforeReceipt.command.id,
          status: "accepted",
          acceptedAt: 3,
          result: { kind: "executor.start.requested", sessionId: session.id },
        },
      }),
    ).rejects.toThrow("has a terminal receipt");

    const failedAttempt = composition();
    const created = await failedAttempt.plane.createSession(createRequest());
    const started = await failedAttempt.plane.submit({
      commandId: "command-start-failed-a",
      sessionId: created.session.id,
      intent: { kind: "executor.start", adapterId: "opencode", continuity: "fresh" },
      provenance: userProvenance,
    });
    await failedAttempt.plane.observe({
      id: "attachment-start-failed-a",
      sessionId: created.session.id,
      occurredAt: 1,
      provenance: adapterProvenance,
      commandId: started.command.id,
      kind: "attachment.failed",
      attachment: attachment(created.session.id, "attachment-start-failed-a"),
      failure: { code: "spawn_failed", detail: null, diagnostic: null },
    });
    await expect(
      failedAttempt.plane.submit({
        commandId: "command-start-after-failure",
        sessionId: created.session.id,
        intent: { kind: "executor.start", adapterId: "claude", continuity: "fresh" },
        provenance: userProvenance,
      }),
    ).resolves.toMatchObject({
      command: { route: { adapterId: "claude", attachmentId: null } },
      receipt: null,
    });
  });
});

describe("SessionEngine attachment facts", () => {
  it("reserves a pending executor start for its exact attachment opening", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const start = await plane.submit({
      commandId: "command-start-reserved-a",
      sessionId: session.id,
      intent: { kind: "executor.start", adapterId: "opencode", continuity: "fresh" },
      provenance: userProvenance,
    });
    const unbound = attachment(session.id, "attachment-unbound-b");

    await expect(
      plane.observe({
        id: "open-unbound-b",
        sessionId: session.id,
        occurredAt: 1,
        provenance: adapterProvenance,
        kind: "attachment.opened",
        attachment: unbound,
      }),
    ).rejects.toThrow("pending executor start");
    await expect(plane.listEvents({ sessionId: session.id })).resolves.not.toContainEqual(
      expect.objectContaining({ id: "open-unbound-b" }),
    );
    await expect(plane.getSession({ sessionId: session.id })).resolves.toMatchObject({
      pendingExecutorStart: { id: start.command.id },
      liveExecutor: null,
    });

    const wrongStart = await plane.submit({
      commandId: "command-start-reserved-b",
      sessionId: session.id,
      intent: { kind: "executor.start", adapterId: "opencode", continuity: "fresh" },
      provenance: userProvenance,
    });
    expect(wrongStart.receipt).toMatchObject({
      status: "rejected",
      code: "executor_start_pending",
    });
    await expect(
      plane.observe({
        id: "open-wrong-command-b",
        sessionId: session.id,
        occurredAt: 2,
        provenance: adapterProvenance,
        commandId: wrongStart.command.id,
        kind: "attachment.opened",
        attachment: attachment(session.id, "attachment-wrong-command-b"),
      }),
    ).rejects.toThrow(
      "Attachment attachment-wrong-command-b does not match command command-start-reserved-b route",
    );

    const opened = attachment(session.id, "attachment-bound-a");
    await plane.observe({
      id: "open-bound-a",
      sessionId: session.id,
      occurredAt: 3,
      provenance: adapterProvenance,
      commandId: start.command.id,
      kind: "attachment.opened",
      attachment: opened,
    });
    await expect(plane.getSession({ sessionId: session.id })).resolves.toMatchObject({
      pendingExecutorStart: null,
      liveExecutor: { id: opened.id },
    });
  });

  it("requires executor-start attachment evidence to match the frozen adapter route", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const start = await plane.submit({
      commandId: "command-start-route",
      sessionId: session.id,
      intent: { kind: "executor.start", adapterId: "opencode", continuity: "fresh" },
      provenance: userProvenance,
    });
    const mismatched = { ...attachment(session.id, "attachment-mismatched"), adapterId: "claude" };
    await expect(
      plane.observe({
        id: "open-mismatched-route",
        sessionId: session.id,
        occurredAt: 1,
        provenance: adapterProvenance,
        commandId: start.command.id,
        kind: "attachment.opened",
        attachment: mismatched,
      }),
    ).rejects.toThrow("does not match command command-start-route route");
    await expect(
      plane.observe({
        id: "failed-mismatched-route",
        sessionId: session.id,
        occurredAt: 2,
        provenance: adapterProvenance,
        commandId: start.command.id,
        kind: "attachment.failed",
        attachment: mismatched,
        failure: { code: "spawn_failed", detail: null, diagnostic: null },
      }),
    ).rejects.toThrow("does not match command command-start-route route");
    const running = attachment(session.id, "attachment-running");
    await plane.observe({
      id: "open-running",
      sessionId: session.id,
      occurredAt: 3,
      provenance: adapterProvenance,
      commandId: start.command.id,
      kind: "attachment.opened",
      attachment: running,
    });
    const message = await plane.submit({
      commandId: "command-not-start-attachment-failure",
      sessionId: session.id,
      intent: {
        kind: "message.submit",
        reference: { id: "message-not-start", mediaType: null, digest: null },
      },
      provenance: userProvenance,
    });
    await plane.observe({
      id: "failed-not-start-route",
      sessionId: session.id,
      occurredAt: 4,
      provenance: adapterProvenance,
      commandId: message.command.id,
      kind: "attachment.failed",
      attachment: attachment(session.id, "attachment-failed-not-start"),
      failure: { code: "spawn_failed", detail: null, diagnostic: null },
    });
  });

  it("records an attachment failure without ending the Session", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const failed = attachment(session.id, "attachment-failed");
    await plane.observe({
      id: "observation-failed",
      sessionId: session.id,
      occurredAt: 200,
      provenance: adapterProvenance,
      kind: "attachment.failed",
      attachment: failed,
      failure: { code: "spawn_failed", detail: "SDK unavailable", diagnostic: { retryable: true } },
    });

    await expect(plane.getSession({ sessionId: session.id })).resolves.toMatchObject({
      status: "open",
      liveExecutor: null,
      attachments: [{ id: failed.id, status: "failed", failure: { code: "spawn_failed" } }],
    });
  });

  it("enforces one live executor and rejects unknown or closed attachment-scoped evidence", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const first = attachment(session.id);
    await plane.observe({
      id: "open-1",
      sessionId: session.id,
      occurredAt: 1,
      provenance: adapterProvenance,
      kind: "attachment.opened",
      attachment: first,
    });
    await plane.observe({
      id: "attention-open",
      sessionId: session.id,
      occurredAt: 2,
      provenance: adapterProvenance,
      kind: "attention.raised",
      attention: {
        id: "attention-1",
        kind: "permission_required",
        attachmentId: first.id,
        detail: null,
        diagnostic: null,
      },
    });
    await expect(
      plane.observe({
        id: "open-2",
        sessionId: session.id,
        occurredAt: 2,
        provenance: adapterProvenance,
        kind: "attachment.opened",
        attachment: attachment(session.id, "attachment-2"),
      }),
    ).rejects.toThrow("already has live executor");
    await expect(
      plane.observe({
        id: "unknown-turn",
        sessionId: session.id,
        occurredAt: 3,
        provenance: adapterProvenance,
        kind: "turn.started",
        attachmentId: "missing",
        turnId: "turn-1",
      }),
    ).rejects.toThrow("is unknown");
    await plane.observe({
      id: "closed-1",
      sessionId: session.id,
      occurredAt: 4,
      provenance: adapterProvenance,
      kind: "attachment.closed",
      attachmentId: first.id,
      outcome: "completed",
    });
    await expect(
      plane.observe({
        id: "closed-turn",
        sessionId: session.id,
        occurredAt: 5,
        provenance: adapterProvenance,
        kind: "turn.started",
        attachmentId: first.id,
        turnId: "turn-2",
      }),
    ).rejects.toThrow("already closed");
    await expect(
      plane.observe({
        id: "duplicate-attachment",
        sessionId: session.id,
        occurredAt: 6,
        provenance: adapterProvenance,
        kind: "attachment.opened",
        attachment: first,
      }),
    ).rejects.toThrow("already exists");
  });

  it("rejects attachment identity drift, attachment startup after archive, and unknown Session observations", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());
    await expect(
      plane.observe({
        id: "wrong-session",
        sessionId: session.id,
        occurredAt: 1,
        provenance: adapterProvenance,
        kind: "attachment.opened",
        attachment: attachment("other-session"),
      }),
    ).rejects.toThrow("belongs to another Session");
    await plane.submit({
      commandId: "command-archive",
      sessionId: session.id,
      intent: { kind: "session.archive" },
      provenance: userProvenance,
    });
    await expect(
      plane.observe({
        id: "archived-open",
        sessionId: session.id,
        occurredAt: 2,
        provenance: adapterProvenance,
        kind: "attachment.opened",
        attachment: attachment(session.id),
      }),
    ).rejects.toThrow("is archived");
    await expect(
      plane.observe({
        id: "missing-session",
        sessionId: "missing",
        occurredAt: 3,
        provenance: adapterProvenance,
        kind: "adapter.observed",
        attachmentId: null,
        name: "signal",
        native: null,
      }),
    ).rejects.toThrow("Session missing was not found");
  });
});

describe("SessionEngine idempotency and defensive ledger reads", () => {
  it("deduplicates an observation and rejects divergent evidence or invalid receipt provenance", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const observation = {
      id: "signal-1",
      sessionId: session.id,
      occurredAt: 1,
      provenance: adapterProvenance,
      kind: "adapter.observed" as const,
      attachmentId: null,
      name: "idle",
      native: { hook: true },
    };
    const first = await plane.observe(observation);
    expect(await plane.observe(observation)).toEqual(first);
    await expect(plane.observe({ ...observation, name: "different" })).rejects.toBeInstanceOf(
      SessionEngineConflictError,
    );
    await expect(
      plane.observe({
        id: "invalid-receipt",
        sessionId: session.id,
        occurredAt: 2,
        provenance: adapterProvenance,
        kind: "command.receipt",
        receipt: acceptedReceipt("receipt-invalid", "missing-command", {
          kind: "message.submitted",
          sessionId: session.id,
        }),
      }),
    ).rejects.toThrow("does not belong");
  });

  it("replays omitted and null envelope identifiers as the same durable evidence", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const observation = {
      id: "signal-null-equivalent",
      sessionId: session.id,
      occurredAt: 1,
      provenance: adapterProvenance,
      kind: "adapter.observed" as const,
      name: "idle",
      native: null,
    };

    // Simulate a legacy/untyped adapter omitting optional envelope fields at
    // runtime while keeping the public TypeScript contract canonical.
    const recorded = await plane.observe(observation as SessionObservation);
    await expect(
      plane.observe({ ...observation, attachmentId: null, commandId: null }),
    ).resolves.toEqual(recorded);
  });

  it("uses sequence one for a ledger-seeded Session and exposes missing history as null", async () => {
    const { ledger, plane } = composition();
    const session = sessionRecord();
    await ledger.transaction((transaction) => transaction.insertSession(session));
    await expect(
      plane.observe({
        id: "first-observation",
        sessionId: session.id,
        occurredAt: 0,
        provenance: adapterProvenance,
        kind: "adapter.observed",
        attachmentId: null,
        name: "signal",
        native: null,
      }),
    ).resolves.toMatchObject({ sequence: 1 });
    await expect(plane.getSession({ sessionId: "missing" })).resolves.toBeNull();
  });

  it("validates receipt result targets, actions, adapter ownership, and attachment evidence", async () => {
    const { plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const opened = attachment(session.id);
    await plane.observe({
      id: "open-validated",
      sessionId: session.id,
      occurredAt: 0,
      provenance: adapterProvenance,
      kind: "attachment.opened",
      attachment: opened,
    });
    const message = await plane.submit({
      commandId: "command-message-validated",
      sessionId: session.id,
      intent: {
        kind: "message.submit",
        reference: { id: "message-validated", mediaType: null, digest: null },
      },
      provenance: userProvenance,
    });
    await expect(
      plane.observe({
        id: "wrong-receipt-action",
        sessionId: session.id,
        occurredAt: 1,
        provenance: adapterProvenance,
        kind: "command.receipt",
        receipt: {
          id: "receipt-wrong-action",
          commandId: message.command.id,
          status: "completed",
          result: { kind: "executor.start.requested", sessionId: session.id },
        },
      }),
    ).rejects.toThrow("does not match command");
    await expect(
      plane.observe({
        id: "wrong-receipt-session",
        sessionId: session.id,
        occurredAt: 2,
        provenance: adapterProvenance,
        kind: "command.receipt",
        receipt: {
          id: "receipt-wrong-session",
          commandId: message.command.id,
          status: "completed",
          result: { kind: "message.submitted", sessionId: "other-session" },
        },
      }),
    ).rejects.toThrow("does not match command");

    const startSession = await plane.createSession(
      createRequest("command-create-start-validation"),
    );
    const start = await plane.submit({
      commandId: "command-start-validated",
      sessionId: startSession.session.id,
      intent: { kind: "executor.start", adapterId: "opencode", continuity: "fresh" },
      provenance: userProvenance,
    });
    await expect(
      plane.observe({
        id: "wrong-start-adapter",
        sessionId: startSession.session.id,
        occurredAt: 3,
        provenance: {
          ...adapterProvenance,
          source: { kind: "adapter", id: "claude", detail: null },
        },
        kind: "command.receipt",
        receipt: {
          id: "receipt-wrong-adapter",
          commandId: start.command.id,
          status: "accepted",
          acceptedAt: 3,
          result: { kind: "executor.start.requested", sessionId: startSession.session.id },
        },
      }),
    ).rejects.toThrow("was not produced by adapter opencode");
    await expect(
      plane.observe({
        id: "start-unknown-attachment-evidence",
        sessionId: startSession.session.id,
        occurredAt: 4,
        provenance: adapterProvenance,
        kind: "command.receipt",
        attachmentId: "missing-attachment",
        receipt: {
          id: "receipt-start-unknown-attachment",
          commandId: start.command.id,
          status: "completed",
          result: { kind: "executor.start.requested", sessionId: startSession.session.id },
        },
      }),
    ).rejects.toThrow("invalid attachment evidence");

    await expect(
      plane.observe({
        id: "wrong-attachment-adapter",
        sessionId: session.id,
        occurredAt: 5,
        provenance: {
          ...adapterProvenance,
          source: { kind: "adapter", id: "claude", detail: null },
        },
        kind: "command.receipt",
        attachmentId: opened.id,
        receipt: {
          id: "receipt-wrong-attachment-adapter",
          commandId: message.command.id,
          status: "completed",
          result: { kind: "message.submitted", sessionId: session.id },
        },
      }),
    ).rejects.toThrow("was not produced by adapter opencode");
    await expect(
      plane.observe({
        id: "missing-attachment-evidence",
        sessionId: session.id,
        occurredAt: 6,
        provenance: adapterProvenance,
        kind: "command.receipt",
        attachmentId: "missing-attachment",
        receipt: {
          id: "receipt-missing-attachment",
          commandId: message.command.id,
          status: "completed",
          result: { kind: "message.submitted", sessionId: session.id },
        },
      }),
    ).rejects.toThrow("does not match routed attachment");
    await expect(
      plane.observe({
        id: "wrong-attachment-source-kind",
        sessionId: session.id,
        occurredAt: 7,
        provenance: userProvenance,
        kind: "command.receipt",
        attachmentId: opened.id,
        receipt: {
          id: "receipt-wrong-attachment-source-kind",
          commandId: message.command.id,
          status: "completed",
          result: { kind: "message.submitted", sessionId: session.id },
        },
      }),
    ).rejects.toThrow("was not produced by adapter opencode");
    await plane.observe({
      id: "valid-attachment-evidence",
      sessionId: session.id,
      occurredAt: 8,
      provenance: adapterProvenance,
      kind: "command.receipt",
      attachmentId: opened.id,
      receipt: {
        id: "receipt-valid-attachment",
        commandId: message.command.id,
        status: "accepted",
        acceptedAt: 8,
        result: { kind: "message.submitted", sessionId: session.id },
      },
    });
    await expect(
      plane.observe({
        id: "valid-attachment-evidence-unbound-replay",
        sessionId: session.id,
        occurredAt: 8,
        provenance: userProvenance,
        kind: "command.receipt",
        attachmentId: opened.id,
        receipt: {
          id: "receipt-valid-attachment",
          commandId: message.command.id,
          status: "accepted",
          acceptedAt: 8,
          result: { kind: "message.submitted", sessionId: session.id },
        },
      }),
    ).rejects.toThrow("was not produced by adapter opencode");
    await expect(
      plane.observe({
        id: "unreconciled-receipt",
        sessionId: session.id,
        occurredAt: 9,
        provenance: adapterProvenance,
        kind: "command.receipt",
        attachmentId: opened.id,
        receipt: {
          id: "receipt-unreconciled",
          commandId: message.command.id,
          status: "unreconciled",
          detail: "Awaiting provider reconciliation",
        },
      }),
    ).rejects.toThrow("has a terminal receipt");

    await expect(
      plane.observe({
        id: "create-receipt-kind",
        sessionId: session.id,
        occurredAt: 10,
        provenance: adapterProvenance,
        kind: "command.receipt",
        receipt: {
          id: "receipt-create-kind",
          commandId: "command-create",
          status: "accepted",
          acceptedAt: 10,
          result: { kind: "session.created", sessionId: session.id },
        },
      }),
    ).rejects.toThrow("cannot be externally observed");
    const stop = await plane.submit({
      commandId: "command-stop-validated",
      sessionId: session.id,
      intent: { kind: "executor.stop", attachmentId: opened.id },
      provenance: userProvenance,
    });
    await plane.observe({
      id: "stop-receipt-kind",
      sessionId: session.id,
      occurredAt: 11,
      provenance: adapterProvenance,
      kind: "command.receipt",
      attachmentId: opened.id,
      receipt: {
        id: "receipt-stop-kind",
        commandId: stop.command.id,
        status: "completed",
        result: { kind: "executor.stop.requested", sessionId: session.id },
      },
    });
    const archived = await plane.submit({
      commandId: "command-archive-validated",
      sessionId: session.id,
      intent: { kind: "session.archive" },
      provenance: userProvenance,
    });
    await expect(
      plane.observe({
        id: "archive-receipt-kind",
        sessionId: session.id,
        occurredAt: 12,
        provenance: adapterProvenance,
        kind: "command.receipt",
        receipt: {
          id: "receipt-archive-kind",
          commandId: archived.command.id,
          status: "accepted",
          acceptedAt: 12,
          result: { kind: "session.archived", sessionId: session.id },
        },
      }),
    ).rejects.toThrow("cannot be externally observed");
  });

  it("deduplicates a fresh receipt observation by outcome and keeps receipt order independent of equal clocks", async () => {
    const { ledger, plane } = composition();
    const { session } = await plane.createSession(createRequest());
    const active = attachment(session.id, "attachment-receipt-order");
    await plane.observe({
      id: "open-receipt-order",
      sessionId: session.id,
      occurredAt: 1,
      provenance: adapterProvenance,
      kind: "attachment.opened",
      attachment: active,
    });
    const submitted = await plane.submit({
      commandId: "command-receipt-order",
      sessionId: session.id,
      intent: {
        kind: "message.submit",
        reference: { id: "message-receipt-order", mediaType: null, digest: null },
      },
      provenance: userProvenance,
    });
    const firstObservation = {
      id: "receipt-observation-first",
      sessionId: session.id,
      occurredAt: 500,
      provenance: adapterProvenance,
      attachmentId: active.id,
      kind: "command.receipt" as const,
      receipt: {
        id: "receipt-order-first",
        commandId: submitted.command.id,
        status: "accepted" as const,
        acceptedAt: 500,
        result: { kind: "message.submitted" as const, sessionId: session.id },
      },
    };
    const first = await plane.observe(firstObservation);
    const duplicate = await plane.observe({
      ...firstObservation,
      id: "receipt-observation-duplicate",
    });
    expect(duplicate).toEqual(first);
    const second = await plane.observe({
      ...firstObservation,
      id: "receipt-observation-second",
      receipt: {
        id: "receipt-order-second",
        commandId: submitted.command.id,
        status: "completed",
        result: { kind: "message.submitted", sessionId: session.id },
      },
    });
    expect(second.sequence).toBe(first.sequence + 1);
    await expect(
      ledger.transaction((transaction) => transaction.listReceipts(submitted.command.id)),
    ).resolves.toMatchObject([
      { id: "receipt-order-first", sequence: first.sequence },
      { id: "receipt-order-second", sequence: second.sequence },
    ]);
    const projection = await plane.getSession({ sessionId: session.id });
    expect(
      projection?.receipts.filter((receipt) => receipt.commandId === submitted.command.id),
    ).toMatchObject([
      { id: "receipt-order-first", sequence: first.sequence },
      { id: "receipt-order-second", sequence: second.sequence },
    ]);
  });

  it("detects missing canonical events for otherwise stored receipt and command history", async () => {
    const missingReceiptEvent = composition();
    const { session } = await missingReceiptEvent.plane.createSession(createRequest());
    const submitted = await missingReceiptEvent.plane.submit({
      commandId: "command-missing-receipt-event",
      sessionId: session.id,
      intent: {
        kind: "executor.start",
        adapterId: "opencode",
        continuity: "fresh",
      },
      provenance: userProvenance,
    });
    const storedReceipt = {
      id: "receipt-missing-event",
      commandId: submitted.command.id,
      status: "unreconciled" as const,
      detail: "Missing event",
      recordedAt: 1,
      sequence: 99,
    };
    await missingReceiptEvent.ledger.transaction((transaction) =>
      transaction.appendReceipt(storedReceipt),
    );
    await expect(
      missingReceiptEvent.plane.observe({
        id: "receipt-missing-event-observation",
        sessionId: session.id,
        occurredAt: 1,
        provenance: adapterProvenance,
        kind: "command.receipt",
        receipt: {
          id: storedReceipt.id,
          commandId: storedReceipt.commandId,
          status: storedReceipt.status,
          detail: storedReceipt.detail,
        },
      }),
    ).rejects.toThrow("has no Session event");
    await expect(
      missingReceiptEvent.plane.submit({
        commandId: submitted.command.id,
        sessionId: session.id,
        intent: {
          kind: "executor.start",
          adapterId: "opencode",
          continuity: "fresh",
        },
        provenance: userProvenance,
      }),
    ).rejects.toThrow("has no Session event");

    const missingCommandEvent = composition();
    const seeded = sessionRecord();
    await missingCommandEvent.ledger.transaction((transaction) => {
      transaction.insertSession(seeded);
      transaction.saveCommand(
        command("command-missing-event", seeded.id, {
          kind: "message.submit",
          reference: { id: "message-missing-event", mediaType: null, digest: null },
        }),
      );
    });
    await expect(
      missingCommandEvent.plane.submit({
        commandId: "command-missing-event",
        sessionId: seeded.id,
        intent: {
          kind: "message.submit",
          reference: { id: "message-missing-event", mediaType: null, digest: null },
        },
        provenance: userProvenance,
      }),
    ).rejects.toThrow("has no recorded event");
  });

  it("rejects a completed model-selection replay whose immutable fact is missing", async () => {
    const { ledger, plane } = composition();
    const seeded = sessionRecord("session-model-fact-missing");
    const selection = {
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high" as const,
    };
    const stored = command("command-model-fact-missing", seeded.id, {
      kind: "model.select",
      selection,
    });
    const receipt = {
      id: "receipt-model-fact-missing",
      commandId: stored.id,
      status: "completed" as const,
      result: { kind: "model.selected" as const, sessionId: seeded.id },
      recordedAt: 2,
      sequence: 2,
    };
    await ledger.transaction((transaction) => {
      transaction.insertSession(seeded);
      transaction.saveCommand(stored);
      transaction.appendEvent({
        id: "event-model-command",
        sessionId: seeded.id,
        sequence: 1,
        occurredAt: 1,
        recordedAt: 1,
        provenance: userProvenance,
        commandId: stored.id,
        payload: { kind: "command.recorded", command: stored },
      });
      transaction.appendReceipt(receipt);
      transaction.appendEvent({
        id: "event-model-receipt",
        sessionId: seeded.id,
        sequence: 2,
        occurredAt: 2,
        recordedAt: 2,
        provenance: userProvenance,
        commandId: stored.id,
        payload: { kind: "command.receipt.recorded", receipt },
      });
    });

    await expect(
      plane.submit({
        commandId: stored.id,
        sessionId: seeded.id,
        intent: { kind: "model.select", selection },
        provenance: userProvenance,
      }),
    ).rejects.toThrow("incomplete model selection history");
  });

  it("rejects a completed model-selection replay whose immutable fact disagrees with intent", async () => {
    const { ledger, plane } = composition();
    const seeded = sessionRecord("session-model-fact-mismatch");
    const selection = {
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high" as const,
    };
    const stored = command("command-model-fact-mismatch", seeded.id, {
      kind: "model.select",
      selection,
    });
    const receipt = {
      id: "receipt-model-fact-mismatch",
      commandId: stored.id,
      status: "completed" as const,
      result: { kind: "model.selected" as const, sessionId: seeded.id },
      recordedAt: 3,
      sequence: 3,
    };
    await ledger.transaction((transaction) => {
      transaction.insertSession(seeded);
      transaction.saveCommand(stored);
      transaction.appendEvent({
        id: "event-model-mismatch-command",
        sessionId: seeded.id,
        sequence: 1,
        occurredAt: 1,
        recordedAt: 1,
        provenance: userProvenance,
        commandId: stored.id,
        payload: { kind: "command.recorded", command: stored },
      });
      transaction.appendEvent({
        id: "event-model-mismatch-fact",
        sessionId: seeded.id,
        sequence: 2,
        occurredAt: 2,
        recordedAt: 2,
        provenance: userProvenance,
        commandId: stored.id,
        payload: {
          kind: "model.selected",
          selection: { ...selection, reasoningLevel: "medium" },
        },
      });
      transaction.appendReceipt(receipt);
      transaction.appendEvent({
        id: "event-model-mismatch-receipt",
        sessionId: seeded.id,
        sequence: 3,
        occurredAt: 3,
        recordedAt: 3,
        provenance: userProvenance,
        commandId: stored.id,
        payload: { kind: "command.receipt.recorded", receipt },
      });
    });

    await expect(
      plane.submit({
        commandId: stored.id,
        sessionId: seeded.id,
        intent: { kind: "model.select", selection },
        provenance: userProvenance,
      }),
    ).rejects.toThrow("model selection history that does not match intent");
  });

  it("detects a pre-existing create command with a missing receipt, Session, or created event", async () => {
    const noReceipt = composition();
    const receiptlessSession = sessionRecord("session-no-receipt");
    await noReceipt.ledger.transaction((transaction) => {
      transaction.insertSession(receiptlessSession);
      transaction.saveCommand(
        command("command-create", receiptlessSession.id, {
          kind: "session.create",
          projectId: "project-1",
          ticketId: "ticket-1",
          role: "ticket",
          parentSessionId: null,
          title: "Durable Session",
        }),
      );
    });
    await expect(noReceipt.plane.createSession(createRequest())).rejects.toThrow(
      "no create receipt",
    );

    const noSession = composition();
    await noSession.ledger.transaction((transaction) => {
      transaction.saveCommand(
        command("command-create", "missing", {
          kind: "session.create",
          projectId: "project-1",
          ticketId: "ticket-1",
          role: "ticket",
          parentSessionId: null,
          title: "Durable Session",
        }),
      );
      transaction.appendReceipt(
        acceptedReceipt("receipt-create", "command-create", {
          kind: "session.created",
          sessionId: "missing",
        }),
      );
    });
    await expect(noSession.plane.createSession(createRequest())).rejects.toThrow("has no Session");

    const noEvent = composition();
    const seeded = sessionRecord();
    await noEvent.ledger.transaction((transaction) => {
      transaction.insertSession(seeded);
      transaction.saveCommand(
        command("command-create", seeded.id, {
          kind: "session.create",
          projectId: "project-1",
          ticketId: "ticket-1",
          role: "ticket",
          parentSessionId: null,
          title: "Durable Session",
        }),
      );
      transaction.appendReceipt(
        acceptedReceipt("receipt-create", "command-create", {
          kind: "session.created",
          sessionId: seeded.id,
        }),
      );
    });
    await expect(noEvent.plane.createSession(createRequest())).rejects.toThrow(
      "incomplete durable history",
    );

    const mismatchedCreatedFact = composition();
    const createdSession = sessionRecord("session-created-mismatch");
    const createCommand = command("command-create", createdSession.id, {
      kind: "session.create",
      projectId: "project-1",
      ticketId: "ticket-1",
      role: "ticket",
      parentSessionId: null,
      title: "Durable Session",
    });
    // Sequence 3 matches the receipt event's envelope below: the in-memory
    // ledger now runs the codec's write-side assertion for SQLite parity, and
    // a receipt whose sequence disagrees with its own event is refused there.
    const createReceipt = {
      ...acceptedReceipt("receipt-create", createCommand.id, {
        kind: "session.created",
        sessionId: createdSession.id,
      }),
      sequence: 3,
    };
    await mismatchedCreatedFact.ledger.transaction((transaction) => {
      transaction.insertSession(createdSession);
      transaction.saveCommand(createCommand);
      transaction.appendEvent({
        id: "event-command",
        sessionId: createdSession.id,
        sequence: 1,
        occurredAt: 0,
        recordedAt: 0,
        provenance: userProvenance,
        commandId: createCommand.id,
        payload: { kind: "command.recorded", command: createCommand },
      });
      transaction.appendEvent({
        ...createdEvent("event-created", createdSession),
        sequence: 2,
        payload: {
          kind: "session.created",
          session: { ...createdSession, title: "mismatched" },
        },
      });
      transaction.appendReceipt(createReceipt);
      transaction.appendEvent({
        id: "event-receipt",
        sessionId: createdSession.id,
        sequence: 3,
        occurredAt: 0,
        recordedAt: 0,
        provenance: userProvenance,
        commandId: createCommand.id,
        payload: { kind: "command.receipt.recorded", receipt: createReceipt },
      });
    });
    await expect(mismatchedCreatedFact.plane.createSession(createRequest())).rejects.toThrow(
      "does not match Session",
    );

    const mismatchedCreateReceipt = composition();
    const receiptSession = sessionRecord("session-receipt-mismatch");
    await mismatchedCreateReceipt.ledger.transaction((transaction) => {
      transaction.insertSession(receiptSession);
      transaction.saveCommand(
        command("command-create", receiptSession.id, {
          kind: "session.create",
          projectId: "project-1",
          ticketId: "ticket-1",
          role: "ticket",
          parentSessionId: null,
          title: "Durable Session",
        }),
      );
      transaction.appendReceipt(
        acceptedReceipt("receipt-create", "command-create", {
          kind: "session.created",
          sessionId: "other-session",
        }),
      );
    });
    await expect(mismatchedCreateReceipt.plane.createSession(createRequest())).rejects.toThrow(
      "create receipt for another Session",
    );
  });
});

describe("InMemorySessionLedger", () => {
  it("exposes only a scoped transaction facade and closes captured facades", async () => {
    const ledger = createInMemorySessionLedger();
    expectTypeOf(ledger).toEqualTypeOf<SessionLedger>();
    expect(ledger).not.toHaveProperty("getSession");
    expect(ledger).not.toHaveProperty("insertSession");

    const resolved = { transaction: null as SessionLedgerTransaction | null };
    await ledger.transaction((transaction) => {
      resolved.transaction = transaction;
      expect(transaction.getSession("missing")).toBeNull();
    });
    const closedResolvedTransaction = resolved.transaction;
    if (!closedResolvedTransaction) throw new Error("Expected a captured transaction facade");
    expect(() => closedResolvedTransaction.getSession("missing")).toThrow("is closed");
    expect(() => closedResolvedTransaction.insertSession(sessionRecord())).toThrow("is closed");

    const rejected = { transaction: null as SessionLedgerTransaction | null };
    await expect(
      ledger.transaction((transaction) => {
        rejected.transaction = transaction;
        throw new Error("rollback captured facade");
      }),
    ).rejects.toThrow("rollback captured facade");
    const closedRejectedTransaction = rejected.transaction;
    if (!closedRejectedTransaction) throw new Error("Expected a rejected transaction facade");
    expect(() => closedRejectedTransaction.listEvents({ sessionId: "missing" })).toThrow(
      "is closed",
    );
  });

  it("lists cloned base Sessions through explicit scopes in durable descending order", async () => {
    const ledger = createInMemorySessionLedger();
    const ticketOlder = {
      ...sessionRecord("session-ticket-older"),
      ticketId: "ticket-1",
      title: "Older ticket",
      createdAt: 1,
    };
    const projectSession = {
      ...sessionRecord("session-project"),
      title: "Board chat",
      createdAt: 2,
    };
    const ticketLaterId = {
      ...sessionRecord("session-zulu"),
      ticketId: "ticket-1",
      title: "Later id",
      createdAt: 3,
    };
    const ticketEarlierId = {
      ...sessionRecord("session-alpha"),
      ticketId: "ticket-1",
      title: "Earlier id",
      createdAt: 3,
    };
    const otherProject = {
      ...sessionRecord("session-other"),
      projectId: "project-2",
      createdAt: 4,
    };
    await ledger.transaction((transaction) => {
      for (const session of [
        ticketOlder,
        projectSession,
        ticketLaterId,
        ticketEarlierId,
        otherProject,
      ]) {
        transaction.insertSession(session);
      }
      const all = transaction.listSessions({ projectId: "project-1", scope: "all" });
      expect(all.map((session) => session.id)).toEqual([
        ticketLaterId.id,
        ticketEarlierId.id,
        projectSession.id,
        ticketOlder.id,
      ]);
      expect(
        transaction
          .listSessions({ projectId: "project-1", scope: "ticket", ticketId: "ticket-1" })
          .map((session) => session.id),
      ).toEqual([ticketLaterId.id, ticketEarlierId.id, ticketOlder.id]);
      expect(transaction.listSessions({ projectId: "project-1", scope: "project" })).toEqual([
        projectSession,
      ]);
      // @ts-expect-error -- `Session` is readonly (VC-393); this reaches past
      // the type on purpose, to prove the ledger answered with a copy rather
      // than the row it holds. The returned row is not frozen, only the
      // listing cache's own projections are, so the assignment succeeds.
      all[0]!.title = "Mutated query result";
      expect(transaction.listSessions({ projectId: "project-1", scope: "all" })[0]?.title).toBe(
        "Later id",
      );
    });
  });

  it("uses SQLite BINARY descending ID order when creation times are equal", async () => {
    const ledger = createInMemorySessionLedger();
    const createdAt = 3;
    const sessionIds = ["session-a", "session-z", "session-é", "session-中", "session-😀"];

    await ledger.transaction((transaction) => {
      for (const id of sessionIds) {
        transaction.insertSession({ ...sessionRecord(id), createdAt });
      }

      // SQLite BINARY compares UTF-8 bytes: F0 (😀), E4 (中), C3 (é), 7A (z), 61 (a).
      expect(transaction.listSessions({ projectId: "project-1", scope: "all" })).toMatchObject([
        { id: "session-😀" },
        { id: "session-中" },
        { id: "session-é" },
        { id: "session-z" },
        { id: "session-a" },
      ]);
    });
  });

  it("is transactional, append-only, and globally id-safe", async () => {
    const ledger = createInMemorySessionLedger();
    const session = sessionRecord();
    const event = createdEvent("event-1", session);
    const storedCommand = command("command-1", session.id, {
      kind: "message.submit",
      reference: { id: "message", mediaType: null, digest: null },
    });
    const receipt = acceptedReceipt("receipt-1", storedCommand.id, {
      kind: "message.submitted",
      sessionId: session.id,
    });

    await expect(
      ledger.transaction((transaction) => {
        transaction.insertSession(session);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await ledger.transaction((transaction) => {
      expect(transaction.getSession("missing")).toBeNull();
      expect(transaction.getEvent("missing")).toBeNull();
      expect(transaction.getCommand("missing")).toBeNull();
      expect(transaction.getReceipt("missing")).toBeNull();
      expect(() => transaction.appendEvent(event)).toThrow("was not found");
      transaction.insertSession(session);
      expect(() => transaction.insertSession(session)).toThrow("already exists");
      expect(() => transaction.appendEvent({ ...event, id: "event-2", sequence: 2 })).toThrow(
        "must be monotonic",
      );
      transaction.appendEvent(event);
      expect(
        transaction.listEvents({ sessionId: session.id, afterSequence: 0, limit: -1 }),
      ).toEqual([]);
      transaction.saveCommand(storedCommand);
      expect(() => transaction.saveCommand({ ...storedCommand })).toThrow("already exists");
      expect(() =>
        transaction.appendEvent({ ...event, id: storedCommand.id, sequence: 2 }),
      ).toThrow("already exists");
      expect(() =>
        transaction.appendReceipt({
          ...receipt,
          commandId: "missing-command",
          id: "receipt-missing",
        }),
      ).toThrow("was not found");
      transaction.appendReceipt(receipt);
      transaction.appendReceipt({
        id: "receipt-completed",
        commandId: storedCommand.id,
        status: "completed",
        recordedAt: 1,
        sequence: 2,
        result: receipt.result,
      });
      expect(transaction.getReceipt(receipt.id)).toEqual(receipt);
      expect(transaction.listReceipts(storedCommand.id)).toHaveLength(2);
      expect(() => transaction.saveCommand({ ...storedCommand, id: receipt.id })).toThrow(
        "already exists",
      );
    });
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

describe("reportUsage", () => {
  /** A Session in a named project/ticket, with one metered operation on it. */
  async function spend(
    plane: ReturnType<typeof createSessionEngine>,
    options: {
      commandId: string;
      projectId: string;
      ticketId: string | null;
      occurredAt: number;
      usage: SessionUsage;
    },
  ): Promise<string> {
    const created = await plane.createSession({
      commandId: options.commandId,
      projectId: options.projectId,
      ticketId: options.ticketId,
      role: roleImpliedByTicket(options.ticketId),
      parentSessionId: null,
      title: options.commandId,
      provenance: userProvenance,
    });
    await plane.observe({
      id: `usage-${options.commandId}`,
      kind: "usage.recorded",
      sessionId: created.session.id,
      occurredAt: options.occurredAt,
      provenance: adapterProvenance,
      attachmentId: null,
      turnId: null,
      usage: options.usage,
    });
    return created.session.id;
  }

  it("answers every scope from the same facts", async () => {
    const { plane } = composition();
    const here = await spend(plane, {
      commandId: "here",
      projectId: "project-1",
      ticketId: "ticket-1",
      occurredAt: 1_000,
      usage: metered({ costUsd: 1 }),
    });
    await spend(plane, {
      commandId: "sibling",
      projectId: "project-1",
      ticketId: null,
      occurredAt: 2_000,
      usage: metered({ costUsd: 2 }),
    });
    await spend(plane, {
      commandId: "elsewhere",
      projectId: "project-2",
      ticketId: "ticket-9",
      occurredAt: 3_000,
      usage: metered({ costUsd: 4 }),
    });

    await expect(plane.reportUsage({ scope: { kind: "all" } })).resolves.toMatchObject({
      total: { knownCostUsd: 7 },
      meteredSessionCount: 3,
    });
    await expect(
      plane.reportUsage({ scope: { kind: "project", projectId: "project-1" } }),
    ).resolves.toMatchObject({ total: { knownCostUsd: 3 } });
    await expect(
      plane.reportUsage({ scope: { kind: "ticket", ticketId: "ticket-1" } }),
    ).resolves.toMatchObject({ total: { knownCostUsd: 1 } });
    await expect(
      plane.reportUsage({ scope: { kind: "session", sessionId: here } }),
    ).resolves.toMatchObject({ total: { knownCostUsd: 1 } });
  });

  it("bounds a report by a half-open window, so adjacent windows tile", async () => {
    const { plane } = composition();
    await spend(plane, {
      commandId: "early",
      projectId: "project-1",
      ticketId: null,
      occurredAt: 1_000,
      usage: metered({ costUsd: 1 }),
    });
    await spend(plane, {
      commandId: "late",
      projectId: "project-1",
      ticketId: null,
      occurredAt: 2_000,
      usage: metered({ costUsd: 2 }),
    });

    await expect(
      plane.reportUsage({ scope: { kind: "all" }, until: 2_000 }),
    ).resolves.toMatchObject({ total: { knownCostUsd: 1, requestCount: 1 } });
    await expect(
      plane.reportUsage({ scope: { kind: "all" }, since: 2_000 }),
    ).resolves.toMatchObject({ total: { knownCostUsd: 2, requestCount: 1 } });
  });

  it("breaks a report down without changing what it totals", async () => {
    const { plane } = composition();
    await spend(plane, {
      commandId: "opus",
      projectId: "project-1",
      ticketId: "ticket-1",
      occurredAt: 1_000,
      usage: metered({ costUsd: 8 }),
    });
    await spend(plane, {
      commandId: "codex",
      projectId: "project-1",
      ticketId: "ticket-1",
      occurredAt: 2_000,
      usage: metered({ providerId: "openai", modelId: "gpt-5", costUsd: 2 }),
    });

    const report = await plane.reportUsage({ scope: { kind: "all" }, groupBy: "model" });
    expect(report.groups.map((group) => group.key)).toEqual([
      "anthropic/claude-opus-4-1",
      "openai/gpt-5",
    ]);
    expect(report.total.knownCostUsd).toBe(10);
  });

  it("says nothing was measured rather than nothing was spent", async () => {
    const { plane } = composition();
    await plane.createSession(createRequest("create-silent"));

    await expect(plane.reportUsage({ scope: { kind: "all" } })).resolves.toMatchObject({
      total: { knownCostUsd: null, costCoverage: "unavailable" },
      meteredSessionCount: 0,
    });
  });
});

describe("the in-memory ledger's usage port", () => {
  // Every adapter must honour the whole port. This one derives usage on each
  // read, so it has no stored projection to discard — but a rebuild must still
  // be callable and must still leave the same answers, or the port would be a
  // promise only SQLite keeps.
  it("answers a rebuild without losing what it can already derive", async () => {
    const { ledger, plane } = composition();
    const created = await plane.createSession(createRequest("create-rebuild"));
    await plane.observe({
      id: "usage-rebuild",
      kind: "usage.recorded",
      sessionId: created.session.id,
      occurredAt: 1_000,
      provenance: adapterProvenance,
      attachmentId: null,
      turnId: null,
      usage: {
        cause: "assistant",
        providerId: "anthropic",
        modelId: "claude-opus-4-1",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsd: 0.5,
        costBasis: "catalog-estimate",
      },
    });

    const before = await plane.reportUsage({ scope: { kind: "all" } });
    await ledger.transaction((transaction) => {
      transaction.rebuildUsageProjection();
    });
    await expect(plane.reportUsage({ scope: { kind: "all" } })).resolves.toEqual(before);
  });

  // A usage event whose Session the ledger no longer has cannot be attributed
  // to a project or a ticket, so it is dropped rather than reported under an
  // invented scope.
  it("drops a metered operation whose Session is gone", async () => {
    const ledger = createInMemorySessionLedger();
    const plane = createSessionEngine({ ledger, clock: { now: () => 100 }, ids: ids() });
    const created = await plane.createSession(createRequest("create-orphan"));
    await plane.observe({
      id: "usage-orphan",
      kind: "usage.recorded",
      sessionId: created.session.id,
      occurredAt: 1_000,
      provenance: adapterProvenance,
      attachmentId: null,
      turnId: null,
      usage: {
        cause: "assistant",
        providerId: "anthropic",
        modelId: "claude-opus-4-1",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsd: 0.5,
        costBasis: "catalog-estimate",
      },
    });

    await expect(
      plane.reportUsage({ scope: { kind: "session", sessionId: "session-that-never-existed" } }),
    ).resolves.toMatchObject({ total: { requestCount: 0 }, meteredSessionCount: 0 });
  });
});

/**
 * A project's whole roster, folded on the process that also serves every other
 * Session operation (VC-388).
 *
 * The cost per Session is already bounded by the checkpoint tail. What these
 * cover is the cost of doing it N times in a row with nothing in between: a
 * listing that holds the ledger for its whole length starves every write
 * behind it, and one that never returns to the event loop blocks the host for
 * the same span whether or not a skeleton is drawn over it.
 */
/** The first {@link SESSION_LISTING_CACHE_LIMIT} rows of a roster: exactly a full cache. */
const rosterAtCacheLimit = (rows: readonly Session[]): readonly Session[] =>
  rows.slice(0, SESSION_LISTING_CACHE_LIMIT);

describe("listSessions over a project roster (VC-388)", () => {
  async function roster(count: number) {
    const { plane } = composition();
    const sessions = [];
    for (let index = 0; index < count; index += 1) {
      sessions.push((await plane.createSession(createRequest(`command-roster-${index}`))).session);
    }
    return { plane, sessions };
  }

  it("lets a write commit while a listing is still in flight", async () => {
    const { plane, sessions } = await roster(40);
    const settled: string[] = [];

    const listing = plane.listSessions({ projectId: "project-1", scope: "all" }).then((rows) => {
      settled.push("listing");
      return rows;
    });
    const write = plane
      .submit({
        commandId: "command-roster-write",
        sessionId: sessions[0].id,
        intent: { kind: "session.retitle", title: "Wrote mid-listing" },
        provenance: userProvenance,
      })
      .then((result) => {
        settled.push("write");
        return result;
      });

    const [rows] = await Promise.all([listing, write]);
    // The whole point: the roster's fold is not one indivisible hold on the
    // ledger, so a Session that wants to record a fact is not made to wait for
    // 39 other Sessions to be projected first.
    expect(settled).toEqual(["write", "listing"]);
    expect(rows).toHaveLength(40);
  });

  it("returns to the host's event loop before the roster is folded", async () => {
    const { plane } = await roster(40);

    const listing = plane.listSessions({ projectId: "project-1", scope: "all" });
    // Registered AFTER the listing began, so it can only run if the listing
    // gives the loop a turn back. A promise chain would not: awaiting a
    // resolved promise drains as a microtask, and the whole microtask queue
    // runs to exhaustion before any timer does.
    let hostRanMidListing = false;
    setTimeout(() => {
      hostRanMidListing = true;
    }, 0);

    await expect(listing).resolves.toHaveLength(40);
    expect(hostRanMidListing).toBe(true);
  });

  it("yields through the host's own primitive when one is injected", async () => {
    // The engine owns no host API, so its default yield is the portable
    // `setTimeout(0)`; a host with a better spelling hands it in here. This
    // proves the port is the seam the listing goes through, and that it is
    // taken once between chunks rather than once per Session.
    let yields = 0;
    const yieldToHost = () =>
      new Promise<void>((resolve) => {
        yields += 1;
        setTimeout(resolve, 0);
      });
    let now = 100;
    const plane = createSessionEngine({
      ledger: createInMemorySessionLedger(),
      clock: { now: () => now++ },
      ids: ids(),
      yieldToHost,
    });
    const count = SESSION_LISTING_FOLD_CHUNK * 2 + 1;
    for (let index = 0; index < count; index += 1) {
      await plane.createSession(createRequest(`command-yield-${index}`));
    }

    await expect(
      plane.listSessions({ projectId: "project-1", scope: "all" }),
    ).resolves.toHaveLength(count);
    // Three chunks, and the yield is between them, not before the first.
    expect(yields).toBe(2);
  });

  /**
   * A ledger that reports which Sessions each read actually folded.
   *
   * `listProjectionEvents` is the fold's own read, so a Session that appears
   * here was projected from its log and one that does not was answered from
   * somewhere cheaper.
   */
  function foldWatchingComposition(
    /**
     * Which of the stored rows a listing sees, so a test can shrink and grow
     * one roster instead of building two.
     */
    visibleRows: (rows: readonly Session[]) => readonly Session[] = (rows) => rows,
  ) {
    const stored = createInMemorySessionLedger();
    const folded: string[] = [];
    const ledger: SessionLedger = {
      transaction: (work) =>
        stored.transaction((transaction) =>
          work(
            new Proxy(transaction, {
              get(target, property, receiver) {
                if (property === "listSessions") {
                  return (query: ListSessionsQuery) => visibleRows(transaction.listSessions(query));
                }
                if (property !== "listProjectionEvents") {
                  return Reflect.get(target, property, receiver);
                }
                return (query: Parameters<SessionLedgerTransaction["listProjectionEvents"]>[0]) => {
                  folded.push(query.sessionId);
                  return transaction.listProjectionEvents(query);
                };
              },
            }),
          ),
        ),
    };
    let now = 100;
    const plane = createSessionEngine({ ledger, clock: { now: () => now++ }, ids: ids() });
    return { plane, folded };
  }

  it("re-folds only the Sessions whose log moved since the last listing", async () => {
    const { plane, folded } = foldWatchingComposition();
    const quiet = (await plane.createSession(createRequest("command-cache-quiet"))).session;
    const busy = (await plane.createSession(createRequest("command-cache-busy"))).session;
    const alsoQuiet = (await plane.createSession(createRequest("command-cache-also-quiet")))
      .session;

    folded.length = 0;
    await expect(
      plane.listSessions({ projectId: "project-1", scope: "all" }),
    ).resolves.toHaveLength(3);
    // Nothing is cached yet, so the first visit pays for all three.
    expect(folded.toSorted()).toEqual([alsoQuiet.id, busy.id, quiet.id].toSorted());

    await plane.submit({
      commandId: "command-cache-retitle",
      sessionId: busy.id,
      intent: { kind: "session.retitle", title: "Moved on" },
      provenance: userProvenance,
    });

    folded.length = 0;
    const second = await plane.listSessions({ projectId: "project-1", scope: "all" });
    expect(folded).toEqual([busy.id]);
    // And the answer is the same one a full fold would have given.
    expect(second.find(({ session }) => session.id === busy.id)?.session.title).toBe("Moved on");
    expect(second.find(({ session }) => session.id === quiet.id)?.session.title).toBe(
      "Durable Session",
    );
  });

  /**
   * The case that decides whether a cursor is a sufficient cache key. It is
   * not.
   *
   * `sessions.ticket_id` is `ON DELETE SET NULL`, so deleting a Ticket moves a
   * field of an otherwise insert-only row and appends NOTHING to any Session's
   * log. A listing cache keyed on the log head alone would keep answering with
   * the Ticket that was deleted, and no later event would ever dislodge it.
   */
  it("re-folds a Session whose row moved even though its log did not", async () => {
    const stored = createInMemorySessionLedger();
    let ticketDeleted = false;
    // Copy-on-write, as the store's own decoder is: the rows the ledger holds
    // must not be edited in place by a reader pretending a Ticket went away.
    const afterTicketDelete = (rows: readonly Session[]): readonly Session[] => {
      if (!ticketDeleted) return rows;
      const moved: Session[] = [];
      for (const session of rows) moved.push({ ...session, ticketId: null });
      return moved;
    };
    const ledger: SessionLedger = {
      transaction: (work) =>
        stored.transaction((transaction) =>
          work(
            new Proxy(transaction, {
              get(target, property, receiver) {
                if (property !== "listSessions") return Reflect.get(target, property, receiver);
                return (query: ListSessionsQuery) =>
                  afterTicketDelete(transaction.listSessions(query));
              },
            }),
          ),
        ),
    };
    const plane = createSessionEngine({ ledger, clock: { now: () => 100 }, ids: ids() });
    const created = await plane.createSession(createRequest("command-cache-ticket-delete"));

    await expect(
      plane.listSessions({ projectId: "project-1", scope: "all" }),
    ).resolves.toMatchObject([{ session: { id: created.session.id, ticketId: "ticket-1" } }]);

    ticketDeleted = true;
    await expect(
      plane.listSessions({ projectId: "project-1", scope: "all" }),
    ).resolves.toMatchObject([{ session: { id: created.session.id, ticketId: null } }]);
  });

  /**
   * The cache's bound, which is the half of a cache that has to be proved
   * rather than observed: a memo that never evicts also answers every
   * assertion about hits and misses, and only grows.
   *
   * The roster is grown by ONE past {@link SESSION_LISTING_CACHE_LIMIT} rather
   * than by many, because the interesting boundary is exactly there: a roster
   * at the limit must survive a repeat listing whole, and the first row over
   * it must cost exactly one entry — the least recently listed one — and not
   * the whole cache.
   *
   * Budgeted like the other roster-sized tests: it creates one Session more
   * than the cache holds and folds that roster four times, which is under a
   * second here and several under coverage instrumentation on a shared CI
   * runner. The default five seconds timed out on main.
   */
  it(
    "evicts the least recently listed Session once the cache is full",
    { timeout: 30_000 },
    async () => {
      // One roster, listed through a moving window: at the cache's size, then
      // one over it, then one row at a time to ask which entry survived.
      let visible: (rows: readonly Session[]) => readonly Session[] = rosterAtCacheLimit;
      const { plane, folded } = foldWatchingComposition((rows) => visible(rows));
      for (let index = 0; index <= SESSION_LISTING_CACHE_LIMIT; index += 1) {
        await plane.createSession(createRequest(`command-evict-${index}`));
      }
      const query = { projectId: "project-1", scope: "all" } as const;

      folded.length = 0;
      const full = await plane.listSessions(query);
      expect(folded).toHaveLength(SESSION_LISTING_CACHE_LIMIT);

      // A roster that exactly fills the cache is served entirely from it: the
      // limit holds this many, not this many minus one.
      folded.length = 0;
      await expect(plane.listSessions(query)).resolves.toHaveLength(SESSION_LISTING_CACHE_LIMIT);
      expect(folded).toEqual([]);

      // One Session more than the cache can hold. Only the newcomer is folded,
      // and storing it pushes out the head of the insertion order — which is
      // the first row of the listing, since a hit re-inserts in listing order.
      visible = (rows) => rows;
      folded.length = 0;
      const overflowing = await plane.listSessions(query);
      expect(overflowing).toHaveLength(SESSION_LISTING_CACHE_LIMIT + 1);
      expect(folded).toEqual([overflowing.at(-1)?.session.id]);

      // Which entry went, asked one row at a time so a miss cannot cascade into
      // the next row and blur the answer. The middle of the roster is still
      // memoized...
      const middle = full[SESSION_LISTING_CACHE_LIMIT >> 1].session;
      visible = (rows) => rows.filter((row) => row.id === middle.id);
      folded.length = 0;
      await expect(plane.listSessions(query)).resolves.toHaveLength(1);
      expect(folded).toEqual([]);

      // ...and the row listed longest ago is not: it has to be folded again,
      // which is the eviction, observed.
      const listedLongestAgo = full[0].session;
      visible = (rows) => rows.filter((row) => row.id === listedLongestAgo.id);
      folded.length = 0;
      await expect(plane.listSessions(query)).resolves.toHaveLength(1);
      expect(folded).toEqual([listedLongestAgo.id]);
    },
  );
});

/**
 * The concurrency budget's read (VC-403).
 *
 * `listSessions` folds a project's whole roster to answer how many Sessions are
 * working — thousands of folds, on a machine with history, for a number bounded
 * by how many things are actually attached. This is the narrowed read that
 * replaces it, and what these hold is that narrowing it did not change what it
 * MEANS: the Sessions it returns are exactly the attached ones, folded the
 * ordinary way, in the ordinary order.
 */
describe("listAttachedSessions (VC-403)", () => {
  /** Opens an attachment on a fresh Session, and optionally closes it again. */
  async function attached(
    plane: ReturnType<typeof createSessionEngine>,
    name: string,
    close: boolean,
  ) {
    const { session } = await plane.createSession(createRequest(`command-${name}`));
    await plane.observe({
      id: `${name}-opened`,
      sessionId: session.id,
      occurredAt: 1,
      provenance: adapterProvenance,
      kind: "attachment.opened",
      attachment: attachment(session.id, `attachment-${name}`),
    });
    if (close) {
      await plane.observe({
        id: `${name}-closed`,
        sessionId: session.id,
        occurredAt: 2,
        provenance: adapterProvenance,
        kind: "attachment.closed",
        attachmentId: `attachment-${name}`,
        outcome: "completed",
      });
    }
    return session;
  }

  it("returns only the Sessions still holding an open attachment", async () => {
    const { plane } = composition();
    const open = await attached(plane, "open", false);
    await attached(plane, "closed", true);
    // Created and never attached: the bulk of a real machine, and the whole set
    // the narrowing exists to skip folding.
    await plane.createSession(createRequest("command-never-attached"));

    const rows = await plane.listAttachedSessions();

    expect(rows.map(({ session }) => session.id)).toEqual([open.id]);
    // Ordinary projections, not a reduced shape: the caller counts these with
    // exactly the code that counts a listing.
    expect(rows[0]?.attachments.map(({ status }) => status)).toEqual(["open"]);
  });

  it("is empty when nothing is attached, rather than falling back to the roster", async () => {
    const { plane } = composition();
    await plane.createSession(createRequest("command-quiet"));

    await expect(plane.listAttachedSessions()).resolves.toEqual([]);
  });

  it("breaks a tie on id, descending, exactly as the SQL ordering does", async () => {
    // A clock that does not move, so both Sessions share a creation stamp and
    // the tie-break is the only thing left to order them. The SQLite ledger
    // orders `created_at DESC, id COLLATE BINARY DESC`; this double has to
    // agree, or a roster read through the two stores would differ by store.
    const plane = createSessionEngine({
      ledger: createInMemorySessionLedger(),
      clock: { now: () => 100 },
      ids: ids(),
    });
    const first = await attached(plane, "tie-first", false);
    const second = await attached(plane, "tie-second", false);

    const rows = await plane.listAttachedSessions();

    expect(first.createdAt).toBe(second.createdAt);
    expect(rows.map(({ session }) => session.id)).toEqual(
      [first.id, second.id].toSorted((left, right) => (left < right ? 1 : -1)),
    );
  });

  it("returns to the host's event loop between chunks, as the listing does", async () => {
    const { plane } = composition();
    // More than one fold chunk, so the yield between chunks is exercised: this
    // runs on the one main thread, behind the UI's IPC.
    const opened = [];
    for (let index = 0; index < SESSION_LISTING_FOLD_CHUNK + 4; index += 1) {
      opened.push(await attached(plane, `chunked-${index}`, false));
    }
    let hostRan = false;

    const listing = plane.listAttachedSessions();
    setTimeout(() => (hostRan = true), 0);
    const rows = await listing;

    expect(rows).toHaveLength(opened.length);
    expect(hostRan).toBe(true);
  });
});

/**
 * A ledger that answers every read of the same event with the SAME object.
 *
 * Both ledgers in this repository happen to hand out fresh objects — the
 * in-memory one clones, the SQLite one decodes each row — but {@link
 * SessionLedger} never promises it, and a conforming implementation that
 * cached its decoded reads would look like this. It is the shape that catches
 * a projection which freezes objects it does not own (VC-393).
 */
function interningComposition() {
  const stored = createInMemorySessionLedger();
  const interned = new Map<string, SessionProjectionEvent>();
  const intern = (events: readonly SessionProjectionEvent[]): readonly SessionProjectionEvent[] =>
    events.map((event) => {
      const key = `${event.sessionId}:${event.sequence}`;
      const first = interned.get(key);
      if (first) return first;
      interned.set(key, event);
      return event;
    });
  const ledger: SessionLedger = {
    transaction: (work) =>
      stored.transaction((transaction) =>
        work(
          new Proxy(transaction, {
            get(target, property, receiver) {
              if (property !== "listProjectionEvents") {
                return Reflect.get(target, property, receiver);
              }
              return (query: Parameters<SessionLedgerTransaction["listProjectionEvents"]>[0]) =>
                intern(transaction.listProjectionEvents(query));
            },
          }),
        ),
      ),
  };
  let now = 100;
  const plane = createSessionEngine({ ledger, clock: { now: () => now++ }, ids: ids() });
  return { plane, interned };
}

/**
 * The cache's other half: the SAME object is handed to every caller of a
 * listing while its entry survives (VC-388), so a caller that mutated a
 * returned row would corrupt every later read rather than its own copy
 * (VC-393). Nothing in the engine or its known callers does this today, but
 * the cache must not depend on that staying true.
 *
 * `SessionProjection` is `readonly` throughout, so each mutation below is a
 * compile error first; the assertions are about the runtime backstop that
 * still has to hold for code which gets past the type (`any`, a structured
 * clone across an RPC seam, plain JavaScript).
 */
describe("listSessions cached projections are frozen (VC-393)", () => {
  it("throws when a caller mutates a top-level field of a returned row", async () => {
    const { plane } = composition();
    await plane.createSession(createRequest("command-freeze-top"));

    const [row] = await plane.listSessions({ projectId: "project-1", scope: "all" });

    expect(() => {
      // @ts-expect-error -- the assignment a mutating caller would write.
      row.turnActive = true;
    }).toThrow(TypeError);
  });

  it("throws when a caller mutates a nested object or array of a returned row", async () => {
    const { plane } = composition();
    await plane.createSession(createRequest("command-freeze-nested"));

    const [row] = await plane.listSessions({ projectId: "project-1", scope: "all" });

    expect(() => {
      // @ts-expect-error -- a nested array.
      row.commands.push(row.commands[0]);
    }).toThrow(TypeError);
    // The nested OBJECT is frozen too, not merely the array it holds: a
    // container that recursed into its children but skipped itself would pass
    // the push above and fail here.
    expect(Object.isFrozen(row.attention)).toBe(true);
    expect(() => {
      // @ts-expect-error -- a field of that nested object.
      row.attention.primary = null;
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error -- and the array one level deeper again.
      row.attention.active.push(row.attention.active[0]);
    }).toThrow(TypeError);
  });

  /**
   * The depth the freeze actually claims. Every assertion above stops at a
   * container; this one reaches an object INSIDE one, which is where a
   * shallow freeze of the row and its immediate children would still let a
   * caller rewrite the cache.
   */
  it("throws when a caller mutates an object inside an array of a returned row", async () => {
    const { plane } = composition();
    await plane.createSession(createRequest("command-freeze-element"));

    const [row] = await plane.listSessions({ projectId: "project-1", scope: "all" });

    // The create wrote a real command, so this element is populated data
    // rather than an empty-array technicality.
    expect(row.commands).toHaveLength(1);
    expect(() => {
      // @ts-expect-error -- an element of a nested array.
      row.commands[0].id = "rewritten";
    }).toThrow(TypeError);
    // Deeper than the `readonly` modifiers reach: a command's INTENT has
    // mutable fields, so from here down the runtime freeze is the only guard
    // left, and it has to hold all the way to the leaves.
    expect(Object.isFrozen(row.commands[0].intent)).toBe(true);
    expect(() => {
      row.commands[0].intent.kind = "session.archive";
    }).toThrow(TypeError);
    expect(row.commands[0].id).toBe("command-freeze-element");
    expect(row.commands[0].intent.kind).toBe("session.create");
  });

  it("keeps serving the original values after a rejected mutation attempt", async () => {
    const { plane } = composition();
    await plane.createSession(createRequest("command-freeze-stable"));

    const first = await plane.listSessions({ projectId: "project-1", scope: "all" });
    try {
      // @ts-expect-error -- the mutation a caller past the type would write.
      first[0].session.title = "Mutated by a caller";
    } catch {
      // Expected: the assignment above throws in strict mode. Even if a
      // caller swallowed that, the cache below proves nothing leaked.
    }

    const second = await plane.listSessions({ projectId: "project-1", scope: "all" });
    // Cache hit (nothing else happened to the Session): the SAME object is
    // handed back, and it still reads the pre-mutation value.
    expect(second[0]).toBe(first[0]);
    expect(second[0].session.title).toBe("Durable Session");
  });

  /**
   * The miss path, which is a second entry into the cache rather than the
   * first: a freeze applied only to the row that populated an empty cache
   * would leave every REPLACEMENT row aliased and mutable.
   */
  it("freezes the replacement row a refold produces after the log moves", async () => {
    const { plane } = composition();
    const created = await plane.createSession(createRequest("command-freeze-refold"));

    const [before] = await plane.listSessions({ projectId: "project-1", scope: "all" });
    await plane.submit({
      commandId: "command-freeze-refold-retitle",
      sessionId: created.session.id,
      intent: { kind: "session.retitle", title: "Moved on" },
      provenance: userProvenance,
    });

    const [after] = await plane.listSessions({ projectId: "project-1", scope: "all" });
    // A genuine refold, not the cached row handed back again.
    expect(after).not.toBe(before);
    expect(after.session.title).toBe("Moved on");
    expect(Object.isFrozen(after)).toBe(true);
    expect(() => {
      // @ts-expect-error -- same guarantee as the first fold's row.
      after.turnActive = true;
    }).toThrow(TypeError);
  });

  /**
   * The other direction: what the cache must NOT freeze.
   *
   * A fold does not own its whole graph — `foldSessionProjection` seeds its
   * containers from the base checkpoint's elements and pushes the objects it
   * read out of the event payloads. Freezing the folded object in place would
   * therefore reach back into whatever the ledger handed over. The cache holds
   * a copy so that it cannot.
   */
  it("freezes nothing the ledger owns, so a ledger that caches its reads is safe", async () => {
    const { plane, interned } = interningComposition();
    await plane.createSession(createRequest("command-freeze-contagion"));

    const [row] = await plane.listSessions({ projectId: "project-1", scope: "all" });
    expect(Object.isFrozen(row)).toBe(true);

    const recorded = [...interned.values()].find(
      (event) => event.payload.kind === "command.recorded",
    );
    expect(recorded?.payload.kind).toBe("command.recorded");
    const ledgerCommand =
      recorded?.payload.kind === "command.recorded" ? recorded.payload.command : undefined;

    // The row reports the same command, by value...
    expect(row.commands[0]).toEqual(ledgerCommand);
    // ...but does not hold the ledger's object, and left it untouched.
    expect(row.commands[0]).not.toBe(ledgerCommand);
    expect(Object.isFrozen(ledgerCommand)).toBe(false);
    for (const event of interned.values()) {
      expect(Object.isFrozen(event)).toBe(false);
      expect(Object.isFrozen(event.payload)).toBe(false);
    }
  });

  /**
   * The behaviour change the cache made to {@link
   * SessionEnginePorts.onProjectionCheckpointFailure}, held where the port
   * documents it: a hit never reaches `projectStoredSession`, so a broken
   * checkpoint is reported once per entry rather than once per listing.
   */
  it("reports a checkpoint failure once per fold, not once per listing", async () => {
    const stored = createInMemorySessionLedger();
    const failure = new Error("checkpoint row could not be decoded");
    let failReads = false;
    const ledger: SessionLedger = {
      transaction: (work) =>
        stored.transaction((transaction) =>
          work(
            new Proxy(transaction, {
              get(target, property, receiver) {
                if (property !== "getProjectionCheckpoint") {
                  return Reflect.get(target, property, receiver);
                }
                return (sessionId: string) => {
                  if (failReads) throw failure;
                  return transaction.getProjectionCheckpoint(sessionId);
                };
              },
            }),
          ),
        ),
    };
    const reported: unknown[] = [];
    let now = 100;
    const plane = createSessionEngine({
      ledger,
      clock: { now: () => now++ },
      ids: ids(),
      onProjectionCheckpointFailure: (error) => reported.push(error),
    });
    const created = await plane.createSession(createRequest("command-freeze-checkpoint"));
    const query = { projectId: "project-1", scope: "all" } as const;

    failReads = true;
    await expect(plane.listSessions(query)).resolves.toHaveLength(1);
    // The miss folded, so the unusable checkpoint was seen and reported.
    expect(reported).toEqual([failure]);

    // A hit answers from the entry and never folds, so the broken checkpoint
    // is not read again and nothing is reported a second time. This is the
    // whole behaviour change: once per entry, not once per listing.
    await expect(plane.listSessions(query)).resolves.toHaveLength(1);
    await expect(plane.listSessions(query)).resolves.toHaveLength(1);
    expect(reported).toEqual([failure]);

    // Moving the log invalidates the entry. The write path folds on its own
    // account, so it reports once here before any listing has run again.
    await plane.submit({
      commandId: "command-freeze-checkpoint-retitle",
      sessionId: created.session.id,
      intent: { kind: "session.retitle", title: "Moved on" },
      provenance: userProvenance,
    });
    const beforeRefold = reported.length;

    // And the next listing has to fold again, so the condition becomes
    // visible again. It is quieter, not silenced.
    await expect(plane.listSessions(query)).resolves.toHaveLength(1);
    expect(reported.length).toBe(beforeRefold + 1);
    expect(reported.at(-1)).toBe(failure);

    // ...and then goes quiet again while the new entry stands.
    await expect(plane.listSessions(query)).resolves.toHaveLength(1);
    expect(reported.length).toBe(beforeRefold + 1);
  });
});
