import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  CATALOG_ENTRIES,
  BOARD_ENTRIES,
  HOST_WORKSPACE_ENTRIES,
  scrubSessionEvent,
  SESSION_PROJECTION_EVENT_KINDS,
} from "@volli/shared";
import type { CommandReceipt, SessionEventPayload } from "@volli/shared";
import type { SessionRuntime } from "@volli/session-engine";
import {
  createSessionRouter,
  LOCAL_DESKTOP_CALLER,
  RpcDiagnosticLog,
  sessionProcedureSchemas,
  sessionCommandOutputSchema,
  sessionProjectionOutputSchema,
  sessionSnapshotOutputSchema,
  type AppRouter,
} from "./index";
import { sessionHandlersFrom } from "./session-handlers.test-support";
import {
  followUpItemWireSchema,
  frameSchema,
  legacyStreamEmissionSchema,
  legacyStreamEmissionWireSchema,
  receiptSchema,
  streamEmissionSchema,
  streamEmissionWireSchema,
  uiMessageWireSchema,
} from "./output-schema";

const session = {
  id: "session",
  projectId: "project",
  ticketId: null,
  role: "project" as const,
  parentSessionId: null,
  title: null,
  createdAt: 10,
};
const attachment = {
  id: "attachment",
  sessionId: "session",
  adapterId: "pi",
  venue: { id: "local", kind: "local" as const },
  continuity: "fresh" as const,
  native: { id: "native", detail: { path: "/private/recovery" } },
  authority: null,
};
const reference = { id: "artifact", digest: null, mediaType: null };
const interaction = {
  id: "ask",
  attachmentId: "attachment",
  kind: "permission" as const,
  title: "Allow?",
  detail: null,
  options: [{ id: "yes", label: "Yes", description: null }],
  multiple: false,
  native: attachment.native,
};
const receipt: CommandReceipt = {
  id: "receipt",
  commandId: "command",
  sequence: 2,
  recordedAt: 10,
  status: "accepted",
  acceptedAt: 10,
  result: { kind: "message.submitted", sessionId: "session" },
};
const payloads = {
  "command.recorded": {
    kind: "command.recorded",
    command: {
      id: "command",
      sessionId: "session",
      createdAt: 10,
      intent: { kind: "executor.start", adapterId: "pi", continuity: "fresh" },
      route: { adapterId: "pi", attachmentId: "attachment" },
    },
  },
  "session.created": { kind: "session.created", session },
  "session.archived": { kind: "session.archived" },
  "session.retitled": { kind: "session.retitled", title: "Title" },
  "model.selected": {
    kind: "model.selected",
    selection: { providerId: "provider", modelId: "model", reasoningLevel: "high" },
  },
  "session.input.recorded": {
    kind: "session.input.recorded",
    input: { kind: "tool-surface", tools: ["read"] },
  },
  "session.signaled": { kind: "session.signaled", signal: "done", reason: null },
  "session.stopped": { kind: "session.stopped", reason: null, by: { kind: "user" } },
  "attachment.opened": { kind: "attachment.opened", attachment },
  "attachment.native_referenced": {
    kind: "attachment.native_referenced",
    attachmentId: "attachment",
    native: attachment.native,
  },
  "attachment.failed": {
    kind: "attachment.failed",
    attachment,
    failure: { code: "failure", detail: null, diagnostic: null },
  },
  "attachment.closed": {
    kind: "attachment.closed",
    attachmentId: "attachment",
    outcome: "completed",
  },
  "attachment.exited": { kind: "attachment.exited", attachmentId: "attachment", exitCode: 0 },
  "run.started": { kind: "run.started", attachmentId: "attachment", runId: "run" },
  "run.completed": { kind: "run.completed", attachmentId: "attachment", runId: "run" },
  "turn.started": { kind: "turn.started", attachmentId: "attachment", turnId: "turn" },
  "turn.completed": { kind: "turn.completed", attachmentId: "attachment", turnId: "turn" },
  "turn.interrupted": { kind: "turn.interrupted", attachmentId: "attachment", turnId: "turn" },
  "context.compacted": {
    kind: "context.compacted",
    attachmentId: "attachment",
    reason: "manual",
    entryId: "entry",
    tokensBefore: 100,
    tokensAfter: 10,
  },
  "context.compaction_failed": {
    kind: "context.compaction_failed",
    attachmentId: "attachment",
    reason: "checkpoint",
    detail: "Missing",
  },
  "context.reasoning_dropped": {
    kind: "context.reasoning_dropped",
    attachmentId: "attachment",
    turnId: "turn",
    count: 1,
    causes: ["unknown"],
    paths: ["0"],
  },
  "transcript.referenced": {
    kind: "transcript.referenced",
    attachmentId: null,
    turnId: null,
    reference,
  },
  "attention.raised": {
    kind: "attention.raised",
    attention: {
      id: "attention",
      attachmentId: null,
      kind: "rate_limited",
      retryAt: 100,
      detail: null,
      diagnostic: { private: true },
    },
  },
  "attention.cleared": { kind: "attention.cleared", attentionId: "attention" },
  "interaction.opened": { kind: "interaction.opened", interaction },
  "interaction.resolved": {
    kind: "interaction.resolved",
    attachmentId: "attachment",
    interactionId: "ask",
    resolution: { optionIds: ["yes"], response: null },
  },
  "interaction.cancelled": {
    kind: "interaction.cancelled",
    attachmentId: "attachment",
    interactionId: "ask",
    reason: "abandoned",
  },
  "command.receipt.recorded": { kind: "command.receipt.recorded", receipt },
  "adapter.observed": {
    kind: "adapter.observed",
    attachmentId: null,
    name: "observation",
    native: { private: true },
  },
  "usage.recorded": {
    kind: "usage.recorded",
    attachmentId: null,
    turnId: null,
    attribution: { projectId: "project", ticketId: null },
    usage: {
      cause: "decision",
      providerId: "provider",
      modelId: "model",
      inputTokens: null,
      outputTokens: 1,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: 0,
      costBasis: "catalog-estimate",
    },
  },
} satisfies { [Kind in SessionEventPayload["kind"]]: Extract<SessionEventPayload, { kind: Kind }> };
function frame(payload: SessionEventPayload) {
  return {
    sessionId: "session",
    sequence: 2,
    transcript: null,
    event: scrubSessionEvent({
      id: "event",
      sessionId: "session",
      sequence: 2,
      occurredAt: 10,
      recordedAt: 10,
      provenance: { source: { kind: "adapter", id: "pi", detail: { private: true } }, venue: null },
      payload,
    }),
  };
}

