import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import type {
  CancelInteractionRequest,
  SessionRuntime,
  SessionRuntimeCommandRequest,
  SessionRuntimeSnapshot,
  SessionStreamCompactionProgress,
  SessionStreamEmission,
  SessionStreamFrame,
  SessionStreamOverlay,
} from "@volli/session-engine";
import {
  CODE_MODE_POLICY_MODELS_MAX,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  EMPTY_SESSION_USAGE_SUMMARY,
} from "@volli/shared";
import type { CommandReceipt, CommandRefusalSeverity, ExperimentSnapshot } from "@volli/shared";
import type { HostReceiptStatus } from "@volli/host-protocol";
import {
  AsyncQueue,
  createSessionRouter,
  LOCAL_DESKTOP_CALLER,
  logRpcDiagnostics,
  RpcDiagnosticLog,
  sanitizeDiagnosticText,
  type AppRouter,
  type JsonUnsafeProcedures,
  type SessionRouterJsonSafety,
} from "./index";
import { sessionContext } from "./session-handlers.test-support";

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
          role: "project",
          parentSessionId: null,
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
    authority: null,
    status: "open",
    openedAt: 10,
    closedAt: null,
    outcome: null,
    failure: null,
    exitCode: null,
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
      modelTier: "fast",
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

function observedFrame(): SessionStreamFrame {
  const base = frameWithPayload(11, {
    kind: "adapter.observed",
    attachmentId: "attachment-1",
    name: "runtime observation",
    native: { credentialPath: RECOVERY_PATH },
  });
  return {
    ...base,
    event: {
      ...base.event,
      provenance: {
        source: { kind: "adapter", id: "pi", detail: { credentialPath: RECOVERY_PATH } },
        venue: null,
      },
    },
  };
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
    authority: attachment.authority,
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
    observedFrame(),
    frameWithPayload(12, { kind: "command.recorded", command: modelCommand() }),
  ];
}

/**
 * A transcript carrying `value` in a message part: the transcript's open JSON,
 * the one place a value no envelope field names can ride (VC-315).
 */
function transcriptWith(value: unknown) {
  return {
    version: 1,
    threadId: "thread",
    branchId: "branch",
    attemptId: "attempt",
    turnId: null,
    message: { id: "m", role: "assistant", parts: [{ type: "text", text: "", extra: value }] },
  };
}

function snapshot(): SessionRuntimeSnapshot {
  return {
    projection: {
      session: {
        id: "session-1",
        projectId: "project-1",
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: null,
        createdAt: 10,
      },
      status: "open",
      commands: [],
      resumptions: [],
      latestTurnId: null,
      latestTurnOrigin: null,
      resumedAfterStop: false,
      receipts: [],
      pendingExecutorStart: null,
      attachments: [],
      liveExecutor: null,
      attention: { active: [], primary: null },
      interactions: { active: [], resolved: [] },
      signal: null,
      stopped: null,
      modelSelection: null,
      modelTier: null,
      turnActive: false,
      lastTurnOutcome: null,
      usage: EMPTY_SESSION_USAGE_SUMMARY,
      lastActivityAt: 10,
      bornTicketless: true,
    },
    throughSequence: 4,
    frames: [frame(4)],
    before: null,
    transcript: [],
    latestReply: null,
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

function compactionProgress(throughSequence: number): SessionStreamCompactionProgress {
  return {
    kind: "compaction",
    sessionId: "session-1",
    throughSequence,
    state: "started",
    reason: "manual",
  };
}

function trackedValue(value: unknown): { id: string; data: unknown } {
  expect(Array.isArray(value)).toBe(true);
  if (!Array.isArray(value)) throw new Error("Expected a tracked SSE envelope");
  const [id, data] = value;
  if (typeof id !== "string") throw new Error("Expected a tracked SSE identifier");
  return { id, data };
}

function runtimeFixture(refusal: CommandRefusalSeverity | null = null): {
  runtime: SessionRuntime;
  calls: {
    command: SessionRuntimeCommandRequest[];
    subscribeAfter: number[];
    cancelled: CancelInteractionRequest[];
  };
  emit: (next: SessionStreamEmission) => void;
  fail: (error: unknown) => void;
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
  let failListener: ((error: unknown) => void) | null = null;
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
          intent: {
            kind: "session.create",
            projectId: "project-1",
            ticketId: null,
            role: "project",
            parentSessionId: null,
            title: null,
          },
          route: null,
        },
        receipt: null,
        throughSequence: 1,
        refusal,
      };
    },
    snapshot: async () => snapshot(),
    history: async ({ before }) => ({
      frames: [frame(before - 1)],
      before: before > 2 ? before - 1 : null,
    }),
    projection: async () => {
      const { projection, throughSequence } = snapshot();
      return { projection, throughSequence };
    },
    subscribe: async (input, next, onFailure) => {
      calls.subscribeAfter.push(input.afterSequence);
      listener = (value) => void next(value);
      failListener = onFailure ?? null;
      return () => {
        listener = null;
        failListener = null;
      };
    },
    cancelInteraction: async (request) => {
      calls.cancelled.push(request);
    },
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
    fail: (error) => {
      if (!failListener) throw new Error("Subscription is not listening for failures");
      failListener(error);
    },
  };
}

// `IsJsonSafe` and the receipt vocabulary are specified in `@volli/host-protocol`;
// these are the seams where this router is held to them (`docs/BOUNDARIES.md` rule 3).
describe("the Session router's host protocol seams", () => {
  it("guards every raw input and output published by AppRouter", () => {
    expectTypeOf<JsonUnsafeProcedures<AppRouter>>().toEqualTypeOf<never>();
    expectTypeOf<SessionRouterJsonSafety>().toEqualTypeOf<never>();
  });

  it("answers commands in the receipt vocabulary the host protocol names", () => {
    expectTypeOf<CommandReceipt["status"]>().toEqualTypeOf<HostReceiptStatus>();
  });
});

describe("logRpcDiagnostics (VC-699)", () => {
  it("forwards each call from now on: start and answer at debug, a failure at warn", () => {
    const diagnostics = new RpcDiagnosticLog();
    diagnostics.record({
      procedure: "old",
      phase: "start",
      transport: "websocket",
      code: null,
      message: null,
    });
    const lines: [string, string, Readonly<Record<string, unknown>>][] = [];
    const stop = logRpcDiagnostics(diagnostics, {
      debug: (msg, fields) => lines.push(["debug", msg, fields]),
      warn: (msg, fields) => lines.push(["warn", msg, fields]),
    });
    const at = { procedure: "session.command", transport: "websocket" as const };
    diagnostics.record({ ...at, phase: "start", code: null, message: null });
    diagnostics.record({ ...at, phase: "success", code: null, message: null });
    diagnostics.record({ ...at, phase: "error", code: "FORBIDDEN", message: "token=abc refused" });
    stop();
    diagnostics.record({ ...at, phase: "start", code: null, message: null });
    expect(lines).toStrictEqual([
      ["debug", "rpc call", { operation: "session.command", transport: "websocket" }],
      ["debug", "rpc call answered", { operation: "session.command", transport: "websocket" }],
      [
        "warn",
        "rpc call failed",
        {
          operation: "session.command",
          transport: "websocket",
          code: "FORBIDDEN",
          reason: "token: [REDACTED] refused",
        },
      ],
    ]);
  });

  it("starts from the beginning of an empty log", () => {
    const diagnostics = new RpcDiagnosticLog();
    const seen: string[] = [];
    logRpcDiagnostics(diagnostics, {
      debug: (msg) => seen.push(msg),
      warn: (msg) => seen.push(msg),
    });
    diagnostics.record({
      procedure: "p",
      phase: "start",
      transport: "websocket",
      code: null,
      message: null,
    });
    expect(seen).toStrictEqual(["rpc call"]);
  });
});

