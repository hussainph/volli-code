import { describe, expect, it } from "vite-plus/test";
import {
  isSessionAttentionKind,
  isSessionAttachmentContinuity,
  observationPayload,
  projectSession,
  sameCommandReceipt,
  sameCommandReceiptOutcome,
  sameSessionCommand,
  sameSessionCommandRequest,
  sameSessionEventPayload,
  sameSessionEventProvenance,
  SESSION_ATTACHMENT_CONTINUITIES,
  SESSION_ATTENTION_KINDS,
} from "./session-ledger";
import type { Session, SessionEvent, SessionObservation } from "./session-ledger";

const session: Session = {
  id: "session-1",
  projectId: "project-1",
  ticketId: "ticket-1",
  title: "A durable Session",
  createdAt: 100,
};

const localVenue = { id: "machine-1", kind: "local" as const };
const systemProvenance = {
  source: { kind: "system" as const, id: "control-plane", detail: null },
  venue: localVenue,
};

function event(sequence: number, payload: SessionEvent["payload"]): SessionEvent {
  return {
    id: `event-${sequence}`,
    sessionId: session.id,
    sequence,
    occurredAt: sequence * 10,
    recordedAt: sequence * 10 + 1,
    provenance: systemProvenance,
    payload,
  };
}

describe("Session ledger vocabularies", () => {
  it("accepts the named continuity modes and rejects unknown values", () => {
    expect(SESSION_ATTACHMENT_CONTINUITIES).toEqual([
      "fresh",
      "native_resume",
      "context_replay",
      "recreate",
    ]);
    for (const continuity of SESSION_ATTACHMENT_CONTINUITIES) {
      expect(isSessionAttachmentContinuity(continuity)).toBe(true);
    }
    expect(isSessionAttachmentContinuity("history_only")).toBe(false);
    expect(isSessionAttachmentContinuity(null)).toBe(false);
  });

  it("keeps attention states structured and finite", () => {
    for (const attention of SESSION_ATTENTION_KINDS)
      expect(isSessionAttentionKind(attention)).toBe(true);
    expect(isSessionAttentionKind("waiting")).toBe(false);
    expect(isSessionAttentionKind(undefined)).toBe(false);
  });
});

