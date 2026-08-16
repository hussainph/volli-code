import { describe, expect, it } from "vite-plus/test";
import {
  assertSession,
  assertSessionEvent,
  parseRendererSessionEvent,
  scrubSessionCommand,
  scrubSessionEvent,
  scrubSessionEventPayload,
  scrubSessionEventProvenance,
  scrubSessionInteraction,
  decodeCommandReceipt,
  decodeSessionCommand,
  decodeSessionCommandIntent,
  decodeSessionCommandRoute,
  decodeSessionEventPayload,
  decodeSessionEventProvenance,
  encodeSessionJson,
  UnknownSessionEventKindError,
} from "./session-event-codec";
import type {
  CommandReceipt,
  Session,
  SessionAttachment,
  SessionCommand,
  SessionEvent,
  SessionEventPayload,
  SessionEventProvenance,
  SessionInteraction,
} from "./session-ledger";

const provenance: SessionEventProvenance = {
  source: { kind: "system", id: "desktop", detail: null },
  venue: { id: "local", kind: "local" },
};

const session: Session = {
  id: "session-1",
  projectId: "project-1",
  ticketId: null,
  title: "One",
  createdAt: 100,
};

const attachment: SessionAttachment = {
  id: "attachment-1",
  sessionId: "session-1",
  adapterId: "pi",
  venue: { id: "local", kind: "local" },
  continuity: "fresh",
  native: { id: "native-1", detail: { runtime: "session" } },
};

const interaction: SessionInteraction = {
  id: "ask:tool-1",
  attachmentId: "attachment-1",
  kind: "permission",
  title: "Allow write?",
  detail: null,
  options: [
    { id: "once", label: "Allow once", description: null },
    { id: "reject", label: "Reject", description: "Refuse this request" },
  ],
  multiple: false,
  native: { id: "native-permission-1", detail: null },
};

const command: SessionCommand = {
  id: "command-1",
  sessionId: "session-1",
  createdAt: 100,
  intent: { kind: "executor.start", adapterId: "pi", continuity: "fresh" },
  route: { adapterId: "pi", attachmentId: null },
};

const receipt: CommandReceipt = {
  id: "receipt-1",
  commandId: "command-1",
  status: "accepted",
  acceptedAt: 101,
  recordedAt: 102,
  sequence: 2,
  result: { kind: "executor.start.requested", sessionId: "session-1" },
};

/** Encode, re-parse from the persisted text, decode: the exact durable round trip. */
function roundTrip(payload: SessionEventPayload): SessionEventPayload {
  return decodeSessionEventPayload(JSON.parse(encodeSessionJson(payload)), "payload");
}