describe("RpcDiagnosticLog", () => {
  it("bounds entries, replays in order, and removes sensitive diagnostics", () => {
    let now = 0;
    const log = new RpcDiagnosticLog({ capacity: 2, now: () => ++now });
    const sensitive = log.record({
      procedure: "session.command",
      phase: "error",
      transport: "electron-ipc",
      code: "INTERNAL_SERVER_ERROR",
      message:
        'token=super-secret prompt="do not leak" provider={"raw":"body"} /Users/alice/private.txt',
    });
    log.record({
      procedure: "session.snapshot",
      phase: "success",
      transport: "electron-ipc",
      code: null,
      message: null,
    });
    const delivered: number[] = [];
    const unsubscribe = log.subscribe({ afterId: 0 }, (entry) => delivered.push(entry.id));
    log.record({
      procedure: "session.reconcile",
      phase: "start",
      transport: "electron-ipc",
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
  it("reads and writes experimental flags through the registry-backed settings routes", async () => {
    const fixture = runtimeFixture();
    const writes: { id: string; enabled: boolean }[] = [];
    let experimentSnapshot: ExperimentSnapshot = {
      cloud: { enabled: false, source: "default" },
    };
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        readExperiments: () => experimentSnapshot,
        writeExperiment: (id, enabled) => {
          writes.push({ id, enabled });
          experimentSnapshot = { cloud: { enabled, source: "storage" } };
          return experimentSnapshot;
        },
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    await expect(caller.settings.experiments()).resolves.toEqual({
      cloud: { enabled: false, source: "default" },
    });
    await expect(caller.settings.setExperiment({ id: "cloud", enabled: true })).resolves.toEqual({
      cloud: { enabled: true, source: "storage" },
    });
    expect(writes).toEqual([{ id: "cloud", enabled: true }]);
  });

  it("rejects unknown experiment ids, non-booleans, and non-JSON-safe snapshots", async () => {
    const fixture = runtimeFixture();
    const writes: unknown[] = [];
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        readExperiments: () => ({ cloud: { enabled: false, source: "default" } }),
        writeExperiment: (id, enabled) => {
          writes.push({ id, enabled });
          return { cloud: { enabled, source: "storage" } };
        },
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    await expect(
      caller.settings.setExperiment({ id: "unknown", enabled: true } as never),
    ).rejects.toThrow();
    await expect(
      caller.settings.setExperiment({ id: 42, enabled: true } as never),
    ).rejects.toThrow();
    await expect(
      caller.settings.setExperiment({ id: "cloud", enabled: "true" } as never),
    ).rejects.toThrow();
    expect(writes).toEqual([]);

    const invalidSnapshot = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        readExperiments: () => ({ cloud: { enabled: "false", source: "unknown" } }) as never,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );
    await expect(invalidSnapshot.settings.experiments()).rejects.toThrow();
  });

  it("reports when experimental settings callbacks are unavailable", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    await expect(caller.settings.experiments()).rejects.toThrow(
      "Experimental settings are unavailable",
    );
    await expect(caller.settings.setExperiment({ id: "cloud", enabled: true })).rejects.toThrow(
      "Experimental settings are unavailable",
    );
  });

  it("carries the host queue and its independent revision through projection reads", async () => {
    const fixture = runtimeFixture();
    const queue = [
      {
        id: "q",
        commandId: "queued",
        state: "queued" as const,
        message: {
          id: "q",
          role: "user" as const,
          parts: [{ type: "text" as const, text: "follow up" }],
        },
      },
    ];
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: {
          ...fixture.runtime,
          projection: async (input) => {
            const base = await fixture.runtime.projection(input);
            return { ...base, projection: { ...base.projection, queue, queueRevision: 7 } };
          },
        },
        diagnostics: new RpcDiagnosticLog(),
      }),
    );
    expect((await caller.session.projection({ sessionId: "session-1" })).projection).toMatchObject({
      queue,
      queueRevision: 7,
    });
  });

  it.each([false, true])(
    "only publishes queue fields to negotiated network peers (queue=%s)",
    async (queueAware) => {
      const fixture = runtimeFixture();
      const base = snapshot();
      const queuedSnapshot = {
        ...base,
        projection: { ...base.projection, queue: [], queueRevision: 7 },
      };
      const caller = createSessionRouter().createCaller({
        ...sessionContext({
          caller: LOCAL_DESKTOP_CALLER,
          diagnostics: new RpcDiagnosticLog(),
          runtime: {
            ...fixture.runtime,
            snapshot: async () => queuedSnapshot,
            projection: async () => queuedSnapshot,
          },
        }),
        operations: new Set([
          "session.snapshot",
          "session.projection",
          ...(queueAware ? ["session.cancelQueued"] : []),
        ]),
      });
      for (const read of [caller.session.snapshot, caller.session.projection]) {
        const answer = await read({ sessionId: "session-1" });
        if (queueAware) expect(answer.projection).toMatchObject({ queue: [], queueRevision: 7 });
        else {
          expect(answer.projection).not.toHaveProperty("queue");
          expect(answer.projection).not.toHaveProperty("queueRevision");
        }
      }
    },
  );

  it("preserves a minimal runtime projection without inventing attachment state", async () => {
    const fixture = runtimeFixture();
    const runtime: SessionRuntime = {
      ...fixture.runtime,
      projection: async () => ({ projection: {}, throughSequence: 4 }) as never,
    };
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    await expect(caller.session.projection({ sessionId: "session-1" })).resolves.toEqual({
      projection: {},
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
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    const resolved = await caller.session.projection({ sessionId: "session-1" });

    expect(Object.keys(resolved.projection).toSorted()).toEqual([
      "attention",
      "bornTicketless",
      "interactions",
      "lastActivityAt",
      "liveExecutor",
      "modelSelection",
      "modelTier",
      "scheduledResume",
      "session",
      "signal",
      "status",
      "turnActive",
    ]);
    // Derived from the commands and receipts that never cross this edge.
    expect(resolved.projection.scheduledResume).toBeNull();
    expect(resolved.projection.liveExecutor).toEqual({ id: "attachment-1" });
    // The tier the model resolved from crosses whole (VC-259): it is the
    // user's own vocabulary, and the header reads it beside the model.
    expect(resolved.projection.modelTier).toBe("fast");
    expect(resolved.projection.interactions.active[0]?.native).toEqual({ id: null, detail: null });
    expect(serverSnapshot.projection.attachments[0]?.native).toEqual(recoveryNative());
    expect(serverSnapshot.projection.liveExecutor?.native).toEqual(recoveryNative());
  });

  it("pages older history with the same scrub as the snapshot, and passes its cursors through (VC-315)", async () => {
    const fixture = runtimeFixture();
    const requests: { sessionId: string; before: number }[] = [];
    const runtime: SessionRuntime = {
      ...fixture.runtime,
      snapshot: async () => ({ ...snapshot(), before: 5 }),
      history: async (input) => {
        requests.push(input);
        return { frames: attachmentFrames(), before: 3 };
      },
    };
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    await expect(caller.session.snapshot({ sessionId: "session-1" })).resolves.toMatchObject({
      before: 5,
      frames: [{ sequence: 4 }],
    });
    expect(
      await caller.session
        .snapshot({ sessionId: "session-1" })
        .then((value) => "transcript" in value),
    ).toBe(false);
    const page = await caller.session.history({ sessionId: "session-1", before: 5 });

    expect(requests).toEqual([{ sessionId: "session-1", before: 5 }]);
    expect(page.before).toBe(3);
    expect(page.frames.map(({ sequence }) => sequence)).toEqual(
      attachmentFrames().map(({ sequence }) => sequence),
    );
    const opened = page.frames[0]?.event.payload;
    expect(opened?.kind === "attachment.opened" && "native" in opened.attachment).toBe(false);
    await expect(caller.session.history({ sessionId: "session-1", before: 0 })).rejects.toThrow();
    await expect(caller.session.history({ sessionId: "session-1", before: 1.5 })).rejects.toThrow();
  });

  it("hands a surface the plan and the current reply a window cannot hold (VC-315)", async () => {
    const fixture = runtimeFixture();
    const todoList = [{ content: "Finish migration", status: "in_progress" as const }];
    const runtime: SessionRuntime = {
      ...fixture.runtime,
      snapshot: async () => ({
        ...snapshot(),
        projection: { ...snapshot().projection, todoList },
        latestReply: { sequence: 2, text: "Current-turn reply" },
      }),
    };
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    await expect(caller.session.snapshot({ sessionId: "session-1" })).resolves.toMatchObject({
      projection: { todoList },
      latestReply: { sequence: 2, text: "Current-turn reply" },
    });
  });

  it("refuses a history page whose frames would not survive a JSON wire (VC-315)", async () => {
    const fixture = runtimeFixture();
    const cyclic: Record<string, unknown> = { kind: "cyclic" };
    cyclic.self = cyclic;
    const unsafe: unknown[] = [
      Number.NaN,
      () => undefined,
      new Date(0),
      new Map(),
      cyclic,
      [1, Number.POSITIVE_INFINITY],
    ];
    const pageWith = (value: unknown) => ({
      frames: [{ ...frame(2), transcript: transcriptWith(value) }],
      before: null,
    });
    const callerFor = (page: unknown) =>
      createSessionRouter().createCaller(
        sessionContext({
          caller: LOCAL_DESKTOP_CALLER,
          runtime: { ...fixture.runtime, history: async () => page as never },
          diagnostics: new RpcDiagnosticLog(),
        }),
      );
    for (const value of unsafe) {
      await expect(
        callerFor(pageWith(value)).session.history({ sessionId: "session-1", before: 3 }),
        String(value),
      ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    }
    // A cursor that is not one is refused too.
    await expect(
      callerFor({ frames: [], before: 0 }).session.history({ sessionId: "session-1", before: 3 }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    // Plain JSON passes, nested arrays and all.
    await expect(
      callerFor(pageWith([1, "two", true, null])).session.history({
        sessionId: "session-1",
        before: 3,
      }),
    ).resolves.toMatchObject({ frames: [{ sequence: 2, transcript: { message: { id: "m" } } }] });
  });

  it("removes runtime identity and recovery locators from snapshot projections and replay frames", async () => {
    const fixture = runtimeFixture();
    const serverSnapshot = { ...snapshotWithRecovery(), frames: attachmentFrames() };
    const runtime: SessionRuntime = { ...fixture.runtime, snapshot: async () => serverSnapshot };
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    const resolved = await caller.session.snapshot({ sessionId: "session-1" });
    const payloads = resolved.frames.map((item) => item.event.payload);

    expect(Object.keys(resolved.projection).toSorted()).toEqual([
      "attention",
      "bornTicketless",
      "interactions",
      "lastActivityAt",
      "liveExecutor",
      "modelSelection",
      "modelTier",
      "scheduledResume",
      "session",
      "signal",
      "status",
      "turnActive",
    ]);
    expect(resolved.projection.liveExecutor).toEqual({ id: "attachment-1" });
    // The replayed `attachment.opened` frame still carries no policy: the
    // summary rides the projection, and the attachment shape is unchanged.
    expect(
      payloads[0]?.kind === "attachment.opened" ? "authority" in payloads[0].attachment : undefined,
    ).toBe(false);
    expect(
      payloads[0]?.kind === "attachment.opened" ? "native" in payloads[0].attachment : undefined,
    ).toBe(false);
    expect(
      payloads[0]?.kind === "attachment.opened" ? "adapterId" in payloads[0].attachment : undefined,
    ).toBe(false);
    expect(
      payloads[1]?.kind === "attachment.native_referenced" ? payloads[1].native : undefined,
    ).toEqual({
      id: null,
      detail: null,
    });
    expect(
      payloads[2]?.kind === "attachment.failed" ? "native" in payloads[2].attachment : undefined,
    ).toBe(false);
    expect(
      payloads[3]?.kind === "interaction.opened" ? payloads[3].interaction.native : undefined,
    ).toEqual({ id: null, detail: null });
    expect(serverSnapshot.frames.map((item) => item.event.payload)).toEqual(
      attachmentFrames().map((item) => item.event.payload),
    );
  });

  it("removes runtime identity and recovery locators from subscribed frames", async () => {
    const fixture = runtimeFixture();
    const serverFrames = attachmentFrames();
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );
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
      payloads[0]?.kind === "attachment.opened" ? "native" in payloads[0].attachment : undefined,
    ).toBe(false);
    expect(
      payloads[0]?.kind === "attachment.opened" ? "adapterId" in payloads[0].attachment : undefined,
    ).toBe(false);
    expect(
      payloads[1]?.kind === "attachment.native_referenced" ? payloads[1].native : undefined,
    ).toEqual({
      id: null,
      detail: null,
    });
    expect(
      payloads[2]?.kind === "attachment.failed" ? "native" in payloads[2].attachment : undefined,
    ).toBe(false);
    expect(
      payloads[3]?.kind === "interaction.opened" ? payloads[3].interaction.native : undefined,
    ).toEqual({ id: null, detail: null });
    expect(serverFrames.map((item) => item.event.payload)).toEqual(
      attachmentFrames().map((item) => item.event.payload),
    );
  });

  it("yields a transient overlay beside durable frames, leaving both exactly as published", async () => {
    const fixture = runtimeFixture();
    const diagnostics = new RpcDiagnosticLog();
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics,
      }),
    );

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

  it("yields a transient compaction marker at its durable cursor", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );
    const stream = await caller.session.subscribe({ sessionId: "session-1" });
    const iterator = stream[Symbol.asyncIterator]();

    const pending = iterator.next();
    await Promise.resolve();
    fixture.emit(compactionProgress(5));
    const transient = trackedValue((await pending).value);
    await iterator.return?.();

    expect(transient.id).toBe("5");
    expect(transient.data).toEqual(compactionProgress(5));
  });

  it("answers a projection read with Session state alone and no transcript replay", async () => {
    const fixture = runtimeFixture();
    const base = snapshot();
    const runtime: SessionRuntime = {
      ...fixture.runtime,
      projection: async () => ({ projection: base.projection, throughSequence: 9 }),
    };
    const diagnostics = new RpcDiagnosticLog();
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime,
        diagnostics,
      }),
    );

    const resolved = await caller.session.projection({ sessionId: "session-1" });

    expect(Object.keys(resolved).toSorted()).toEqual(["projection", "throughSequence"]);
    expect(resolved.throughSequence).toBe(9);
    expect(diagnostics.list().map((entry) => `${entry.procedure}:${entry.phase}`)).toEqual([
      "session.projection:start",
      "session.projection:success",
    ]);
  });

  it("reports router, validation, and handler time without retaining payloads", async () => {
    const fixture = runtimeFixture();
    const samples: unknown[] = [];
    let now = 20;
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics: new RpcDiagnosticLog(),
        performanceObserver: {
          now: () => (now += 3),
          record: (sample) => samples.push(sample),
        },
      }),
    );

    await caller.session.projection({ sessionId: "session-private" });

    expect(samples).toEqual([
      {
        procedure: "session.projection",
        durationMs: 3,
        outcome: "success",
      },
    ]);
    expect(JSON.stringify(samples)).not.toContain("session-private");
  });

  it("isolates procedure behavior from optional observer clock and record failures", async () => {
    const fixture = runtimeFixture();
    const defaultClockSamples: unknown[] = [];
    const defaultClockCaller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics: new RpcDiagnosticLog(),
        performanceObserver: { record: (sample) => defaultClockSamples.push(sample) },
      }),
    );
    await expect(
      defaultClockCaller.session.projection({ sessionId: "session-default-clock" }),
    ).resolves.toBeDefined();
    expect(defaultClockSamples).toHaveLength(1);

    const throwingCaller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics: new RpcDiagnosticLog(),
        performanceObserver: {
          now: () => {
            throw new Error("clock failed");
          },
          record: () => {
            throw new Error("record failed");
          },
        },
      }),
    );
    await expect(
      throwingCaller.session.projection({ sessionId: "session-throwing-observer" }),
    ).resolves.toBeDefined();
  });

  it("skips a procedure sample when either performance clock read fails", async () => {
    for (const failedRead of [1, 2]) {
      const fixture = runtimeFixture();
      const samples: unknown[] = [];
      let reads = 0;
      const caller = createSessionRouter().createCaller(
        sessionContext({
          caller: LOCAL_DESKTOP_CALLER,
          runtime: fixture.runtime,
          diagnostics: new RpcDiagnosticLog(),
          performanceObserver: {
            now: () => {
              reads += 1;
              if (reads === failedRead) throw new Error("clock failed");
              return reads;
            },
            record: (sample) => samples.push(sample),
          },
        }),
      );

      await expect(
        caller.session.projection({ sessionId: "session-clock-failure" }),
      ).resolves.toBeDefined();
      expect(samples).toEqual([]);
    }
  });

  it("exposes Model Access without adapter, profile, or credential inputs", async () => {
    const fixture = runtimeFixture();
    const calls: unknown[] = [];
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        inspectModelAccess: async (input) => {
          calls.push(input);
          return {
            observedAt: 42,
            refresh: {
              added: 1,
              removed: 2,
              rejected: 3,
              refreshedProviderIds: ["openai-codex"],
              failedProviderIds: ["anthropic"],
            },
            credentialToken: "root-secret",
            providers: [
              {
                id: "openai-codex",
                label: "OpenAI Codex",
                state: "available" as const,
                accountLabel: "OAuth",
                billingSource: "ambient" as const,
                recovery: null,
                signIn: [],
                hasStoredCredential: false,
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
                acceptsImageInput: true,
                headers: { authorization: "model-secret" },
              },
            ],
          };
        },
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    const access = await caller.modelAccess.inspect({ refresh: true });

    expect(calls).toEqual([{ refresh: true }]);
    expect(access.models[0]).toMatchObject({
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
    });
    expect(Object.keys(access).toSorted()).toEqual([
      "models",
      "observedAt",
      "providers",
      "refresh",
    ]);
    expect(access.refresh).toEqual({
      added: 1,
      removed: 2,
      rejected: 3,
      refreshedProviderIds: ["openai-codex"],
      failedProviderIds: ["anthropic"],
    });
    expect(Object.keys(access.providers[0]!).toSorted()).toEqual([
      "accountLabel",
      "billingSource",
      "hasStoredCredential",
      "id",
      "label",
      "recovery",
      "signIn",
      "state",
    ]);
    expect(Object.keys(access.models[0]!).toSorted()).toEqual([
      "acceptsImageInput",
      "label",
      "modelId",
      "providerId",
      "reasoningLevels",
      "state",
    ]);
    // `hasStoredCredential` is itself a legitimate field name (not a leak) —
    // strip it before checking that no other adapter/profile/credential/token
    // shaped secret survived parsing.
    expect(JSON.stringify(access).replaceAll('"hasStoredCredential"', "")).not.toMatch(
      /adapter|profile|credential|token/i,
    );
  });

  it("sanitizes a whitespace-padded catalog label instead of rejecting the whole snapshot", async () => {
    // A live upstream model catalog is not an identifier Volli minted — it is
    // under no obligation to trim its own display text, and a large one
    // (observed: 1000+ entries) has shipped labels with incidental
    // surrounding whitespace. `nonEmptyString`'s "no surrounding whitespace"
    // refinement is the right contract for providerId/modelId (Volli's own
    // identifiers); reusing it for `label` used to fail `.parse()` on the
    // ENTIRE snapshot over one cosmetic entry, which broke every Model
    // Access caller (composer, Settings, `setDefault`'s availability check).
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        inspectModelAccess: async () => ({
          observedAt: 42,
          providers: [
            {
              id: "openai-codex",
              label: "  OpenAI Codex  ",
              state: "available" as const,
              accountLabel: "OAuth",
              billingSource: "ambient" as const,
              recovery: null,
              signIn: [],
              hasStoredCredential: false,
            },
          ],
          models: [
            {
              providerId: "openai-codex",
              modelId: "gpt-5.6-sol",
              label: "  GPT-5.6 Sol  ",
              state: "available" as const,
              reasoningLevels: ["off", "low", "medium", "high"] as const,
              acceptsImageInput: true,
            },
          ],
        }),
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    const access = await caller.modelAccess.inspect({});

    expect(access.providers[0]?.label).toBe("OpenAI Codex");
    expect(access.models[0]?.label).toBe("GPT-5.6 Sol");
  });

  it("names an entry whose label is unusable rather than dropping the catalog", async () => {
    // Trimming alone still left one bad entry able to take the whole snapshot
    // down: an empty, whitespace-only or absurdly long label failed the
    // length bound and `.parse()` threw for all 1000+ of them. There is no
    // label worth showing in any of the three cases, so all three answer the
    // same way — the entry's own identity — and the catalog survives.
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        inspectModelAccess: async () => ({
          observedAt: 42,
          providers: [
            {
              id: "openai-codex",
              label: "",
              state: "available" as const,
              accountLabel: null,
              billingSource: "ambient" as const,
              recovery: null,
              signIn: [],
              hasStoredCredential: false,
            },
            {
              id: "anthropic",
              label: "x".repeat(513),
              state: "available" as const,
              accountLabel: null,
              billingSource: "api-key" as const,
              recovery: null,
              signIn: [],
              hasStoredCredential: false,
            },
          ],
          models: [
            {
              providerId: "openai-codex",
              modelId: "gpt-5.6-sol",
              label: "   ",
              state: "available" as const,
              reasoningLevels: ["off", "high"] as const,
              acceptsImageInput: true,
            },
            {
              providerId: "anthropic",
              modelId: "claude-opus-5",
              label: "y".repeat(513),
              state: "available" as const,
              reasoningLevels: ["off"] as const,
              acceptsImageInput: false,
            },
            {
              providerId: "anthropic",
              modelId: "claude-sonnet-5",
              label: "Claude Sonnet 5",
              state: "available" as const,
              reasoningLevels: ["off"] as const,
              acceptsImageInput: true,
            },
          ],
        }),
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    const access = await caller.modelAccess.inspect({});

    expect(access.providers.map((provider) => provider.label)).toEqual([
      "openai-codex",
      "anthropic",
    ]);
    expect(access.models.map((model) => model.label)).toEqual([
      "openai-codex/gpt-5.6-sol",
      "anthropic/claude-opus-5",
      // The good entries beside them are untouched, which is the whole point.
      "Claude Sonnet 5",
    ]);
  });

  it("carries an account's usage limits across the edge, and only the fields it knows", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        inspectModelAccess: async () => ({
          observedAt: 42,
          providers: [
            {
              id: "anthropic",
              label: "Anthropic",
              state: "available" as const,
              accountLabel: null,
              billingSource: "subscription" as const,
              recovery: null,
              signIn: [],
              hasStoredCredential: true,
              usageLimits: {
                checkedAt: 41,
                windows: [
                  {
                    id: "five_hour",
                    kind: "session" as const,
                    label: "Session",
                    usedPercent: 37,
                    resetsAt: "2026-03-01T14:00:00.000Z",
                    windowDurationMins: 300,
                    rawHeaders: { authorization: "leak" },
                  },
                  { id: "seven_day", kind: "weekly" as const, label: "Weekly", usedPercent: 4 },
                ],
              },
            },
            {
              id: "openai-codex",
              label: "OpenAI Codex",
              state: "available" as const,
              accountLabel: null,
              billingSource: "unknown" as const,
              recovery: null,
              signIn: [],
              hasStoredCredential: true,
              usageLimits: {
                checkedAt: 40,
                windows: [],
                unavailable: { reason: "unsupported" as const },
              },
            },
          ],
          models: [],
        }),
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    const access = await caller.modelAccess.inspect({});

    expect(access.providers[0]?.usageLimits).toEqual({
      checkedAt: 41,
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 37,
          resetsAt: "2026-03-01T14:00:00.000Z",
          windowDurationMins: 300,
        },
        { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 4 },
      ],
    });
    expect(access.providers[1]?.usageLimits).toEqual({
      checkedAt: 40,
      windows: [],
      unavailable: { reason: "unsupported" },
    });
    expect(JSON.stringify(access)).not.toMatch(/leak|rawHeaders/);
  });

  it("reads and writes the per-purpose defaults through an exact safe shape", async () => {
    const fixture = runtimeFixture();
    const writes: unknown[] = [];
    const stored = {
      ...EMPTY_MODEL_ACCESS_DEFAULTS,
      global: {
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        reasoningLevel: "high" as const,
        credential: "must-not-cross",
      },
    };
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        readModelAccessDefaults: () => stored,
        writeModelAccessDefault: (purpose, selection) => {
          writes.push({ purpose, selection });
          return { ...stored, ticket: selection };
        },
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    const current = await caller.modelAccess.defaults();
    const afterWrite = await caller.modelAccess.setDefault({
      purpose: "ticket",
      selection: { providerId: "anthropic", modelId: "claude-sonnet", reasoningLevel: "medium" },
    });

    // The stray credential on the stored value never crosses the edge.
    expect(current).toEqual({
      ...EMPTY_MODEL_ACCESS_DEFAULTS,
      global: { providerId: "openai-codex", modelId: "gpt-5.6-sol", reasoningLevel: "high" },
    });
    expect(writes).toEqual([
      {
        purpose: "ticket",
        selection: { providerId: "anthropic", modelId: "claude-sonnet", reasoningLevel: "medium" },
      },
    ]);
    expect(afterWrite.ticket).toEqual({
      providerId: "anthropic",
      modelId: "claude-sonnet",
      reasoningLevel: "medium",
    });

    // Clearing an execution default is allowed — it resolves to global — but
    // clearing the global one would leave nothing to resolve to anywhere.
    await caller.modelAccess.setDefault({ purpose: "utility", selection: null });
    await expect(
      caller.modelAccess.setDefault({ purpose: "global", selection: null }),
    ).rejects.toThrow("cannot be cleared");
  });

  it("round-trips the curated hidden-model list as identity pairs only", async () => {
    const fixture = runtimeFixture();
    const writes: unknown[] = [];
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        readHiddenModels: () => [{ providerId: "anthropic", modelId: "claude-haiku" }],
        writeHiddenModels: (hidden) => {
          writes.push(hidden);
        },
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    await expect(caller.modelAccess.hiddenModels()).resolves.toEqual([
      { providerId: "anthropic", modelId: "claude-haiku" },
    ]);
    await expect(
      caller.modelAccess.setHiddenModels([{ providerId: "openai", modelId: "gpt-5.6-luna" }]),
    ).resolves.toEqual([{ providerId: "openai", modelId: "gpt-5.6-luna" }]);
    expect(writes).toEqual([[{ providerId: "openai", modelId: "gpt-5.6-luna" }]]);
  });

  it("round-trips the compaction policy whole", async () => {
    const fixture = runtimeFixture();
    const writes: unknown[] = [];
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        readCompactionPolicy: () => ({ autoCompaction: true }),
        writeCompactionPolicy: (policy) => {
          writes.push(policy);
          return policy;
        },
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    await expect(caller.modelAccess.compactionPolicy()).resolves.toEqual({
      autoCompaction: true,
    });

    const saved = { autoCompaction: false };
    await expect(caller.modelAccess.setCompactionPolicy(saved)).resolves.toEqual(saved);
    expect(writes).toEqual([saved]);
  });

  it("says so rather than inventing a policy when preferences are unavailable", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    await expect(caller.modelAccess.compactionPolicy()).rejects.toThrow("unavailable");
    await expect(caller.modelAccess.setCompactionPolicy({ autoCompaction: true })).rejects.toThrow(
      "unavailable",
    );
    await expect(caller.modelAccess.pickerView()).rejects.toThrow("unavailable");
    await expect(caller.modelAccess.setPickerView("defaults")).rejects.toThrow("unavailable");
    await expect(caller.modelAccess.codeModePolicy()).rejects.toThrow("unavailable");
    await expect(
      caller.modelAccess.setCodeModePolicy({ enabled: true, models: {} }),
    ).rejects.toThrow("unavailable");
  });

  it("round-trips the Code Mode policy whole — the switch and every pin", async () => {
    const fixture = runtimeFixture();
    const writes: unknown[] = [];
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        readCodeModePolicy: () => ({
          enabled: true,
          models: { "anthropic/claude-sonnet-4-5": "only" },
        }),
        writeCodeModePolicy: (policy) => {
          writes.push(policy);
          return policy;
        },
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    await expect(caller.modelAccess.codeModePolicy()).resolves.toEqual({
      enabled: true,
      models: { "anthropic/claude-sonnet-4-5": "only" },
    });

    // A routed model id carries its own slash; the key splits at the first.
    const saved = {
      enabled: false,
      models: {
        "openai-codex/gpt-5.5": "both" as const,
        "openrouter/z-ai/glm-4.6": "off" as const,
      },
    };
    await expect(caller.modelAccess.setCodeModePolicy(saved)).resolves.toEqual(saved);
    expect(writes).toEqual([saved]);
  });

  it("refuses a Code Mode policy storage would quietly drop part of", async () => {
    const fixture = runtimeFixture();
    const writes: unknown[] = [];
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        writeCodeModePolicy: (policy) => {
          writes.push(policy);
          return policy;
        },
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    // A mode the shared vocabulary does not name.
    await expect(
      caller.modelAccess.setCodeModePolicy({
        enabled: true,
        models: { "anthropic/claude-opus-4-5": "sometimes" as never },
      }),
    ).rejects.toThrow();
    // Keys that are not `providerId/modelId`.
    for (const key of ["claude-opus-4-5", "/claude-opus-4-5", "anthropic/", ""]) {
      await expect(
        caller.modelAccess.setCodeModePolicy({ enabled: true, models: { [key]: "both" } }),
      ).rejects.toThrow();
    }
    // More pins than a stored policy may hold.
    const tooMany = Object.fromEntries(
      Array.from({ length: CODE_MODE_POLICY_MODELS_MAX + 1 }, (_, index) => [
        `acme/model-${index}`,
        "both" as const,
      ]),
    );
    await expect(
      caller.modelAccess.setCodeModePolicy({ enabled: true, models: tooMany }),
    ).rejects.toThrow("At most");
    // A missing switch is not "off": the policy crosses whole or not at all.
    await expect(caller.modelAccess.setCodeModePolicy({ models: {} } as never)).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  it("round-trips the picker view as one word", async () => {
    const fixture = runtimeFixture();
    const writes: unknown[] = [];
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        readModelPickerView: () => "all",
        writeModelPickerView: (view) => {
          writes.push(view);
          return view;
        },
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    await expect(caller.modelAccess.pickerView()).resolves.toBe("all");
    await expect(caller.modelAccess.setPickerView("defaults")).resolves.toBe("defaults");
    expect(writes).toEqual(["defaults"]);
    // The vocabulary is closed at the edge: a word the renderer did not get
    // from the shared list never reaches storage.
    await expect(caller.modelAccess.setPickerView("tiers" as never)).rejects.toThrow();
  });

  it("mints Ticket and Board Sessions through one create door — ticketId is the Role", async () => {
    const fixture = runtimeFixture();
    const calls: unknown[] = [];
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        createSession: async (input) => {
          calls.push(["create", input]);
          return { sessionId: input.ticketId === null ? "session-2" : "session-1" };
        },
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    const ticket = await caller.sessions.create({
      operationId: "operation-1",
      projectId: "project-1",
      ticketId: "ticket-1",
      title: "VC-1",
    });
    const project = await caller.sessions.create({
      operationId: "operation-2",
      projectId: "project-1",
      ticketId: null,
      title: "Board chat",
    });

    expect(ticket).toEqual({ sessionId: "session-1" });
    expect(project).toEqual({ sessionId: "session-2" });
    expect(calls).toEqual([
      [
        "create",
        { operationId: "operation-1", projectId: "project-1", ticketId: "ticket-1", title: "VC-1" },
      ],
      [
        "create",
        {
          operationId: "operation-2",
          projectId: "project-1",
          ticketId: null,
          title: "Board chat",
        },
      ],
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/adapter|profile|pi/i);

    // Unconfigured transports refuse explicitly, like every other product facade.
    const bare = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );
    await expect(
      bare.sessions.create({
        operationId: "op",
        projectId: "project-1",
        ticketId: "ticket-1",
        title: null,
      }),
    ).rejects.toThrow("Sessions are unavailable");
  });

  it("carries skill slugs on create, and refuses one the grammar cannot spell", async () => {
    const fixture = runtimeFixture();
    const calls: unknown[] = [];
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        createSession: async (input) => {
          calls.push(input);
          return { sessionId: "session-1" };
        },
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    // The optimistic-open route is the one that MINTS the Session, so it is
    // the one that carries them — `attach` composes from the record, never
    // the input.
    await caller.sessions.create({
      operationId: "operation-1",
      projectId: "project-1",
      ticketId: "ticket-1",
      title: "VC-1",
      skills: ["svg-logo-designer"],
    });
    expect(calls).toEqual([expect.objectContaining({ skills: ["svg-logo-designer"] })]);

    await expect(
      caller.sessions.create({
        operationId: "operation-2",
        projectId: "project-1",
        ticketId: "ticket-1",
        title: "VC-1",
        skills: ["not a slug"],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("carries a model override on create, and refuses a level no model can run", async () => {
    const fixture = runtimeFixture();
    const calls: unknown[] = [];
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        createSession: async (input) => {
          calls.push(input);
          return { sessionId: "session-1" };
        },
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    // The composer's Create & start states both halves; the merge onto the
    // app default and the availability check are the server's, not this edge's.
    await caller.sessions.create({
      operationId: "operation-1",
      projectId: "project-1",
      ticketId: "ticket-1",
      title: "Work on VC-1",
      modelOverride: {
        model: { providerId: "anthropic", modelId: "sonnet-4.5" },
        reasoningLevel: "high",
      },
    });
    // A level alone is a legal override: it keeps the default model.
    await caller.sessions.create({
      operationId: "operation-2",
      projectId: "project-1",
      ticketId: "ticket-1",
      title: null,
      modelOverride: { reasoningLevel: "low" },
    });

    expect(calls).toEqual([
      expect.objectContaining({
        modelOverride: {
          model: { providerId: "anthropic", modelId: "sonnet-4.5" },
          reasoningLevel: "high",
        },
      }),
      expect.objectContaining({ modelOverride: { reasoningLevel: "low" } }),
    ]);

    await expect(
      caller.sessions.create({
        operationId: "operation-3",
        projectId: "project-1",
        ticketId: "ticket-1",
        title: null,
        // @ts-expect-error — the wire grammar is the shipped level set, and a
        // renderer that invented a level must be refused at the edge.
        modelOverride: { reasoningLevel: "ludicrous" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("carries the first message for automatic model choice on create (VC-432)", async () => {
    const fixture = runtimeFixture();
    const calls: unknown[] = [];
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        createSession: async (input) => {
          calls.push(input);
          return { sessionId: "session-1" };
        },
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    await caller.sessions.create({
      operationId: "operation-1",
      projectId: "project-1",
      ticketId: null,
      title: null,
      autoSelect: { request: "rename the helper" },
    });
    expect(calls).toEqual([
      expect.objectContaining({ autoSelect: { request: "rename the helper" } }),
    ]);

    await expect(
      caller.sessions.create({
        operationId: "operation-2",
        projectId: "project-1",
        ticketId: null,
        title: null,
        // @ts-expect-error — the request is text.
        autoSelect: { request: 7 },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("carries the decision model's pick across to the renderer, and a command cannot declare one", async () => {
    const fixture = runtimeFixture();
    const auto = { confidence: 0.8, alternatives: [] };
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: {
          ...fixture.runtime,
          projection: async (input) => {
            const base = await fixture.runtime.projection(input);
            return { ...base, projection: { ...base.projection, modelAuto: auto } };
          },
        },
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    const resolved = await caller.session.projection({ sessionId: "session-1" });
    expect(resolved.projection.modelAuto).toEqual(auto);

    const submitted: unknown[] = [];
    const commandCaller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: {
          ...fixture.runtime,
          command: async (request) => {
            submitted.push(request.command);
            return fixture.runtime.command(request);
          },
        },
        diagnostics: new RpcDiagnosticLog(),
      }),
    );
    await commandCaller.session.command({
      commandId: "command-1",
      sessionId: "session-1",
      command: {
        kind: "model.select",
        selection: { providerId: "anthropic", modelId: "sonnet-4.5", reasoningLevel: "high" },
        // A renderer-side pick is a person's: provenance is never self-declared.
        auto,
      } as never,
    });
    expect(submitted[0]).not.toHaveProperty("auto");
  });

  it("carries a client-requested Session id on create, UUID-checked at the edge (VC-358)", async () => {
    const fixture = runtimeFixture();
    const calls: unknown[] = [];
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        createSession: async (input) => {
          calls.push(input);
          return { sessionId: "session-1" };
        },
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    // A provisional chat promotes under the id it minted; absent, nothing
    // changes for callers that never state one.
    const requested = "0f1a2b3c-4d5e-4f6a-8b7c-9d0e1f2a3b4c";
    await caller.sessions.create({
      operationId: "operation-1",
      projectId: "project-1",
      ticketId: "ticket-1",
      title: "VC-1",
      requestedSessionId: requested,
    });
    await caller.sessions.create({
      operationId: "operation-2",
      projectId: "project-1",
      ticketId: "ticket-1",
      title: null,
    });

    expect(calls).toEqual([
      expect.objectContaining({ requestedSessionId: requested }),
      {
        operationId: "operation-2",
        projectId: "project-1",
        ticketId: "ticket-1",
        title: null,
      },
    ]);

    await expect(
      caller.sessions.create({
        operationId: "operation-3",
        projectId: "project-1",
        ticketId: "ticket-1",
        title: null,
        requestedSessionId: "not a uuid",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a well-formed UUID that is not v4, and the nil and max ids", async () => {
    // `docs/BOUNDARIES.md` rule 1: a durable id may never be built from
    // anything machine-local. A v1 UUID carries the minting machine's MAC
    // address in its last 48 bits, so accepting one would put a hardware
    // identifier into a permanent Session id — and a durable id derivation is
    // frozen the moment it ships, so this door cannot be narrowed later.
    const fixture = runtimeFixture();
    const admitted: unknown[] = [];
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        createSession: async (input) => {
          admitted.push(input);
          return { sessionId: "session-1" };
        },
        diagnostics: new RpcDiagnosticLog(),
      }),
    );
    const refused = [
      // v1: time-based, node field is a MAC.
      "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      // v3 and v5: name-based, so two clients naming the same thing collide.
      "3d813cbb-47fb-32ba-91df-831e1593ac29",
      "886313e1-3b8a-5372-9b90-0c9aee199e5d",
      "00000000-0000-0000-0000-000000000000",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
    ];

    for (const [index, requestedSessionId] of refused.entries()) {
      await expect(
        caller.sessions.create({
          operationId: `refused-${index}`,
          projectId: "project-1",
          ticketId: "ticket-1",
          title: null,
          requestedSessionId,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    // Refused at the edge means refused before the handler — no create ran.
    expect(admitted).toEqual([]);

    // And the shape the renderer actually mints still passes.
    await caller.sessions.create({
      operationId: "admitted",
      projectId: "project-1",
      ticketId: "ticket-1",
      title: null,
      requestedSessionId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(admitted).toEqual([
      expect.objectContaining({ requestedSessionId: "550e8400-e29b-41d4-a716-446655440000" }),
    ]);
  });

  it("withholds executor creation and attachment commands from Electron renderers", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics: new RpcDiagnosticLog(),
        transport: "electron-ipc",
      }),
    );

    await expect(
      caller.session.command({
        commandId: "forged-create",
        command: {
          kind: "session.create",
          projectId: "p1",
          ticketId: null,
          role: "project",
          parentSessionId: null,
          title: null,
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.session.command({
        commandId: "forged-attach",
        sessionId: "session-1",
        command: { kind: "adapter.attach", continuity: "fresh" },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fixture.calls.command).toEqual([]);
  });

  it("routes queue edit/cancel through their catalog entries and refuses the generic bypass", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );
    const message = {
      id: "m",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "edited" }],
    };
    expect(
      await caller.session.cancelQueued({
        commandId: "cancel",
        sessionId: "session-1",
        messageId: "m",
        expectedRevision: 3,
      }),
    ).toMatchObject({ sessionId: "session-1", receipt: null });
    await caller.session.editQueued({
      commandId: "edit",
      sessionId: "session-1",
      messageId: "m",
      message,
      expectedRevision: 4,
    });
    expect(fixture.calls.command).toEqual([
      {
        commandId: "cancel",
        sessionId: "session-1",
        command: { kind: "message.cancel", messageId: "m", expectedRevision: 3 },
      },
      {
        commandId: "edit",
        sessionId: "session-1",
        command: { kind: "message.edit", messageId: "m", message, expectedRevision: 4 },
      },
    ]);
    for (const command of [
      { kind: "message.cancel" as const, messageId: "m" },
      { kind: "message.edit" as const, messageId: "m", message },
    ]) {
      await expect(
        caller.session.command({ commandId: "bypass", sessionId: "session-1", command }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(fixture.calls.command).toHaveLength(2);
    for (const expectedRevision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const input = {
        commandId: "invalid-revision",
        sessionId: "session-1",
        messageId: "m",
        expectedRevision,
      };
      await expect(caller.session.cancelQueued(input)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      await expect(caller.session.editQueued({ ...input, message })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(fixture.calls.command).toHaveLength(2);
  });

  it("reattaches an existing Session with no Role in the request and no runtime identity out", async () => {
    const fixture = runtimeFixture();
    const calls: unknown[] = [];
    const answer = {
      sessionId: "session-1",
      state: "ready" as const,
      receipt: null,
      throughSequence: 6,
    };
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        attachSession: async (input) => {
          calls.push(["attach", input]);
          return answer;
        },
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    await caller.sessions.attach({ operationId: "retry-1", sessionId: "session-1" });
    await caller.sessions.attach({ operationId: "retry-2", sessionId: "session-2" });

    expect(calls).toEqual([
      ["attach", { operationId: "retry-1", sessionId: "session-1" }],
      ["attach", { operationId: "retry-2", sessionId: "session-2" }],
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/adapter|profile|pi|opencode/i);
  });

  it("fails product facades explicitly when a transport did not configure them", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    await expect(
      caller.sessions.create({
        operationId: "session-create",
        projectId: "project-1",
        ticketId: "ticket-1",
        title: null,
      }),
    ).rejects.toThrow("Sessions are unavailable");
    await expect(
      caller.sessions.attach({ operationId: "session-attach", sessionId: "session-1" }),
    ).rejects.toThrow("Sessions are unavailable");
    await expect(caller.modelAccess.inspect({})).rejects.toThrow("Model Access is unavailable");
    await expect(caller.modelAccess.defaults()).rejects.toThrow(
      "Model Access preferences are unavailable",
    );
    await expect(
      caller.modelAccess.setDefault({
        purpose: "global",
        selection: { providerId: "openai-codex", modelId: "gpt-5.6-sol", reasoningLevel: "high" },
      }),
    ).rejects.toThrow("Model Access preferences are unavailable");
    await expect(caller.modelAccess.hiddenModels()).rejects.toThrow(
      "Model Access preferences are unavailable",
    );
    await expect(caller.modelAccess.setHiddenModels([])).rejects.toThrow(
      "Model Access preferences are unavailable",
    );
  });

  it("classifies unconfigured product facades as unavailable transport capabilities", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    const calls = [
      () =>
        caller.sessions.create({
          operationId: "operation-create",
          projectId: "project-1",
          ticketId: "ticket-1",
          title: null,
        }),
      () => caller.sessions.attach({ operationId: "operation-attach", sessionId: "s1" }),
      () => caller.modelAccess.inspect({}),
      () => caller.modelAccess.defaults(),
      () =>
        caller.modelAccess.setDefault({
          purpose: "global",
          selection: { providerId: "openai-codex", modelId: "gpt-5.6-sol", reasoningLevel: "high" },
        }),
      () => caller.modelAccess.hiddenModels(),
      () => caller.modelAccess.setHiddenModels([]),
      () => caller.modelAccess.codeModePolicy(),
      () => caller.modelAccess.setCodeModePolicy({ enabled: true, models: {} }),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
    }
  });

  // VC-564: the guard was keyed on `transport === "electron-ipc"`, so any other
  // door (the WebSocket harness link passed "unknown") reached the runtime with
  // a raw create. It is the catalog entry's policy now, and holds on every door.
  it.each(["electron-ipc", "unknown", undefined] as const)(
    "refuses the start kinds through session.command over transport %s, before the handler",
    async (transport) => {
      const fixture = runtimeFixture();
      const caller = createSessionRouter().createCaller(
        sessionContext({
          caller: LOCAL_DESKTOP_CALLER,
          runtime: fixture.runtime,
          diagnostics: new RpcDiagnosticLog(),
          ...(transport === undefined ? {} : { transport }),
        }),
      );

      await expect(
        caller.session.command({
          commandId: "create-command",
          command: {
            kind: "session.create",
            projectId: "project-1",
            ticketId: null,
            role: "project",
            parentSessionId: null,
            title: null,
          },
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", reason: "verb-refused" });
      await expect(
        caller.session.command({
          commandId: "attach-command",
          sessionId: "session-1",
          command: { kind: "adapter.attach", continuity: "fresh" },
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", reason: "verb-refused" });
      expect(fixture.calls.command).toEqual([]);
    },
  );

  // VC-141: the adapter's judgement is in-memory detail, so it only reaches a
  // client if this edge forwards it deliberately. Nullable rather than
  // optional, so it survives a transport that drops `undefined` keys
  // (BOUNDARIES.md rule 3).
  it.each(["benign", "failure", null] as const)(
    "forwards a %s refusal mark to the renderer beside the receipt",
    async (refusal) => {
      const fixture = runtimeFixture(refusal);
      const caller = createSessionRouter().createCaller(
        sessionContext({
          caller: LOCAL_DESKTOP_CALLER,
          runtime: fixture.runtime,
          diagnostics: new RpcDiagnosticLog(),
        }),
      );

      const result = await caller.session.command({
        commandId: "compact-command",
        sessionId: "session-1",
        command: { kind: "context.compact" },
      });

      expect(result.refusal).toBe(refusal);
      expect("refusal" in result).toBe(true);
    },
  );

  it("passes executor retry attachment identity to the Session runtime only when supplied", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

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
        origin: { kind: "user" },
        commandId: "retry-command",
        sessionId: "session-1",
        command: { kind: "executor.retry", attachmentId: "attachment-1" },
      },
      {
        origin: { kind: "user" },
        commandId: "session-owned-retry-command",
        sessionId: "session-1",
        command: { kind: "executor.retry" },
      },
    ]);
    expect("attachmentId" in fixture.calls.command.at(-1)!.command).toBe(false);
  });

  it("passes a person's scheduled resume and its cancel, and never a settle", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    await caller.session.command({
      commandId: "schedule-1",
      sessionId: "session-1",
      command: {
        kind: "resume.schedule",
        attentionId: "attention-1",
        attachmentId: "attachment-1",
        resumeAt: 1_800_000_000_000,
      },
    });
    await caller.session.command({
      commandId: "cancel-1",
      sessionId: "session-1",
      command: { kind: "resume.cancel", scheduleId: "schedule-1" },
    });
    expect(fixture.calls.command.map(({ command }) => command.kind)).toEqual([
      "resume.schedule",
      "resume.cancel",
    ]);
    // What became of a schedule is the host's to record, never a client's.
    await expect(
      caller.session.command({
        commandId: "settle-1",
        sessionId: "session-1",
        command: {
          kind: "resume.settle",
          scheduleId: "schedule-1",
          outcome: { kind: "resumed", retryCommandId: "schedule-1:resume" },
        } as never,
      }),
    ).rejects.toThrow();
    // A reset is an instant, never zero or fractional.
    await expect(
      caller.session.command({
        commandId: "schedule-2",
        sessionId: "session-1",
        command: {
          kind: "resume.schedule",
          attentionId: "attention-1",
          attachmentId: "attachment-1",
          resumeAt: 0,
        },
      }),
    ).rejects.toThrow();
  });

  it("presents the one scheduled resume a surface may draw", async () => {
    const base = snapshot();
    const attachment = attachmentWithRecovery();
    const runtime: SessionRuntime = {
      ...runtimeFixture().runtime,
      projection: async () => ({
        throughSequence: 6,
        projection: {
          ...base.projection,
          attachments: [attachment],
          liveExecutor: attachment,
          commands: [
            {
              id: "schedule-1",
              sessionId: "session-1",
              createdAt: 10,
              intent: {
                kind: "resume.schedule",
                attentionId: "attention-1",
                attachmentId: attachment.id,
                resumeAt: 5_000,
              },
              route: null,
            },
          ],
          receipts: [
            {
              id: "receipt-schedule-1",
              commandId: "schedule-1",
              status: "completed",
              result: { kind: "resume.scheduled", sessionId: "session-1" },
              recordedAt: 10,
              sequence: 5,
            },
          ],
        },
      }),
    };
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    const resolved = await caller.session.projection({ sessionId: "session-1" });
    expect(resolved.projection.scheduledResume).toEqual({
      id: "schedule-1",
      attentionId: "attention-1",
      resumeAt: 5_000,
    });
  });

  it("passes an explicit compaction, with or without instructions", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    await caller.session.command({
      commandId: "compact-command",
      sessionId: "session-1",
      command: { kind: "context.compact", instructions: "keep the API work" },
    });
    await caller.session.command({
      commandId: "bare-compact-command",
      sessionId: "session-1",
      command: { kind: "context.compact" },
    });

    expect(fixture.calls.command.slice(-2)).toEqual([
      {
        origin: { kind: "user" },
        commandId: "compact-command",
        sessionId: "session-1",
        command: { kind: "context.compact", instructions: "keep the API work" },
      },
      {
        origin: { kind: "user" },
        commandId: "bare-compact-command",
        sessionId: "session-1",
        command: { kind: "context.compact" },
      },
    ]);
  });

  it("refuses compaction instructions too long to be a summarizer's brief", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

    // These words are headed for the call meant to RECLAIM the window; an
    // unbounded brief is a way to spend it instead.
    await expect(
      caller.session.command({
        commandId: "overlong-compact",
        sessionId: "session-1",
        command: { kind: "context.compact", instructions: "x".repeat(4001) },
      }),
    ).rejects.toThrow();
    expect(fixture.calls.command).toEqual([]);
  });

  it("passes a durable model selection without adapter or profile identity", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

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
      origin: { kind: "user" },
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
      refusal: null,
    });
    expect(JSON.stringify(selected)).not.toMatch(/adapter|profile/i);
  });

  it("carries per-prompt answers through a resolve command and leaves absent ones absent", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );

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
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics,
        transport: "electron-ipc",
      }),
    );

    await caller.session.snapshot({ sessionId: "session-1" });
    await caller.session.command({
      commandId: "command-1",
      sessionId: "session-1",
      command: {
        kind: "message.submit",
        message: {
          id: "message-1",
          role: "user",
          metadata: {
            omitted: undefined,
            sparse: [undefined],
            retained: { none: null, count: 1, enabled: true },
          },
          parts: [{ type: "text", text: "private prompt" }],
        },
      },
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
      {
        sessionId: "session-1",
        interactionId: "question-1",
        reason: "abandoned",
        origin: { kind: "user" },
      },
    ]);
    expect(diagnostics.list().map((entry) => entry.procedure)).toEqual([
      "session.snapshot",
      "session.snapshot",
      "session.command",
      "session.command",
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
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics,
      }),
    );

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

  it.each([
    { operation: "subscribe" as const, transport: "websocket" as const, queueAware: false },
    { operation: "subscribe" as const, transport: "electron-ipc" as const, queueAware: true },
    { operation: "subscribeQueue" as const, transport: "websocket" as const, queueAware: true },
  ])(
    "$operation on $transport preserves its negotiated stream vocabulary",
    async ({ operation, transport, queueAware }) => {
      const fixture = runtimeFixture();
      const queued: SessionStreamEmission = {
        kind: "queue",
        sessionId: "session-1",
        throughSequence: 4,
        revision: 2,
        queue: [],
      };
      fixture.runtime.subscribe = async (_input, emit) => {
        await emit(queued);
        await emit(frame(5));
        return () => {};
      };
      const caller = createSessionRouter().createCaller(
        sessionContext({
          caller: LOCAL_DESKTOP_CALLER,
          runtime: fixture.runtime,
          diagnostics: new RpcDiagnosticLog(),
          transport,
        }),
      );
      const stream = await caller.session[operation]({ sessionId: "session-1" });
      const iterator = stream[Symbol.asyncIterator]();
      try {
        const first = trackedValue((await iterator.next()).value);
        expect(first.data).toEqual(queueAware ? queued : expect.objectContaining({ sequence: 5 }));
        if (queueAware)
          expect(trackedValue((await iterator.next()).value).data).toEqual(
            expect.objectContaining({ sequence: 5 }),
          );
      } finally {
        await iterator.return?.();
      }
    },
  );

  it("records a sanitized diagnostic when either bounded subscription queue overflows", async () => {
    const fixture = runtimeFixture();
    const diagnostics = new RpcDiagnosticLog({ capacity: 10_000 });
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics,
      }),
    );

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
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics,
      }),
    );

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

  /**
   * The runtime's own drain dying behind a subscription must end the stream
   * with an error, never a clean `done`: a clean end reads downstream as a
   * stream with nothing left to say, while the ledger already holds a
   * `turn.completed` this stream will never deliver. The error is what makes
   * the client resubscribe and heal from the ledger.
   */
  it("ends a subscription whose runtime source failed with an error its subscriber can catch", async () => {
    const fixture = runtimeFixture();
    const diagnostics = new RpcDiagnosticLog({ capacity: 10_000 });
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics,
      }),
    );

    const stream = await caller.session.subscribe({ sessionId: "session-1" });
    const iterator = stream[Symbol.asyncIterator]();
    const firstFrame = iterator.next();
    await Promise.resolve();
    fixture.emit(frame(1));
    await firstFrame;
    fixture.fail(new Error("subscriber drain died"));

    const drain = async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
      }
    };
    await expect(drain()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Session stream source failed; resubscribe to resume from the ledger",
    });
    expect(
      diagnostics.list().filter(({ code }) => code === "SUBSCRIPTION_SOURCE_FAILURE"),
    ).toHaveLength(1);
  });

  it("ends an overflowing diagnostics subscription with an error its subscriber can catch", async () => {
    const fixture = runtimeFixture();
    const diagnostics = new RpcDiagnosticLog({ capacity: 10_000 });
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics,
      }),
    );

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
      sessionContext({ caller: LOCAL_DESKTOP_CALLER, runtime: fixture.runtime, diagnostics }),
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
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics,
      }),
    );

    await expect(caller.session.snapshot({ sessionId: "session-1" })).rejects.toThrow();
    await expect(
      caller.session.command({
        commandId: "create-with-session",
        sessionId: "session-1",
        command: {
          kind: "session.create",
          projectId: "project-1",
          ticketId: null,
          role: "project",
          parentSessionId: null,
          title: null,
        },
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

  it("rejects non-JSON opaque UIMessage payloads before runtime submission", async () => {
    const fixture = runtimeFixture();
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );
    const circularPayload: Record<string, unknown> = {};
    circularPayload.self = circularPayload;
    const invalidMessages = [
      {
        id: "date-message",
        role: "user",
        parts: [{ type: "data-example", data: { nested: new Date("2025-01-01T00:00:00.000Z") } }],
      },
      {
        id: "map-message",
        role: "user",
        parts: [{ type: "data-example", data: { nested: new Map([["key", "value"]]) } }],
      },
      {
        id: "nan-message",
        role: "user",
        parts: [{ type: "data-example", data: { nested: Number.NaN } }],
      },
      {
        id: "function-message",
        role: "user",
        parts: [{ type: "data-example", data: { nested: () => undefined } }],
      },
      {
        id: "cycle-message",
        role: "user",
        parts: [{ type: "data-example", data: { nested: circularPayload } }],
      },
      {
        id: "symbol-key-message",
        role: "user",
        parts: [{ type: "data-example", data: { nested: { [Symbol("hidden")]: "value" } } }],
      },
    ];

    for (const [index, message] of invalidMessages.entries()) {
      await expect(
        Reflect.apply(caller.session.command, caller.session, [
          {
            commandId: `invalid-json-message-${index}`,
            sessionId: "session-1",
            command: { kind: "message.submit", message },
          },
        ]),
      ).rejects.toThrow("UIMessage payloads must contain only JSON-safe values");
    }

    expect(fixture.calls.command).toEqual([]);
  });

  it("rejects whitespace identifiers and unsafe SSE resume cursors", async () => {
    const fixture = runtimeFixture();
    const diagnostics = new RpcDiagnosticLog();
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics,
      }),
    );

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
      sessionContext({ caller: LOCAL_DESKTOP_CALLER, runtime: fixture.runtime, diagnostics }),
      { signal: controller.signal },
    );
    const stream = await caller.session.subscribe({ sessionId: "session-1" });
    const iterator = stream[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(fixture.calls.subscribeAfter).toEqual([]);

    const diagnosticsController = new AbortController();
    diagnosticsController.abort();
    const diagnosticsCaller = createSessionRouter().createCaller(
      sessionContext({ caller: LOCAL_DESKTOP_CALLER, runtime: fixture.runtime, diagnostics }),
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
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: fixture.runtime,
        diagnostics: new RpcDiagnosticLog(),
      }),
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
      sessionContext({ caller: LOCAL_DESKTOP_CALLER, runtime: fixture.runtime, diagnostics }),
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
      sessionContext({ caller: LOCAL_DESKTOP_CALLER, runtime: fixture.runtime, diagnostics }),
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
      sessionContext({ caller: LOCAL_DESKTOP_CALLER, runtime: fixture.runtime, diagnostics }),
      { signal: diagnosticsController.signal },
    );
    const diagnosticsStream = await diagnosticsCaller.labDiagnostics.subscribe({ afterId: 999 });
    const diagnosticsPending = diagnosticsStream[Symbol.asyncIterator]().next();
    await Promise.resolve();
    diagnosticsController.abort();
    expect(await diagnosticsPending).toEqual({ done: true, value: undefined });
  });
});

