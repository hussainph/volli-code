import { describe, expect, it } from "vite-plus/test";
import type { SessionEvent, SessionLedgerIds } from "@volli/shared";
import type { UIMessage } from "ai";
import {
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
  createNativeAdapterRegistry,
  createSessionEngine,
  createSessionRuntime,
  SessionRuntimeConflictError,
  SessionRuntimeNotFoundError,
  type BindingHandle,
  type HarnessCommand,
  type HarnessObservation,
  type NativeHarnessAdapter,
  type NativeProbeResult,
  type ObservationSink,
  type SessionEngine,
  type SessionRuntime,
  type TranscriptArtifactStore,
} from "./index";

const venue = { id: "machine-1", kind: "local" as const };

function ids(): SessionLedgerIds {
  let sequence = 0;
  return { next: (kind) => `${kind}-${++sequence}` };
}

function runtimeIds(prefix = "") {
  let sequence = 0;
  return { next: (kind: string) => `${prefix}${kind}-${++sequence}` };
}

function userMessage(id = "message-1", text = "Hello"): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

class Gate {
  readonly promise: Promise<void>;
  #resolve!: () => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  resolve(): void {
    this.#resolve();
  }
}

class FakeAdapter implements NativeHarnessAdapter {
  readonly manifest = {
    id: "fake",
    displayName: "Fake",
    adapterVersion: "1.0.0",
    profiles: [{ id: "native", label: "Native", transport: "native" as const }],
  };
  probes = 0;
  attaches = 0;
  dispatches = 0;
  reconciles = 0;
  reconcileAcknowledgements: Array<Awaited<ReturnType<BindingHandle["reconcile"]>>["cursor"]> = [];
  releases = 0;
  sink: ObservationSink | null = null;
  reconcileReceipts: Awaited<ReturnType<BindingHandle["reconcile"]>>["receipts"] = [];
  reconcileObservations: HarnessObservation[] = [];
  reconcileGate: Promise<void> | null = null;
  reconcileStarted: () => void = () => undefined;
  probeResult: NativeProbeResult | null = null;
  attachFailure: unknown = null;
  releaseFailure: unknown = null;
  dispatchReceipt: Awaited<ReturnType<BindingHandle["dispatch"]>> | null = null;
  dispatchGate: Promise<void> | null = null;
  commands: HarnessCommand[] = [];
  attachObservation: HarnessObservation | null = null;
  releaseReasons: string[] = [];

  async probe() {
    this.probes += 1;
    return (
      this.probeResult ?? {
        status: "available" as const,
        runtime: { path: "/trusted/fake", version: "1.0.0", fingerprint: "sha256:fake" },
        capabilities: {
          features: [
            {
              id: "message.submit",
              state: "available" as const,
              evidence: "verified" as const,
              detail: null,
            },
          ],
          catalog: [
            {
              kind: "model" as const,
              id: "fake/model",
              label: "Fake Model",
              state: "available" as const,
              evidence: "reported" as const,
              detail: null,
            },
          ],
        },
      }
    );
  }

  async attach(
    _spec: Parameters<NativeHarnessAdapter["attach"]>[0],
    sink: ObservationSink,
  ): Promise<BindingHandle> {
    this.attaches += 1;
    this.sink = sink;
    if (this.attachObservation) await sink.emit(this.attachObservation);
    if (this.attachFailure) throw this.attachFailure;
    return {
      native: { id: "native-session-1", detail: { provider: "fake" } },
      dispatch: async (command) => {
        this.dispatches += 1;
        this.commands.push(command);
        await this.dispatchGate;
        return (
          this.dispatchReceipt ?? {
            commandId: command.commandId,
            status: "accepted" as const,
            acceptedAt: 200,
            native: { id: command.commandId, detail: null },
          }
        );
      },
      reconcile: async () => {
        this.reconciles += 1;
        this.reconcileStarted();
        await this.reconcileGate;
        return {
          cursor: { value: this.reconciles },
          observations: this.reconcileObservations,
          receipts: this.reconcileReceipts,
        };
      },
      acknowledgeReconciliation: async (cursor) => {
        this.reconcileAcknowledgements.push(cursor);
      },
      release: async (reason) => {
        this.releases += 1;
        this.releaseReasons.push(reason);
        if (this.releaseFailure) throw this.releaseFailure;
      },
    };
  }

  emit(observation: HarnessObservation): Promise<void> {
    if (!this.sink) throw new Error("Fake adapter is not attached");
    return this.sink.emit(observation);
  }
}

function composition(
  options: {
    adapter?: FakeAdapter;
    engine?: SessionEngine;
    artifacts?: TranscriptArtifactStore;
    locations?: Parameters<typeof createSessionRuntime>[0]["locations"];
    runtimeIdPrefix?: string;
  } = {},
): { runtime: SessionRuntime; engine: SessionEngine; adapter: FakeAdapter } {
  let now = 100;
  const engine =
    options.engine ??
    createSessionEngine({
      ledger: createInMemorySessionLedger(),
      clock: { now: () => now++ },
      ids: ids(),
    });
  const adapter = options.adapter ?? new FakeAdapter();
  return {
    engine,
    adapter,
    runtime: createSessionRuntime({
      engine,
      adapters: createNativeAdapterRegistry([adapter]),
      artifacts: options.artifacts ?? createInMemoryTranscriptArtifactStore(),
      locations:
        options.locations ??
        ({
          resolve: async () => ({ directory: "/projects/fake", venue }),
        } satisfies Parameters<typeof createSessionRuntime>[0]["locations"]),
      clock: { now: () => now++ },
      ids: runtimeIds(options.runtimeIdPrefix),
    }),
  };
}