describe("observationPayload", () => {
  it("maps every externally observed fact without inventing a command", () => {
    const attachment = {
      id: "attachment-1",
      sessionId: session.id,
      adapterId: "opencode",
      venue: localVenue,
      continuity: "fresh" as const,
      native: { id: "native-1", detail: { model: "local" } },
    };
    const provenance = {
      source: { kind: "adapter" as const, id: "opencode", detail: { plugin: "hook" } },
      venue: localVenue,
    };
    const observations: readonly SessionObservation[] = [
      {
        id: "1",
        sessionId: session.id,
        occurredAt: 1,
        provenance,
        kind: "attachment.opened",
        attachment,
      },
      {
        id: "1-native",
        sessionId: session.id,
        occurredAt: 1,
        provenance,
        kind: "attachment.native_referenced",
        attachmentId: attachment.id,
        native: { id: "native-continuation", detail: { cursor: ["opaque", 3] } },
      },
      {
        id: "1-failed",
        sessionId: session.id,
        occurredAt: 1,
        provenance,
        kind: "attachment.failed",
        attachment: { ...attachment, id: "attachment-failed" },
        failure: { code: "spawn_failed", detail: "Unavailable", diagnostic: { retryable: false } },
      },
      {
        id: "2",
        sessionId: session.id,
        occurredAt: 2,
        provenance,
        kind: "attachment.closed",
        attachmentId: attachment.id,
        outcome: "completed",
      },
      {
        id: "3",
        sessionId: session.id,
        occurredAt: 3,
        provenance,
        kind: "run.started",
        attachmentId: attachment.id,
        runId: "run-1",
      },
      {
        id: "4",
        sessionId: session.id,
        occurredAt: 4,
        provenance,
        kind: "run.completed",
        attachmentId: attachment.id,
        runId: "run-1",
      },
      {
        id: "5",
        sessionId: session.id,
        occurredAt: 5,
        provenance,
        kind: "turn.started",
        attachmentId: attachment.id,
        turnId: "turn-1",
      },
      {
        id: "6",
        sessionId: session.id,
        occurredAt: 6,
        provenance,
        kind: "turn.completed",
        attachmentId: attachment.id,
        turnId: "turn-1",
      },
      {
        id: "7",
        sessionId: session.id,
        occurredAt: 7,
        provenance,
        kind: "transcript.referenced",
        attachmentId: attachment.id,
        turnId: "turn-1",
        reference: { id: "transcript-1", mediaType: "text/markdown", digest: "sha256:1" },
      },
      {
        id: "8",
        sessionId: session.id,
        occurredAt: 8,
        provenance,
        kind: "attention.raised",
        attention: {
          id: "attention-1",
          kind: "input_required",
          attachmentId: attachment.id,
          detail: null,
          diagnostic: null,
        },
      },
      {
        id: "9",
        sessionId: session.id,
        occurredAt: 9,
        provenance,
        kind: "attention.cleared",
        attentionId: "attention-1",
      },
      {
        id: "10",
        sessionId: session.id,
        occurredAt: 10,
        provenance,
        kind: "adapter.observed",
        attachmentId: attachment.id,
        name: "native.signal",
        native: ["opaque", true],
      },
    ];

    expect(observations.map(observationPayload).map(({ kind }) => kind)).toEqual([
      "attachment.opened",
      "attachment.native_referenced",
      "attachment.failed",
      "attachment.closed",
      "run.started",
      "run.completed",
      "turn.started",
      "turn.completed",
      "transcript.referenced",
      "attention.raised",
      "attention.cleared",
      "adapter.observed",
    ]);
    expect(() =>
      observationPayload({
        id: "11",
        sessionId: session.id,
        occurredAt: 11,
        provenance,
        kind: "command.receipt",
        receipt: {
          id: "receipt-1",
          commandId: "command-1",
          status: "unreconciled",
          detail: "Awaiting reconciliation",
        },
      }),
    ).toThrow("require Control Plane stamping");
  });
});