describe("decodeSessionEventPayload round-trips every durable kind", () => {
  const payloads: SessionEventPayload[] = [
    { kind: "command.recorded", command },
    {
      kind: "command.recorded",
      command: { ...command, intent: { kind: "session.archive" }, route: null },
    },
    { kind: "session.created", session },
    { kind: "session.created", session: { ...session, ticketId: "ticket-1", title: null } },
    { kind: "session.archived" },
    { kind: "session.retitled", title: "Renamed" },
    { kind: "session.retitled", title: null },
    {
      kind: "model.selected",
      selection: { providerId: "openai", modelId: "gpt-5", reasoningLevel: "high" },
    },
    { kind: "session.input.recorded", input: { kind: "runtime-brief", text: "brief" } },
    { kind: "session.signaled", signal: "done", reason: null },
    { kind: "session.signaled", signal: "blocked", reason: "stuck" },
    { kind: "attachment.opened", attachment },
    { kind: "attachment.opened", attachment: { ...attachment, native: null } },
    {
      kind: "attachment.native_referenced",
      attachmentId: "attachment-1",
      native: { id: null, detail: null },
    },
    {
      kind: "attachment.failed",
      attachment,
      failure: { code: "spawn", detail: "no binary", diagnostic: { stderr: "boom" } },
    },
    {
      kind: "attachment.failed",
      attachment,
      failure: { code: "spawn", detail: null, diagnostic: null },
    },
    { kind: "attachment.closed", attachmentId: "attachment-1", outcome: "completed" },
    { kind: "run.started", attachmentId: "attachment-1", runId: "run-1" },
    { kind: "run.completed", attachmentId: "attachment-1", runId: "run-1" },
    { kind: "turn.started", attachmentId: "attachment-1", turnId: "turn-1" },
    { kind: "turn.completed", attachmentId: "attachment-1", turnId: "turn-1" },
    { kind: "turn.interrupted", attachmentId: "attachment-1", turnId: "turn-1" },
    {
      kind: "transcript.referenced",
      attachmentId: null,
      turnId: null,
      reference: { id: "sha256:a", mediaType: null, digest: null },
    },
    {
      kind: "transcript.referenced",
      attachmentId: "attachment-1",
      turnId: "turn-1",
      reference: { id: "sha256:a", mediaType: "text/plain", digest: "sha256:a" },
    },
    {
      kind: "attention.raised",
      attention: {
        kind: "rate_limited",
        id: "attention-1",
        attachmentId: "attachment-1",
        detail: "slow down",
        diagnostic: { status: 429 },
        retryAt: 200,
      },
    },
    {
      kind: "attention.raised",
      attention: {
        kind: "rate_limited",
        id: "attention-1",
        attachmentId: null,
        detail: null,
        diagnostic: null,
        retryAt: null,
      },
    },
    {
      kind: "attention.raised",
      attention: {
        kind: "quota_exhausted",
        id: "attention-2",
        attachmentId: null,
        detail: null,
        diagnostic: null,
        resetAt: 300,
      },
    },
    {
      kind: "attention.raised",
      attention: {
        kind: "quota_exhausted",
        id: "attention-2",
        attachmentId: null,
        detail: null,
        diagnostic: null,
        resetAt: null,
      },
    },
    {
      kind: "attention.raised",
      attention: {
        kind: "auth_required",
        id: "attention-3",
        attachmentId: null,
        detail: null,
        diagnostic: null,
      },
    },
    { kind: "attention.cleared", attentionId: "attention-1" },
    { kind: "interaction.opened", interaction },
    {
      kind: "interaction.opened",
      interaction: {
        ...interaction,
        kind: "question",
        prompts: [
          {
            id: "prompt:0",
            label: "Which files?",
            detail: "Pick all that apply",
            options: [{ id: "src", label: "src", description: null }],
            multiple: true,
            custom: false,
          },
          {
            id: "prompt:1",
            label: "Anything else?",
            detail: null,
            options: [{ id: "no", label: "No", description: "Nothing further" }],
            multiple: false,
            custom: true,
          },
        ],
      },
    },
    {
      kind: "interaction.resolved",
      attachmentId: "attachment-1",
      interactionId: "ask:tool-1",
      resolution: { optionIds: ["once"], response: null },
    },
    {
      kind: "interaction.resolved",
      attachmentId: "attachment-1",
      interactionId: "ask:tool-1",
      resolution: {
        optionIds: ["src", "no"],
        response: "text",
        answers: [
          { promptId: "prompt:0", optionIds: ["src"], response: null },
          { promptId: "prompt:1", optionIds: ["no"], response: "nothing further" },
        ],
      },
    },
    {
      kind: "interaction.cancelled",
      attachmentId: "attachment-1",
      interactionId: "ask:tool-1",
      reason: "abandoned",
    },
    { kind: "command.receipt.recorded", receipt },
    {
      kind: "command.receipt.recorded",
      receipt: {
        id: "receipt-2",
        commandId: "command-1",
        status: "rejected",
        code: "route.mismatch",
        detail: "stale attachment",
        recordedAt: 103,
        sequence: 3,
      },
    },
    {
      kind: "command.receipt.recorded",
      receipt: {
        id: "receipt-3",
        commandId: "command-1",
        status: "completed",
        result: { kind: "session.retitled", sessionId: "session-1" },
        recordedAt: 104,
        sequence: 4,
      },
    },
    {
      kind: "command.receipt.recorded",
      receipt: {
        id: "receipt-4",
        commandId: "command-1",
        status: "unreconciled",
        detail: null,
        recordedAt: 105,
        sequence: 5,
      },
    },
    {
      kind: "authority.denied",
      attachmentId: "attachment-1",
      turnId: null,
      tool: "bash",
      cause: "command.destructive-removal",
      reason: "rm -rf ~ discards more than this Session's workspace.",
    },
    { kind: "adapter.observed", attachmentId: null, name: "session-wide", native: null },
    {
      kind: "adapter.observed",
      attachmentId: "attachment-1",
      name: "message",
      native: { parts: [true, 1, "text"] },
    },
  ];

  for (const payload of payloads) {
    it(`round-trips ${payload.kind}${"attention" in payload ? ` (${payload.attention.kind})` : ""}${"receipt" in payload ? ` (${payload.receipt.status})` : ""}`, () => {
      expect(roundTrip(payload)).toEqual(payload);
    });
  }

  it("round-trips every command intent kind through command.recorded", () => {
    const intents: SessionCommand["intent"][] = [
      { kind: "session.create", projectId: "project-1", ticketId: "ticket-1", title: "One" },
      { kind: "session.create", projectId: "project-1", ticketId: null, title: null },
      { kind: "session.archive" },
      { kind: "session.retitle", title: null },
      { kind: "session.signal", signal: "done", reason: null },
      {
        kind: "model.select",
        selection: { providerId: "openai", modelId: "gpt-5", reasoningLevel: "low" },
      },
      { kind: "executor.start", adapterId: "pi", continuity: "fresh" },
      { kind: "executor.stop", attachmentId: "attachment-1" },
      { kind: "executor.interrupt", attachmentId: "attachment-1" },
      { kind: "executor.retry", attachmentId: "attachment-1" },
      {
        kind: "message.submit",
        reference: { id: "sha256:m", mediaType: null, digest: null },
      },
      {
        kind: "interaction.resolve",
        attachmentId: "attachment-1",
        interactionId: "ask:tool-1",
        resolution: { optionIds: ["once"], response: null },
        reference: { id: "sha256:r", mediaType: null, digest: null },
      },
    ];
    for (const intent of intents) {
      const withRoute: SessionCommand = {
        ...command,
        intent,
        route: intent.kind === "session.create" ? null : command.route,
      };
      expect(roundTrip({ kind: "command.recorded", command: withRoute })).toEqual({
        kind: "command.recorded",
        command: withRoute,
      });
    }
  });

  it("keeps absent interaction prompts and resolution answers absent, not synthesized", () => {
    const opened = roundTrip({ kind: "interaction.opened", interaction });
    expect(opened.kind === "interaction.opened" && "prompts" in opened.interaction).toBe(false);
    const resolved = roundTrip({
      kind: "interaction.resolved",
      attachmentId: "attachment-1",
      interactionId: "ask:tool-1",
      resolution: { optionIds: [], response: null },
    });
    expect(resolved.kind === "interaction.resolved" && "answers" in resolved.resolution).toBe(
      false,
    );
  });

  it("reads an interaction option description that an older event never wrote", () => {
    const decoded = decodeSessionEventPayload(
      {
        kind: "interaction.opened",
        interaction: {
          ...interaction,
          options: [{ id: "once", label: "Allow once" }],
        },
      },
      "payload",
    );
    expect(
      decoded.kind === "interaction.opened" ? decoded.interaction.options[0]?.description : "read",
    ).toBeNull();
  });
});