function callerWithResults(input: { projection?: unknown; frames?: unknown; command?: unknown }) {
  const runtime = {
    projection: async () => ({ projection: input.projection ?? {}, throughSequence: 2 }),
    snapshot: async () => ({
      projection: input.projection ?? {},
      frames: input.frames ?? [],
      throughSequence: 2,
    }),
    command: async () => input.command,
  } as unknown as SessionRuntime;
  return createSessionRouter().createCaller({
    caller: LOCAL_DESKTOP_CALLER,
    handlers: sessionHandlersFrom({ runtime }),
    diagnostics: new RpcDiagnosticLog(),
  });
}

// Deliberately malformed introspection records; no fake handler can dispatch.
function malformedRouter(inputs: z.ZodType[]): AppRouter {
  return {
    _def: {
      procedures: {
        "future.procedure": { _def: { type: "query", inputs } },
      },
    },
  } as unknown as AppRouter;
}

function commandRouter(schema: z.ZodType | undefined): AppRouter {
  return {
    _def: {
      procedures: {
        "session.command": {
          _def: { type: "mutation", inputs: schema ? [schema] : [], output: z.null() },
        },
      },
    },
  } as unknown as AppRouter;
}

describe("publishable Session procedure schemas", () => {
  it("publishes every catalog entry, without unrepresentable fallback", () => {
    const schemas = sessionProcedureSchemas();
    expect(Object.keys(schemas).toSorted()).toEqual(
      CATALOG_ENTRIES.filter(
        ({ key }) =>
          ![...BOARD_ENTRIES, ...HOST_WORKSPACE_ENTRIES].some((entry) => entry.key === key),
      )
        .map(({ key }) => key)
        .toSorted(),
    );
    for (const schema of Object.values(schemas)) {
      expect(() => z.toJSONSchema(schema.input, { io: "input" })).not.toThrow();
      expect(() => z.toJSONSchema(schema.output)).not.toThrow();
    }
    expect(schemas["session.reconcile"]!.voidOutput).toBe(true);
    expect(schemas["modelAccess.defaults"]!.noInput).toBe(true);
    expect(schemas["session.subscribe"]!.type).toBe("subscription");
  });

  it("refuses ambiguous input chains and procedures without an output grammar", () => {
    expect(() => sessionProcedureSchemas(malformedRouter([z.string(), z.number()]))).toThrow(
      "Procedure future.procedure has multiple input schemas",
    );
    expect(() => sessionProcedureSchemas(malformedRouter([]))).toThrow(
      "Procedure future.procedure has no publishable output schema",
    );
  });

  it("derives command envelope constraints from the actual procedure input", () => {
    const input = z.object({
      commandId: z.string().max(8),
      sessionId: z.string(),
      added: z.boolean().optional(),
      command: z.discriminatedUnion("kind", [z.object({ kind: z.literal("session.stop") })]),
    });
    const document = z.toJSONSchema(
      sessionProcedureSchemas(commandRouter(input))["session.command"]!.input,
      { io: "input" },
    );
    expect(document.required).toContain("sessionId");
    expect(document.properties?.commandId).toMatchObject({ maxLength: 8 });
    expect(document.properties?.added).toMatchObject({ type: "boolean" });
    const malformedEdit = {
      _def: {
        procedures: {
          "session.editQueued": {
            _def: { type: "mutation", inputs: [z.string()], output: z.null() },
          },
        },
      },
    } as unknown as AppRouter;
    expect(() => sessionProcedureSchemas(malformedEdit)).toThrow(
      "session.editQueued needs a structural message envelope",
    );
    for (const unsupported of [undefined, z.string(), z.object({ command: z.string() })]) {
      expect(() => sessionProcedureSchemas(commandRouter(unsupported))).toThrow(
        "structural command envelope",
      );
    }
    const nonliteral = z.object({
      command: z.discriminatedUnion("kind", [z.object({ kind: z.enum(["a", "b"]) })]),
    });
    expect(() => sessionProcedureSchemas(commandRouter(nonliteral))).toThrow("literal kinds");
  });

  it("keeps the custom command input publication in parity with runtime accept/reject", () => {
    const router = createSessionRouter();
    // oxlint-disable-next-line no-underscore-dangle -- compare the actual parser, not a reconstructed validator.
    const procedures = router._def.procedures as unknown as Record<
      string,
      { _def: { inputs: z.ZodType[] } }
    >;
    // oxlint-disable-next-line no-underscore-dangle -- actual tRPC input parser.
    const runtime = procedures["session.command"]!._def.inputs[0]!;
    const published = sessionProcedureSchemas(router)["session.command"]!.input;
    const message = { id: "message", role: "user", parts: [{ type: "text", text: "hello" }] };
    const resolution = { optionIds: ["yes"], response: null };
    const samples = [
      { kind: "message.submit", message },
      { kind: "message.submit", message: { ...message, metadata: { arbitrary: [null, 1] } } },
      ...[
        { ...message, id: "" },
        { ...message, id: " leading" },
        { ...message, role: "unknown" },
        { ...message, parts: [] },
        { ...message, parts: [{ type: 1 }] },
        { ...message, parts: [null] },
      ].map((value) => ({ kind: "message.submit", message: value })),
      { kind: "interaction.resolve", interactionId: "ask", resolution },
      {
        kind: "interaction.resolve",
        interactionId: "ask",
        resolution: { ...resolution, answers: [{ promptId: "prompt", ...resolution }] },
      },
      {
        kind: "interaction.resolve",
        interactionId: "ask",
        resolution: { ...resolution, optionIds: [""] },
      },
      {
        kind: "interaction.resolve",
        interactionId: "ask",
        resolution: { ...resolution, answers: [{ promptId: "", ...resolution }] },
      },
    ];
    for (const command of samples) {
      const envelope = { commandId: "command", sessionId: "session", command };
      expect(published.safeParse(envelope).success, JSON.stringify(command)).toBe(
        runtime.safeParse(envelope).success,
      );
    }
  });

  it.each(Object.entries(payloads))(
    "validates and JSON-round-trips scrubbed %s frames",
    (_kind, payload) => {
      const sample = frame(payload);
      expect(frameSchema.parse(sample)).toEqual(sample);
      expect(frameSchema.parse(JSON.parse(JSON.stringify(sample)))).toEqual(sample);
    },
  );

  it("keeps the payload schema vocabulary in step with the engine's durable vocabulary", () => {
    expect(Object.keys(payloads).toSorted()).toEqual(SESSION_PROJECTION_EVENT_KINDS.toSorted());
  });

  it.each([
    receipt,
    {
      id: "receipt",
      commandId: "command",
      sequence: 2,
      recordedAt: 10,
      status: "rejected",
      code: "refused",
      detail: null,
    },
    {
      id: "receipt",
      commandId: "command",
      sequence: 2,
      recordedAt: 10,
      status: "completed",
      result: receipt.result,
    },
    {
      id: "receipt",
      commandId: "command",
      sequence: 2,
      recordedAt: 10,
      status: "unreconciled",
      detail: null,
    },
  ])("preserves receipt variant $status and nullable refusal", (value) => {
    const result = { sessionId: "session", receipt: value, throughSequence: 2, refusal: null };
    expect(sessionCommandOutputSchema.parse(result)).toEqual(result);
    expect(receiptSchema.parse(value)).toEqual(value);
  });

  it("keeps optional stop details and a minimal projection without defaults", () => {
    const result = {
      sessionId: "session",
      receipt: null,
      throughSequence: 2,
      refusal: "benign",
      stop: {
        sessionId: "session",
        handle: "sess",
        title: null,
        previouslyStopped: true,
        interrupted: false,
        released: false,
        failures: ["Release failed"],
      },
    };
    expect(sessionCommandOutputSchema.parse(result)).toEqual(result);
    expect(sessionProjectionOutputSchema.parse({ projection: {}, throughSequence: 2 })).toEqual({
      projection: {},
      throughSequence: 2,
    });
    // A window that reaches the first event, with no reply: what an older host sent.
    const snapshot = { projection: {}, frames: [], throughSequence: 2 };
    expect(sessionSnapshotOutputSchema.parse(snapshot)).toEqual(snapshot);
    const paged = { ...snapshot, before: 2, latestReply: { sequence: 1, text: "Done." } };
    expect(sessionSnapshotOutputSchema.parse(paged)).toEqual(paged);
  });

  it("rejects malformed envelopes, receipt variants and non-JSON transcript payloads", () => {
    expect(
      sessionCommandOutputSchema.safeParse({
        sessionId: "session",
        throughSequence: 2,
        receipt: null,
      }).success,
    ).toBe(false);
    expect(
      receiptSchema.safeParse({ ...receipt, result: { kind: "unknown", sessionId: "session" } })
        .success,
    ).toBe(false);
    expect(receiptSchema.safeParse({ ...receipt, acceptedAt: "now" }).success).toBe(false);
    expect(
      sessionProjectionOutputSchema.safeParse({
        projection: { turnActive: "yes" },
        throughSequence: 2,
      }).success,
    ).toBe(false);
    expect(
      sessionSnapshotOutputSchema.safeParse({ projection: {}, throughSequence: -1, frames: [] })
        .success,
    ).toBe(false);
    expect(
      frameSchema.safeParse({ ...frame(payloads["session.created"]), event: {} }).success,
    ).toBe(false);
    for (const value of [BigInt(1), Number.NaN, () => "function", new Date()]) {
      expect(
        uiMessageWireSchema.safeParse({
          id: "message",
          role: "assistant",
          parts: [{ type: "data-custom", data: value }],
        }).success,
      ).toBe(false);
    }
  });

  it("preserves extensible AI SDK part content and metadata as JSON", () => {
    const sample = {
      ...frame(payloads["transcript.referenced"]),
      transcript: {
        version: 1,
        threadId: "thread",
        branchId: "branch",
        attemptId: "attempt",
        turnId: null,
        message: {
          id: "message",
          role: "assistant",
          metadata: { arbitrary: [null, true] },
          parts: [{ type: "tool-new", output: { lines: ["one"] } }],
        },
      },
    };
    expect(frameSchema.parse(sample)).toEqual(sample);
    expect(frameSchema.parse(JSON.parse(JSON.stringify(sample)))).toEqual(sample);
  });

  it("uses the validators at actual query and mutation dispatch", async () => {
    const caller = callerWithResults({
      projection: { turnActive: "yes" },
      frames: [],
      command: {
        sessionId: "session",
        receipt: { ...receipt, acceptedAt: "now" },
        throughSequence: 2,
        refusal: null,
      },
    });
    await expect(caller.session.projection({ sessionId: "session" })).rejects.toThrow(
      "Output validation failed",
    );
    await expect(caller.session.snapshot({ sessionId: "session" })).rejects.toThrow(
      "Output validation failed",
    );
    await expect(
      caller.session.command({
        commandId: "command",
        sessionId: "session",
        command: { kind: "executor.retry" },
      }),
    ).rejects.toThrow("Output validation failed");
  });
});