describe("projectSession", () => {
  it("projects retitle and native-continuation facts without mutating immutable inputs", () => {
    const attachment = {
      id: "attachment-1",
      sessionId: session.id,
      adapterId: "codex",
      venue: localVenue,
      continuity: "native_resume" as const,
      native: null,
    };
    const native = { id: "native-continuation", detail: { cursor: ["opaque", 3] } };

    const projection = projectSession(session, [
      event(1, { kind: "attachment.opened", attachment }),
      event(2, { kind: "session.retitled", title: "Retitled Session" }),
      event(3, { kind: "attachment.native_referenced", attachmentId: attachment.id, native }),
      event(4, {
        kind: "attachment.native_referenced",
        attachmentId: "missing",
        native: { id: null, detail: null },
      }),
    ]);

    expect(projection.session).toEqual({ ...session, title: "Retitled Session" });
    expect(session.title).toBe("A durable Session");
    expect(projection.attachments).toMatchObject([{ id: attachment.id, native }]);
    expect(attachment.native).toBeNull();
  });

  it("keeps the Session open when runs, turns, and an executor end", () => {
    const attachment = {
      id: "attachment-1",
      sessionId: session.id,
      adapterId: "codex",
      venue: localVenue,
      continuity: "native_resume" as const,
      native: null,
    };
    const projection = projectSession(session, [
      event(0, { kind: "attachment.closed", attachmentId: "unknown", outcome: "failed" }),
      event(1, { kind: "attachment.opened", attachment }),
      event(2, { kind: "run.started", attachmentId: attachment.id, runId: "run-1" }),
      event(3, { kind: "turn.started", attachmentId: attachment.id, turnId: "turn-1" }),
      event(4, { kind: "turn.completed", attachmentId: attachment.id, turnId: "turn-1" }),
      event(5, { kind: "run.completed", attachmentId: attachment.id, runId: "run-1" }),
      event(6, { kind: "attachment.closed", attachmentId: attachment.id, outcome: "completed" }),
    ]);

    expect(projection.status).toBe("open");
    expect(projection.liveExecutor).toBeNull();
    expect(projection.attachments).toMatchObject([
      { id: attachment.id, status: "closed", closedAt: 60, outcome: "completed" },
    ]);
  });

  it("projects attachment, structured attention, and explicit archive facts", () => {
    const attachment = {
      id: "attachment-1",
      sessionId: session.id,
      adapterId: "claude",
      venue: localVenue,
      continuity: "context_replay" as const,
      native: { id: null, detail: null },
    };
    const projection = projectSession(session, [
      { ...event(0, { kind: "session.created", session }), sessionId: "other-session" },
      event(1, { kind: "attachment.opened", attachment }),
      {
        ...event(2, {
          kind: "attention.raised",
          attention: {
            id: "attention-1",
            kind: "permission_required",
            attachmentId: attachment.id,
            detail: "Approve",
            diagnostic: null,
          },
        }),
      },
      event(3, { kind: "attention.cleared", attentionId: "missing" }),
      event(4, { kind: "attention.cleared", attentionId: "attention-1" }),
      event(5, {
        kind: "attention.raised",
        attention: {
          id: "attention-2",
          kind: "quota_exhausted",
          attachmentId: null,
          detail: null,
          diagnostic: null,
          resetAt: 99,
        },
      }),
      event(6, { kind: "session.archived" }),
    ]);

    expect(projection.status).toBe("archived");
    expect(projection.liveExecutor?.id).toBe(attachment.id);
    expect(projection.attention).toEqual({
      active: [
        {
          id: "attention-2",
          kind: "quota_exhausted",
          attachmentId: null,
          detail: null,
          diagnostic: null,
          resetAt: 99,
        },
      ],
      primary: {
        id: "attention-2",
        kind: "quota_exhausted",
        attachmentId: null,
        detail: null,
        diagnostic: null,
        resetAt: 99,
      },
    });
  });

  it("retains a failed attachment as durable evidence without closing the Session", () => {
    const failed = {
      id: "attachment-failed",
      sessionId: session.id,
      adapterId: "codex",
      venue: localVenue,
      continuity: "fresh" as const,
      native: null,
    };
    const projection = projectSession(session, [
      event(1, {
        kind: "attachment.failed",
        attachment: failed,
        failure: { code: "spawn_failed", detail: null, diagnostic: { retryable: true } },
      }),
    ]);

    expect(projection).toMatchObject({
      status: "open",
      liveExecutor: null,
      attachments: [{ id: failed.id, status: "failed", failure: { code: "spawn_failed" } }],
    });
  });

  it("makes a re-raised Attention primary according to its latest event sequence", () => {
    const first = {
      id: "attention-first",
      kind: "input_required" as const,
      attachmentId: null,
      detail: "First",
      diagnostic: null,
    };
    const second = {
      id: "attention-second",
      kind: "permission_required" as const,
      attachmentId: null,
      detail: "Second",
      diagnostic: null,
    };
    const projection = projectSession(session, [
      event(1, { kind: "attention.raised", attention: first }),
      event(2, { kind: "attention.raised", attention: second }),
      event(3, { kind: "attention.raised", attention: { ...first, detail: "Re-raised" } }),
    ]);

    expect(projection.attention.primary).toMatchObject({ id: first.id, detail: "Re-raised" });
  });

  it("replays command and receipt history in sequence order even when a reader returns facts unordered", () => {
    const attachment = {
      id: "attachment-ordered",
      sessionId: session.id,
      adapterId: "opencode",
      venue: localVenue,
      continuity: "fresh" as const,
      native: null,
    };
    const command = {
      id: "command-ordered",
      sessionId: session.id,
      createdAt: 1,
      route: { adapterId: "opencode", attachmentId: "attachment-ordered" },
      intent: {
        kind: "message.submit" as const,
        reference: { id: "message-ordered", mediaType: null, digest: null },
      },
    };
    const receipt = {
      id: "receipt-ordered",
      commandId: command.id,
      status: "completed" as const,
      recordedAt: 4,
      sequence: 4,
      result: { kind: "message.submitted" as const, sessionId: session.id },
    };

    const projection = projectSession(session, [
      event(3, { kind: "attachment.closed", attachmentId: attachment.id, outcome: "completed" }),
      event(4, { kind: "command.receipt.recorded", receipt }),
      event(2, { kind: "attachment.opened", attachment }),
      event(1, { kind: "command.recorded", command }),
    ]);

    expect(projection.commands).toEqual([command]);
    expect(projection.receipts).toEqual([receipt]);
    expect(projection.attachments).toMatchObject([
      { id: attachment.id, status: "closed", outcome: "completed" },
    ]);
  });

  it("keeps only unresolved executor starts pending and clears them by matching facts", () => {
    const first = {
      id: "command-start-a",
      sessionId: session.id,
      createdAt: 1,
      route: { adapterId: "opencode", attachmentId: null },
      intent: {
        kind: "executor.start" as const,
        adapterId: "opencode",
        continuity: "fresh" as const,
      },
    };
    const second = {
      id: "command-start-b",
      sessionId: session.id,
      createdAt: 2,
      route: { adapterId: "claude", attachmentId: null },
      intent: {
        kind: "executor.start" as const,
        adapterId: "claude",
        continuity: "fresh" as const,
      },
    };
    const failedAttachment = {
      id: "attachment-start-a",
      sessionId: session.id,
      adapterId: "opencode",
      venue: localVenue,
      continuity: "fresh" as const,
      native: null,
    };
    const pending = projectSession(session, [
      event(1, { kind: "command.recorded", command: first }),
      event(2, { kind: "command.recorded", command: second }),
      {
        ...event(3, {
          kind: "attachment.failed",
          attachment: failedAttachment,
          failure: { code: "spawn_failed", detail: null, diagnostic: null },
        }),
        commandId: first.id,
      },
    ]);
    expect(pending).toMatchObject({ pendingExecutorStart: second });

    const openedAttachment = {
      ...failedAttachment,
      id: "attachment-start-b",
      adapterId: "claude",
    };
    const onlyFirstRemains = projectSession(session, [
      event(1, { kind: "command.recorded", command: first }),
      event(2, { kind: "command.recorded", command: second }),
      {
        ...event(3, { kind: "attachment.opened", attachment: openedAttachment }),
        commandId: second.id,
      },
    ]);
    expect(onlyFirstRemains).toMatchObject({ pendingExecutorStart: first });

    const settled = projectSession(session, [
      event(1, { kind: "command.recorded", command: first }),
      event(2, { kind: "command.recorded", command: second }),
      {
        ...event(3, {
          kind: "attachment.failed",
          attachment: failedAttachment,
          failure: { code: "spawn_failed", detail: null, diagnostic: null },
        }),
        commandId: first.id,
      },
      event(4, {
        kind: "command.receipt.recorded",
        receipt: {
          id: "receipt-start-b-rejected",
          commandId: second.id,
          status: "rejected",
          code: "adapter_rejected",
          detail: null,
          recordedAt: 4,
          sequence: 4,
        },
      }),
    ]);
    expect(settled).toMatchObject({ pendingExecutorStart: null });
  });
});

