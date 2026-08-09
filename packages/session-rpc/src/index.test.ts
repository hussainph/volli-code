import { describe, expect, it } from "vite-plus/test";
import type {
  CancelInteractionRequest,
  RuntimeCatalog,
  SessionRuntime,
  SessionRuntimeCommandRequest,
  SessionRuntimeSnapshot,
  SessionStreamEmission,
  SessionStreamFrame,
  SessionStreamOverlay,
} from "@volli/session-engine";
import { AsyncQueue, createSessionRouter, RpcDiagnosticLog, sanitizeDiagnosticText } from "./index";

type CapabilitySnapshot = Extract<
  SessionStreamFrame["event"]["payload"],
  { kind: "capabilities.updated" }
>["snapshot"];

type SessionAttachmentProjection = SessionRuntimeSnapshot["projection"]["attachments"][number];
type SessionCommand = SessionRuntimeSnapshot["projection"]["commands"][number];
type SessionAttention = SessionRuntimeSnapshot["projection"]["attention"]["active"][number];

const RECOVERY_PATH =
  "/Users/alice/Library/Application Support/Volli Code/pi-sessions/pi-session-9.jsonl";

function recoveryNative() {
  return {
    id: "pi-session-9",
    detail: { runtime: "pi", sessionId: "pi-session-9", sessionFilePath: RECOVERY_PATH },
  };
}

const INTERACTION_NATIVE = {
  id: "permission-native-7",
  detail: { requestId: "permission-request-7" },
};

function frame(sequence: number): SessionStreamFrame {
  return {
    sessionId: "session-1",
    sequence,
    event: {
      id: `event-${sequence}`,
      sessionId: "session-1",
      sequence,
      occurredAt: 10,
      recordedAt: 10,
      provenance: { source: { kind: "system", id: "test", detail: null }, venue: null },
      payload: {
        kind: "session.created",
        session: {
          id: "session-1",
          projectId: "project-1",
          ticketId: null,
          title: null,
          createdAt: 10,
        },
      },
    },
    transcript: null,
  };
}

function attachmentWithRecovery(): SessionAttachmentProjection {
  return {
    id: "attachment-1",
    sessionId: "session-1",
    adapterId: "pi",
    venue: { id: "local", kind: "local" },
    continuity: "fresh",
    native: recoveryNative(),
    status: "open",
    openedAt: 10,
    closedAt: null,
    outcome: null,
    failure: null,
  };
}

function interactionWithCorrelation() {
  return {
    id: "permission-1",
    attachmentId: "attachment-1",
    kind: "permission" as const,
    title: "Allow file write?",
    detail: null,
    options: [{ id: "once", label: "Allow once", description: null }],
    multiple: false,
    native: { ...INTERACTION_NATIVE, detail: { ...INTERACTION_NATIVE.detail } },
  };
}

function executorCommand(): SessionCommand {
  return {
    id: "command-start-1",
    sessionId: "session-1",
    createdAt: 10,
    route: { adapterId: "pi", attachmentId: "attachment-1" },
    intent: { kind: "executor.start", adapterId: "pi", continuity: "fresh" },
  };
}

function modelCommand(): SessionCommand {
  return {
    id: "command-model-1",
    sessionId: "session-1",
    createdAt: 9,
    route: null,
    intent: {
      kind: "model.select",
      selection: { providerId: "openai-codex", modelId: "gpt-5.6-sol", reasoningLevel: "high" },
    },
  };
}

function recoveryAttention(): SessionAttention {
  return {
    id: "attention-auth-1",
    attachmentId: "attachment-1",
    kind: "auth_required",
    detail: "Sign in required",
    diagnostic: { credentialPath: RECOVERY_PATH },
  };
}

function snapshotWithRecovery(): SessionRuntimeSnapshot {
  const base = snapshot();
  const attachment = attachmentWithRecovery();
  return {
    ...base,
    projection: {
      ...base.projection,
      commands: [executorCommand(), modelCommand()],
      pendingExecutorStart: executorCommand(),
      attachments: [attachment],
      liveExecutor: attachment,
      attention: { active: [recoveryAttention()], primary: recoveryAttention() },
      interactions: {
        active: [interactionWithCorrelation()],
        resolved: [
          {
            interaction: interactionWithCorrelation(),
            resolution: { optionIds: ["once"], response: null },
            resolvedAt: 11,
          },
        ],
      },
    },
  };
}

function frameWithPayload(
  sequence: number,
  payload: SessionStreamFrame["event"]["payload"],
): SessionStreamFrame {
  const base = frame(sequence);
  return { ...base, event: { ...base.event, payload } };
}

function attachmentFrames(): readonly SessionStreamFrame[] {
  const attachment = attachmentWithRecovery();
  const eventAttachment = {
    id: attachment.id,
    sessionId: attachment.sessionId,
    adapterId: attachment.adapterId,
    venue: attachment.venue,
    continuity: attachment.continuity,
    native: attachment.native,
  };
  return [
    frameWithPayload(5, { kind: "attachment.opened", attachment: eventAttachment }),
    frameWithPayload(6, {
      kind: "attachment.native_referenced",
      attachmentId: attachment.id,
      native: recoveryNative(),
    }),
    frameWithPayload(7, {
      kind: "attachment.failed",
      attachment: { ...eventAttachment, id: "attachment-2" },
      failure: { code: "runtime_failed", detail: "Runtime failed", diagnostic: null },
    }),
    frameWithPayload(8, {
      kind: "interaction.opened",
      interaction: interactionWithCorrelation(),
    }),
    frameWithPayload(9, { kind: "command.recorded", command: executorCommand() }),
    frameWithPayload(10, { kind: "attention.raised", attention: recoveryAttention() }),
    {
      ...frameWithPayload(11, {
        kind: "adapter.observed",
        attachmentId: attachment.id,
        name: "runtime observation",
        native: { credentialPath: RECOVERY_PATH },
      }),
      event: {
        ...frameWithPayload(11, {
          kind: "adapter.observed",
          attachmentId: attachment.id,
          name: "runtime observation",
          native: { credentialPath: RECOVERY_PATH },
        }).event,
        provenance: {
          source: { kind: "adapter", id: "pi", detail: { credentialPath: RECOVERY_PATH } },
          venue: null,
        },
      },
    },
  ];
}

function snapshot(): SessionRuntimeSnapshot {
  return {
    projection: {
      session: {
        id: "session-1",
        projectId: "project-1",
        ticketId: null,
        title: null,
        createdAt: 10,
      },
      status: "open",
      commands: [],
      receipts: [],
      pendingExecutorStart: null,
      attachments: [],
      liveExecutor: null,
      attention: { active: [], primary: null },
      capabilities: [],
      interactions: { active: [], resolved: [] },
      signal: null,
      modelSelection: null,
      turnActive: false,
      lastActivityAt: 10,
      bornTicketless: true,
    },
    throughSequence: 4,
    frames: [frame(4)],
    transcript: [],
  };
}

