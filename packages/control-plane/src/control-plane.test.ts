import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import {
  ControlPlaneConflictError,
  createControlPlane,
  createInMemorySessionLedger,
} from "./index";
import type {
  AcceptedCommandReceipt,
  Session,
  SessionAttachment,
  SessionCommand,
  SessionEvent,
  SessionEventProvenance,
  SessionLedgerIds,
  SessionLedger,
  SessionLedgerTransaction,
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
  const plane = createControlPlane({ ledger, clock: { now: () => now++ }, ids: ids() });
  return { ledger, plane };
}

function createRequest(commandId = "command-create") {
  return {
    commandId,
    projectId: "project-1",
    ticketId: "ticket-1",
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
  };
}

function sessionRecord(id = "session-seed"): Session {
  return { id, projectId: "project-1", ticketId: null, title: null, createdAt: 0 };
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

describe("ControlPlane creation and explicit commands", () => {
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
      { ...createRequest(), title: "different" },
    ]) {
      await expect(plane.createSession(request)).rejects.toBeInstanceOf(ControlPlaneConflictError);
    }
    await plane.submit({
      commandId: "command-create-conflict",
      sessionId: first.session.id,
      intent: { kind: "session.archive" },
      provenance: userProvenance,
    });
    await expect(
      plane.createSession(createRequest("command-create-conflict")),
    ).rejects.toBeInstanceOf(ControlPlaneConflictError);
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
    await plane.observe({
      id: "observation-receipt-accepted",
      sessionId: session.id,
      occurredAt: 200,
      provenance: adapterProvenance,
      kind: "command.receipt",
      receipt: observedReceipt(receipt),
    });
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

  it("lists deep Session projections through explicit project scopes in stable descending order", async () => {
    const ledger = createInMemorySessionLedger();
    const plane = createControlPlane({ ledger, clock: { now: () => 100 }, ids: ids() });
    const ticketFirst = await plane.createSession(createRequest("command-list-ticket-first"));
    const scratch = await plane.createSession({
      ...createRequest("command-list-scratch"),
      ticketId: null,
      title: "Scratch Session",
    });
    const ticketLater = await plane.createSession({
      ...createRequest("command-list-ticket-later"),
      title: "Ticket Session",
    });
    await plane.createSession({
      ...createRequest("command-list-other-project"),
      projectId: "project-2",
      ticketId: null,
    });
    await plane.submit({
      commandId: "command-list-retitle",
      sessionId: ticketLater.session.id,
      intent: { kind: "session.retitle", title: "Projected title" },
      provenance: userProvenance,
    });

    const all = await plane.listSessions({ projectId: "project-1", scope: "all" });
    expect(all.map(({ session: listed }) => listed.id)).toEqual([
      scratch.session.id,
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
      plane.listSessions({ projectId: "project-1", scope: "scratch" }),
    ).resolves.toMatchObject([{ session: { id: scratch.session.id, ticketId: null } }]);
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
      id: "observation-start-pending-a-accepted",
      sessionId: session.id,
      occurredAt: 1,
      provenance: adapterProvenance,
      kind: "command.receipt",
      receipt: {
        id: "receipt-start-pending-a-accepted",
        commandId: first.command.id,
        status: "accepted",
        acceptedAt: 1,
        result: { kind: "executor.start.requested", sessionId: session.id },
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

describe("ControlPlane attachment facts", () => {
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
    ).rejects.toThrow();

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

describe("ControlPlane idempotency and defensive ledger reads", () => {
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
      ControlPlaneConflictError,
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
    await plane.observe({
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
    });

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
      title: "Durable Session",
    });
    const createReceipt = acceptedReceipt("receipt-create", createCommand.id, {
      kind: "session.created",
      sessionId: createdSession.id,
    });
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
    const scratch = {
      ...sessionRecord("session-scratch"),
      title: "Scratch",
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
      for (const session of [ticketOlder, scratch, ticketLaterId, ticketEarlierId, otherProject]) {
        transaction.insertSession(session);
      }
      const all = transaction.listSessions({ projectId: "project-1", scope: "all" });
      expect(all.map((session) => session.id)).toEqual([
        ticketLaterId.id,
        ticketEarlierId.id,
        scratch.id,
        ticketOlder.id,
      ]);
      expect(
        transaction
          .listSessions({ projectId: "project-1", scope: "ticket", ticketId: "ticket-1" })
          .map((session) => session.id),
      ).toEqual([ticketLaterId.id, ticketEarlierId.id, ticketOlder.id]);
      expect(transaction.listSessions({ projectId: "project-1", scope: "scratch" })).toEqual([
        scratch,
      ]);
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