async function createAndAttach(runtime: SessionRuntime) {
  const created = await runtime.command({
    commandId: "command-create",
    command: {
      kind: "session.create",
      projectId: "project-1",
      ticketId: null,
      title: "Native Session",
    },
  });
  await runtime.command({
    commandId: "command-attach",
    sessionId: created.sessionId,
    command: {
      kind: "adapter.attach",
      adapterId: "fake",
      profileId: "native",
      continuity: "fresh",
    },
  });
  return created.sessionId;
}

describe("SessionRuntime native adapter contract", () => {
  it("buffers startup observations until the attachment is durable", async () => {
    const adapter = new FakeAdapter();
    adapter.attachObservation = {
      id: "startup-turn",
      kind: "turn.started",
      occurredAt: 150,
      turnId: "turn-startup",
    };
    const { runtime } = composition({ adapter });

    const sessionId = await createAndAttach(runtime);
    const snapshot = await runtime.snapshot({ sessionId });

    expect(snapshot.frames.map(({ event }) => event.payload.kind)).toEqual(
      expect.arrayContaining(["attachment.opened", "turn.started", "capabilities.updated"]),
    );
    expect(
      snapshot.frames.find(({ event }) => event.payload.kind === "turn.started")?.event.sequence,
    ).toBeGreaterThan(
      snapshot.frames.find(({ event }) => event.payload.kind === "attachment.opened")!.event
        .sequence,
    );
  });

  it("probes, attaches, snapshots dynamic capabilities, and releases through the narrow binding", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const snapshot = await runtime.snapshot({ sessionId });

    expect(adapter.probes).toBe(1);
    expect(adapter.attaches).toBe(1);
    expect(snapshot.projection.liveExecutor).toMatchObject({
      adapterId: "fake",
      native: {
        id: "native-session-1",
        detail: { kind: "volli.native-binding.v1", profileId: "native" },
      },
    });
    expect(snapshot.projection.capabilities).toMatchObject([
      { adapterId: "fake", profileId: "native", revision: 1 },
    ]);

    await runtime.command({
      commandId: "command-release",
      sessionId,
      command: { kind: "adapter.release", attachmentId: snapshot.projection.liveExecutor!.id },
    });
    expect(adapter.releases).toBe(1);
    expect((await runtime.snapshot({ sessionId })).projection.liveExecutor).toBeNull();
  });

  it("coalesces duplicate submissions and never dispatches an accepted command twice", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const request = {
      commandId: "command-message",
      sessionId,
      command: { kind: "message.submit" as const, message: userMessage() },
    };

    const [first, second] = await Promise.all([runtime.command(request), runtime.command(request)]);

    expect(adapter.dispatches).toBe(1);
    expect(second).toEqual(first);
    expect(first.receipt).toMatchObject({ status: "accepted", commandId: "command-message" });
    expect((await runtime.snapshot({ sessionId })).transcript).toMatchObject([
      { message: { id: "message-1", role: "user", parts: [{ text: "Hello" }] } },
    ]);
  });

  it("reconciles a persisted command before redelivery after a runtime restart", async () => {
    const first = composition();
    const sessionId = await createAndAttach(first.runtime);
    const artifact = await createInMemoryTranscriptArtifactStore().write({
      version: 1,
      threadId: `thread:${sessionId}:root`,
      branchId: `branch:${sessionId}:main`,
      attemptId: `attempt:command-recovered`,
      turnId: "turn:command-recovered",
      message: userMessage("command-recovered"),
    });
    await first.engine.submit({
      commandId: "command-recovered",
      sessionId,
      intent: { kind: "message.submit", reference: artifact },
      provenance: { source: { kind: "user", id: "session-client", detail: null }, venue },
    });

    const recoveringAdapter = new FakeAdapter();
    recoveringAdapter.reconcileReceipts = [
      {
        commandId: "command-recovered",
        status: "accepted",
        acceptedAt: 250,
        native: { id: "command-recovered", detail: null },
      },
    ];
    const recovered = composition({ adapter: recoveringAdapter, engine: first.engine });
    const result = await recovered.runtime.command({
      commandId: "command-recovered",
      sessionId,
      command: { kind: "message.submit", message: userMessage("command-recovered") },
    });

    expect(recoveringAdapter.reconciles).toBe(1);
    expect(recoveringAdapter.dispatches).toBe(0);
    expect(result.receipt).toMatchObject({ status: "accepted" });
  });

  it("writes transcript bytes before the reference fact and publishes only committed frames", async () => {
    const steps: string[] = [];
    const memory = createInMemoryTranscriptArtifactStore();
    const artifacts: TranscriptArtifactStore = {
      write: async (record) => {
        steps.push("artifact");
        return memory.write(record);
      },
      read: (reference) => memory.read(reference),
    };
    const { runtime, adapter } = composition({ artifacts });
    const sessionId = await createAndAttach(runtime);
    const snapshot = await runtime.snapshot({ sessionId });
    const seen: SessionEvent[] = [];
    const unsubscribe = await runtime.subscribe(
      { sessionId, afterSequence: snapshot.throughSequence },
      (frame) => {
        steps.push("published");
        seen.push(frame.event);
      },
    );

    await adapter.emit({
      id: "native-message-1",
      kind: "transcript.message",
      occurredAt: 300,
      turnId: "turn-1",
      threadId: `thread:${sessionId}:root`,
      branchId: `branch:${sessionId}:main`,
      attemptId: "attempt-1",
      message: { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "Hi" }] },
    });
    unsubscribe();

    expect(steps).toEqual(["artifact", "published"]);
    expect(seen).toMatchObject([{ payload: { kind: "transcript.referenced" } }]);
    expect((await runtime.snapshot({ sessionId })).transcript).toMatchObject([
      { message: { id: "assistant-1", parts: [{ text: "Hi" }] } },
    ]);
  });

  it("does not append or publish a transcript reference when the artifact write fails", async () => {
    const { runtime, adapter } = composition({
      artifacts: {
        write: async () => {
          throw new Error("disk full");
        },
        read: async () => {
          throw new Error("missing");
        },
      },
    });
    const sessionId = await createAndAttach(runtime);
    const before = await runtime.snapshot({ sessionId });
    const seen: SessionEvent[] = [];
    const unsubscribe = await runtime.subscribe(
      { sessionId, afterSequence: before.throughSequence },
      (frame) => {
        seen.push(frame.event);
      },
    );

    await expect(
      adapter.emit({
        id: "native-message-failed",
        kind: "transcript.message",
        occurredAt: 300,
        turnId: "turn-1",
        threadId: `thread:${sessionId}:root`,
        branchId: `branch:${sessionId}:main`,
        attemptId: "attempt-1",
        message: { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "Hi" }] },
      }),
    ).rejects.toThrow("disk full");
    unsubscribe();

    expect(seen).toEqual([]);
    expect((await runtime.snapshot({ sessionId })).throughSequence).toBe(before.throughSequence);
  });

  it("closes the replay/live registration race without gaps or duplicates", async () => {
    const base = composition();
    const sessionId = await createAndAttach(base.runtime);
    const originalList = base.engine.listEvents.bind(base.engine);
    let releaseReplay!: () => void;
    const replayBlocked = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    let blockNext = true;
    const delayedEngine: SessionEngine = {
      ...base.engine,
      listEvents: async (query) => {
        if (blockNext) {
          blockNext = false;
          await replayBlocked;
        }
        return originalList(query);
      },
    };
    const racing = composition({ engine: delayedEngine, adapter: base.adapter });
    const start = await base.runtime.snapshot({ sessionId });
    const sequences: number[] = [];
    const subscription = racing.runtime.subscribe(
      { sessionId, afterSequence: start.throughSequence },
      (frame) => {
        sequences.push(frame.sequence);
      },
    );
    await Promise.resolve();
    await racing.runtime.command({
      commandId: "command-live",
      sessionId,
      command: { kind: "message.submit", message: userMessage("message-live") },
    });
    releaseReplay();
    const unsubscribe = await subscription;
    unsubscribe();

    expect(sequences.length).toBeGreaterThan(0);
    expect(sequences).toEqual([...new Set(sequences)].toSorted((left, right) => left - right));
  });

  it("rejects unavailable profiles and failed native attachment probes as durable outcomes", async () => {
    const unavailable = composition();
    const unavailableSession = await unavailable.runtime.command({
      commandId: "unavailable-create",
      command: { kind: "session.create", projectId: "project-1", ticketId: null, title: null },
    });
    unavailable.adapter.probeResult = {
      status: "unavailable",
      runtime: null,
      reason: "OpenCode is not installed",
    };
    const result = await unavailable.runtime.command({
      commandId: "unavailable-attach",
      sessionId: unavailableSession.sessionId,
      command: {
        kind: "adapter.attach",
        adapterId: "fake",
        profileId: "native",
        continuity: "fresh",
      },
    });
    expect(result.receipt).toMatchObject({ status: "rejected", code: "adapter_unavailable" });
    expect(
      (await unavailable.runtime.snapshot({ sessionId: unavailableSession.sessionId })).projection
        .attachments,
    ).toMatchObject([{ status: "failed", failure: { code: "adapter_unavailable" } }]);

    const missing = composition();
    const missingSession = await missing.runtime.command({
      commandId: "missing-create",
      command: { kind: "session.create", projectId: "project-1", ticketId: null, title: null },
    });
    const missingResult = await missing.runtime.command({
      commandId: "missing-attach",
      sessionId: missingSession.sessionId,
      command: {
        kind: "adapter.attach",
        adapterId: "fake",
        profileId: "terminal",
        continuity: "fresh",
      },
    });
    expect(missingResult.receipt).toMatchObject({
      status: "rejected",
      code: "profile_unavailable",
    });

    const failed = composition();
    const failedSession = await failed.runtime.command({
      commandId: "failed-create",
      command: { kind: "session.create", projectId: "project-1", ticketId: null, title: null },
    });
    failed.adapter.attachFailure = new Error("native server refused the binding");
    await expect(
      failed.runtime.command({
        commandId: "failed-attach",
        sessionId: failedSession.sessionId,
        command: {
          kind: "adapter.attach",
          adapterId: "fake",
          profileId: "native",
          continuity: "fresh",
        },
      }),
    ).resolves.toMatchObject({ receipt: { status: "rejected", code: "attach_failed" } });

    const plainFailure = composition();
    const plainSession = await plainFailure.runtime.command({
      commandId: "plain-failure-create",
      command: { kind: "session.create", projectId: "project-1", ticketId: null, title: null },
    });
    plainFailure.adapter.attachFailure = "socket disappeared";
    await expect(
      plainFailure.runtime.command({
        commandId: "plain-failure-attach",
        sessionId: plainSession.sessionId,
        command: {
          kind: "adapter.attach",
          adapterId: "fake",
          profileId: "native",
          continuity: "fresh",
        },
      }),
    ).resolves.toMatchObject({ receipt: { detail: "socket disappeared" } });
  });

  it("dispatches interrupts and resolves durable interactions against their owning attachment", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const attachmentId = (await runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    await adapter.emit({
      id: "permission-1",
      kind: "interaction.opened",
      occurredAt: 300,
      interaction: {
        id: "permission-1",
        kind: "permission",
        title: "Write file",
        detail: null,
        options: [{ id: "allow", label: "Allow" }],
        multiple: false,
        native: { id: "native-permission-1", detail: { request: 1 } },
      },
    });
    await runtime.command({
      commandId: "interrupt-1",
      sessionId,
      command: { kind: "executor.interrupt" },
    });
    const resolved = await runtime.command({
      commandId: "resolve-1",
      sessionId,
      command: {
        kind: "interaction.resolve",
        interactionId: "permission-1",
        resolution: { optionIds: ["allow"], response: null },
      },
    });

    expect(adapter.dispatches).toBe(2);
    expect(resolved).toMatchObject({
      command: {
        intent: {
          kind: "interaction.resolve",
          attachmentId,
          interactionId: "permission-1",
          resolution: { optionIds: ["allow"], response: null },
        },
      },
      receipt: { status: "accepted", result: { kind: "interaction.resolved" } },
    });
    const projection = (await runtime.snapshot({ sessionId })).projection;
    expect(projection.interactions.active).toMatchObject([{ id: "permission-1", attachmentId }]);
    expect(adapter.commands).toContainEqual(
      expect.objectContaining({
        kind: "interaction.resolve",
        interaction: expect.objectContaining({ id: "permission-1", attachmentId }),
        resolution: { optionIds: ["allow"], response: null },
      }),
    );
    await adapter.emit({
      id: "permission-resolved",
      kind: "interaction.resolved",
      occurredAt: 302,
      interactionId: "permission-1",
      resolution: { optionIds: ["allow"], response: null },
    });
    expect((await runtime.snapshot({ sessionId })).projection.interactions).toMatchObject({
      active: [],
      resolved: [{ interaction: { id: "permission-1", attachmentId } }],
    });
    await expect(
      runtime.command({
        commandId: "resolve-missing",
        sessionId,
        command: {
          kind: "interaction.resolve",
          interactionId: "permission-1",
          resolution: { optionIds: [], response: null },
        },
      }),
    ).rejects.toBeInstanceOf(SessionRuntimeNotFoundError);
  });

  it("normalizes attention facts and advances capability revisions only after a healthy probe", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const attachmentId = (await runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    for (const attention of [
      { id: "rate", kind: "rate_limited" as const, retryAt: 999 },
      { id: "quota", kind: "quota_exhausted" as const, resetAt: 1000 },
      { id: "rate-null", kind: "rate_limited" as const },
      { id: "quota-null", kind: "quota_exhausted" as const },
      { id: "auth", kind: "auth_required" as const },
    ]) {
      await adapter.emit({
        id: `attention-${attention.id}`,
        kind: "attention.raised",
        occurredAt: 300,
        attention: { ...attention, detail: null, diagnostic: null },
      });
    }
    await adapter.emit({
      id: "attention-clear",
      kind: "attention.cleared",
      occurredAt: 301,
      attentionId: "auth",
    });
    const refreshed = await runtime.refreshCapabilities({ sessionId, attachmentId });
    expect(refreshed.revision).toBe(2);
    expect((await runtime.snapshot({ sessionId })).projection.attention.active).toMatchObject([
      { id: "rate", retryAt: 999 },
      { id: "quota", resetAt: 1000 },
      { id: "rate-null", retryAt: null },
      { id: "quota-null", resetAt: null },
    ]);

    adapter.probeResult = { status: "incompatible", runtime: null, reason: "unsupported protocol" };
    await expect(runtime.refreshCapabilities({ sessionId, attachmentId })).rejects.toMatchObject({
      message: "unsupported protocol",
    });
  });

  it("continues capability revisions after rebuilding the runtime", async () => {
    const first = composition();
    const sessionId = await createAndAttach(first.runtime);
    const attachmentId = (await first.runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    await first.runtime.close();

    const second = composition({
      engine: first.engine,
      adapter: first.adapter,
      runtimeIdPrefix: "restart-",
    });
    const refreshed = await second.runtime.refreshCapabilities({ sessionId, attachmentId });

    expect(refreshed.revision).toBe(2);
  });

  it("reconciles native observations and known receipts without inventing receipts for unknown commands", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const attachmentId = (await runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    adapter.reconcileObservations = [
      {
        id: "turn-start",
        kind: "turn.started",
        occurredAt: 400,
        turnId: "turn-reconciled",
        cursor: { page: 2 },
      },
      { id: "turn-complete", kind: "turn.completed", occurredAt: 401, turnId: "turn-reconciled" },
    ];
    adapter.reconcileReceipts = [
      {
        commandId: "command-attach",
        status: "unknown",
        detail: "server still deciding",
        native: null,
      },
      { commandId: "not-a-command", status: "accepted", acceptedAt: 402, native: null },
    ];
    await runtime.reconcile({ sessionId, attachmentId });
    const snapshot = await runtime.snapshot({ sessionId });
    expect(adapter.reconciles).toBe(1);
    expect(adapter.reconcileAcknowledgements).toEqual([{ value: 1 }]);
    expect(snapshot.frames.map(({ event }) => event.payload.kind)).toContain("turn.started");
    expect(snapshot.projection.receipts).toContainEqual(
      expect.objectContaining({ commandId: "command-attach", status: "accepted" }),
    );
    expect(snapshot.projection.receipts).not.toContainEqual(
      expect.objectContaining({ commandId: "command-attach", status: "unreconciled" }),
    );
  });

  it("coalesces concurrent reconciliation through one durable acknowledgement", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const attachmentId = (await runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    const started = new Gate();
    const release = new Gate();
    adapter.reconcileStarted = () => started.resolve();
    adapter.reconcileGate = release.promise;
    adapter.reconcileObservations = [
      {
        id: "concurrent-turn",
        kind: "turn.started",
        occurredAt: 450,
        turnId: "turn-concurrent",
      },
    ];

    const first = runtime.reconcile({ sessionId, attachmentId });
    await started.promise;
    const second = runtime.reconcile({ sessionId, attachmentId });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(adapter.reconciles).toBe(1);
    release.resolve();
    await Promise.all([first, second]);
    expect(adapter.reconcileAcknowledgements).toEqual([{ value: 1 }]);
    const snapshot = await runtime.snapshot({ sessionId });
    expect(
      snapshot.frames.filter(
        ({ event }) =>
          event.payload.kind === "turn.started" && event.payload.turnId === "turn-concurrent",
      ),
    ).toHaveLength(1);
  });

  it("cancels reconciliation paused during a non-blocking close without reattaching", async () => {
    const locationStarted = new Gate();
    const releaseLocation = new Gate();
    let delayLocation = false;
    const { runtime, adapter } = composition({
      locations: {
        resolve: async () => {
          if (delayLocation) {
            locationStarted.resolve();
            await releaseLocation.promise;
          }
          return { directory: "/projects/fake", venue };
        },
      },
    });
    const sessionId = await createAndAttach(runtime);
    const attachmentId = (await runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    delayLocation = true;

    const reconciling = runtime.reconcile({ sessionId, attachmentId });
    await locationStarted.promise;
    const closing = runtime.close();
    const closeState = await Promise.race([
      closing.then(() => "closed" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 0)),
    ]);
    releaseLocation.resolve();
    await closing;

    expect(closeState).toBe("closed");
    await expect(reconciling).rejects.toThrow("Session runtime is closed");
    expect(adapter.attaches).toBe(1);
    expect(adapter.reconciles).toBe(0);
    expect(adapter.releaseReasons).toEqual(["shutdown"]);
  });

  it("validates subscriptions, stops delivery after unsubscribe, and makes close idempotent", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    await expect(
      runtime.subscribe({ sessionId, afterSequence: -1 }, () => undefined),
    ).rejects.toThrow("non-negative integer");
    const seen: number[] = [];
    const stop = await runtime.subscribe({ sessionId, afterSequence: 0 }, (frame) => {
      seen.push(frame.sequence);
    });
    const beforeStop = [...seen];
    stop();
    await adapter.emit({
      id: "after-stop",
      kind: "turn.started",
      occurredAt: 500,
      turnId: "turn-after-stop",
    });
    expect(seen).toEqual(beforeStop);

    await runtime.close();
    await runtime.close();
    expect(adapter.releases).toBe(1);
    await expect(runtime.snapshot({ sessionId })).rejects.toThrow("Session runtime is closed");
  });

  it("reports missing sessions, adapters, bindings, and invalid persisted binding metadata explicitly", async () => {
    const { runtime } = composition();
    await expect(runtime.snapshot({ sessionId: "missing" })).rejects.toBeInstanceOf(
      SessionRuntimeNotFoundError,
    );
    const created = await runtime.command({
      commandId: "metadata-create",
      command: { kind: "session.create", projectId: "project-1", ticketId: null, title: null },
    });
    await expect(
      runtime.command({
        commandId: "unknown-adapter",
        sessionId: created.sessionId,
        command: {
          kind: "adapter.attach",
          adapterId: "missing",
          profileId: "native",
          continuity: "fresh",
        },
      }),
    ).resolves.toMatchObject({
      receipt: {
        commandId: "unknown-adapter",
        status: "rejected",
        code: "adapter_missing",
      },
    });
    const malformed = composition();
    const createdMalformed = await malformed.runtime.command({
      commandId: "malformed-create",
      command: { kind: "session.create", projectId: "project-1", ticketId: null, title: null },
    });
    await malformed.engine.observe({
      id: "malformed-attachment",
      sessionId: createdMalformed.sessionId,
      occurredAt: 600,
      provenance: { source: { kind: "adapter", id: "fake", detail: null }, venue },
      kind: "attachment.opened",
      attachment: {
        id: "malformed-attachment",
        sessionId: createdMalformed.sessionId,
        adapterId: "fake",
        venue,
        continuity: "native_resume",
        native: null,
      },
    });
    await expect(
      malformed.runtime.refreshCapabilities({
        sessionId: createdMalformed.sessionId,
        attachmentId: "malformed-attachment",
      }),
    ).rejects.toBeInstanceOf(SessionRuntimeConflictError);
  });

  it("rejects conflicting concurrent command IDs without redelivering the first intent", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    let releaseDispatch!: () => void;
    adapter.dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const first = runtime.command({
      commandId: "same-id",
      sessionId,
      command: { kind: "message.submit", message: userMessage("first", "first") },
    });
    await Promise.resolve();

    await expect(
      runtime.command({
        commandId: "same-id",
        sessionId,
        command: { kind: "message.submit", message: userMessage("second", "second") },
      }),
    ).rejects.toBeInstanceOf(SessionRuntimeConflictError);

    releaseDispatch();
    await first;
    expect(adapter.dispatches).toBe(1);
  });

  it("replays persisted attach, message, interrupt, and release commands before delivery", async () => {
    const first = composition();
    const sessionId = await createAndAttach(first.runtime);
    const attachmentId = (await first.runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    const replayedAttach = await first.runtime.command({
      commandId: "command-attach",
      sessionId,
      command: {
        kind: "adapter.attach",
        adapterId: "fake",
        profileId: "native",
        continuity: "fresh",
      },
    });
    expect(replayedAttach.receipt).toMatchObject({ status: "accepted" });

    const artifacts = createInMemoryTranscriptArtifactStore();
    const reference = await artifacts.write({
      version: 1,
      threadId: `thread:${sessionId}:root`,
      branchId: `branch:${sessionId}:main`,
      attemptId: "attempt:replay-message",
      turnId: "turn:replay-message",
      message: userMessage("replay-message"),
    });
    await first.engine.submit({
      commandId: "replay-message",
      sessionId,
      intent: { kind: "message.submit", reference },
      provenance: { source: { kind: "user", id: "session-client", detail: null }, venue },
    });
    await first.engine.submit({
      commandId: "replay-interrupt",
      sessionId,
      intent: { kind: "executor.interrupt", attachmentId },
      provenance: { source: { kind: "user", id: "session-client", detail: null }, venue },
    });
    await first.engine.submit({
      commandId: "replay-release",
      sessionId,
      intent: { kind: "executor.stop", attachmentId },
      provenance: { source: { kind: "user", id: "session-client", detail: null }, venue },
    });
    await first.runtime.close();

    const recovering = composition({ engine: first.engine, adapter: first.adapter, artifacts });
    await recovering.runtime.command({
      commandId: "replay-message",
      sessionId,
      command: { kind: "message.submit", message: userMessage("replay-message") },
    });
    await recovering.runtime.command({
      commandId: "replay-interrupt",
      sessionId,
      command: { kind: "executor.interrupt", attachmentId },
    });
    await recovering.runtime.command({
      commandId: "replay-release",
      sessionId,
      command: { kind: "adapter.release", attachmentId },
    });

    expect(first.adapter.reconciles).toBe(3);
    expect(first.adapter.commands.map(({ kind }) => kind)).toEqual([
      "message.submit",
      "executor.interrupt",
    ]);
    expect(first.adapter.releaseReasons).toContain("requested");
  });

  it("rolls back a failed durable attach and discards its buffered provider observations", async () => {
    const base = composition();
    const engine: SessionEngine = {
      ...base.engine,
      observe: async (input) => {
        if (input.kind === "attachment.opened") throw new Error("ledger unavailable");
        return base.engine.observe(input);
      },
    };
    const adapter = new FakeAdapter();
    adapter.attachObservation = {
      id: "discard-me",
      kind: "turn.started",
      occurredAt: 700,
      turnId: "discard-me",
    };
    adapter.releaseFailure = new Error("release also failed");
    const { runtime } = composition({ engine, adapter });
    const created = await runtime.command({
      commandId: "rollback-create",
      command: { kind: "session.create", projectId: "project-1", ticketId: null, title: null },
    });

    await expect(
      runtime.command({
        commandId: "rollback-attach",
        sessionId: created.sessionId,
        command: {
          kind: "adapter.attach",
          adapterId: "fake",
          profileId: "native",
          continuity: "fresh",
        },
      }),
    ).rejects.toThrow("ledger unavailable");
    await adapter.emit({
      id: "discarded",
      kind: "turn.completed",
      occurredAt: 701,
      turnId: "discard-me",
    });

    expect(adapter.releaseReasons).toEqual(["adapter_failure"]);
    expect((await runtime.snapshot({ sessionId: created.sessionId })).frames).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({ payload: { kind: "turn.started" } }),
        }),
      ]),
    );
  });

  it("returns previously recorded receipts and rejects commands with no live route", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const attachmentId = (await runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    const message = { kind: "message.submit" as const, message: userMessage("receipt-message") };
    await runtime.command({ commandId: "receipt-message", sessionId, command: message });
    await runtime.command({ commandId: "receipt-message", sessionId, command: message });
    const interrupt = { kind: "executor.interrupt" as const, attachmentId };
    await runtime.command({ commandId: "receipt-interrupt", sessionId, command: interrupt });
    await runtime.command({ commandId: "receipt-interrupt", sessionId, command: interrupt });
    await adapter.emit({
      id: "receipt-interaction",
      kind: "interaction.opened",
      occurredAt: 750,
      interaction: {
        id: "receipt-interaction",
        kind: "permission",
        title: "Receipt",
        detail: null,
        options: [],
        multiple: false,
        native: { id: "native-receipt", detail: null },
      },
    });
    const resolution = { optionIds: [], response: null };
    const resolve = {
      kind: "interaction.resolve" as const,
      interactionId: "receipt-interaction",
      resolution,
    };
    await runtime.command({ commandId: "receipt-resolution", sessionId, command: resolve });
    await runtime.command({ commandId: "receipt-resolution", sessionId, command: resolve });
    const release = { kind: "adapter.release" as const, attachmentId };
    await runtime.command({ commandId: "receipt-release", sessionId, command: release });
    await runtime.command({ commandId: "receipt-release", sessionId, command: release });

    const detached = await runtime.command({
      commandId: "detached-create",
      command: { kind: "session.create", projectId: "project-1", ticketId: null, title: null },
    });
    await expect(
      runtime.command({
        commandId: "detached-interrupt",
        sessionId: detached.sessionId,
        command: { kind: "executor.interrupt" },
      }),
    ).rejects.toBeInstanceOf(SessionRuntimeConflictError);
  });

  it("surfaces failed subscription setup, missing bindings, and corrupt native metadata", async () => {
    const base = composition();
    const sessionId = await createAndAttach(base.runtime);
    const failingReplay: SessionEngine = {
      ...base.engine,
      listEvents: async (input) => {
        if ("afterSequence" in input) throw new Error("replay failed");
        return base.engine.listEvents(input);
      },
    };
    const runtime = composition({ engine: failingReplay, adapter: base.adapter }).runtime;
    await expect(
      runtime.subscribe({ sessionId, afterSequence: 0 }, () => undefined),
    ).rejects.toThrow("replay failed");
    await expect(
      runtime.refreshCapabilities({ sessionId, attachmentId: "missing-binding" }),
    ).rejects.toBeInstanceOf(SessionRuntimeNotFoundError);

    const corrupt = composition();
    const created = await corrupt.runtime.command({
      commandId: "corrupt-create",
      command: { kind: "session.create", projectId: "project-1", ticketId: null, title: null },
    });
    await corrupt.engine.observe({
      id: "corrupt-attachment",
      sessionId: created.sessionId,
      occurredAt: 760,
      provenance: { source: { kind: "adapter", id: "fake", detail: null }, venue },
      kind: "attachment.opened",
      attachment: {
        id: "corrupt-attachment",
        sessionId: created.sessionId,
        adapterId: "fake",
        venue,
        continuity: "native_resume",
        native: { id: "corrupt", detail: { kind: "wrong" } as never },
      },
    });
    await expect(
      corrupt.runtime.refreshCapabilities({
        sessionId: created.sessionId,
        attachmentId: "corrupt-attachment",
      }),
    ).rejects.toThrow("invalid native binding metadata");
  });

  it("recovers persisted interaction resolutions and keeps failed release shutdown best-effort", async () => {
    const artifacts = createInMemoryTranscriptArtifactStore();
    const first = composition({ artifacts });
    const sessionId = await createAndAttach(first.runtime);
    const attachmentId = (await first.runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    await first.adapter.emit({
      id: "resume-interaction",
      kind: "interaction.opened",
      occurredAt: 800,
      interaction: {
        id: "resume-interaction",
        kind: "permission",
        title: "Resume",
        detail: null,
        options: [],
        multiple: false,
        native: { id: "native-resume", detail: null },
      },
    });
    const resolution = { optionIds: [], response: "continue" };
    const reference = await artifacts.write({
      version: 1,
      threadId: `thread:${sessionId}:root`,
      branchId: `branch:${sessionId}:main`,
      attemptId: "attempt:resume-resolution",
      turnId: null,
      message: {
        id: "resume-resolution",
        role: "user",
        metadata: { kind: "interaction-resolution", interactionId: "resume-interaction" },
        parts: [{ type: "data-interaction-resolution", data: resolution }],
      },
    });
    await first.engine.submit({
      commandId: "resume-resolution",
      sessionId,
      intent: {
        kind: "interaction.resolve",
        attachmentId,
        interactionId: "resume-interaction",
        resolution,
        reference,
      },
      provenance: { source: { kind: "user", id: "session-client", detail: null }, venue },
    });
    await first.runtime.close();

    const recovered = composition({ engine: first.engine, adapter: first.adapter, artifacts });
    await recovered.runtime.command({
      commandId: "resume-resolution",
      sessionId,
      command: { kind: "interaction.resolve", interactionId: "resume-interaction", resolution },
    });
    first.adapter.releaseFailure = new Error("already gone");
    await recovered.runtime.close();

    expect(first.adapter.commands).toContainEqual(
      expect.objectContaining({ kind: "interaction.resolve" }),
    );
    expect(first.adapter.releaseReasons).toContain("shutdown");
  });

  it("accepts reconciliation receipts for replayed interrupt, resolution, and release commands", async () => {
    const artifacts = createInMemoryTranscriptArtifactStore();
    const first = composition({ artifacts });
    const sessionId = await createAndAttach(first.runtime);
    const attachmentId = (await first.runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    await first.adapter.emit({
      id: "receipt-replay-interaction",
      kind: "interaction.opened",
      occurredAt: 810,
      interaction: {
        id: "receipt-replay-interaction",
        kind: "permission",
        title: "Reconcile",
        detail: null,
        options: [],
        multiple: false,
        native: { id: "native-reconcile", detail: null },
      },
    });
    const resolution = { optionIds: [], response: null };
    const reference = await artifacts.write({
      version: 1,
      threadId: `thread:${sessionId}:root`,
      branchId: `branch:${sessionId}:main`,
      attemptId: "attempt:receipt-replay-resolution",
      turnId: null,
      message: {
        id: "receipt-replay-resolution",
        role: "user",
        metadata: { kind: "interaction-resolution", interactionId: "receipt-replay-interaction" },
        parts: [{ type: "data-interaction-resolution", data: resolution }],
      },
    });
    await first.engine.submit({
      commandId: "receipt-replay-interrupt",
      sessionId,
      intent: { kind: "executor.interrupt", attachmentId },
      provenance: { source: { kind: "user", id: "session-client", detail: null }, venue },
    });
    await first.engine.submit({
      commandId: "receipt-replay-resolution",
      sessionId,
      intent: {
        kind: "interaction.resolve",
        attachmentId,
        interactionId: "receipt-replay-interaction",
        resolution,
        reference,
      },
      provenance: { source: { kind: "user", id: "session-client", detail: null }, venue },
    });
    await first.engine.submit({
      commandId: "receipt-replay-release",
      sessionId,
      intent: { kind: "executor.stop", attachmentId },
      provenance: { source: { kind: "user", id: "session-client", detail: null }, venue },
    });
    await first.runtime.close();

    const recovered = composition({ engine: first.engine, adapter: first.adapter, artifacts });
    for (const [commandId, command] of [
      ["receipt-replay-interrupt", { kind: "executor.interrupt", attachmentId }],
      [
        "receipt-replay-resolution",
        { kind: "interaction.resolve", interactionId: "receipt-replay-interaction", resolution },
      ],
      ["receipt-replay-release", { kind: "adapter.release", attachmentId }],
    ] as const) {
      first.adapter.reconcileReceipts = [
        { commandId, status: "accepted", acceptedAt: 811, native: { id: commandId, detail: null } },
      ];
      const result = await recovered.runtime.command({ commandId, sessionId, command });
      expect(result.receipt).toMatchObject({ status: "accepted", commandId });
    }
    expect(first.adapter.dispatches).toBe(0);
  });

  it("handles subscription close races, empty external event streams, and omitted optional delivery", async () => {
    const memory = createInMemoryTranscriptArtifactStore();
    let releaseRead!: () => void;
    let reading!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const artifacts: TranscriptArtifactStore = {
      write: (record) => memory.write(record),
      read: async (reference) => {
        reading();
        await readGate;
        return memory.read(reference);
      },
    };
    const { runtime, adapter, engine } = composition({ artifacts });
    const sessionId = await createAndAttach(runtime);
    const stop = await runtime.subscribe(
      { sessionId, afterSequence: (await runtime.snapshot({ sessionId })).throughSequence },
      () => undefined,
    );
    const pending = runtime.command({
      commandId: "close-during-frame",
      sessionId,
      command: {
        kind: "message.submit",
        message: userMessage("close-during-frame"),
        delivery: undefined,
      },
    });
    await readStarted;
    await runtime.close();
    releaseRead();
    await pending;
    stop();
    expect(adapter.releaseReasons).toContain("shutdown");

    const emptyEvents: SessionEngine = { ...engine, listEvents: async () => [] };
    const external = composition({
      engine: emptyEvents,
      adapter: new FakeAdapter(),
      artifacts: memory,
    }).runtime;
    expect((await external.snapshot({ sessionId })).throughSequence).toBe(0);
  });

  it("retains active subscribers through close and distinguishes no-route and late attach failures", async () => {
    const artifacts = createInMemoryTranscriptArtifactStore();
    const { runtime, engine } = composition({ artifacts });
    const created = await runtime.command({
      commandId: "no-route-create",
      command: { kind: "session.create", projectId: "project-1", ticketId: null, title: null },
    });
    const reference = await artifacts.write({
      version: 1,
      threadId: `thread:${created.sessionId}:root`,
      branchId: `branch:${created.sessionId}:main`,
      attemptId: "attempt:no-route-message",
      turnId: "turn:no-route-message",
      message: userMessage("no-route"),
    });
    await engine.submit({
      commandId: "no-route-message",
      sessionId: created.sessionId,
      intent: { kind: "message.submit", reference },
      provenance: { source: { kind: "user", id: "session-client", detail: null }, venue },
    });
    await expect(
      runtime.command({
        commandId: "no-route-message",
        sessionId: created.sessionId,
        command: { kind: "message.submit", message: userMessage("no-route") },
      }),
    ).resolves.toMatchObject({ receipt: { status: "rejected", code: "no_live_executor" } });

    const active = composition();
    const activeSession = await createAndAttach(active.runtime);
    const first = await active.runtime.subscribe(
      { sessionId: activeSession, afterSequence: 0 },
      () => undefined,
    );
    const second = await active.runtime.subscribe(
      { sessionId: activeSession, afterSequence: 0 },
      () => undefined,
    );
    await active.runtime.close();
    first();
    second();
    expect(active.adapter.releaseReasons).toContain("shutdown");

    const failingBase = composition();
    const failingEngine: SessionEngine = {
      ...failingBase.engine,
      observe: async (input) => {
        if (input.kind === "capabilities.updated") throw new Error("capabilities unavailable");
        return failingBase.engine.observe(input);
      },
    };
    const failure = composition({ engine: failingEngine });
    const failureSession = await failure.runtime.command({
      commandId: "late-failure-create",
      command: { kind: "session.create", projectId: "project-1", ticketId: null, title: null },
    });
    await expect(
      failure.runtime.command({
        commandId: "late-failure-attach",
        sessionId: failureSession.sessionId,
        command: {
          kind: "adapter.attach",
          adapterId: "fake",
          profileId: "native",
          continuity: "fresh",
        },
      }),
    ).rejects.toThrow("capabilities unavailable");
    expect(failure.adapter.releaseReasons).toEqual([]);
  });

  it("finishes delayed subscription setup after close and restores bindings without a locator", async () => {
    const base = composition();
    const sessionId = await createAndAttach(base.runtime);
    let releaseReplay!: () => void;
    let replayRequested!: () => void;
    const replayGate = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const replayStarted = new Promise<void>((resolve) => {
      replayRequested = resolve;
    });
    const delayed: SessionEngine = {
      ...base.engine,
      listEvents: async (input) => {
        if ("afterSequence" in input) {
          replayRequested();
          await replayGate;
        }
        return base.engine.listEvents(input);
      },
    };
    const closing = composition({ engine: delayed, adapter: base.adapter }).runtime;
    const subscription = closing.subscribe({ sessionId, afterSequence: 0 }, () => undefined);
    await replayStarted;
    await closing.close();
    releaseReplay();
    (await subscription)();

    const restored = composition();
    const created = await restored.runtime.command({
      commandId: "locator-create",
      command: { kind: "session.create", projectId: "project-1", ticketId: null, title: null },
    });
    await restored.engine.observe({
      id: "locator-attachment",
      sessionId: created.sessionId,
      occurredAt: 900,
      provenance: { source: { kind: "adapter", id: "fake", detail: null }, venue },
      kind: "attachment.opened",
      attachment: {
        id: "locator-attachment",
        sessionId: created.sessionId,
        adapterId: "fake",
        venue,
        continuity: "native_resume",
        native: {
          id: "locator-native",
          detail: { kind: "volli.native-binding.v1", profileId: "native" },
        },
      },
    });
    await expect(
      restored.runtime.refreshCapabilities({
        sessionId: created.sessionId,
        attachmentId: "locator-attachment",
      }),
    ).resolves.toMatchObject({ revision: 1 });
  });

  it("publishes an externally recovered receipt even when its command event is absent from the stream", async () => {
    const base = composition();
    const sessionId = await createAndAttach(base.runtime);
    const request = {
      commandId: "stream-gap-message",
      sessionId,
      command: { kind: "message.submit" as const, message: userMessage("stream-gap-message") },
    };
    await base.runtime.command(request);
    const inconsistent: SessionEngine = {
      ...base.engine,
      listEvents: async (input) => {
        const events = await base.engine.listEvents(input);
        if (!("afterSequence" in input)) {
          return events.filter(
            (event) =>
              !(
                event.payload.kind === "command.recorded" &&
                event.payload.command.id === "stream-gap-message"
              ),
          );
        }
        return events;
      },
    };
    const recovering = composition({ engine: inconsistent, adapter: base.adapter }).runtime;
    await expect(recovering.command(request)).resolves.toMatchObject({
      receipt: { status: "accepted", commandId: "stream-gap-message" },
    });
  });
});