function capabilitySnapshot(): CapabilitySnapshot {
  return {
    id: "capabilities-1",
    adapterId: "opencode",
    attachmentId: "attachment-1",
    profileId: "native",
    revision: 1,
    observedAt: 10,
    expiresAt: 70,
    features: [{ id: "message.submit", state: "available", evidence: "verified", detail: null }],
    catalog: [
      {
        kind: "model",
        id: "provider/model-with-exhaustive-detail",
        label: "Exhaustive model inventory",
        state: "available",
        evidence: "reported",
        detail: { payload: "must stay behind the server boundary" },
      },
    ],
  };
}

function capabilityFrame(sequence: number): SessionStreamFrame {
  const base = frame(sequence);
  return {
    ...base,
    event: {
      ...base.event,
      payload: { kind: "capabilities.updated", snapshot: capabilitySnapshot() },
    },
  };
}

function overlay(throughSequence: number): SessionStreamOverlay {
  return {
    kind: "overlay",
    sessionId: "session-1",
    throughSequence,
    messageId: "assistant-1",
    delta: { op: "part.append", key: "text-1", text: "lo" },
  };
}

function trackedValue(value: unknown): { id: string; data: unknown } {
  expect(Array.isArray(value)).toBe(true);
  if (!Array.isArray(value)) throw new Error("Expected a tracked SSE envelope");
  const [id, data] = value;
  if (typeof id !== "string") throw new Error("Expected a tracked SSE identifier");
  return { id, data };
}

function runtimeFixture(): {
  runtime: SessionRuntime;
  calls: {
    command: SessionRuntimeCommandRequest[];
    subscribeAfter: number[];
    cancelled: CancelInteractionRequest[];
  };
  emit: (next: SessionStreamEmission) => void;
} {
  const calls: {
    command: SessionRuntimeCommandRequest[];
    subscribeAfter: number[];
    cancelled: CancelInteractionRequest[];
  } = {
    command: [],
    subscribeAfter: [],
    cancelled: [],
  };
  let listener: ((next: SessionStreamEmission) => void) | null = null;
  const runtime: SessionRuntime = {
    command: async (request) => {
      calls.command.push(request);
      const sessionId = "sessionId" in request ? request.sessionId : "created-session";
      return {
        sessionId,
        command: {
          id: request.commandId,
          sessionId,
          createdAt: 10,
          intent: { kind: "session.create", projectId: "project-1", ticketId: null, title: null },
          route: null,
        },
        receipt: null,
        throughSequence: 1,
      };
    },
    snapshot: async () => snapshot(),
    projection: async () => {
      const { projection, throughSequence } = snapshot();
      return { projection, throughSequence };
    },
    subscribe: async (input, next) => {
      calls.subscribeAfter.push(input.afterSequence);
      listener = (value) => void next(value);
      return () => {
        listener = null;
      };
    },
    cancelInteraction: async (request) => {
      calls.cancelled.push(request);
    },
    refreshCapabilities: async () => ({
      id: "capability-1",
      adapterId: "opencode",
      attachmentId: "attachment-1",
      profileId: "native",
      revision: 1,
      observedAt: 10,
      expiresAt: null,
      features: [],
      catalog: [],
    }),
    reconcile: async () => undefined,
    close: async () => undefined,
  };
  return {
    runtime,
    calls,
    emit: (next) => {
      if (!listener) throw new Error("Subscription is not listening");
      listener(next);
    },
  };
}