const openedAttachment = (candidate: unknown) =>
  decodeSessionEventPayload({ kind: "attachment.opened", attachment: candidate }, "payload");

const resolved = (resolution: unknown) =>
  decodeSessionEventPayload(
    {
      kind: "interaction.resolved",
      attachmentId: "attachment-1",
      interactionId: "ask:tool-1",
      resolution,
    },
    "payload",
  );

describe("decodeSessionEventPayload tolerance and corruption", () => {
  it("raises the distinct unknown-kind signal for a retired kind", () => {
    let caught: unknown;
    try {
      decodeSessionEventPayload({ kind: "capabilities.retired" }, "payload");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnknownSessionEventKindError);
    expect((caught as UnknownSessionEventKindError).payloadKind).toBe("capabilities.retired");
    expect((caught as UnknownSessionEventKindError).message).toBe(
      "payload.kind is not a known Session event payload",
    );
  });

  it("fails loudly on a payload that is not an object or has no kind", () => {
    expect(() => decodeSessionEventPayload(null, "payload")).toThrow("payload must be an object");
    expect(() => decodeSessionEventPayload([], "payload")).toThrow("payload must be an object");
    expect(() => decodeSessionEventPayload("archived", "payload")).toThrow(
      "payload must be an object",
    );
    expect(() => decodeSessionEventPayload({ kind: 7 }, "payload")).toThrow(
      "payload.kind must be a string",
    );
  });

  it("fails loudly on malformed fields inside known kinds", () => {
    expect(() =>
      decodeSessionEventPayload({ kind: "session.retitled", title: 7 }, "payload"),
    ).toThrow("payload.title must be a string");
    expect(() =>
      decodeSessionEventPayload(
        { kind: "session.signaled", signal: "unexpected", reason: null },
        "payload",
      ),
    ).toThrow("payload.signal has an unsupported value");
    expect(() =>
      decodeSessionEventPayload(
        { kind: "session.input.recorded", input: { kind: "runtime-brief", text: 7 } },
        "payload",
      ),
    ).toThrow("payload.input.text must be an integer".replace("an integer", "a string"));
    expect(() =>
      decodeSessionEventPayload(
        {
          kind: "model.selected",
          selection: { providerId: "openai", modelId: "gpt-5", reasoningLevel: "extreme" },
        },
        "payload",
      ),
    ).toThrow("payload.selection.reasoningLevel has an unsupported value");
    expect(() =>
      decodeSessionEventPayload(
        {
          kind: "authority.denied",
          attachmentId: "attachment-1",
          turnId: null,
          tool: 7,
          cause: "cause",
          reason: "reason",
        },
        "payload",
      ),
    ).toThrow("payload.tool must be a string");
    expect(() =>
      decodeSessionEventPayload(
        {
          kind: "interaction.cancelled",
          attachmentId: "attachment-1",
          interactionId: "ask:tool-1",
          reason: "resolved",
        },
        "payload",
      ),
    ).toThrow("payload.reason has an unsupported value");
  });

  it("rejects a malformed session entity inside session.created", () => {
    expect(() =>
      decodeSessionEventPayload(
        { kind: "session.created", session: { ...session, id: "" } },
        "payload",
      ),
    ).toThrow("payload.session is not a valid Session");
    expect(() =>
      decodeSessionEventPayload(
        { kind: "session.created", session: { ...session, createdAt: 1.5 } },
        "payload",
      ),
    ).toThrow("payload.session.createdAt must be an integer");
  });

  it("rejects a malformed attachment", () => {
    expect(() => openedAttachment({ ...attachment, id: "" })).toThrow(
      "payload.attachment is not a valid Session attachment",
    );
    expect(() => openedAttachment({ ...attachment, sessionId: "" })).toThrow(
      "payload.attachment is not a valid Session attachment",
    );
    expect(() => openedAttachment({ ...attachment, adapterId: "" })).toThrow(
      "payload.attachment is not a valid Session attachment",
    );
    expect(() => openedAttachment({ ...attachment, venue: { id: "", kind: "local" } })).toThrow(
      "payload.attachment is not a valid Session attachment",
    );
    expect(() =>
      openedAttachment({ ...attachment, venue: { id: "local", kind: "orbital" } }),
    ).toThrow("payload.attachment.venue.kind has an unsupported value");
    expect(() => openedAttachment({ ...attachment, continuity: "teleport" })).toThrow(
      "payload.attachment.continuity has an unsupported value",
    );
    expect(() => openedAttachment({ ...attachment, native: { id: 7, detail: null } })).toThrow(
      "payload.attachment.native.id must be a string",
    );
  });

  it("rejects malformed attention, prompts, and answers", () => {
    expect(() =>
      decodeSessionEventPayload(
        { kind: "attention.raised", attention: { kind: "not-a-kind" } },
        "payload",
      ),
    ).toThrow("payload.attention.kind has an unsupported value");
    expect(() =>
      decodeSessionEventPayload(
        {
          kind: "attention.raised",
          attention: {
            kind: "rate_limited",
            id: "attention-1",
            attachmentId: null,
            detail: null,
            diagnostic: null,
            retryAt: "soon",
          },
        },
        "payload",
      ),
    ).toThrow("payload.attention.retryAt must be an integer");
    const opened = (candidate: Record<string, unknown>) =>
      decodeSessionEventPayload(
        { kind: "interaction.opened", interaction: { ...interaction, ...candidate } },
        "payload",
      );
    expect(() => opened({ options: "once" })).toThrow(
      "payload.interaction.options must be an array",
    );
    expect(() =>
      opened({ options: [{ id: "once", label: "Allow once", description: 7 }] }),
    ).toThrow("payload.interaction.options[0].description must be a string");
    expect(() => opened({ multiple: "yes" })).toThrow(
      "payload.interaction.multiple must be a boolean",
    );
    expect(() => opened({ prompts: "prompt:0" })).toThrow(
      "payload.interaction.prompts must be an array",
    );
    expect(() => resolved({ optionIds: "once", response: null })).toThrow(
      "payload.resolution.optionIds must be an array",
    );
    expect(() => resolved({ optionIds: [7], response: null })).toThrow(
      "payload.resolution.optionIds[0] must be a string",
    );
    expect(() => resolved({ optionIds: [], response: null, answers: {} })).toThrow(
      "payload.resolution.answers must be an array",
    );
    expect(() =>
      resolved({
        optionIds: [],
        response: null,
        answers: [{ promptId: "prompt:0", optionIds: "once", response: null }],
      }),
    ).toThrow("payload.resolution.answers[0].optionIds must be an array");
    expect(() =>
      resolved({
        optionIds: [],
        response: null,
        answers: [{ promptId: 0, optionIds: ["once"], response: null }],
      }),
    ).toThrow("payload.resolution.answers[0].promptId must be a string");
  });
});