describe("sameSessionCommand", () => {
  it("keeps a create command owned by the Session it created", () => {
    const created = {
      id: "command-create",
      sessionId: session.id,
      createdAt: 1,
      route: null,
      intent: {
        kind: "session.create" as const,
        projectId: session.projectId,
        ticketId: session.ticketId,
        title: session.title,
      },
    };

    expect(created.sessionId).toBe(session.id);
    expect(sameSessionCommand(created, { ...created })).toBe(true);
    expect(sameSessionCommand(created, { ...created, sessionId: "other-session" })).toBe(false);
  });

  it("compares id, target and semantic intent while ignoring object-key order", () => {
    const left = {
      id: "command-1",
      sessionId: "session-1",
      createdAt: 1,
      route: { adapterId: "opencode", attachmentId: "attachment-1" },
      intent: {
        kind: "message.submit" as const,
        reference: { id: "message-1", mediaType: "text/plain", digest: "sha256:1" },
      },
    };
    expect(sameSessionCommand(left, { ...left, createdAt: 2 })).toBe(true);
    expect(sameSessionCommand(left, { ...left, id: "command-2" })).toBe(false);
    expect(sameSessionCommand(left, { ...left, sessionId: "session-2" })).toBe(false);
    expect(
      sameSessionCommand(left, {
        ...left,
        route: { adapterId: "opencode", attachmentId: "attachment-2" },
      }),
    ).toBe(false);
    expect(
      sameSessionCommand(left, {
        ...left,
        intent: {
          kind: "message.submit",
          reference: { digest: "sha256:1", id: "message-1", mediaType: "text/plain" },
        },
      }),
    ).toBe(true);
    expect(
      sameSessionCommand(left, {
        ...left,
        intent: {
          kind: "message.submit",
          reference: { id: "message-2", mediaType: "text/plain", digest: "sha256:1" },
        },
      }),
    ).toBe(false);
  });
});

