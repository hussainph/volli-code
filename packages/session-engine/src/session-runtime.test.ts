import { describe, expect, it } from "vite-plus/test";
import type { SessionEvent, SessionLedgerIds } from "@volli/shared";
import type { UIMessage } from "ai";
import {
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
  createNativeAdapterRegistry,
  createSessionEngine,
  createSessionRuntime,
  isSessionStreamOverlay,
  SessionRuntimeConflictError,
  SessionRuntimeNotFoundError,
  type BindingHandle,
  type HarnessCommand,
  type HarnessObservation,
  type NativeHarnessAdapter,
  type NativeProbeResult,
  type ObservationSink,
  type SessionEngine,
  type SessionLocationResolver,
  type SessionRuntime,
  type SessionStreamEmission,
  type SessionStreamFrame,
  type SessionStreamOverlay,
  type TranscriptArtifactStore,
  type TranscriptDelta,
} from "./index";

const venue = { id: "machine-1", kind: "local" as const };

/** Nothing was ever materialized, so nothing a binding holds can have gone missing. */
const stillThere = async () => undefined;

/** A host with nothing to materialize: preparing a location is resolving it. */
function fixedLocation(directory: string): SessionLocationResolver {
  const at = async () => ({ directory, venue });
  return { resolve: at, prepare: at, reaffirm: stillThere };
}

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
  reconcileCursors: Parameters<BindingHandle["reconcile"]>[0][] = [];
  reconcileAcknowledgements: Array<Awaited<ReturnType<BindingHandle["reconcile"]>>["cursor"]> = [];
  releases = 0;
  sink: ObservationSink | null = null;
  reconcileReceipts: Awaited<ReturnType<BindingHandle["reconcile"]>>["receipts"] = [];
  reconcileObservations: HarnessObservation[] = [];
  reconcileGate: Promise<void> | null = null;
  reconcileStarted: () => void = () => undefined;
  probeResult: NativeProbeResult | null = null;
  attachFailure: unknown = null;
  attachGate: Promise<void> | null = null;
  attachStarted: () => void = () => undefined;
  releaseFailure: unknown = null;
  dispatchReceipt: Awaited<ReturnType<BindingHandle["dispatch"]>> | null = null;
  dispatchGate: Promise<void> | null = null;
  commands: HarnessCommand[] = [];
  /** What each attach was actually pointed at — the live half of the directory contract. */
  specs: Parameters<NativeHarnessAdapter["attach"]>[0][] = [];
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
    spec: Parameters<NativeHarnessAdapter["attach"]>[0],
    sink: ObservationSink,
  ): Promise<BindingHandle> {
    this.attaches += 1;
    this.specs.push(spec);
    this.attachStarted();
    await this.attachGate;
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
      reconcile: async (cursor) => {
        this.reconciles += 1;
        this.reconcileCursors.push(cursor);
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
    /** One clock for engine and runtime, as the composition root supplies. */
    clock?: { now: () => number };
    onSubscriberFailure?: (error: unknown) => void;
  } = {},
): { runtime: SessionRuntime; engine: SessionEngine; adapter: FakeAdapter } {
  let now = 100;
  const clock = options.clock ?? { now: () => now++ };
  const engine =
    options.engine ??
    createSessionEngine({
      ledger: createInMemorySessionLedger(),
      clock,
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
      locations: options.locations ?? fixedLocation("/projects/fake"),
      clock,
      ids: runtimeIds(options.runtimeIdPrefix),
      ...(options.onSubscriberFailure ? { onSubscriberFailure: options.onSubscriberFailure } : {}),
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

  it("keeps unavailable catalog inventory out of the durable Session stream", async () => {
    const { runtime, adapter } = composition();
    adapter.probeResult = {
      status: "available",
      runtime: { path: "/trusted/fake", version: "1.0.0", fingerprint: "sha256:fake" },
      capabilities: {
        features: [],
        catalog: [
          {
            kind: "model",
            id: "provider/usable",
            label: "Usable",
            state: "available",
            evidence: "reported",
            detail: null,
          },
          {
            kind: "model",
            id: "provider/exhaustive-inventory",
            label: "Exhaustive inventory",
            state: "unavailable",
            evidence: "reported",
            detail: { payload: "does not belong in every Session snapshot" },
          },
        ],
      },
    };

    const sessionId = await createAndAttach(runtime);
    const snapshot = await runtime.snapshot({ sessionId });

    expect(snapshot.projection.capabilities.at(-1)?.catalog).toEqual([
      expect.objectContaining({ id: "provider/usable" }),
    ]);
    expect(JSON.stringify(snapshot.frames)).not.toContain("exhaustive-inventory");
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
      (emission) => {
        if (isSessionStreamOverlay(emission)) return;
        steps.push("published");
        seen.push(emission.event);
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
      (emission) => {
        if (isSessionStreamOverlay(emission)) return;
        seen.push(emission.event);
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
      (emission) => {
        if (isSessionStreamOverlay(emission)) return;
        sequences.push(emission.sequence);
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

  it("refuses the attach when the host cannot produce the directory", async () => {
    // The adapter is never asked. A binding made against a directory that is
    // not there is the failure the reader gets per prompt instead of once, and
    // wearing the harness's name for a missing path rather than this one.
    const detail = "Couldn't prepare the worktree at /w/VC-12 — fatal: invalid reference";
    const { runtime, adapter } = composition({
      locations: {
        resolve: async () => ({ directory: "/w/VC-12", venue }),
        prepare: async () => {
          throw new Error(detail);
        },
        reaffirm: stillThere,
      },
    });
    const session = await runtime.command({
      commandId: "unprepared-create",
      command: {
        kind: "session.create",
        projectId: "project-1",
        ticketId: "ticket-1",
        title: null,
      },
    });

    await expect(
      runtime.command({
        commandId: "unprepared-attach",
        sessionId: session.sessionId,
        command: {
          kind: "adapter.attach",
          adapterId: "fake",
          profileId: "native",
          continuity: "fresh",
        },
      }),
    ).resolves.toMatchObject({
      receipt: { status: "rejected", code: "location_unavailable", detail },
    });
    expect(adapter.probes).toBe(0);
    expect((await runtime.snapshot({ sessionId: session.sessionId })).projection).toMatchObject({
      liveExecutor: null,
      attachments: [{ status: "failed", failure: { code: "location_unavailable", detail } }],
    });
  });

  it("binds and records the directory it prepared, not the one it resolved", async () => {
    // The case the split exists for: a worktree ticket with no stamp yet, where
    // `resolve` can only name the main checkout and `prepare` is what makes the
    // isolated one. Both halves have to say the prepared directory — the live
    // spec, and the durable binding a later resume reads instead of re-reading.
    const { runtime, adapter } = composition({
      locations: {
        resolve: async () => ({ directory: "/projects/fake", venue }),
        prepare: async () => ({ directory: "/w/VC-12", venue }),
        reaffirm: stillThere,
      },
    });
    const sessionId = await createAndAttach(runtime);

    expect(adapter.specs.at(-1)?.directory).toBe("/w/VC-12");
    const { projection } = await runtime.snapshot({ sessionId });
    expect(projection.attachments[0]?.native?.detail).toMatchObject({
      kind: "volli.native-binding.v1",
      directory: "/w/VC-12",
    });
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
        options: [{ id: "allow", label: "Allow", description: null }],
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

  it("cancels a pending interaction as a fact, without answering it or telling the harness", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const attachmentId = (await runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    await adapter.emit({
      id: "question-1",
      kind: "interaction.opened",
      occurredAt: 300,
      interaction: {
        id: "question-1",
        kind: "question",
        title: "Which files should I read?",
        detail: null,
        options: [{ id: "prompt:0/option:0", label: "All of them", description: null }],
        multiple: true,
        native: { id: "native-question-1", detail: null },
      },
    });
    const dispatchesBefore = adapter.dispatches;

    await runtime.cancelInteraction({
      sessionId,
      interactionId: "question-1",
      reason: "abandoned",
    });

    const { projection, frames } = await runtime.snapshot({ sessionId });
    expect(projection.interactions).toMatchObject({ active: [], resolved: [] });
    // No delivery, so no receipt: the harness was never told an answer and
    // Volli does not pretend otherwise.
    expect(adapter.dispatches).toBe(dispatchesBefore);
    expect(frames.map(({ event }) => event.payload).at(-1)).toEqual({
      kind: "interaction.cancelled",
      attachmentId,
      interactionId: "question-1",
      reason: "abandoned",
    });
    expect(frames.at(-1)?.event.provenance.source).toEqual({
      kind: "user",
      id: "session-client",
      detail: null,
    });
    expect(projection.receipts.some(({ commandId }) => commandId.includes("question-1"))).toBe(
      false,
    );

    // Two Stop clicks, or a click racing the harness's own answer: the second
    // cancel finds nothing open and says so by doing nothing. It carries no
    // idempotency key, so the state it asked for is the only thing to answer
    // against — and that state already holds.
    const throughSequence = frames.at(-1)!.sequence;
    await expect(
      runtime.cancelInteraction({
        sessionId,
        interactionId: "question-1",
        reason: "withdrawn",
      }),
    ).resolves.toBeUndefined();
    const repeated = await runtime.snapshot({ sessionId });
    expect(repeated.throughSequence).toBe(throughSequence);
    expect(repeated.projection.interactions).toEqual({ active: [], resolved: [] });
    // An unknown Session is still a fault: nothing was ever asked there.
    await expect(
      runtime.cancelInteraction({
        sessionId: "session-missing",
        interactionId: "question-1",
        reason: "withdrawn",
      }),
    ).rejects.toBeInstanceOf(SessionRuntimeNotFoundError);
    await runtime.close();
    await expect(
      runtime.cancelInteraction({ sessionId, interactionId: "question-1", reason: "superseded" }),
    ).rejects.toThrow("Session runtime is closed");
  });

  it("still takes down a card whose attachment closed under it", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const attachmentId = (await runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    await adapter.emit({
      id: "question-2",
      kind: "interaction.opened",
      occurredAt: 300,
      interaction: {
        id: "question-2",
        kind: "question",
        title: "Which files should I read?",
        detail: null,
        options: [{ id: "prompt:0/option:0", label: "All of them", description: null }],
        multiple: true,
        native: { id: "native-question-2", detail: null },
      },
    });
    await adapter.emit({
      id: "closed-under-question",
      kind: "attachment.closed",
      occurredAt: 301,
      outcome: "interrupted",
    });
    const before = await runtime.snapshot({ sessionId });
    // Closing the binding does not answer what it asked, so the card outlives it.
    expect(before.projection.liveExecutor).toBeNull();
    expect(before.projection.interactions.active).toHaveLength(1);
    const dispatchesBefore = adapter.dispatches;

    await runtime.cancelInteraction({
      sessionId,
      interactionId: "question-2",
      reason: "withdrawn",
    });

    const { projection, frames } = await runtime.snapshot({ sessionId });
    expect(projection.interactions).toMatchObject({ active: [], resolved: [] });
    expect(adapter.dispatches).toBe(dispatchesBefore);
    expect(frames.map(({ event }) => event.payload).at(-1)).toEqual({
      kind: "interaction.cancelled",
      attachmentId,
      interactionId: "question-2",
      reason: "withdrawn",
    });
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
    const at = async () => {
      if (delayLocation) {
        locationStarted.resolve();
        await releaseLocation.promise;
      }
      return { directory: "/projects/fake", venue };
    };
    const { runtime, adapter } = composition({
      locations: { resolve: at, prepare: at, reaffirm: stillThere },
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

  it("releases a rehydrated binding that finishes attaching after close", async () => {
    const first = composition();
    const sessionId = await createAndAttach(first.runtime);
    const attachmentId = (await first.runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    await first.runtime.close();
    const attachStarted = new Gate();
    const releaseAttach = new Gate();
    first.adapter.attachStarted = () => attachStarted.resolve();
    first.adapter.attachGate = releaseAttach.promise;
    const recovered = composition({ engine: first.engine, adapter: first.adapter });

    const reconciling = recovered.runtime.reconcile({ sessionId, attachmentId });
    await attachStarted.promise;
    const closing = recovered.runtime.close();
    const closeState = await Promise.race([
      closing.then(() => "closed" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 0)),
    ]);
    releaseAttach.resolve();
    await closing;

    expect(closeState).toBe("closed");
    await expect(reconciling).rejects.toThrow("Session runtime is closed");
    expect(first.adapter.attaches).toBe(2);
    expect(first.adapter.reconciles).toBe(0);
    expect(first.adapter.releaseReasons).toEqual(["shutdown", "shutdown"]);
  });

  it("validates subscriptions, stops delivery after unsubscribe, and makes close idempotent", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    await expect(
      runtime.subscribe({ sessionId, afterSequence: -1 }, () => undefined),
    ).rejects.toThrow("non-negative integer");
    const seen: number[] = [];
    const stop = await runtime.subscribe({ sessionId, afterSequence: 0 }, (emission) => {
      if (isSessionStreamOverlay(emission)) return;
      seen.push(emission.sequence);
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
    // Asked of the runtime whose ledger answers: reading a Session's history
    // is a cursored read now, so the replay-hostile engine above fails it
    // before any binding is looked up.
    await expect(
      base.runtime.refreshCapabilities({ sessionId, attachmentId: "missing-binding" }),
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

  it("answers Session state without the transcript replay a snapshot carries", async () => {
    const { runtime } = composition();
    const sessionId = await createAndAttach(runtime);

    const snapshot = await runtime.snapshot({ sessionId });
    const projection = await runtime.projection({ sessionId });

    expect(Object.keys(projection).toSorted()).toEqual(["projection", "throughSequence"]);
    expect(projection.throughSequence).toBe(snapshot.throughSequence);
    expect(projection.projection).toEqual(snapshot.projection);
    expect(snapshot.frames.length).toBeGreaterThan(0);
  });

  it("folds a Session's history once and re-reads only what the ledger appended", async () => {
    const base = composition();
    const reads: string[] = [];
    const projectedReads: string[] = [];
    const cursors: (number | undefined)[] = [];
    const counting: SessionEngine = {
      ...base.engine,
      getBaseSession: async (query) => {
        reads.push(query.sessionId);
        return base.engine.getBaseSession(query);
      },
      // The engine's own fold. A cache miss needs the row the fold starts from
      // and nothing else, so reaching for this here would fold the same log
      // twice for one read.
      getSession: async (query) => {
        projectedReads.push(query.sessionId);
        return base.engine.getSession(query);
      },
      listEvents: async (query) => {
        cursors.push(query.afterSequence);
        return base.engine.listEvents(query);
      },
    };
    const { runtime } = composition({ engine: counting, adapter: base.adapter });
    const sessionId = await createAndAttach(runtime);

    // The attach already folded this Session once; nothing reads it whole again.
    const folded = await runtime.projection({ sessionId });
    const cached = await runtime.projection({ sessionId });

    expect(reads).toEqual([sessionId]);
    expect(projectedReads).toEqual([]);
    expect(cached.projection).toBe(folded.projection);
    expect(cursors.at(-1)).toBe(folded.throughSequence);

    await base.adapter.emit({
      id: "cached-attention",
      kind: "attention.raised",
      occurredAt: 500,
      attention: { id: "attention-cached", kind: "auth_required", detail: null, diagnostic: null },
    });
    const appended = await runtime.projection({ sessionId });

    expect(appended.projection).not.toBe(folded.projection);
    expect(appended.projection.attention.primary?.id).toBe("attention-cached");
    expect(appended.throughSequence).toBeGreaterThan(folded.throughSequence);
    expect(reads).toEqual([sessionId]);
  });

  it("re-folds a history that only the clock made stale", async () => {
    let now = 1_000;
    const { runtime } = composition({ clock: { now: () => now } });
    const sessionId = await createAndAttach(runtime);

    const observed = await runtime.projection({ sessionId });
    expect(observed.projection.capabilities.map(({ expiresAt }) => expiresAt)).toEqual([61_000]);

    // Nothing was appended: the snapshot simply expired. A cache watching only
    // the ledger would still be offering a capability the harness lost.
    now = 61_000;
    const expired = await runtime.projection({ sessionId });

    expect(expired.projection.capabilities).toEqual([]);
    expect(expired.throughSequence).toBe(observed.throughSequence);
  });

  it("takes its deadline from the capability snapshot that expires first", async () => {
    let now = 1_000;
    const { runtime, engine } = composition({ clock: { now: () => now } });
    const sessionId = await createAndAttach(runtime);
    const attachmentId = (await runtime.projection({ sessionId })).projection.liveExecutor!.id;
    // Scope is adapter/profile/attachment, so these are four live snapshots
    // beside the attach's own — one of them with no expiry at all.
    for (const [profileId, expiresAt] of [
      ["soon", 30_000],
      ["late", 90_000],
      ["eternal", null],
    ] as const) {
      await engine.observe({
        id: `deadline-${profileId}`,
        sessionId,
        attachmentId,
        occurredAt: now,
        provenance: { source: { kind: "adapter", id: "fake", detail: null }, venue },
        kind: "capabilities.updated",
        snapshot: {
          id: `deadline-capabilities-${profileId}`,
          adapterId: "fake",
          attachmentId,
          profileId,
          revision: 1,
          observedAt: now,
          expiresAt,
          features: [],
          catalog: [],
        },
      });
    }

    const observed = await runtime.projection({ sessionId });
    expect(observed.projection.capabilities.map(({ profileId }) => profileId)).toEqual([
      "native",
      "soon",
      "late",
      "eternal",
    ]);

    // The earliest expiry is the deadline: at it, the fold has to run again
    // even though the other three are still good and nothing was appended.
    now = 30_000;
    expect(
      (await runtime.projection({ sessionId })).projection.capabilities.map(
        ({ profileId }) => profileId,
      ),
    ).toEqual(["native", "late", "eternal"]);

    now = 90_000;
    expect(
      (await runtime.projection({ sessionId })).projection.capabilities.map(
        ({ profileId }) => profileId,
      ),
    ).toEqual(["eternal"]);
  });

  it("bounds how many folded histories it keeps", async () => {
    const base = composition();
    const reads: string[] = [];
    const counting: SessionEngine = {
      ...base.engine,
      getBaseSession: async (query) => {
        reads.push(query.sessionId);
        return base.engine.getBaseSession(query);
      },
    };
    const { runtime } = composition({ engine: counting, adapter: base.adapter });
    const sessions: string[] = [];
    let oldest = "";
    let newest = "";
    // One past the limit, so the first Session read is the one evicted.
    for (let index = 0; index <= 8; index += 1) {
      const created = await runtime.command({
        commandId: `bounded-create-${index}`,
        command: { kind: "session.create", projectId: "project-1", ticketId: null, title: null },
      });
      if (index === 0) oldest = created.sessionId;
      newest = created.sessionId;
      sessions.push(created.sessionId);
      await runtime.projection({ sessionId: created.sessionId });
    }
    expect(reads).toEqual(sessions);

    await runtime.projection({ sessionId: newest });
    await runtime.projection({ sessionId: oldest });

    expect(reads).toEqual([...sessions, oldest]);
  });
});

// ---------------------------------------------------------------------------
// The transient overlay (docs/plans/delta-frames.md, "Engine"). Nothing below
// this line may cost a durable write: a delta is what the assistant is saying
// right now, and only a settle point is what it said.
// ---------------------------------------------------------------------------

const OVERLAY_MESSAGE_ID = "assistant-1";

function deltaObservation(
  id: string,
  delta: TranscriptDelta,
  messageId = OVERLAY_MESSAGE_ID,
): HarnessObservation {
  return {
    id,
    kind: "transcript.delta",
    occurredAt: 400,
    threadId: "thread:overlay:root",
    branchId: "branch:overlay:main",
    attemptId: "attempt:overlay",
    turnId: "turn-1",
    messageId,
    delta,
  };
}

function resetDelta(text: string, messageId = OVERLAY_MESSAGE_ID): TranscriptDelta {
  return {
    op: "reset",
    message: {
      id: messageId,
      role: "assistant",
      parts: [{ key: "text-1", part: { type: "text", text } }],
    },
  };
}

function settleObservation(id: string, text: string, messageId = OVERLAY_MESSAGE_ID) {
  return {
    id,
    kind: "transcript.message",
    occurredAt: 500,
    turnId: "turn-1",
    threadId: "thread:overlay:root",
    branchId: "branch:overlay:main",
    attemptId: "attempt:overlay",
    message: { id: messageId, role: "assistant", parts: [{ type: "text", text }] },
  } satisfies HarnessObservation;
}

function overlaysIn(emissions: readonly SessionStreamEmission[]): SessionStreamOverlay[] {
  return emissions.filter((emission) => isSessionStreamOverlay(emission));
}

/**
 * Runs the microtasks an in-flight `emit` still owes before its overlay reaches
 * a subscriber's chain. Nothing here waits on a timer, so a fixed number of
 * turns is deterministic — and if it ever stopped being enough, the branch it
 * exists to reach would show up uncovered rather than flaky.
 */
async function settleMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

describe("SessionRuntime transient transcript overlay", () => {
  it("publishes deltas without a durable trace, a dedupe window, or a cursor advance", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const before = await runtime.snapshot({ sessionId });
    const attachmentId = before.projection.liveExecutor!.id;
    const emissions: SessionStreamEmission[] = [];
    const stop = await runtime.subscribe(
      { sessionId, afterSequence: before.throughSequence },
      (emission) => {
        emissions.push(emission);
      },
    );

    // The same observation id twice: a delta carries no durable identity, so
    // the id that dedupes Session facts must not swallow the second one.
    await adapter.emit(deltaObservation("delta-1", resetDelta("Hel")));
    await adapter.emit(
      deltaObservation("delta-1", { op: "part.append", key: "text-1", text: "lo" }),
    );
    await runtime.reconcile({ sessionId, attachmentId });
    stop();

    const after = await runtime.snapshot({ sessionId });
    expect(after.throughSequence).toBe(before.throughSequence);
    expect(after.transcript).toEqual([]);
    expect(emissions).toEqual([
      {
        kind: "overlay",
        sessionId,
        throughSequence: before.throughSequence,
        messageId: OVERLAY_MESSAGE_ID,
        delta: resetDelta("Hel"),
      },
      {
        kind: "overlay",
        sessionId,
        throughSequence: before.throughSequence,
        messageId: OVERLAY_MESSAGE_ID,
        delta: { op: "part.append", key: "text-1", text: "lo" },
      },
    ]);
    // No delta moved the reconcile cursor: the provider is still asked for
    // everything since the last fact this Session actually wrote down.
    expect(adapter.reconcileCursors).toEqual([null]);
  });

  it("serves a late subscriber the folded message as one reset baseline", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    await adapter.emit(deltaObservation("delta-1", resetDelta("Hel")));
    await adapter.emit(
      deltaObservation("delta-2", { op: "part.append", key: "text-1", text: "lo" }),
    );
    await adapter.emit(
      deltaObservation("delta-3", resetDelta("Second", "assistant-2"), "assistant-2"),
    );

    const latest = (await runtime.snapshot({ sessionId })).throughSequence;
    const emissions: SessionStreamEmission[] = [];
    const stop = await runtime.subscribe({ sessionId, afterSequence: latest }, (emission) => {
      emissions.push(emission);
    });
    stop();

    // One baseline per in-flight message, each carrying the engine's fold —
    // not the deltas that built it.
    expect(overlaysIn(emissions)).toEqual([
      {
        kind: "overlay",
        sessionId,
        throughSequence: latest,
        messageId: OVERLAY_MESSAGE_ID,
        delta: resetDelta("Hello"),
      },
      {
        kind: "overlay",
        sessionId,
        throughSequence: latest,
        messageId: "assistant-2",
        delta: resetDelta("Second", "assistant-2"),
      },
    ]);
  });

  it("clears a message's overlay when its durable snapshot is processed", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    await adapter.emit(deltaObservation("delta-1", resetDelta("Hello")));
    await adapter.emit(
      deltaObservation("delta-2", resetDelta("Other", "assistant-2"), "assistant-2"),
    );
    await adapter.emit(settleObservation("settle-1", "Hello"));

    const emissions: SessionStreamEmission[] = [];
    const stop = await runtime.subscribe(
      { sessionId, afterSequence: (await runtime.snapshot({ sessionId })).throughSequence },
      (emission) => {
        emissions.push(emission);
      },
    );
    stop();

    expect(overlaysIn(emissions).map(({ messageId }) => messageId)).toEqual(["assistant-2"]);
    expect((await runtime.snapshot({ sessionId })).transcript).toMatchObject([
      { message: { id: OVERLAY_MESSAGE_ID, parts: [{ text: "Hello" }] } },
    ]);
  });

  it("stamps a baseline with the durable sequence a later settle can be told from", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    await adapter.emit(deltaObservation("delta-1", resetDelta("Hel")));

    const emissions: SessionStreamEmission[] = [];
    const stop = await runtime.subscribe(
      { sessionId, afterSequence: (await runtime.snapshot({ sessionId })).throughSequence },
      (emission) => {
        emissions.push(emission);
      },
    );
    await adapter.emit(settleObservation("settle-1", "Hello"));
    stop();

    const [baseline] = overlaysIn(emissions);
    const settled = emissions.find(
      (emission) =>
        !isSessionStreamOverlay(emission) &&
        emission.event.payload.kind === "transcript.referenced",
    );
    // The guard the consumer applies: this baseline is strictly below the
    // settle's sequence, so a fold that already applied the settle drops it —
    // which is what makes the order the two arrive in immaterial.
    expect(baseline!.throughSequence).toBeLessThan(
      (settled as SessionStreamFrame | undefined)!.sequence,
    );
  });

  it("keeps an overlay ahead of a durable publish that arrives after it", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const order: string[] = [];
    const entered = new Gate();
    const release = new Gate();
    let blocked = false;
    const stop = await runtime.subscribe(
      { sessionId, afterSequence: (await runtime.snapshot({ sessionId })).throughSequence },
      async (emission) => {
        order.push(isSessionStreamOverlay(emission) ? "overlay" : emission.event.payload.kind);
        if (isSessionStreamOverlay(emission) && !blocked) {
          blocked = true;
          entered.resolve();
          await release.promise;
        }
      },
    );

    const streaming = adapter.emit(deltaObservation("delta-1", resetDelta("Hel")));
    await entered.promise;
    const submitting = runtime.command({
      commandId: "overlay-ordering-submit",
      sessionId,
      command: { kind: "message.submit", message: userMessage("overlay-ordering") },
    });
    await settleMicrotasks();
    release.resolve();
    await Promise.all([streaming, submitting]);
    stop();

    expect(order[0]).toBe("overlay");
    expect(order.slice(1)).not.toContain("overlay");
  });

  /**
   * The runtime is not the ledger's only writer, and a subscriber that assumed
   * it was went deaf for the rest of the Session.
   *
   * A retitle submitted straight to the Engine — what `volli:session-rename`
   * does, and what a chat titling itself from its first message now does on
   * every first turn — appends three events the publish path never sees. The
   * drain delivers `cursor + 1` and nothing else, so those three were a hole
   * that never filled: the turn's own `turn.completed` landed behind it and was
   * never handed over, leaving the Session working forever with a Stop button
   * nothing could clear.
   */
  it("delivers past a gap left by a writer that bypassed the publish path", async () => {
    const { runtime, engine, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const kinds: string[] = [];
    const stop = await runtime.subscribe(
      { sessionId, afterSequence: (await runtime.snapshot({ sessionId })).throughSequence },
      (emission) => {
        if (!isSessionStreamOverlay(emission)) kinds.push(emission.event.payload.kind);
      },
    );

    await adapter.emit({
      id: "turn-open",
      kind: "turn.started",
      occurredAt: 800,
      turnId: "turn-1",
    });
    // Out of band, exactly as the rename IPC does it: durable, and invisible to
    // every live subscriber.
    await engine.submit({
      commandId: "rename-mid-turn",
      sessionId,
      intent: { kind: "session.retitle", title: "Titled from its first message" },
      provenance: { source: { kind: "user", id: "renderer", detail: null }, venue },
    });
    await adapter.emit({
      id: "turn-close",
      kind: "turn.completed",
      occurredAt: 801,
      turnId: "turn-1",
    });
    stop();

    // In sequence order, with the three unpublished events read back from the
    // ledger rather than skipped — a subscriber may never be handed a hole.
    expect(kinds).toEqual([
      "turn.started",
      "command.recorded",
      "session.retitled",
      "command.receipt.recorded",
      "turn.completed",
    ]);
  });

  it("drops the overlay when the attachment closes and when the adapter is released", async () => {
    const closing = composition();
    const closedSession = await createAndAttach(closing.runtime);
    await closing.adapter.emit(deltaObservation("delta-1", resetDelta("Hel")));
    await closing.adapter.emit({
      id: "closed-1",
      kind: "attachment.closed",
      occurredAt: 600,
      outcome: "completed",
    });
    const afterClose: SessionStreamEmission[] = [];
    (
      await closing.runtime.subscribe(
        {
          sessionId: closedSession,
          afterSequence: (
            await closing.runtime.snapshot({ sessionId: closedSession })
          ).throughSequence,
        },
        (emission) => {
          afterClose.push(emission);
        },
      )
    )();

    const releasing = composition();
    const releasedSession = await createAndAttach(releasing.runtime);
    const attachmentId = (await releasing.runtime.snapshot({ sessionId: releasedSession }))
      .projection.liveExecutor!.id;
    await releasing.adapter.emit(deltaObservation("delta-1", resetDelta("Hel")));
    await releasing.runtime.command({
      commandId: "overlay-release",
      sessionId: releasedSession,
      command: { kind: "adapter.release", attachmentId },
    });
    const afterRelease: SessionStreamEmission[] = [];
    (
      await releasing.runtime.subscribe(
        {
          sessionId: releasedSession,
          afterSequence: (
            await releasing.runtime.snapshot({ sessionId: releasedSession })
          ).throughSequence,
        },
        (emission) => {
          afterRelease.push(emission);
        },
      )
    )();

    expect(overlaysIn(afterClose)).toEqual([]);
    expect(overlaysIn(afterRelease)).toEqual([]);
  });

  it("bounds how many Sessions keep an overlay", async () => {
    const { runtime, adapter } = composition();
    const sessions: string[] = [];
    // One past the limit, so the first Session's in-flight message is the one
    // evicted — and an evicted overlay is a message the next reset rebuilds.
    for (let index = 0; index <= 8; index += 1) {
      const created = await runtime.command({
        commandId: `overlay-create-${index}`,
        command: { kind: "session.create", projectId: "project-1", ticketId: null, title: null },
      });
      await runtime.command({
        commandId: `overlay-attach-${index}`,
        sessionId: created.sessionId,
        command: {
          kind: "adapter.attach",
          adapterId: "fake",
          profileId: "native",
          continuity: "fresh",
        },
      });
      await adapter.emit(deltaObservation(`delta-${index}`, resetDelta(`Session ${index}`)));
      sessions.push(created.sessionId);
    }

    const seen = new Map<string, SessionStreamOverlay[]>();
    for (const sessionId of [sessions[0]!, sessions[8]!]) {
      const emissions: SessionStreamEmission[] = [];
      (
        await runtime.subscribe(
          { sessionId, afterSequence: (await runtime.snapshot({ sessionId })).throughSequence },
          (emission) => {
            emissions.push(emission);
          },
        )
      )();
      seen.set(sessionId, overlaysIn(emissions));
    }

    expect(seen.get(sessions[0]!)).toEqual([]);
    expect(seen.get(sessions[8]!)).toMatchObject([{ delta: { op: "reset" } }]);
  });

  it("re-seeds the overlay after a failed read rather than reporting sequence zero", async () => {
    const base = composition();
    let failListEvents = false;
    const engine: SessionEngine = {
      ...base.engine,
      listEvents: async (query) => {
        if (failListEvents) throw new Error("ledger unavailable");
        return base.engine.listEvents(query);
      },
    };
    const { runtime, adapter } = composition({ engine, adapter: base.adapter });
    const sessionId = await createAndAttach(runtime);

    failListEvents = true;
    await expect(adapter.emit(deltaObservation("delta-1", resetDelta("Hel")))).rejects.toThrow(
      "ledger unavailable",
    );
    failListEvents = false;
    await adapter.emit(deltaObservation("delta-2", resetDelta("Hello")));

    const latest = (await runtime.snapshot({ sessionId })).throughSequence;
    const emissions: SessionStreamEmission[] = [];
    (
      await runtime.subscribe({ sessionId, afterSequence: latest }, (emission) => {
        emissions.push(emission);
      })
    )();

    expect(overlaysIn(emissions)).toEqual([
      {
        kind: "overlay",
        sessionId,
        throughSequence: latest,
        messageId: OVERLAY_MESSAGE_ID,
        delta: resetDelta("Hello"),
      },
    ]);
  });

  it("does not let one subscriber's cursor inflate the sequence other subscribers are stamped with", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    await adapter.emit(deltaObservation("delta-1", resetDelta("Hel")));
    const head = (await runtime.snapshot({ sessionId })).throughSequence;

    // A cursor names where one subscriber resumes. It is client input — an SSE
    // reconnect supplies it — and it is checked only for being a non-negative
    // integer, so it says nothing about what this Session has durably written.
    const stopAhead = await runtime.subscribe(
      { sessionId, afterSequence: head + 1_000_000 },
      () => undefined,
    );
    const emissions: SessionStreamEmission[] = [];
    const stop = await runtime.subscribe({ sessionId, afterSequence: head }, (emission) => {
      emissions.push(emission);
    });
    await adapter.emit(
      deltaObservation("delta-2", { op: "part.append", key: "text-1", text: "lo" }),
    );
    stopAhead();
    stop();

    // Both the baseline and the delta behind it still carry the real head. A
    // number above it would be a claim to be newer than every settle, which is
    // what the consumer's staleness guard reads to drop an overtaken overlay.
    expect(overlaysIn(emissions).map(({ throughSequence }) => throughSequence)).toEqual([
      head,
      head,
    ]);
  });

  it("lets a durable publish that lands during the seeding read outrank the seed", async () => {
    const base = composition();
    let publishDuringRead: (() => Promise<void>) | null = null;
    const engine: SessionEngine = {
      ...base.engine,
      listEvents: async (query) => {
        const publish = publishDuringRead;
        publishDuringRead = null;
        const page = await base.engine.listEvents(query);
        // Between the page and the moment `#overlay` records what it says. The
        // seed is now the older of the two facts, and the record it is seeding
        // has already been moved past it.
        if (publish) await publish();
        return page;
      },
    };
    const { runtime, adapter } = composition({ engine, adapter: base.adapter });
    const sessionId = await createAndAttach(runtime);
    const seededFrom = (await runtime.snapshot({ sessionId })).throughSequence;

    const emissions: SessionStreamEmission[] = [];
    const stop = await runtime.subscribe({ sessionId, afterSequence: seededFrom }, (emission) => {
      emissions.push(emission);
    });
    publishDuringRead = async () => {
      await runtime.command({
        commandId: "overlay-seed-race-submit",
        sessionId,
        command: { kind: "message.submit", message: userMessage("overlay-seed-race") },
      });
    };
    await adapter.emit(deltaObservation("delta-1", resetDelta("Hel")));
    stop();

    // The number only ever moves forward, so the later of the two wins whichever
    // order they arrive in. Stamping the delta with the seed's older sequence
    // would put it below events the subscriber has already folded, and the
    // staleness guard would throw away an overlay that is not stale at all.
    const durableHead = (await runtime.snapshot({ sessionId })).throughSequence;
    expect(durableHead).toBeGreaterThan(seededFrom);
    expect(overlaysIn(emissions).map(({ throughSequence }) => throughSequence)).toEqual([
      durableHead,
    ]);
  });

  it("honours an overlay dropped while the read that seeds it is still in flight", async () => {
    const base = composition();
    let dropOverlay: (() => Promise<void>) | null = null;
    const engine: SessionEngine = {
      ...base.engine,
      listEvents: async (query) => {
        // Fires once, from inside the seeding read `#overlay` awaits — the one
        // window where the record is in the map and the value it starts from is
        // not yet known.
        const drop = dropOverlay;
        dropOverlay = null;
        if (drop) await drop();
        return base.engine.listEvents(query);
      },
    };
    const { runtime, adapter } = composition({ engine, adapter: base.adapter });
    const sessionId = await createAndAttach(runtime);
    const attachmentId = (await runtime.snapshot({ sessionId })).projection.liveExecutor!.id;

    dropOverlay = async () => {
      await runtime.command({
        commandId: "overlay-dropped-mid-read",
        sessionId,
        command: { kind: "adapter.release", attachmentId },
      });
    };
    await adapter.emit(deltaObservation("delta-1", resetDelta("Hel")));

    expect(adapter.releases).toBe(1);
    const emissions: SessionStreamEmission[] = [];
    (
      await runtime.subscribe(
        { sessionId, afterSequence: (await runtime.snapshot({ sessionId })).throughSequence },
        (emission) => {
          emissions.push(emission);
        },
      )
    )();
    // The release dropped the overlay; the delta that was mid-read may not put
    // it back. A baseline here would be transient text for a Session with no
    // binding left to finish it.
    expect(overlaysIn(emissions)).toEqual([]);
  });

  it("contains a subscriber that fails on an overlay, and stops delivering to one that left", async () => {
    const failures: unknown[] = [];
    const failing = composition({
      onSubscriberFailure: (error) => {
        failures.push(error);
      },
    });
    const failingSession = await createAndAttach(failing.runtime);
    const delivered: string[] = [];
    await failing.runtime.subscribe(
      {
        sessionId: failingSession,
        afterSequence: (await failing.runtime.snapshot({ sessionId: failingSession }))
          .throughSequence,
      },
      (emission) => {
        delivered.push(isSessionStreamOverlay(emission) ? "overlay" : emission.event.payload.kind);
        if (isSessionStreamOverlay(emission)) throw new Error("overlay client failed");
      },
    );
    await failing.adapter.emit(deltaObservation("delta-1", resetDelta("Hel")));
    await failing.adapter.emit(settleObservation("settle-1", "Hello"));

    expect(delivered).toEqual(["overlay"]);
    expect(failures).toEqual([expect.objectContaining({ message: "overlay client failed" })]);

    const leaving = composition();
    const leavingSession = await createAndAttach(leaving.runtime);
    // The record exists before the gated emit below, so that emit has only its
    // own awaits left to run before the overlay reaches the chain.
    await leaving.adapter.emit(deltaObservation("delta-1", resetDelta("Hel")));
    const seen: string[] = [];
    const entered = new Gate();
    const release = new Gate();
    const stop = await leaving.runtime.subscribe(
      {
        sessionId: leavingSession,
        afterSequence: (await leaving.runtime.snapshot({ sessionId: leavingSession }))
          .throughSequence,
      },
      async (emission) => {
        seen.push(isSessionStreamOverlay(emission) ? "overlay" : emission.event.payload.kind);
        if (!isSessionStreamOverlay(emission)) {
          entered.resolve();
          await release.promise;
        }
      },
    );
    const submitting = leaving.runtime.command({
      commandId: "overlay-leaving-submit",
      sessionId: leavingSession,
      command: { kind: "message.submit", message: userMessage("overlay-leaving") },
    });
    await entered.promise;
    const streaming = leaving.adapter.emit(
      deltaObservation("delta-2", { op: "part.append", key: "text-1", text: "lo" }),
    );
    await settleMicrotasks();
    stop();
    release.resolve();
    await Promise.all([submitting, streaming]);

    // The baseline reached the chain before the subscriber left; the append
    // queued behind it never reaches a listener that is no longer listening.
    expect(seen).toEqual(["overlay", "command.recorded"]);
  });
});