describe("decodeSessionCommand and its parts", () => {
  it("round-trips through the persisted JSON form", () => {
    expect(decodeSessionCommand(JSON.parse(encodeSessionJson(command)), "command")).toEqual(
      command,
    );
  });

  it("rejects an empty command id after field decode", () => {
    expect(() => decodeSessionCommand({ ...command, id: "" }, "command")).toThrow(
      "command is not a valid Session command",
    );
  });

  it("rejects an unknown intent kind loudly — commands are not tolerant history", () => {
    expect(() => decodeSessionCommandIntent({ kind: "session.merge" }, "intent")).toThrow(
      "intent.kind is not a known Session command",
    );
    expect(() => decodeSessionCommandIntent({ kind: 7 }, "intent")).toThrow(
      "intent.kind must be a string",
    );
  });

  it("decodes a route with and without an attachment", () => {
    expect(decodeSessionCommandRoute({ adapterId: "pi", attachmentId: null }, "route")).toEqual({
      adapterId: "pi",
      attachmentId: null,
    });
    expect(
      decodeSessionCommandRoute({ adapterId: "pi", attachmentId: "attachment-1" }, "route"),
    ).toEqual({ adapterId: "pi", attachmentId: "attachment-1" });
  });
});

describe("decodeCommandReceipt", () => {
  it("rejects an unknown status", () => {
    expect(() => decodeCommandReceipt({ ...receipt, status: "maybe" }, "receipt")).toThrow(
      "receipt.status is not a known receipt status",
    );
  });

  it("rejects an unknown result kind", () => {
    expect(() =>
      decodeCommandReceipt(
        { ...receipt, result: { kind: "session.merged", sessionId: "session-1" } },
        "receipt",
      ),
    ).toThrow("receipt.result.kind has an unsupported value");
  });
});