describe("sameSessionCommandRequest", () => {
  it("compares caller intent for an existing Session without a durable route", () => {
    const command = {
      id: "command-1",
      sessionId: session.id,
      createdAt: 1,
      route: { adapterId: "opencode", attachmentId: "attachment-1" },
      intent: {
        kind: "message.submit" as const,
        reference: { id: "message-1", mediaType: "text/plain", digest: "sha256:1" },
      },
    };
    const request = {
      id: command.id,
      sessionId: command.sessionId,
      intent: command.intent,
    };

    expect(sameSessionCommandRequest(command, request)).toBe(true);
    expect(sameSessionCommandRequest(command, { ...request, id: "command-2" })).toBe(false);
    expect(sameSessionCommandRequest(command, { ...request, sessionId: "session-2" })).toBe(false);
    expect(
      sameSessionCommandRequest(command, {
        ...request,
        intent: {
          kind: "message.submit",
          reference: { id: "message-2", mediaType: "text/plain", digest: "sha256:1" },
        },
      }),
    ).toBe(false);
  });
});

describe("sameCommandReceipt", () => {
  it("compares durable receipt content rather than acceptance status alone", () => {
    const accepted = {
      id: "receipt-1",
      commandId: "command-1",
      status: "accepted" as const,
      acceptedAt: 1,
      recordedAt: 1,
      sequence: 1,
      result: { kind: "message.submitted" as const, sessionId: session.id },
    };
    expect(sameCommandReceipt(accepted, { ...accepted })).toBe(true);
    expect(sameCommandReceipt(accepted, { ...accepted, id: "receipt-2" })).toBe(false);
    expect(
      sameCommandReceiptOutcome(accepted, {
        id: accepted.id,
        commandId: accepted.commandId,
        status: accepted.status,
        acceptedAt: accepted.acceptedAt,
        result: accepted.result,
      }),
    ).toBe(true);
    expect(
      sameCommandReceiptOutcome(accepted, {
        id: accepted.id,
        commandId: accepted.commandId,
        status: "completed",
        result: accepted.result,
      }),
    ).toBe(false);
  });
});

describe("sameSessionEventPayload", () => {
  it("compares semantic event content independent of object-key order", () => {
    const left = {
      kind: "adapter.observed" as const,
      attachmentId: null,
      name: "signal",
      native: { source: "hook", retries: 1 },
    };
    expect(
      sameSessionEventPayload(left, {
        kind: "adapter.observed",
        attachmentId: null,
        name: "signal",
        native: { retries: 1, source: "hook" },
      }),
    ).toBe(true);
    expect(sameSessionEventPayload(left, { ...left, name: "different" })).toBe(false);
    expect(
      sameSessionEventPayload(
        { ...left, native: [null, true, 1] },
        { ...left, native: [null, true, 1] },
      ),
    ).toBe(true);
  });
});

describe("sameSessionEventProvenance", () => {
  it("compares source and venue provenance independent of object-key order", () => {
    expect(
      sameSessionEventProvenance(
        {
          source: { kind: "adapter", id: "claude", detail: { first: 1, second: 2 } },
          venue: localVenue,
        },
        {
          source: { kind: "adapter", id: "claude", detail: { second: 2, first: 1 } },
          venue: localVenue,
        },
      ),
    ).toBe(true);
    expect(
      sameSessionEventProvenance(systemProvenance, {
        ...systemProvenance,
        source: { ...systemProvenance.source, id: "other" },
      }),
    ).toBe(false);
  });
});