function logBatch(cursor: string) {
  return {
    entries: [
      {
        cursor,
        record: {
          ts: "2026-10-07T00:00:00.000Z",
          level: "info" as const,
          component: "c",
          msg: cursor,
        },
      },
    ],
    gap: false,
    cursor,
  };
}

describe("host.logs on the router (VC-699)", () => {
  it("follows from a cursor, and ends subscription-overflow when it falls behind", async () => {
    const follows: unknown[] = [];
    let unsubscribed = 0;
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: {},
        diagnostics: new RpcDiagnosticLog(),
        followLogs: (query, listener) => {
          follows.push(query);
          // A burst past the stream's queue before the reader takes anything.
          for (let index = 0; index < 300; index += 1) listener(logBatch(`r:${index}`));
          return () => {
            unsubscribed += 1;
          };
        },
      }),
    );
    const stream = await caller.logs.follow({});
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const tracked of stream) seen.push((tracked as unknown as [string])[0]);
      })(),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(seen).toHaveLength(256);
    expect(follows).toStrictEqual([{}]);
    expect(unsubscribed).toBe(1);
  });

  it("hands the host the door's frame budget, and bounds a stream's queue in bytes (VC-712)", async () => {
    const reads: unknown[] = [];
    const follows: unknown[] = [];
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    const one = bytes(logBatch("r:0"));
    const bounded = (followLogs: Parameters<typeof sessionContext>[0]["followLogs"]) =>
      createSessionRouter().createCaller({
        ...sessionContext({
          caller: LOCAL_DESKTOP_CALLER,
          runtime: {},
          diagnostics: new RpcDiagnosticLog(),
          readLogs: (query) => {
            reads.push(query);
            return logBatch("r:1");
          },
          followLogs,
        }),
        maxResponseBytes: one + 16,
        // Twice this is what one log stream may hold unsent: four batches.
        replayBounds: { events: 100, bytes: 2 * one },
      });
    await bounded(undefined).logs.tail({ limit: 5 });
    expect(reads).toStrictEqual([{ limit: 5, maxBytes: one + 16 }]);
    const stream = await bounded((query, listener) => {
      follows.push(query);
      for (let index = 0; index < 10; index += 1) listener(logBatch(`r:${index}`));
      return () => undefined;
    }).logs.follow({ after: "r:0" });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const tracked of stream) seen.push((tracked as unknown as [string])[0]);
      })(),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(follows).toStrictEqual([{ after: "r:0", maxBytes: one + 16 }]);
    expect(seen).toEqual(["r:0", "r:1", "r:2", "r:3"]);
    // An unbounded door (the desktop's IPC) names no budget, as before.
    const local = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: {},
        diagnostics: new RpcDiagnosticLog(),
        readLogs: (query) => {
          reads.push(query);
          return logBatch("r:1");
        },
      }),
    );
    await local.logs.tail({});
    expect(reads.at(-1)).toStrictEqual({});
  });

  it("ends subscription-source-failed when the host's log stops, after what it held", async () => {
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: {},
        diagnostics: new RpcDiagnosticLog(),
        followLogs: (_query, listener, fail) => {
          listener(logBatch("r:1"));
          fail(new Error("ring gone"));
          return () => undefined;
        },
      }),
    );
    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const tracked of await caller.logs.follow({})) seen.push(tracked);
      })(),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(seen).toHaveLength(1);
  });

  it("opens nothing for a caller that already left", async () => {
    const abort = new AbortController();
    abort.abort();
    let opened = false;
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: {},
        diagnostics: new RpcDiagnosticLog(),
        followLogs: () => {
          opened = true;
          return () => undefined;
        },
      }),
      { signal: abort.signal },
    );
    const stream = await caller.logs.follow({ after: "r:1" });
    for await (const _ of stream) throw new Error("nothing should arrive");
    expect(opened).toBe(false);
  });

  it("answers unavailable on a host that keeps no log", async () => {
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: LOCAL_DESKTOP_CALLER,
        runtime: {},
        diagnostics: new RpcDiagnosticLog(),
      }),
    );
    await expect(caller.logs.tail({})).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });
});