describe("RpcDiagnosticLog", () => {
  it("bounds entries, replays in order, and removes sensitive diagnostics", () => {
    let now = 0;
    const log = new RpcDiagnosticLog({ capacity: 2, now: () => ++now });
    const sensitive = log.record({
      procedure: "session.command",
      phase: "error",
      transport: "lab-http",
      code: "INTERNAL_SERVER_ERROR",
      message:
        'token=super-secret prompt="do not leak" provider={"raw":"body"} /Users/alice/private.txt',
    });
    log.record({
      procedure: "session.snapshot",
      phase: "success",
      transport: "lab-http",
      code: null,
      message: null,
    });
    const delivered: number[] = [];
    const unsubscribe = log.subscribe({ afterId: 0 }, (entry) => delivered.push(entry.id));
    log.record({
      procedure: "session.reconcile",
      phase: "start",
      transport: "lab-http",
      code: null,
      message: null,
    });
    unsubscribe();

    expect(log.list().map((entry) => entry.id)).toEqual([2, 3]);
    expect(delivered).toEqual([1, 2, 3]);
    expect(log.list({ afterId: 2 })).toEqual([expect.objectContaining({ id: 3 })]);
    expect(log.list({ afterId: 0, limit: 1 })).toEqual([expect.objectContaining({ id: 3 })]);
    expect(sanitizeDiagnosticText("Bearer abc /home/alice/key")).toContain("[REDACTED]");
    expect(sensitive.message).not.toContain("super-secret");
    expect(sensitive.message).not.toContain("do not leak");
    expect(sensitive.message).toContain("[HOME]");
  });

  it("rejects invalid cursors and stops delivery after unsubscribe", () => {
    expect(() => new RpcDiagnosticLog({ capacity: 0 })).toThrow("positive integer");
    const log = new RpcDiagnosticLog();
    expect(() => log.list({ afterId: -1 })).toThrow("non-negative integer");
    expect(() => log.list({ afterId: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      "non-negative integer",
    );
    expect(() => log.list({ limit: 0 })).toThrow("positive integer");
    expect(() => log.subscribe({ afterId: -1 }, () => undefined)).toThrow("non-negative integer");
    expect(() => log.subscribe({ afterId: Number.MAX_SAFE_INTEGER + 1 }, () => undefined)).toThrow(
      "non-negative integer",
    );
    const delivered: number[] = [];
    const unsubscribe = log.subscribe({ afterId: 0 }, (entry) => delivered.push(entry.id));
    unsubscribe();
    log.record({
      procedure: "later",
      phase: "success",
      transport: "unknown",
      code: null,
      message: null,
    });
    expect(delivered).toEqual([]);
  });

  it("replays retained history when a diagnostic cursor falls behind its bounded buffer", () => {
    const log = new RpcDiagnosticLog({ capacity: 2 });
    for (const procedure of ["first", "second", "third"]) {
      log.record({
        procedure,
        phase: "success",
        transport: "unknown",
        code: null,
        message: null,
      });
    }

    const delivered: number[] = [];
    log.subscribe({ afterId: 0 }, (entry) => delivered.push(entry.id));

    expect(delivered).toEqual([2, 3]);
  });

  it("redacts Authorization bearer values and bounds stored diagnostic fields", () => {
    const log = new RpcDiagnosticLog();
    const entry = log.record({
      procedure: "x".repeat(2_000),
      phase: "error",
      transport: "unknown",
      code: "x".repeat(2_000),
      message: `Authorization: Basic super-secret ${"x".repeat(2_000)}`,
    });

    expect(entry.message).not.toContain("super-secret");
    expect(entry.procedure.length).toBeLessThanOrEqual(1_000);
    expect(entry.code?.length).toBeLessThanOrEqual(1_000);
    expect(entry.message?.length).toBeLessThanOrEqual(1_000);
  });
});

describe("AsyncQueue", () => {
  it("finishes immediately when closed before next and discards queued values on close", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.close();
    queue.close();
    queue.push(2);

    expect(await queue.next()).toEqual({ done: true, value: undefined });
  });

  it("delivers an explicitly queued undefined value", async () => {
    const queue = new AsyncQueue<number | undefined>();
    queue.push(undefined);

    expect(await queue.next()).toEqual({ done: false, value: undefined });
  });

  it("ends an overflowing queue after delivering its already-buffered frames", async () => {
    const queue = new AsyncQueue<number>(1);
    queue.push(1);
    queue.push(2);

    expect(queue.overflowed).toBe(true);
    expect(await queue.next()).toEqual({ done: false, value: 1 });
    expect(await queue.next()).toEqual({ done: true, value: undefined });
    expect(() => new AsyncQueue(0)).toThrow("capacity must be a positive integer");
  });
});

describe("Session tRPC router", () => {
  it("preserves a minimal runtime projection without inventing attachment state", async () => {
    const fixture = runtimeFixture();
    const runtime: SessionRuntime = {
      ...fixture.runtime,
      projection: async () => ({ projection: { capabilities: [] }, throughSequence: 4 }) as never,
    };
    const caller = createSessionRouter().createCaller({
      runtime,
      diagnostics: new RpcDiagnosticLog(),
    });

    await expect(caller.session.projection({ sessionId: "session-1" })).resolves.toEqual({
      projection: { capabilities: [] },
      throughSequence: 4,
    });
  });

  it("removes runtime identity and recovery locators from projection reads without mutating runtime state", async () => {
    const fixture = runtimeFixture();
    const serverSnapshot = snapshotWithRecovery();
    const unreferencedAttachment = {
      ...attachmentWithRecovery(),
      id: "attachment-without-recovery",
      native: null,
    };
    const runtime: SessionRuntime = {
      ...fixture.runtime,
      projection: async () => ({
        projection: {
          ...serverSnapshot.projection,
          attachments: [...serverSnapshot.projection.attachments, unreferencedAttachment],
        },
        throughSequence: serverSnapshot.throughSequence,
      }),
    };
    const caller = createSessionRouter().createCaller({
      runtime,
      diagnostics: new RpcDiagnosticLog(),
    });

    const resolved = await caller.session.projection({ sessionId: "session-1" });

    expect(resolved.projection.attachments[0]?.native).toBeUndefined();
    expect(resolved.projection.attachments[1]).toEqual(
      expect.objectContaining({ id: "attachment-without-recovery", status: "open" }),
    );
    expect(resolved.projection.liveExecutor?.native).toBeUndefined();
    expect(resolved.projection.interactions.active[0]?.native).toEqual({ id: null, detail: null });
    expect(JSON.stringify(resolved)).not.toMatch(/adapterId|profileId/);
    expect(JSON.stringify(resolved)).not.toMatch(/pi|native-session|permission-request/i);
    expect(serverSnapshot.projection.attachments[0]?.native).toEqual(recoveryNative());
    expect(serverSnapshot.projection.liveExecutor?.native).toEqual(recoveryNative());
  });

  it("removes runtime identity and recovery locators from snapshot projections and replay frames", async () => {
    const fixture = runtimeFixture();
    const serverSnapshot = { ...snapshotWithRecovery(), frames: attachmentFrames() };
    const runtime: SessionRuntime = { ...fixture.runtime, snapshot: async () => serverSnapshot };
    const caller = createSessionRouter().createCaller({
      runtime,
      diagnostics: new RpcDiagnosticLog(),
    });

    const resolved = await caller.session.snapshot({ sessionId: "session-1" });
    const payloads = resolved.frames.map((item) => item.event.payload);

    expect(resolved.projection.attachments[0]?.native).toBeUndefined();
    expect(
      payloads[0]?.kind === "attachment.opened" ? payloads[0].attachment.native : undefined,
    ).toBeUndefined();
    expect(JSON.stringify(resolved)).not.toMatch(/adapterId|profileId/);
    expect(
      payloads[1]?.kind === "attachment.native_referenced" ? payloads[1].native : undefined,
    ).toEqual({
      id: null,
      detail: null,
    });
    expect(
      payloads[2]?.kind === "attachment.failed" ? payloads[2].attachment.native : undefined,
    ).toBeUndefined();
    expect(
      payloads[3]?.kind === "interaction.opened" ? payloads[3].interaction.native : undefined,
    ).toEqual({ id: null, detail: null });
    expect(JSON.stringify(resolved)).not.toMatch(/pi|native-session|permission-request/i);
    expect(serverSnapshot.frames.map((item) => item.event.payload)).toEqual(
      attachmentFrames().map((item) => item.event.payload),
    );
  });

  it("removes runtime identity and recovery locators from subscribed frames", async () => {
    const fixture = runtimeFixture();
    const serverFrames = attachmentFrames();
    const caller = createSessionRouter().createCaller({
      runtime: fixture.runtime,
      diagnostics: new RpcDiagnosticLog(),
    });
    const stream = await caller.session.subscribe({ sessionId: "session-1" });
    const iterator = stream[Symbol.asyncIterator]();
    const rendererFrames: SessionStreamFrame[] = [];

    for (const serverFrame of serverFrames) {
      const pending = iterator.next();
      await Promise.resolve();
      fixture.emit(serverFrame);
      rendererFrames.push(trackedValue((await pending).value).data as SessionStreamFrame);
    }
    await iterator.return?.();

    const payloads = rendererFrames.map((item) => item.event.payload);
    expect(
      payloads[0]?.kind === "attachment.opened" ? payloads[0].attachment.native : undefined,
    ).toBeUndefined();
    expect(
      payloads[1]?.kind === "attachment.native_referenced" ? payloads[1].native : undefined,
    ).toEqual({
      id: null,
      detail: null,
    });
    expect(
      payloads[2]?.kind === "attachment.failed" ? payloads[2].attachment.native : undefined,
    ).toBeUndefined();
    expect(
      payloads[3]?.kind === "interaction.opened" ? payloads[3].interaction.native : undefined,
    ).toEqual({ id: null, detail: null });
    expect(JSON.stringify(rendererFrames)).not.toMatch(/adapterId|profileId/);
    expect(JSON.stringify(rendererFrames)).not.toMatch(/pi|native-session|permission-request/i);
    expect(serverFrames.map((item) => item.event.payload)).toEqual(
      attachmentFrames().map((item) => item.event.payload),
    );
  });

  it("keeps exhaustive capability catalogs out of renderer snapshots and streams", async () => {
    const fixture = runtimeFixture();
    const base = snapshot();
    const runtime: SessionRuntime = {
      ...fixture.runtime,
      snapshot: async () => ({
        ...base,
        projection: { ...base.projection, capabilities: [capabilitySnapshot()] },
        frames: [capabilityFrame(4)],
      }),
      refreshCapabilities: async () => capabilitySnapshot(),
    };
    const caller = createSessionRouter().createCaller({
      runtime,
      diagnostics: new RpcDiagnosticLog(),
    });

    const resolved = await caller.session.snapshot({ sessionId: "session-1" });
    expect(resolved.projection.capabilities[0]?.catalog).toEqual([]);
    expect(
      resolved.frames[0]?.event.payload.kind === "capabilities.updated"
        ? resolved.frames[0].event.payload.snapshot.catalog
        : null,
    ).toEqual([]);

    const refreshed = await caller.session.refreshCapabilities({
      sessionId: "session-1",
      attachmentId: "attachment-1",
    });
    expect(refreshed.catalog).toEqual([]);

    const stream = await caller.session.subscribe({ sessionId: "session-1" });
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    await Promise.resolve();
    fixture.emit(capabilityFrame(5));
    const tracked = trackedValue((await pending).value);
    const streamed = tracked.data as SessionStreamFrame;
    expect(
      streamed.event.payload.kind === "capabilities.updated"
        ? streamed.event.payload.snapshot.catalog
        : null,
    ).toEqual([]);
    await iterator.return?.();
  });

  it("yields a transient overlay beside durable frames, leaving both exactly as published", async () => {
    const fixture = runtimeFixture();
    const diagnostics = new RpcDiagnosticLog();
    const caller = createSessionRouter().createCaller({ runtime: fixture.runtime, diagnostics });

    const stream = await caller.session.subscribe({ sessionId: "session-1" });
    const iterator = stream[Symbol.asyncIterator]();
    const durablePending = iterator.next();
    await Promise.resolve();
    fixture.emit(frame(5));
    const durable = trackedValue((await durablePending).value);
    const overlayPending = iterator.next();
    await Promise.resolve();
    fixture.emit(overlay(5));
    const transient = trackedValue((await overlayPending).value);
    await iterator.return?.();

    // The durable arm is byte-identical to what it was before overlays existed:
    // every consumer validating a frame by its `sequence` keeps working.
    expect(durable.id).toBe("5");
    expect(JSON.stringify(durable.data)).toBe(JSON.stringify(frame(5)));
    // The overlay is tracked by the durable sequence it was emitted beside —
    // unsuffixed, so a resubscribe from it still parses as a cursor.
    expect(transient.id).toBe("5");
    expect(transient.data).toEqual(overlay(5));
  });

  it("answers a projection read with Session state alone and no transcript replay", async () => {
    const fixture = runtimeFixture();
    const base = snapshot();
    const runtime: SessionRuntime = {
      ...fixture.runtime,
      projection: async () => ({
        projection: { ...base.projection, capabilities: [capabilitySnapshot()] },
        throughSequence: 9,
      }),
    };
    const diagnostics = new RpcDiagnosticLog();
    const caller = createSessionRouter().createCaller({ runtime, diagnostics });

    const resolved = await caller.session.projection({ sessionId: "session-1" });

    expect(Object.keys(resolved).toSorted()).toEqual(["projection", "throughSequence"]);
    expect(resolved.throughSequence).toBe(9);
    // The one thing this edge still owes the renderer: no exhaustive inventory.
    expect(resolved.projection.capabilities[0]?.catalog).toEqual([]);
    expect(diagnostics.list().map((entry) => `${entry.procedure}:${entry.phase}`)).toEqual([
      "session.projection:start",
      "session.projection:success",
    ]);
  });

  it("exposes Model Access without adapter, profile, or credential inputs", async () => {
    const fixture = runtimeFixture();
    const calls: unknown[] = [];
    const caller = createSessionRouter().createCaller({
      runtime: fixture.runtime,
      inspectModelAccess: async (input) => {
        calls.push(input);
        return {
          observedAt: 42,
          credentialToken: "root-secret",
          providers: [
            {
              id: "openai-codex",
              label: "OpenAI Codex",
              state: "available" as const,
              accountLabel: "OAuth",
              billingSource: "ambient" as const,
              recovery: null,
              runtime: { credential: "provider-secret" },
            },
          ],
          models: [
            {
              providerId: "openai-codex",
              modelId: "gpt-5.6-sol",
              label: "GPT-5.6 Sol",
              state: "available" as const,
              reasoningLevels: ["off", "low", "medium", "high"] as const,
              headers: { authorization: "model-secret" },
            },
          ],
        };
      },
      diagnostics: new RpcDiagnosticLog(),
    });

    const access = await caller.modelAccess.inspect({ refresh: true });

    expect(calls).toEqual([{ refresh: true }]);
    expect(access.models[0]).toMatchObject({
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
    });
    expect(Object.keys(access).toSorted()).toEqual(["models", "observedAt", "providers"]);
    expect(Object.keys(access.providers[0]!).toSorted()).toEqual([
      "accountLabel",
      "billingSource",
      "id",
      "label",
      "recovery",
      "state",
    ]);
    expect(Object.keys(access.models[0]!).toSorted()).toEqual([
      "label",
      "modelId",
      "providerId",
      "reasoningLevels",
      "state",
    ]);
    expect(JSON.stringify(access)).not.toMatch(/adapter|profile|credential|token/i);
  });

  it("reads and writes the user-configured default model through an exact safe shape", async () => {
    const fixture = runtimeFixture();
    const writes: unknown[] = [];
    const caller = createSessionRouter().createCaller({
      runtime: fixture.runtime,
      readDefaultModelSelection: () => ({
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        reasoningLevel: "high",
        credential: "must-not-cross",
      }),
      writeDefaultModelSelection: (selection) => {
        writes.push(selection);
      },
      diagnostics: new RpcDiagnosticLog(),
    });

    const current = await caller.modelAccess.defaultSelection();
    await caller.modelAccess.setDefault({
      providerId: "anthropic",
      modelId: "claude-sonnet",
      reasoningLevel: "medium",
    });

    expect(current).toEqual({
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high",
    });
    expect(writes).toEqual([
      {
        providerId: "anthropic",
        modelId: "claude-sonnet",
        reasoningLevel: "medium",
      },
    ]);
    const empty = createSessionRouter().createCaller({
      runtime: fixture.runtime,
      readDefaultModelSelection: () => null,
      diagnostics: new RpcDiagnosticLog(),
    });
    await expect(empty.modelAccess.defaultSelection()).resolves.toBeNull();
  });

  it("starts a Ticket Session without accepting runtime identity", async () => {
    const fixture = runtimeFixture();
    const calls: unknown[] = [];
    const caller = createSessionRouter().createCaller({
      runtime: fixture.runtime,
      startTicketSession: async (input) => {
        calls.push(input);
        return {
          sessionId: "session-1",
          state: "ready" as const,
          receipt: null,
          throughSequence: 6,
        };
      },
      diagnostics: new RpcDiagnosticLog(),
    });

    const started = await caller.ticketSessions.start({
      operationId: "operation-1",
      projectId: "project-1",
      ticketId: "ticket-1",
      title: "VC-1",
    });

    expect(started).toMatchObject({ sessionId: "session-1", state: "ready" });
    expect(calls).toEqual([
      {
        operationId: "operation-1",
        projectId: "project-1",
        ticketId: "ticket-1",
        title: "VC-1",
      },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/adapter|profile|pi/i);
  });

  it("withholds executor creation and attachment commands from Electron renderers", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller({
      runtime: fixture.runtime,
      diagnostics: new RpcDiagnosticLog(),
      transport: "electron-ipc",
    });

    await expect(
      caller.session.command({
        commandId: "forged-create",
        command: { kind: "session.create", projectId: "p1", ticketId: null, title: null },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.session.command({
        commandId: "forged-attach",
        sessionId: "session-1",
        command: {
          kind: "adapter.attach",
          adapterId: "pi",
          profileId: "native",
          continuity: "fresh",
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fixture.calls.command).toEqual([]);
  });

  it("reattaches Ticket and temporary project Sessions without runtime identity", async () => {
    const fixture = runtimeFixture();
    const calls: unknown[] = [];
    const answer = {
      sessionId: "session-1",
      state: "ready" as const,
      receipt: null,
      throughSequence: 6,
    };
    const caller = createSessionRouter().createCaller({
      runtime: fixture.runtime,
      attachTicketSession: async (input) => {
        calls.push(["ticket.attach", input]);
        return answer;
      },
      startProjectSession: async (input) => {
        calls.push(["project.start", input]);
        return answer;
      },
      attachProjectSession: async (input) => {
        calls.push(["project.attach", input]);
        return answer;
      },
      diagnostics: new RpcDiagnosticLog(),
    });

    await caller.ticketSessions.attach({ operationId: "ticket-retry", sessionId: "session-1" });
    await caller.projectSessions.start({
      operationId: "project-start",
      projectId: "project-1",
      title: "Scratch",
    });
    await caller.projectSessions.attach({
      operationId: "project-retry",
      sessionId: "session-2",
    });

    expect(calls).toEqual([
      ["ticket.attach", { operationId: "ticket-retry", sessionId: "session-1" }],
      ["project.start", { operationId: "project-start", projectId: "project-1", title: "Scratch" }],
      ["project.attach", { operationId: "project-retry", sessionId: "session-2" }],
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/adapter|profile|pi|opencode/i);
  });

  it("fails product facades explicitly when a transport did not configure them", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller({
      runtime: fixture.runtime,
      diagnostics: new RpcDiagnosticLog(),
    });

    await expect(
      caller.ticketSessions.start({
        operationId: "ticket-start",
        projectId: "project-1",
        ticketId: "ticket-1",
        title: null,
      }),
    ).rejects.toThrow("Ticket Sessions are unavailable");
    await expect(
      caller.ticketSessions.attach({ operationId: "ticket-attach", sessionId: "session-1" }),
    ).rejects.toThrow("Ticket Sessions are unavailable");
    await expect(
      caller.projectSessions.start({
        operationId: "project-start",
        projectId: "project-1",
        title: null,
      }),
    ).rejects.toThrow("Project Sessions are unavailable");
    await expect(
      caller.projectSessions.attach({ operationId: "project-attach", sessionId: "session-1" }),
    ).rejects.toThrow("Project Sessions are unavailable");
    await expect(caller.modelAccess.inspect({})).rejects.toThrow("Model Access is unavailable");
    await expect(caller.modelAccess.defaultSelection()).rejects.toThrow(
      "Model Access preferences are unavailable",
    );
    await expect(
      caller.modelAccess.setDefault({
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        reasoningLevel: "high",
      }),
    ).rejects.toThrow("Model Access preferences are unavailable");
  });

  it("exposes bounded Runtime Catalog browsing and shortlist resolution to Lab clients", async () => {
    const fixture = runtimeFixture();
    const calls: string[] = [];
    const resolverCalls: (string | undefined)[] = [];
    const runtimeCatalog: RuntimeCatalog = {
      // `projectId` reaches the catalog rather than being stripped at the edge:
      // it is the SCOPE the stored preferences are read and written at, not just
      // the key the host picks an instance with.
      inspect: async (input) => {
        calls.push(`inspect:${input.projectId ?? "global"}:${input.providerId ?? "overview"}`);
        return {
          adapterId: input.adapterId,
          status: "available",
          reason: null,
          observedAt: 10,
          runtimeVersion: "1.0.0",
          providers: [],
          models: [],
          modelTotal: 0,
          preferences: {
            version: 1,
            enabledModels: [],
            defaults: { providerId: "", modelId: "", variant: "", agent: "" },
          },
          preferencesOrigin: input.projectId === undefined ? "global" : "project",
        };
      },
      save: async (input) => {
        calls.push(`save:${input.projectId ?? "global"}:${input.preferences.enabledModels.length}`);
        return input.preferences;
      },
      clear: async (input) => {
        calls.push(`clear:${input.projectId}:${input.adapterId}`);
      },
      resolve: async (input) => {
        calls.push(`resolve:${input.projectId ?? "global"}:${input.adapterId}`);
        return {
          adapterId: input.adapterId,
          observedAt: 10,
          catalog: { providers: [], models: [], agents: [] },
          selection: { providerId: "", modelId: "", variant: "", agent: "" },
        };
      },
    };
    const caller = createSessionRouter().createCaller({
      runtime: fixture.runtime,
      resolveRuntimeCatalog: (projectId) => {
        resolverCalls.push(projectId);
        return runtimeCatalog;
      },
      diagnostics: new RpcDiagnosticLog(),
      transport: "lab-http",
    });

    await caller.runtimeCatalog.inspect({
      adapterId: "opencode",
      providerId: "openai",
      projectId: "project-1",
    });
    await caller.runtimeCatalog.save({
      adapterId: "opencode",
      projectId: "project-1",
      preferences: {
        version: 1,
        enabledModels: [{ providerId: "openai", modelId: "codex" }],
        defaults: { providerId: "openai", modelId: "codex", variant: "high", agent: "build" },
      },
    });
    await caller.runtimeCatalog.clear({ adapterId: "opencode", projectId: "project-1" });
    await caller.runtimeCatalog.resolve({ adapterId: "opencode", projectId: "project-1" });
    await caller.runtimeCatalog.resolve({ adapterId: "opencode" });

    await expect(
      caller.runtimeCatalog.save({
        adapterId: "opencode",
        preferences: {
          version: 1,
          enabledModels: Array.from({ length: 51 }, (_, index) => ({
            providerId: "provider",
            modelId: `model-${index}`,
          })),
          defaults: { providerId: "", modelId: "", variant: "", agent: "" },
        },
      }),
    ).rejects.toThrow();

    expect(calls).toEqual([
      "inspect:project-1:openai",
      "save:project-1:1",
      "clear:project-1:opencode",
      "resolve:project-1:opencode",
      "resolve:global:opencode",
    ]);
    // Every verb advertises the scope it was asked at — `resolve` included, so
    // a project's chat resolves that project's own curated models.
    expect(resolverCalls).toEqual(["project-1", "project-1", "project-1", "project-1", undefined]);
  });

  it("rejects Runtime Catalog procedures on a transport that carries no catalog", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller({
      runtime: fixture.runtime,
      diagnostics: new RpcDiagnosticLog(),
    });

    await expect(caller.runtimeCatalog.resolve({ adapterId: "opencode" })).rejects.toThrow(
      "Runtime Catalog is unavailable on this transport",
    );
  });

  it("wraps a Runtime Catalog resolver rejection as a not-found projectId", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller({
      runtime: fixture.runtime,
      resolveRuntimeCatalog: () => {
        throw new Error("Unknown project unknown-project");
      },
      diagnostics: new RpcDiagnosticLog(),
      transport: "lab-http",
    });

    await expect(
      caller.runtimeCatalog.inspect({ adapterId: "opencode", projectId: "unknown-project" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Unknown project unknown-project" });
  });

  it("stringifies a non-Error Runtime Catalog resolver rejection", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller({
      runtime: fixture.runtime,
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercises the non-Error fallback
      resolveRuntimeCatalog: () => {
        throw "boom";
      },
      diagnostics: new RpcDiagnosticLog(),
      transport: "lab-http",
    });

    await expect(caller.runtimeCatalog.resolve({ adapterId: "opencode" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "boom",
    });
  });

  // A blank `projectId` is a malformed request, and routing one reports it as
  // the wrong thing entirely: the hub finds no project by that id and the
  // caller is told NOT_FOUND, which reads as "your project is gone" rather
  // than "you sent an empty string". Every other identifier this router takes
  // is `nonEmptyString`, including `projectId` on `session.create`.
  it("refuses a blank Runtime Catalog projectId as bad input, never routing it", async () => {
    const fixture = runtimeFixture();
    const resolverCalls: (string | undefined)[] = [];
    const caller = createSessionRouter().createCaller({
      runtime: fixture.runtime,
      resolveRuntimeCatalog: (projectId) => {
        resolverCalls.push(projectId);
        throw new Error("the resolver must not be reached for a malformed request");
      },
      diagnostics: new RpcDiagnosticLog(),
      transport: "lab-http",
    });

    await expect(
      caller.runtimeCatalog.inspect({ adapterId: "opencode", projectId: "" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.runtimeCatalog.save({
        adapterId: "opencode",
        projectId: "  ",
        preferences: {
          version: 1,
          enabledModels: [],
          defaults: { providerId: "", modelId: "", variant: "", agent: "" },
        },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(resolverCalls).toEqual([]);
  });

  it("passes a structurally valid create command to the runtime without a session identifier", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller({
      runtime: fixture.runtime,
      diagnostics: new RpcDiagnosticLog(),
    });

    await caller.session.command({
      commandId: "create-command",
      command: { kind: "session.create", projectId: "project-1", ticketId: null, title: null },
    });

    expect(fixture.calls.command).toEqual([
      expect.objectContaining({
        commandId: "create-command",
        command: expect.objectContaining({ kind: "session.create" }),
      }),
    ]);
  });

  it("passes executor retry attachment identity to the Session runtime only when supplied", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller({
      runtime: fixture.runtime,
      diagnostics: new RpcDiagnosticLog(),
    });

    await caller.session.command({
      commandId: "retry-command",
      sessionId: "session-1",
      command: { kind: "executor.retry", attachmentId: "attachment-1" },
    });
    await caller.session.command({
      commandId: "session-owned-retry-command",
      sessionId: "session-1",
      command: { kind: "executor.retry" },
    });

    expect(fixture.calls.command.slice(-2)).toEqual([
      {
        commandId: "retry-command",
        sessionId: "session-1",
        command: { kind: "executor.retry", attachmentId: "attachment-1" },
      },
      {
        commandId: "session-owned-retry-command",
        sessionId: "session-1",
        command: { kind: "executor.retry" },
      },
    ]);
    expect("attachmentId" in fixture.calls.command.at(-1)!.command).toBe(false);
  });

  it("passes a durable model selection without adapter or profile identity", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller({
      runtime: fixture.runtime,
      diagnostics: new RpcDiagnosticLog(),
    });

    const selected = await caller.session.command({
      commandId: "select-model",
      sessionId: "session-1",
      command: {
        kind: "model.select",
        selection: {
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          reasoningLevel: "high",
        },
      },
    });

    expect(fixture.calls.command.at(-1)).toEqual({
      commandId: "select-model",
      sessionId: "session-1",
      command: {
        kind: "model.select",
        selection: {
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          reasoningLevel: "high",
        },
      },
    });
    expect(JSON.stringify(fixture.calls.command.at(-1))).not.toMatch(/adapter|profile/i);
    expect(selected).toEqual({
      sessionId: "session-1",
      receipt: null,
      throughSequence: 1,
    });
    expect(JSON.stringify(selected)).not.toMatch(/adapter|profile/i);
  });

  it("carries per-prompt answers through a resolve command and leaves absent ones absent", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller({
      runtime: fixture.runtime,
      diagnostics: new RpcDiagnosticLog(),
    });

    await caller.session.command({
      commandId: "resolve-answered",
      sessionId: "session-1",
      command: {
        kind: "interaction.resolve",
        interactionId: "question:1",
        resolution: {
          optionIds: ["prompt:0:yes", "prompt:1:no"],
          response: null,
          answers: [
            { promptId: "prompt:0", optionIds: ["prompt:0:yes"], response: null },
            { promptId: "prompt:1", optionIds: ["prompt:1:no"], response: "because" },
          ],
        },
      },
    });
    await caller.session.command({
      commandId: "resolve-flat",
      sessionId: "session-1",
      command: {
        kind: "interaction.resolve",
        interactionId: "permission:1",
        resolution: { optionIds: ["once"], response: null },
      },
    });
    // The shape Electron's structured clone delivers when a client spreads an
    // answer it did not compute: the key survives the wire, so the edge is what
    // has to drop it before the ledger tries to encode it.
    await caller.session.command({
      commandId: "resolve-undefined",
      sessionId: "session-1",
      command: {
        kind: "interaction.resolve",
        interactionId: "permission:2",
        resolution: { optionIds: ["reject"], response: null, answers: undefined },
      },
    });

    const resolutions = fixture.calls.command.map((request) =>
      request.command.kind === "interaction.resolve" ? request.command.resolution : null,
    );
    expect(resolutions[0]).toEqual({
      optionIds: ["prompt:0:yes", "prompt:1:no"],
      response: null,
      answers: [
        { promptId: "prompt:0", optionIds: ["prompt:0:yes"], response: null },
        { promptId: "prompt:1", optionIds: ["prompt:1:no"], response: "because" },
      ],
    });
    expect(resolutions[1]).toEqual({ optionIds: ["once"], response: null });
    expect(resolutions[1] && "answers" in resolutions[1]).toBe(false);
    // Not merely `answers === undefined`: the ledger encodes an intent behind a
    // strict JSON assertion that rejects an undefined value on a present key.
    expect(resolutions[2] && "answers" in resolutions[2]).toBe(false);
    expect(resolutions[2]).toEqual({ optionIds: ["reject"], response: null });
  });

  it("calls the durable runtime without retaining client prompt payloads in diagnostics", async () => {
    const fixture = runtimeFixture();
    const diagnostics = new RpcDiagnosticLog();
    const caller = createSessionRouter().createCaller({
      runtime: fixture.runtime,
      diagnostics,
      transport: "lab-http",
    });

    await caller.session.snapshot({ sessionId: "session-1" });
    await caller.session.command({
      commandId: "command-1",
      sessionId: "session-1",
      command: {
        kind: "message.submit",
        message: {
          id: "message-1",
          role: "user",
          parts: [{ type: "text", text: "private prompt" }],
        },
      },
    });
    await caller.session.refreshCapabilities({
      sessionId: "session-1",
      attachmentId: "attachment-1",
    });
    await caller.session.reconcile({ sessionId: "session-1", attachmentId: "attachment-1" });
    await caller.session.cancelInteraction({
      sessionId: "session-1",
      interactionId: "question-1",
    });
    await caller.labDiagnostics.list();

    expect(fixture.calls.command).toEqual([
      expect.objectContaining({ commandId: "command-1", sessionId: "session-1" }),
    ]);
    // The transport carries no reason of its own: what it knows is that a user
    // left the interaction undecided.
    expect(fixture.calls.cancelled).toEqual([
      { sessionId: "session-1", interactionId: "question-1", reason: "abandoned" },
    ]);
    expect(diagnostics.list().map((entry) => entry.procedure)).toEqual([
      "session.snapshot",
      "session.snapshot",
      "session.command",
      "session.command",
      "session.refreshCapabilities",
      "session.refreshCapabilities",
      "session.reconcile",
      "session.reconcile",
      "session.cancelInteraction",
      "session.cancelInteraction",
      "labDiagnostics.list",
      "labDiagnostics.list",
    ]);
    expect(JSON.stringify(diagnostics.list())).not.toContain("private prompt");
  });

  it("resumes session and diagnostic subscriptions from the latest cursor", async () => {
    const fixture = runtimeFixture();
    const diagnostics = new RpcDiagnosticLog();
    diagnostics.record({
      procedure: "old",
      phase: "success",
      transport: "unknown",
      code: null,
      message: null,
    });
    const caller = createSessionRouter().createCaller({ runtime: fixture.runtime, diagnostics });

    const sessionStream = await caller.session.subscribe({
      sessionId: "session-1",
      afterSequence: 2,
      lastEventId: "4",
    });
    const sessionIterator = sessionStream[Symbol.asyncIterator]();
    const sessionNext = sessionIterator.next();
    await Promise.resolve();
    fixture.emit(frame(5));
    const sessionValue = await sessionNext;

    const diagnosticsStream = await caller.labDiagnostics.subscribe({
      afterId: 0,
      lastEventId: "1",
    });
    const diagnosticsIterator = diagnosticsStream[Symbol.asyncIterator]();
    const diagnosticValue = await diagnosticsIterator.next();
    await sessionIterator.return?.();
    await diagnosticsIterator.return?.();

    expect(fixture.calls.subscribeAfter).toEqual([4]);
    const sessionTracked = trackedValue(sessionValue.value);
    const diagnosticTracked = trackedValue(diagnosticValue.value);
    expect(sessionTracked.id).toBe("5");
    expect(sessionTracked.data).toEqual(expect.objectContaining({ sequence: 5 }));
    expect(diagnosticTracked.id).toBe("2");
    expect(diagnosticTracked.data).toEqual(expect.objectContaining({ id: 2 }));
  });

  it("records a sanitized diagnostic when either bounded subscription queue overflows", async () => {
    const fixture = runtimeFixture();
    const diagnostics = new RpcDiagnosticLog({ capacity: 10_000 });
    const caller = createSessionRouter().createCaller({ runtime: fixture.runtime, diagnostics });

    const sessionStream = await caller.session.subscribe({
      sessionId: "session-1",
      afterSequence: 0,
    });
    const sessionIterator = sessionStream[Symbol.asyncIterator]();
    const firstSessionFrame = sessionIterator.next();
    await Promise.resolve();
    for (let sequence = 1; sequence <= 4_098; sequence += 1) fixture.emit(frame(sequence));
    await firstSessionFrame;
    await sessionIterator.return?.();

    const diagnosticStream = await caller.labDiagnostics.subscribe({ afterId: 0 });
    const diagnosticIterator = diagnosticStream[Symbol.asyncIterator]();
    const firstDiagnostic = diagnosticIterator.next();
    for (let index = 0; index <= 4_097; index += 1) {
      diagnostics.record({
        procedure: `live-${index}`,
        phase: "success",
        transport: "unknown",
        code: null,
        message: null,
      });
    }
    await firstDiagnostic;
    await diagnosticIterator.return?.();

    expect(diagnostics.list().filter(({ code }) => code === "SUBSCRIPTION_OVERFLOW")).toHaveLength(
      2,
    );
  });

  // Overflow used to end the stream the way a finished stream ends. The Electron
  // pump turned that into `{kind:"done"}`, the renderer link into
  // `observer.complete()`, and a consumer holding only `onData`/`onError` into a
  // transcript that quietly stopped moving — the drop legible nowhere but a
  // main-process log. These two assert the client is now told.
  it("ends an overflowing session subscription with an error its subscriber can catch", async () => {
    const fixture = runtimeFixture();
    const diagnostics = new RpcDiagnosticLog({ capacity: 10_000 });
    const caller = createSessionRouter().createCaller({ runtime: fixture.runtime, diagnostics });

    const stream = await caller.session.subscribe({ sessionId: "session-1" });
    const iterator = stream[Symbol.asyncIterator]();
    const firstFrame = iterator.next();
    await Promise.resolve();
    for (let sequence = 1; sequence <= 4_098; sequence += 1) fixture.emit(frame(sequence));
    await firstFrame;

    let delivered = 0;
    const drain = async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        delivered += 1;
      }
    };
    await expect(drain()).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: "Session subscription fell behind; resume from the last event id",
    });

    // Terminal, not a discard: everything the queue had buffered still reached
    // the subscriber, and only the gap after it is reported.
    expect(delivered).toBeGreaterThan(0);
    // Still recorded — the main-process log keeps its evidence either way.
    expect(diagnostics.list().filter(({ code }) => code === "SUBSCRIPTION_OVERFLOW")).toHaveLength(
      1,
    );
    expect(fixture.calls.subscribeAfter).toEqual([0]);
  });

  it("ends an overflowing diagnostics subscription with an error its subscriber can catch", async () => {
    const fixture = runtimeFixture();
    const diagnostics = new RpcDiagnosticLog({ capacity: 10_000 });
    const caller = createSessionRouter().createCaller({ runtime: fixture.runtime, diagnostics });

    const stream = await caller.labDiagnostics.subscribe({ afterId: 0 });
    const iterator = stream[Symbol.asyncIterator]();
    const firstEntry = iterator.next();
    await Promise.resolve();
    for (let index = 0; index < 4_100; index += 1) {
      diagnostics.record({
        procedure: `live-${index}`,
        phase: "success",
        transport: "unknown",
        code: null,
        message: null,
      });
    }
    await firstEntry;

    const drain = async () => {
      for (;;) {
        if ((await iterator.next()).done) return;
      }
    };
    await expect(drain()).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: "Diagnostics subscription fell behind; resume from the last event id",
    });
    expect(diagnostics.list().filter(({ code }) => code === "SUBSCRIPTION_OVERFLOW")).toHaveLength(
      1,
    );
  });

  // The other half of the overflow rule: a stream that simply ended still ends.
  // Raising on every clean close would make every teardown look like data loss.
  it("completes a subscription that ended without dropping frames, raising nothing", async () => {
    const fixture = runtimeFixture();
    const diagnostics = new RpcDiagnosticLog();
    const controller = new AbortController();
    const caller = createSessionRouter().createCaller(
      { runtime: fixture.runtime, diagnostics },
      { signal: controller.signal },
    );

    const stream = await caller.session.subscribe({ sessionId: "session-1" });
    const iterator = stream[Symbol.asyncIterator]();
    const delivered = iterator.next();
    await Promise.resolve();
    fixture.emit(frame(5));
    expect(trackedValue((await delivered).value).id).toBe("5");
    const ended = iterator.next();
    await Promise.resolve();
    controller.abort();

    expect(await ended).toEqual({ done: true, value: undefined });
    expect(diagnostics.list().filter((entry) => entry.phase === "error")).toEqual([]);
  });

  it("records sanitized failures and rejects structurally invalid commands", async () => {
    const fixture = runtimeFixture();
    fixture.runtime.snapshot = async () => {
      throw new Error('provider={"token":"super-secret"} /Users/alice/failure');
    };
    const diagnostics = new RpcDiagnosticLog();
    const caller = createSessionRouter().createCaller({ runtime: fixture.runtime, diagnostics });

    await expect(caller.session.snapshot({ sessionId: "session-1" })).rejects.toThrow();
    await expect(
      caller.session.command({
        commandId: "create-with-session",
        sessionId: "session-1",
        command: { kind: "session.create", projectId: "project-1", ticketId: null, title: null },
      }),
    ).rejects.toThrow("session.create must not include sessionId");
    await expect(
      Reflect.apply(caller.session.command, caller.session, [
        {
          commandId: "invalid-message",
          sessionId: "session-1",
          command: { kind: "message.submit", message: { id: "bad", role: "unknown", parts: [] } },
        },
      ]),
    ).rejects.toThrow("Expected an AI SDK UIMessage");
    await expect(
      Reflect.apply(caller.session.command, caller.session, [
        {
          commandId: "empty-message",
          sessionId: "session-1",
          command: { kind: "message.submit", message: { id: "bad", role: "user", parts: [] } },
        },
      ]),
    ).rejects.toThrow("Expected an AI SDK UIMessage");
    await expect(
      Reflect.apply(caller.session.command, caller.session, [
        {
          commandId: "missing-session",
          command: { kind: "adapter.release", attachmentId: "attachment-1" },
        },
      ]),
    ).rejects.toThrow("Session command requires sessionId");

    const failures = diagnostics.list().filter((entry) => entry.phase === "error");
    expect(failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ procedure: "session.snapshot", code: "INTERNAL_SERVER_ERROR" }),
      ]),
    );
    expect(JSON.stringify(failures)).not.toContain("super-secret");
    expect(JSON.stringify(failures)).toContain("[HOME]");
  });

  it("rejects whitespace identifiers and unsafe SSE resume cursors", async () => {
    const fixture = runtimeFixture();
    const diagnostics = new RpcDiagnosticLog();
    const caller = createSessionRouter().createCaller({ runtime: fixture.runtime, diagnostics });

    await expect(caller.session.snapshot({ sessionId: " " })).rejects.toThrow();
    await expect(
      caller.session.subscribe({ sessionId: "session-1", lastEventId: "9007199254740993" }),
    ).rejects.toThrow();
    await expect(
      caller.labDiagnostics.list({ afterId: Number.MAX_SAFE_INTEGER + 1 }),
    ).rejects.toThrow();
  });

  it("does not attach a runtime stream when its request was already aborted", async () => {
    const fixture = runtimeFixture();
    const diagnostics = new RpcDiagnosticLog();
    const controller = new AbortController();
    controller.abort();
    const caller = createSessionRouter().createCaller(
      { runtime: fixture.runtime, diagnostics },
      { signal: controller.signal },
    );
    const stream = await caller.session.subscribe({ sessionId: "session-1" });
    const iterator = stream[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(fixture.calls.subscribeAfter).toEqual([]);

    const diagnosticsController = new AbortController();
    diagnosticsController.abort();
    const diagnosticsCaller = createSessionRouter().createCaller(
      { runtime: fixture.runtime, diagnostics },
      { signal: diagnosticsController.signal },
    );
    const diagnosticsStream = await diagnosticsCaller.labDiagnostics.subscribe({ afterId: 0 });
    expect(await diagnosticsStream[Symbol.asyncIterator]().next()).toEqual({
      done: true,
      value: undefined,
    });
  });

  it("cleans up subscriptions that are aborted while their setup is completing", async () => {
    const fixture = runtimeFixture();
    const controller = new AbortController();
    const startSubscription = fixture.runtime.subscribe.bind(fixture.runtime);
    let completeSetup: (() => void) | undefined;
    fixture.runtime.subscribe = async (input, listener) =>
      new Promise<() => void>((resolve) => {
        completeSetup = () => void startSubscription(input, listener).then(resolve);
      });
    const caller = createSessionRouter().createCaller(
      { runtime: fixture.runtime, diagnostics: new RpcDiagnosticLog() },
      { signal: controller.signal },
    );
    const stream = await caller.session.subscribe({ sessionId: "session-1" });
    const pending = stream[Symbol.asyncIterator]().next();
    await Promise.resolve();
    controller.abort();
    completeSetup?.();

    expect(await pending).toEqual({ done: true, value: undefined });
    expect(fixture.calls.subscribeAfter).toEqual([0]);

    const diagnostics = new RpcDiagnosticLog();
    const diagnosticsController = new AbortController();
    const subscribe = diagnostics.subscribe.bind(diagnostics);
    diagnostics.subscribe = (input, listener) => {
      const unsubscribe = subscribe(input, listener);
      diagnosticsController.abort();
      return unsubscribe;
    };
    const diagnosticsCaller = createSessionRouter().createCaller(
      { runtime: fixture.runtime, diagnostics },
      { signal: diagnosticsController.signal },
    );
    const diagnosticsStream = await diagnosticsCaller.labDiagnostics.subscribe({ afterId: 0 });

    expect(await diagnosticsStream[Symbol.asyncIterator]().next()).toEqual({
      done: true,
      value: undefined,
    });
  });

  it("closes an aborted subscription without accepting late frames", async () => {
    const fixture = runtimeFixture();
    const diagnostics = new RpcDiagnosticLog();
    const controller = new AbortController();
    const caller = createSessionRouter().createCaller(
      { runtime: fixture.runtime, diagnostics },
      { signal: controller.signal },
    );
    const stream = await caller.session.subscribe({ sessionId: "session-1" });
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    await Promise.resolve();
    controller.abort();
    fixture.emit(frame(1));

    expect(await pending).toEqual({ done: true, value: undefined });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });

    const diagnosticsController = new AbortController();
    const diagnosticsCaller = createSessionRouter().createCaller(
      { runtime: fixture.runtime, diagnostics },
      { signal: diagnosticsController.signal },
    );
    const diagnosticsStream = await diagnosticsCaller.labDiagnostics.subscribe({ afterId: 999 });
    const diagnosticsPending = diagnosticsStream[Symbol.asyncIterator]().next();
    await Promise.resolve();
    diagnosticsController.abort();
    expect(await diagnosticsPending).toEqual({ done: true, value: undefined });
  });
});