describe("decodeSessionEventProvenance", () => {
  it("round-trips adapter and user sources, with and without a venue", () => {
    const adapter: SessionEventProvenance = {
      source: { kind: "adapter", id: "pi", detail: { pid: 42 } },
      venue: null,
    };
    expect(decodeSessionEventProvenance(JSON.parse(encodeSessionJson(adapter)), "prov")).toEqual(
      adapter,
    );
    expect(decodeSessionEventProvenance(JSON.parse(encodeSessionJson(provenance)), "prov")).toEqual(
      provenance,
    );
  });

  it("rejects unknown source and venue kinds", () => {
    expect(() =>
      decodeSessionEventProvenance(
        { source: { kind: "ghost", id: "x", detail: null }, venue: null },
        "prov",
      ),
    ).toThrow("prov.source.kind has an unsupported value");
    expect(() =>
      decodeSessionEventProvenance(
        { source: provenance.source, venue: { id: "local", kind: "orbital" } },
        "prov",
      ),
    ).toThrow("prov.venue.kind has an unsupported value");
  });
});

describe("assertSessionEvent (write-side parity)", () => {
  const event: SessionEvent = {
    id: "event-1",
    sessionId: "session-1",
    sequence: 1,
    occurredAt: 100,
    recordedAt: 100,
    provenance,
    payload: { kind: "session.archived" },
  };

  it("accepts a well-formed event", () => {
    expect(() => assertSessionEvent(event, "Session event")).not.toThrow();
  });

  it("rejects each envelope violation", () => {
    const violations: Partial<SessionEvent>[] = [
      { id: "" },
      { sessionId: "" },
      { sequence: 1.5 },
      { sequence: 0 },
      { occurredAt: 0.5 },
      { recordedAt: 0.5 },
    ];
    for (const violation of violations) {
      expect(() => assertSessionEvent({ ...event, ...violation }, "Session event")).toThrow(
        "Session event has an invalid envelope",
      );
    }
  });

  it("requires a receipt event's envelope to match its receipt", () => {
    const receiptEvent: SessionEvent = {
      ...event,
      id: "event-receipt",
      sequence: receipt.sequence,
      recordedAt: receipt.recordedAt,
      commandId: receipt.commandId,
      payload: { kind: "command.receipt.recorded", receipt },
    };
    expect(() => assertSessionEvent(receiptEvent, "Session event")).not.toThrow();
    const mismatches: Partial<SessionEvent>[] = [
      { commandId: "command-other" },
      { sequence: receipt.sequence + 1 },
      { recordedAt: receipt.recordedAt + 1 },
    ];
    for (const mismatch of mismatches) {
      expect(() => assertSessionEvent({ ...receiptEvent, ...mismatch }, "Session event")).toThrow(
        "Session event receipt envelope does not match receipt",
      );
    }
  });

  it("rejects what SQLite's JSON encode would: undefined-valued keys and non-finite numbers", () => {
    expect(() =>
      assertSessionEvent(
        {
          ...event,
          payload: {
            kind: "session.retitled",
            title: null,
            stray: undefined,
          } as unknown as SessionEventPayload,
        },
        "Session event",
      ),
    ).toThrow("Session event.payload.stray is not JSON-compatible");
    expect(() =>
      assertSessionEvent(
        {
          ...event,
          payload: {
            kind: "adapter.observed",
            attachmentId: null,
            name: "message",
            native: { tokens: Number.POSITIVE_INFINITY },
          },
        },
        "Session event",
      ),
    ).toThrow("payload.native.tokens contains a non-finite number");
  });
});

describe("assertSession", () => {
  it("accepts a valid Session and rejects each falsy field", () => {
    expect(() => assertSession(session, "Session")).not.toThrow();
    expect(() => assertSession({ ...session, id: "" }, "Session")).toThrow(
      "Session is not a valid Session",
    );
    expect(() => assertSession({ ...session, projectId: "" }, "Session")).toThrow(
      "Session is not a valid Session",
    );
    expect(() => assertSession({ ...session, createdAt: 0.5 }, "Session")).toThrow(
      "Session is not a valid Session",
    );
  });
});