/** The `kind` constants of a stream union's published alternatives. */
function emissionKinds(schema: z.ZodType) {
  return ((z.toJSONSchema(schema).anyOf ?? []) as { properties?: { kind?: { const?: string } } }[])
    .map((variant) => variant.properties?.kind?.const)
    .filter((kind) => kind !== undefined);
}

describe("the host follow-up queue on the wire (VC-675)", () => {
  const item = {
    id: "queued",
    commandId: "submit-queued",
    state: "queued" as const,
    message: {
      id: "queued",
      role: "user" as const,
      metadata: { origin: ["kept", null] },
      parts: [
        { type: "text", text: "follow up" },
        { type: "file", mediaType: "text/plain", url: "data:,x" },
      ],
    },
  };
  const queued = {
    kind: "queue" as const,
    sessionId: "session",
    throughSequence: 2,
    revision: 3,
    queue: [item, { ...item, id: "second", commandId: "submit-second", state: "releasing" }],
  };

  it("keeps every row field and the revision through projection and snapshot outputs", () => {
    const projection = { turnActive: true, queue: queued.queue, queueRevision: 3 };
    expect(sessionProjectionOutputSchema.parse({ projection, throughSequence: 2 })).toEqual({
      projection,
      throughSequence: 2,
    });
    const snapshot = { projection, frames: [], throughSequence: 2 };
    expect(sessionSnapshotOutputSchema.parse(JSON.parse(JSON.stringify(snapshot)))).toEqual(
      snapshot,
    );
    // Both stay optional: a host with no queue still answers a valid projection.
    expect(
      sessionProjectionOutputSchema.parse({ projection: { queue: [] }, throughSequence: 0 }),
    ).toEqual({ projection: { queue: [] }, throughSequence: 0 });
  });

  it("refuses a malformed row or an unbounded, negative or fractional revision", () => {
    const { parts: _parts, ...partless } = item.message;
    const { role: _role, ...roleless } = item.message;
    const rows = [
      { ...item, state: "delivered" },
      { ...item, commandId: undefined },
      { ...item, id: 1 },
      { ...item, message: partless },
      { ...item, message: roleless },
      { ...item, message: { ...item.message, parts: [{ text: "untyped" }] } },
      { ...item, message: { ...item.message, parts: [{ type: "data-x", data: Number.NaN }] } },
    ];
    for (const row of rows) {
      expect(followUpItemWireSchema.safeParse(row).success, JSON.stringify(row)).toBe(false);
      expect(
        sessionProjectionOutputSchema.safeParse({
          projection: { queue: [row] },
          throughSequence: 2,
        }).success,
      ).toBe(false);
      expect(streamEmissionSchema.safeParse({ ...queued, queue: [row] }).success).toBe(false);
    }
    for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3"]) {
      expect(
        sessionProjectionOutputSchema.safeParse({
          projection: { queueRevision: revision },
          throughSequence: 2,
        }).success,
      ).toBe(false);
      expect(streamEmissionSchema.safeParse({ ...queued, revision }).success).toBe(false);
    }
    expect(streamEmissionSchema.safeParse({ ...queued, throughSequence: -1 }).success).toBe(false);
    expect(followUpItemWireSchema.parse({ ...item, state: "releasing" }).state).toBe("releasing");
  });

  it("carries queue emissions on the current stream union and keeps the legacy union frozen", () => {
    expect(streamEmissionSchema.parse(queued)).toEqual(queued);
    expect(streamEmissionWireSchema.parse(JSON.parse(JSON.stringify(queued)))).toEqual(queued);
    expect(legacyStreamEmissionSchema.safeParse(queued).success).toBe(false);
    expect(legacyStreamEmissionWireSchema.safeParse(queued).success).toBe(false);
    const sample = frame(payloads["session.created"]);
    for (const schema of [streamEmissionSchema, legacyStreamEmissionSchema]) {
      expect(schema.parse(sample)).toEqual(sample);
    }
    expect(emissionKinds(streamEmissionWireSchema)).toEqual(["overlay", "compaction", "queue"]);
    expect(emissionKinds(legacyStreamEmissionWireSchema)).toEqual(["overlay", "compaction"]);
  });

  it("publishes the queue grammar wherever the router returns it", () => {
    const schemas = sessionProcedureSchemas();
    for (const key of ["session.projection", "session.snapshot"]) {
      const output = schemas[key]!.output;
      const result = { projection: { queue: queued.queue, queueRevision: 3 }, throughSequence: 2 };
      expect(
        output.parse(key === "session.snapshot" ? { ...result, frames: [] } : result),
      ).toMatchObject(result);
      expect(() => z.toJSONSchema(output)).not.toThrow();
    }
    expect(schemas["session.subscribe"]!.output.safeParse(queued).success).toBe(false);
    expect(schemas["session.subscribeQueue"]?.output.parse(queued)).toEqual(queued);
  });

  it("retains the row and revision at actual projection and snapshot dispatch", async () => {
    const projection = { queue: queued.queue, queueRevision: 3 };
    const caller = callerWithResults({ projection });
    expect(await caller.session.projection({ sessionId: "session" })).toEqual({
      projection,
      throughSequence: 2,
    });
    expect(await caller.session.snapshot({ sessionId: "session" })).toEqual({
      projection,
      frames: [],
      throughSequence: 2,
    });
    const malformed = callerWithResults({ projection: { queue: queued.queue, queueRevision: -1 } });
    await expect(malformed.session.projection({ sessionId: "session" })).rejects.toThrow(
      "Output validation failed",
    );
  });
});
