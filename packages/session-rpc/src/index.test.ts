import { describe, expect, it } from "vite-plus/test";
import type {
  RuntimeCatalog,
  SessionRuntime,
  SessionRuntimeCommandRequest,
  SessionRuntimeSnapshot,
  SessionStreamFrame,
} from "@volli/session-engine";
import { AsyncQueue, createSessionRouter, RpcDiagnosticLog, sanitizeDiagnosticText } from "./index";

type CapabilitySnapshot = Extract<
  SessionStreamFrame["event"]["payload"],
  { kind: "capabilities.updated" }
>["snapshot"];

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

function trackedValue(value: unknown): { id: string; data: unknown } {
  expect(Array.isArray(value)).toBe(true);
  if (!Array.isArray(value)) throw new Error("Expected a tracked SSE envelope");
  const [id, data] = value;
  if (typeof id !== "string") throw new Error("Expected a tracked SSE identifier");
  return { id, data };
}

function runtimeFixture(): {
  runtime: SessionRuntime;
  calls: { command: SessionRuntimeCommandRequest[]; subscribeAfter: number[] };
  emit: (next: SessionStreamFrame) => void;
} {
  const calls: { command: SessionRuntimeCommandRequest[]; subscribeAfter: number[] } = {
    command: [],
    subscribeAfter: [],
  };
  let listener: ((next: SessionStreamFrame) => void) | null = null;
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
    subscribe: async (input, next) => {
      calls.subscribeAfter.push(input.afterSequence);
      listener = (value) => void next(value);
      return () => {
        listener = null;
      };
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

  it("exposes bounded Runtime Catalog browsing and shortlist resolution to Lab clients", async () => {
    const fixture = runtimeFixture();
    const calls: string[] = [];
    const runtimeCatalog: RuntimeCatalog = {
      inspect: async (input) => {
        calls.push(`inspect:${input.providerId ?? "overview"}`);
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
        };
      },
      save: async (input) => {
        calls.push(`save:${input.preferences.enabledModels.length}`);
        return input.preferences;
      },
      resolve: async (input) => {
        calls.push(`resolve:${input.adapterId}`);
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
      runtimeCatalog,
      diagnostics: new RpcDiagnosticLog(),
      transport: "lab-http",
    });

    await caller.runtimeCatalog.inspect({ adapterId: "opencode", providerId: "openai" });
    await caller.runtimeCatalog.save({
      adapterId: "opencode",
      preferences: {
        version: 1,
        enabledModels: [{ providerId: "openai", modelId: "codex" }],
        defaults: { providerId: "openai", modelId: "codex", variant: "high", agent: "build" },
      },
    });
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

    expect(calls).toEqual(["inspect:openai", "save:1", "resolve:opencode"]);
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
    await caller.labDiagnostics.list();

    expect(fixture.calls.command).toEqual([
      expect.objectContaining({ commandId: "command-1", sessionId: "session-1" }),
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