describe("encodeSessionJson", () => {
  it("encodes plain canonical JSON without re-ordering keys", () => {
    expect(encodeSessionJson({ b: 1, a: [true, "x", null] })).toBe('{"b":1,"a":[true,"x",null]}');
  });

  it("rejects non-JSON-safe values loudly", () => {
    expect(() => encodeSessionJson(undefined)).toThrow("JSON value is not JSON-compatible");
    expect(() => encodeSessionJson({ run: () => 1 })).toThrow(
      "JSON value.run is not JSON-compatible",
    );
    expect(() => encodeSessionJson([Number.NaN])).toThrow(
      "JSON value[0] contains a non-finite number",
    );
  });
});

describe("the renderer-safe scrub", () => {
  it("strips executor identity and the recovery locator from attachments", () => {
    const scrubbed = scrubSessionEventPayload({ kind: "attachment.opened", attachment });
    expect(scrubbed).toEqual({
      kind: "attachment.opened",
      attachment: {
        id: "attachment-1",
        sessionId: "session-1",
        venue: { id: "local", kind: "local" },
        continuity: "fresh",
      },
    });
    expect(scrubbed.kind === "attachment.opened" && "adapterId" in scrubbed.attachment).toBe(false);
    expect(scrubbed.kind === "attachment.opened" && "native" in scrubbed.attachment).toBe(false);
  });

  it("nulls a failure's diagnostic beside its scrubbed attachment", () => {
    const scrubbed = scrubSessionEventPayload({
      kind: "attachment.failed",
      attachment,
      failure: { code: "spawn", detail: "no binary", diagnostic: { stderr: "boom" } },
    });
    expect(scrubbed).toMatchObject({
      kind: "attachment.failed",
      failure: { code: "spawn", detail: "no binary", diagnostic: null },
    });
  });

  it("nulls native references, attention diagnostics, and adapter observations", () => {
    expect(
      scrubSessionEventPayload({
        kind: "attachment.native_referenced",
        attachmentId: "attachment-1",
        native: { id: "native-1", detail: { path: "/tmp/session" } },
      }),
    ).toEqual({
      kind: "attachment.native_referenced",
      attachmentId: "attachment-1",
      native: { id: null, detail: null },
    });
    expect(
      scrubSessionEventPayload({
        kind: "attention.raised",
        attention: {
          kind: "rate_limited",
          id: "attention-1",
          attachmentId: null,
          detail: "slow down",
          diagnostic: { status: 429 },
          retryAt: 200,
        },
      }),
    ).toEqual({
      kind: "attention.raised",
      // The arm keeps its own fields; only the diagnostic goes.
      attention: {
        kind: "rate_limited",
        id: "attention-1",
        attachmentId: null,
        detail: "slow down",
        diagnostic: null,
        retryAt: 200,
      },
    });
    expect(
      scrubSessionEventPayload({
        kind: "adapter.observed",
        attachmentId: null,
        name: "message",
        native: { parts: ["text"] },
      }),
    ).toEqual({ kind: "adapter.observed", attachmentId: null, name: "message", native: null });
  });

  it("nulls an interaction's native reference and keeps its prompts", () => {
    const scrubbed = scrubSessionInteraction({
      ...interaction,
      prompts: [
        {
          id: "prompt:0",
          label: "Allow write?",
          detail: null,
          options: interaction.options,
          multiple: false,
          custom: false,
        },
      ],
    });
    expect(scrubbed.native).toEqual({ id: null, detail: null });
    expect(scrubbed.prompts).toHaveLength(1);
    expect(scrubbed.options).toEqual(interaction.options);
  });

  it("strips adapterId from an executor.start intent and its route, and only there", () => {
    const scrubbed = scrubSessionEventPayload({ kind: "command.recorded", command });
    expect(scrubbed).toEqual({
      kind: "command.recorded",
      command: {
        id: "command-1",
        sessionId: "session-1",
        createdAt: 100,
        intent: { kind: "executor.start", continuity: "fresh" },
        route: { attachmentId: null },
      },
    });
    const retitle = scrubSessionCommand({
      ...command,
      intent: { kind: "session.retitle", title: "Renamed" },
      route: null,
    });
    expect(retitle.intent).toEqual({ kind: "session.retitle", title: "Renamed" });
    expect(retitle.route).toBeNull();
  });

  it("passes every kind without adapter-native detail through untouched", () => {
    const identity: SessionEventPayload[] = [
      { kind: "session.created", session },
      { kind: "session.archived" },
      { kind: "session.retitled", title: "Renamed" },
      {
        kind: "model.selected",
        selection: { providerId: "openai", modelId: "gpt-5", reasoningLevel: "high" },
      },
      { kind: "session.input.recorded", input: { kind: "runtime-brief", text: "brief" } },
      { kind: "session.signaled", signal: "done", reason: null },
      { kind: "attachment.closed", attachmentId: "attachment-1", outcome: "completed" },
      { kind: "run.started", attachmentId: "attachment-1", runId: "run-1" },
      { kind: "run.completed", attachmentId: "attachment-1", runId: "run-1" },
      { kind: "turn.started", attachmentId: "attachment-1", turnId: "turn-1" },
      { kind: "turn.completed", attachmentId: "attachment-1", turnId: "turn-1" },
      { kind: "turn.interrupted", attachmentId: "attachment-1", turnId: "turn-1" },
      {
        kind: "transcript.referenced",
        attachmentId: null,
        turnId: null,
        reference: { id: "sha256:a", mediaType: null, digest: null },
      },
      { kind: "attention.cleared", attentionId: "attention-1" },
      {
        kind: "interaction.resolved",
        attachmentId: "attachment-1",
        interactionId: "ask:tool-1",
        resolution: { optionIds: ["once"], response: null },
      },
      {
        kind: "interaction.cancelled",
        attachmentId: "attachment-1",
        interactionId: "ask:tool-1",
        reason: "abandoned",
      },
      { kind: "command.receipt.recorded", receipt },
      // Volli's own vocabulary already, not a harness's.
      {
        kind: "authority.denied",
        attachmentId: "attachment-1",
        turnId: null,
        tool: "bash",
        cause: "command.destructive-removal",
        reason: "refused",
      },
      { kind: "interaction.opened", interaction },
    ];
    for (const payload of identity) {
      const scrubbed = scrubSessionEventPayload(payload);
      if (payload.kind === "interaction.opened") continue; // asserted above
      expect(scrubbed).toEqual(payload);
    }
  });

  it("rewrites adapter provenance to a system source and keeps the rest", () => {
    const event: SessionEvent = {
      id: "event-1",
      sessionId: "session-1",
      sequence: 1,
      occurredAt: 100,
      recordedAt: 100,
      provenance: {
        source: { kind: "adapter", id: "pi", detail: { pid: 42 } },
        venue: { id: "local", kind: "local" },
      },
      payload: { kind: "attachment.opened", attachment },
    };
    const scrubbed = scrubSessionEvent(event);
    expect(scrubbed.provenance).toEqual({
      source: { kind: "system", id: "session-runtime", detail: null },
      venue: { id: "local", kind: "local" },
    });
    expect(scrubbed.payload.kind).toBe("attachment.opened");
    expect(
      scrubSessionEventProvenance({
        source: { kind: "user", id: "person", detail: null },
        venue: null,
      }),
    ).toEqual({ source: { kind: "user", id: "person", detail: null }, venue: null });
  });
});

function rendererEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "event-1",
    sessionId: "session-1",
    sequence: 1,
    occurredAt: 100,
    recordedAt: 100,
    provenance: { source: { kind: "system", id: "session-runtime", detail: null }, venue: null },
    payload: { kind: "turn.started", attachmentId: "attachment-1", turnId: "turn-1" },
    ...overrides,
  };
}

describe("the renderer-side parse", () => {
  it("round-trips what the edge ships: scrub, JSON, parse", () => {
    const durable: SessionEvent = {
      id: "event-1",
      sessionId: "session-1",
      sequence: 1,
      occurredAt: 100,
      recordedAt: 100,
      attachmentId: "attachment-1",
      provenance: {
        source: { kind: "adapter", id: "pi", detail: { pid: 42 } },
        venue: { id: "local", kind: "local" },
      },
      payload: { kind: "attachment.opened", attachment },
    };
    const shipped = scrubSessionEvent(durable);
    const parsed = parseRendererSessionEvent(JSON.parse(encodeSessionJson(shipped)), "event");
    expect(parsed).toEqual({ ok: true, event: shipped });
  });

  it("parses every scrubbed kind the table publishes", () => {
    // The kinds whose scrub removes keys carry their own renderer decode;
    // everything else parses through scrub(decode(…)). Both paths, per kind.
    const durables: SessionEventPayload[] = [
      { kind: "command.recorded", command },
      {
        kind: "command.recorded",
        command: { ...command, intent: { kind: "session.retitle", title: null }, route: null },
      },
      { kind: "attachment.opened", attachment },
      {
        kind: "attachment.failed",
        attachment,
        failure: { code: "spawn", detail: null, diagnostic: { stderr: "boom" } },
      },
      {
        kind: "attachment.native_referenced",
        attachmentId: "attachment-1",
        native: { id: "native-1", detail: null },
      },
      { kind: "interaction.opened", interaction },
      { kind: "session.archived" },
    ];
    for (const durable of durables) {
      const shipped = scrubSessionEventPayload(durable);
      const parsed = parseRendererSessionEvent(
        rendererEvent({ payload: JSON.parse(encodeSessionJson(shipped)) }),
        "event",
      );
      expect(parsed.ok ? parsed.event.payload : parsed).toEqual(shipped);
    }
  });

  it("answers an unknown kind with the distinct tolerant arm, not an error", () => {
    expect(
      parseRendererSessionEvent(
        rendererEvent({ payload: { kind: "capabilities.retired" } }),
        "event",
      ),
    ).toEqual({ ok: false, reason: "unknown-kind", kind: "capabilities.retired" });
  });

  it("answers corruption of a known kind with the loud arm", () => {
    expect(
      parseRendererSessionEvent(
        rendererEvent({ payload: { kind: "turn.started", attachmentId: "a", turnId: 7 } }),
        "event",
      ),
    ).toEqual({
      ok: false,
      reason: "malformed",
      message: "event.payload.turnId must be a string",
    });
    expect(parseRendererSessionEvent(null, "event")).toEqual({
      ok: false,
      reason: "malformed",
      message: "event must be an object",
    });
    expect(parseRendererSessionEvent(rendererEvent({ sequence: 0 }), "event")).toEqual({
      ok: false,
      reason: "malformed",
      message: "event has an invalid envelope",
    });
    expect(parseRendererSessionEvent(rendererEvent({ id: "" }), "event")).toEqual({
      ok: false,
      reason: "malformed",
      message: "event has an invalid envelope",
    });
    expect(parseRendererSessionEvent(rendererEvent({ sessionId: "" }), "event")).toEqual({
      ok: false,
      reason: "malformed",
      message: "event has an invalid envelope",
    });
  });

  it("keeps optional envelope correlation ids, absent either way", () => {
    const bare = parseRendererSessionEvent(rendererEvent(), "event");
    expect(bare.ok && "attachmentId" in bare.event).toBe(false);
    expect(bare.ok && "commandId" in bare.event).toBe(false);
    const correlated = parseRendererSessionEvent(
      rendererEvent({ attachmentId: "attachment-1", commandId: "command-1" }),
      "event",
    );
    expect(correlated.ok ? correlated.event.attachmentId : null).toBe("attachment-1");
    expect(correlated.ok ? correlated.event.commandId : null).toBe("command-1");
    // Explicit nulls decode back to absence, like the SQLite row read.
    const nulled = parseRendererSessionEvent(
      rendererEvent({ attachmentId: null, commandId: null }),
      "event",
    );
    expect(nulled.ok && "attachmentId" in nulled.event).toBe(false);
  });

  it("re-scrubs on read: a leaked adapter source, native id or adapterId never survives", () => {
    const leakedProvenance = parseRendererSessionEvent(
      rendererEvent({
        provenance: { source: { kind: "adapter", id: "pi", detail: { pid: 42 } }, venue: null },
      }),
      "event",
    );
    expect(leakedProvenance.ok ? leakedProvenance.event.provenance.source : null).toEqual({
      kind: "system",
      id: "session-runtime",
      detail: null,
    });
    const leakedNative = parseRendererSessionEvent(
      rendererEvent({
        payload: {
          kind: "interaction.opened",
          interaction: { ...interaction, native: { id: "leaked", detail: { path: "/tmp" } } },
        },
      }),
      "event",
    );
    expect(
      leakedNative.ok && leakedNative.event.payload.kind === "interaction.opened"
        ? leakedNative.event.payload.interaction.native
        : null,
    ).toEqual({ id: null, detail: null });
    // An executor.start intent that still carries adapterId loses it on read.
    const leakedIntent = parseRendererSessionEvent(
      rendererEvent({
        payload: { kind: "command.recorded", command: { ...command, route: null } },
      }),
      "event",
    );
    expect(
      leakedIntent.ok && leakedIntent.event.payload.kind === "command.recorded"
        ? leakedIntent.event.payload.command.intent
        : null,
    ).toEqual({ kind: "executor.start", continuity: "fresh" });
  });

  it("rejects a malformed renderer-safe command or attachment", () => {
    const parse = (payload: unknown) =>
      parseRendererSessionEvent(rendererEvent({ payload }), "event");
    expect(parse({ kind: "command.recorded", command: { ...command, id: "" } })).toEqual({
      ok: false,
      reason: "malformed",
      message: "event.payload.command is not a valid Session command",
    });
    expect(
      parse({
        kind: "command.recorded",
        command: { ...command, route: { attachmentId: 7 } },
      }),
    ).toEqual({
      ok: false,
      reason: "malformed",
      message: "event.payload.command.route.attachmentId must be a string",
    });
    const scrubbed = scrubSessionEventPayload({ kind: "attachment.opened", attachment });
    const shippedAttachment =
      scrubbed.kind === "attachment.opened" ? scrubbed.attachment : undefined;
    expect(
      parse({ kind: "attachment.opened", attachment: { ...shippedAttachment, id: "" } }),
    ).toEqual({
      ok: false,
      reason: "malformed",
      message: "event.payload.attachment is not a valid Session attachment",
    });
    expect(
      parse({
        kind: "attachment.opened",
        attachment: { ...shippedAttachment, venue: { id: "", kind: "local" } },
      }),
    ).toEqual({
      ok: false,
      reason: "malformed",
      message: "event.payload.attachment is not a valid Session attachment",
    });
    expect(
      parse({
        kind: "attachment.opened",
        attachment: { ...shippedAttachment, sessionId: "" },
      }),
    ).toEqual({
      ok: false,
      reason: "malformed",
      message: "event.payload.attachment is not a valid Session attachment",
    });
  });
});
