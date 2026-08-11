import { describe, expect, it } from "vite-plus/test";
import type { RuntimeObservation, SessionEvent, SessionLedgerIds } from "@volli/shared";
import type { UIMessage } from "ai";
import {
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
  createSessionEngine,
  createSessionRuntime,
  isSessionStreamOverlay,
  NativeAttachmentError,
  SessionRuntimeConflictError,
  SessionRuntimeNotFoundError,
  type BindingHandle,
  type HarnessCommand,
  type NativeHarnessAdapter,
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
  readonly id = "fake";
  readonly durableIdNamespace = "fake";
  readonly adapterVersion = "1.0.0";
  readonly runtime = { path: "/trusted/fake", version: "1.0.0", fingerprint: "sha256:fake" };
  attaches = 0;
  dispatches = 0;
  reconciles = 0;
  reconcileCursors: Parameters<BindingHandle["reconcile"]>[0][] = [];
  reconcileAcknowledgements: Array<Awaited<ReturnType<BindingHandle["reconcile"]>>["cursor"]> = [];
  releases = 0;
  sink: ObservationSink | null = null;
  reconcileReceipts: Awaited<ReturnType<BindingHandle["reconcile"]>>["receipts"] = [];
  reconcileObservations: RuntimeObservation[] = [];
  reconcileGate: Promise<void> | null = null;
  reconcileFailure: unknown = null;
  reconcileStarted: () => void = () => undefined;
  attachFailure: unknown = null;
  attachGate: Promise<void> | null = null;
  attachStarted: () => void = () => undefined;
  releaseFailure: unknown = null;
  dispatchReceipt: Awaited<ReturnType<BindingHandle["dispatch"]>> | null = null;
  dispatchGate: Promise<void> | null = null;
  dispatchStarted: () => void = () => undefined;
  withdrawals: string[] = [];
  /** Off means the optional method is absent, not present and inert. */
  withdrawsInteractions = true;
  withdrawFailure: unknown = null;
  withdrawThrow: unknown = null;
  commands: HarnessCommand[] = [];
  /** What each attach was actually pointed at — the live half of the directory contract. */
  specs: Parameters<NativeHarnessAdapter["attach"]>[0][] = [];
  attachObservation: RuntimeObservation | null = null;
  releaseReasons: string[] = [];

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
        this.dispatchStarted();
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
        if (this.reconcileFailure) throw this.reconcileFailure;
        return {
          cursor: { value: this.reconciles },
          observations: this.reconcileObservations,
          receipts: this.reconcileReceipts,
        };
      },
      acknowledgeReconciliation: async (cursor) => {
        this.reconcileAcknowledgements.push(cursor);
      },
      ...(this.withdrawsInteractions
        ? {
            // Deliberately not `async`: a harness that fails before it has a
            // promise to reject is the case a bare `.catch()` would miss.
            withdrawInteraction: (interactionId: string) => {
              this.withdrawals.push(interactionId);
              if (this.withdrawThrow) throw this.withdrawThrow;
              return this.withdrawFailure
                ? Promise.reject(this.withdrawFailure)
                : Promise.resolve();
            },
          }
        : {}),
      release: async (reason) => {
        this.releases += 1;
        this.releaseReasons.push(reason);
        if (this.releaseFailure) throw this.releaseFailure;
      },
    };
  }

  emit(observation: RuntimeObservation): Promise<void> {
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
      executor: adapter,
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
    command: { kind: "adapter.attach", continuity: "fresh" },
  });
  return created.sessionId;
}

describe("SessionRuntime native adapter contract", () => {
  it("records product model selection without an adapter command", async () => {
    const { runtime } = composition();
    const created = await runtime.command({
      commandId: "command-create-model-selection",
      command: {
        kind: "session.create",
        projectId: "project-1",
        ticketId: "ticket-1",
        title: "Model selection",
      },
    });
    const selection = {
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high" as const,
    };

    const selected = await runtime.command({
      commandId: "command-select-model",
      sessionId: created.sessionId,
      command: { kind: "model.select", selection },
    });

    expect(selected.receipt).toMatchObject({
      status: "completed",
      result: { kind: "model.selected" },
    });
    await expect(runtime.projection({ sessionId: created.sessionId })).resolves.toMatchObject({
      projection: { modelSelection: selection },
    });
  });

  it("applies an idle live model selection before committing its durable policy", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const selection = {
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high" as const,
    };

    const selected = await runtime.command({
      commandId: "command-select-live-model",
      sessionId,
      command: { kind: "model.select", selection },
    });

    expect(adapter.commands.at(-1)).toMatchObject({
      kind: "model.select",
      commandId: "command-select-live-model",
      selection,
    });
    expect(selected.receipt).toMatchObject({
      status: "completed",
      result: { kind: "model.selected", sessionId },
    });
    await expect(runtime.projection({ sessionId })).resolves.toMatchObject({
      projection: { modelSelection: selection },
    });

    const dispatches = adapter.dispatches;
    await expect(
      runtime.command({
        commandId: "command-select-live-model",
        sessionId,
        command: { kind: "model.select", selection },
      }),
    ).resolves.toEqual(selected);
    expect(adapter.dispatches).toBe(dispatches);
  });

  it("keeps the previous model policy when the live runtime rejects a change", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    adapter.dispatchReceipt = {
      commandId: "command-select-rejected-model",
      status: "rejected",
      code: "PI_MODEL_UNAVAILABLE",
      detail: "The selected model is not currently available.",
      native: null,
    };

    const selected = await runtime.command({
      commandId: "command-select-rejected-model",
      sessionId,
      command: {
        kind: "model.select",
        selection: {
          providerId: "openai-codex",
          modelId: "missing",
          reasoningLevel: "off",
        },
      },
    });

    expect(selected.receipt).toMatchObject({
      status: "rejected",
      code: "PI_MODEL_UNAVAILABLE",
    });
    await expect(runtime.projection({ sessionId })).resolves.toMatchObject({
      projection: { modelSelection: null },
    });
  });

  it("completes a persisted model selection from accepted reconciliation after relaunch", async () => {
    const first = composition();
    const sessionId = await createAndAttach(first.runtime);
    const selection = {
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high" as const,
    };
    await first.engine.submit({
      commandId: "command-select-reconciled-model",
      sessionId,
      intent: { kind: "model.select", selection },
      provenance: { source: { kind: "user", id: "session-client", detail: null }, venue },
    });
    await first.runtime.close();
    first.adapter.reconcileReceipts = [
      {
        commandId: "command-select-reconciled-model",
        status: "accepted",
        acceptedAt: 250,
        native: { id: "native-model-selection", detail: null },
      },
    ];
    const recovered = composition({ engine: first.engine, adapter: first.adapter });

    const selected = await recovered.runtime.command({
      commandId: "command-select-reconciled-model",
      sessionId,
      command: { kind: "model.select", selection },
    });

    expect(selected.receipt).toMatchObject({
      status: "completed",
      result: { kind: "model.selected", sessionId },
    });
    expect(first.adapter.dispatches).toBe(0);
    await expect(recovered.runtime.projection({ sessionId })).resolves.toMatchObject({
      projection: { modelSelection: selection },
    });
  });

  it("redelivers a persisted receipt-less model selection after reconciliation finds no outcome", async () => {
    const { runtime, engine, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const selection = {
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "medium" as const,
    };
    await engine.submit({
      commandId: "command-select-redelivered-model",
      sessionId,
      intent: { kind: "model.select", selection },
      provenance: { source: { kind: "user", id: "session-client", detail: null }, venue },
    });

    const selected = await runtime.command({
      commandId: "command-select-redelivered-model",
      sessionId,
      command: { kind: "model.select", selection },
    });

    expect(adapter.reconciles).toBe(1);
    expect(adapter.commands.at(-1)).toMatchObject({
      kind: "model.select",
      commandId: "command-select-redelivered-model",
    });
    expect(selected.receipt).toMatchObject({ status: "completed" });
  });

  it("records an unknown reconciled model-selection outcome without changing model policy", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const attachmentId = (await runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    adapter.dispatchReceipt = {
      commandId: "command-select-unknown-model",
      status: "unknown",
      detail: "provider did not confirm selection",
      native: null,
    };
    const selection = {
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high" as const,
    };
    await runtime.command({
      commandId: "command-select-unknown-model",
      sessionId,
      command: { kind: "model.select", selection },
    });
    adapter.reconcileReceipts = [
      {
        commandId: "command-select-unknown-model",
        status: "unknown",
        detail: "provider still did not confirm selection",
        native: null,
      },
    ];

    await runtime.reconcile({ sessionId, attachmentId });

    const { projection } = await runtime.projection({ sessionId });
    expect(projection.modelSelection).toBeNull();
    expect(
      projection.receipts.filter(({ commandId }) => commandId === "command-select-unknown-model"),
    ).toMatchObject([
      { status: "unreconciled", detail: "provider did not confirm selection" },
      { status: "unreconciled", detail: "provider still did not confirm selection" },
    ]);

    adapter.reconcileReceipts = [
      {
        commandId: "command-select-unknown-model",
        status: "accepted",
        acceptedAt: 300,
        native: { id: "native-model-selection", detail: null },
      },
    ];
    await runtime.reconcile({ sessionId, attachmentId });

    await expect(runtime.projection({ sessionId })).resolves.toMatchObject({
      projection: {
        modelSelection: selection,
        receipts: expect.arrayContaining([
          expect.objectContaining({
            commandId: "command-select-unknown-model",
            status: "completed",
            result: { kind: "model.selected", sessionId },
          }),
        ]),
      },
    });
  });

  it("settles a fresh model selection when its durable binding directory is unavailable", async () => {
    let unavailable = false;
    const locations: SessionLocationResolver = {
      resolve: async () => ({ directory: "/projects/fake", venue }),
      prepare: async () => ({ directory: "/projects/fake", venue }),
      reaffirm: async () => {
        if (unavailable) throw new Error("worktree is missing");
      },
    };
    const first = composition({ locations });
    const sessionId = await createAndAttach(first.runtime);
    await first.runtime.close();
    unavailable = true;
    const recovered = composition({
      engine: first.engine,
      adapter: first.adapter,
      locations,
      runtimeIdPrefix: "model-location-",
    });

    await expect(
      recovered.runtime.command({
        commandId: "command-select-missing-location",
        sessionId,
        command: {
          kind: "model.select",
          selection: {
            providerId: "openai-codex",
            modelId: "gpt-5.6-sol",
            reasoningLevel: "high",
          },
        },
      }),
    ).resolves.toMatchObject({
      receipt: { status: "rejected", code: "location_unavailable" },
    });
    expect(first.adapter.attaches).toBe(1);

    unavailable = false;
    await expect(
      recovered.runtime.command({
        commandId: "command-select-restored-location",
        sessionId,
        command: {
          kind: "model.select",
          selection: {
            providerId: "openai-codex",
            modelId: "gpt-5.6-sol",
            reasoningLevel: "high",
          },
        },
      }),
    ).resolves.toMatchObject({ receipt: { status: "completed" } });
    expect(first.adapter.attaches).toBe(2);
  });

  it("rejects a persisted model selection that has neither a receipt nor an attachment route", async () => {
    const ledger = createInMemorySessionLedger();
    const engine = createSessionEngine({ ledger, clock: { now: () => 100 }, ids: ids() });
    const session = {
      id: "session-unrouted-model",
      projectId: "project-1",
      ticketId: null,
      title: null,
      createdAt: 0,
    };
    const selection = {
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high" as const,
    };
    const command = {
      id: "command-unrouted-model",
      sessionId: session.id,
      createdAt: 0,
      intent: { kind: "model.select" as const, selection },
      route: null,
    };
    await ledger.transaction((transaction) => {
      transaction.insertSession(session);
      transaction.saveCommand(command);
      transaction.appendEvent({
        id: "event-unrouted-model",
        sessionId: session.id,
        sequence: 1,
        occurredAt: 0,
        recordedAt: 0,
        provenance: { source: { kind: "user", id: "session-client", detail: null }, venue },
        commandId: command.id,
        payload: { kind: "command.recorded", command },
      });
    });
    const { runtime } = composition({ engine });

    await expect(
      runtime.command({
        commandId: command.id,
        sessionId: session.id,
        command: { kind: "model.select", selection },
      }),
    ).rejects.toThrow(
      "Model selection command-unrouted-model has neither a receipt nor a live attachment route",
    );
  });

  it("does not admit a model change while a message is becoming active", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const dispatchStarted = new Gate();
    const releaseDispatch = new Gate();
    adapter.dispatchStarted = () => dispatchStarted.resolve();
    adapter.dispatchGate = releaseDispatch.promise;

    const message = runtime.command({
      commandId: "command-racing-message",
      sessionId,
      command: { kind: "message.submit", message: userMessage("racing-message") },
    });
    await dispatchStarted.promise;
    const selection = runtime.command({
      commandId: "command-racing-model",
      sessionId,
      command: {
        kind: "model.select",
        selection: {
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          reasoningLevel: "high",
        },
      },
    });
    const admission = await Promise.race([
      selection.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]);
    expect(admission).toBe("pending");
    await adapter.emit({
      kind: "turn",
      state: "started",
      turnId: "turn-racing-model",
      occurredAt: 160,
    });
    releaseDispatch.resolve();

    await message;
    await expect(selection).resolves.toMatchObject({
      receipt: { status: "rejected", code: "turn_active" },
    });
  });

  it("delivers an interrupt while the active message command is still running", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const dispatchStarted = new Gate();
    const releaseDispatch = new Gate();
    adapter.dispatchStarted = () => dispatchStarted.resolve();
    adapter.dispatchGate = releaseDispatch.promise;

    const message = runtime.command({
      commandId: "command-long-message",
      sessionId,
      command: { kind: "message.submit", message: userMessage("long-message") },
    });
    await dispatchStarted.promise;

    const interrupt = runtime.command({
      commandId: "command-live-interrupt",
      sessionId,
      command: { kind: "executor.interrupt" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.commands.map(({ kind }) => kind)).toEqual(["message.submit"]);

    await adapter.emit({
      kind: "turn",
      state: "started",
      turnId: "turn-long-message",
      occurredAt: 160,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(adapter.commands.map(({ kind }) => kind)).toEqual([
      "message.submit",
      "executor.interrupt",
    ]);

    releaseDispatch.resolve();
    await expect(Promise.all([message, interrupt])).resolves.toHaveLength(2);
  });

  it("delivers a steering message after the active turn is durably admitted", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const dispatchStarted = new Gate();
    const releaseDispatch = new Gate();
    adapter.dispatchStarted = () => dispatchStarted.resolve();
    adapter.dispatchGate = releaseDispatch.promise;

    const message = runtime.command({
      commandId: "command-active-message",
      sessionId,
      command: { kind: "message.submit", message: userMessage("active-message") },
    });
    await dispatchStarted.promise;
    await adapter.emit({
      kind: "turn",
      state: "started",
      turnId: "turn-active-message",
      occurredAt: 160,
    });

    const steering = runtime.command({
      commandId: "command-live-steer",
      sessionId,
      command: {
        kind: "message.submit",
        message: userMessage("redirect", "redirect"),
        delivery: "steer",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(adapter.commands.map(({ kind }) => kind)).toEqual(["message.submit", "message.submit"]);
    expect(adapter.commands[1]).toMatchObject({ delivery: "steer" });

    releaseDispatch.resolve();
    await expect(Promise.all([message, steering])).resolves.toHaveLength(2);
  });

  it("buffers startup observations until the attachment is durable", async () => {
    const adapter = new FakeAdapter();
    adapter.attachObservation = {
      kind: "turn",
      state: "started",
      turnId: "turn-startup",
      occurredAt: 150,
    };
    const { runtime } = composition({ adapter });

    const sessionId = await createAndAttach(runtime);
    const snapshot = await runtime.snapshot({ sessionId });

    expect(snapshot.frames.map(({ event }) => event.payload.kind)).toEqual(
      expect.arrayContaining(["attachment.opened", "turn.started"]),
    );
    expect(
      snapshot.frames.find(({ event }) => event.payload.kind === "turn.started")?.event.sequence,
    ).toBeGreaterThan(
      snapshot.frames.find(({ event }) => event.payload.kind === "attachment.opened")!.event
        .sequence,
    );
  });

  it("persists an interrupted turn distinctly and projects the Session idle", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);

    await adapter.emit({
      kind: "turn",
      state: "started",
      turnId: "turn-1",
      occurredAt: 160,
    });
    expect((await runtime.snapshot({ sessionId })).projection.turnActive).toBe(true);

    await adapter.emit({
      kind: "turn",
      state: "interrupted",
      turnId: "turn-1",
      occurredAt: 161,
    });

    const snapshot = await runtime.snapshot({ sessionId });
    expect(snapshot.projection.turnActive).toBe(false);
    expect(snapshot.frames.map(({ event }) => event.payload.kind)).toContain("turn.interrupted");
  });

  it("records a durable authority.denied event with the attachment id filled in from the spec", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const attachmentId = (await runtime.snapshot({ sessionId })).projection.liveExecutor!.id;

    await adapter.emit({
      kind: "authority",
      state: "denied",
      occurredAt: 160,
      turnId: "turn-1",
      tool: "execute",
      cause: "command.destructive-removal",
      reason: "rm -rf resolves under a home directory",
    });

    const snapshot = await runtime.snapshot({ sessionId });
    const denial = snapshot.frames.find(({ event }) => event.payload.kind === "authority.denied");
    expect(denial?.event.attachmentId).toBe(attachmentId);
    expect(denial?.event.payload).toEqual({
      kind: "authority.denied",
      attachmentId,
      turnId: "turn-1",
      tool: "execute",
      cause: "command.destructive-removal",
      reason: "rm -rf resolves under a home directory",
    });
    expect(snapshot.projection.authorityDenials).toBe(1);
  });

  it("attaches and releases through the narrow binding", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const snapshot = await runtime.snapshot({ sessionId });

    expect(adapter.attaches).toBe(1);
    expect(snapshot.projection.liveExecutor).toMatchObject({
      adapterId: "fake",
      native: {
        id: "native-session-1",
        detail: {
          kind: "volli.native-binding.v1",
          runtime: { path: "/trusted/fake", version: "1.0.0", fingerprint: "sha256:fake" },
        },
      },
    });

    await runtime.command({
      commandId: "command-release",
      sessionId,
      command: { kind: "adapter.release", attachmentId: snapshot.projection.liveExecutor!.id },
    });
    expect(adapter.releases).toBe(1);
    expect((await runtime.snapshot({ sessionId })).projection.liveExecutor).toBeNull();
  });

  it("drops a released binding's tail instead of recording it against the closed attachment", async () => {
    // The artifact write is the one await between accepting a settled message
    // and recording it, so parking there holds a fan-out open and lets the
    // release land in the middle of one.
    const memory = createInMemoryTranscriptArtifactStore();
    const writing = new Gate();
    const released = new Gate();
    const { runtime, adapter } = composition({
      artifacts: {
        write: async (record) => {
          writing.resolve();
          await released.promise;
          return memory.write(record);
        },
        read: (reference) => memory.read(reference),
      },
    });
    const sessionId = await createAndAttach(runtime);
    const attachmentId = (await runtime.snapshot({ sessionId })).projection.liveExecutor!.id;

    // A delta first, so the settle below is a fan-out rather than a single
    // fact: the streaming claim is withdrawn transiently, and only then is the
    // durable message written. A settled message never reuses its stream's id,
    // so the withdrawal is not incidental — every streamed answer fans out.
    await adapter.emit(textDelta("Hi"));
    const settling = adapter.emit(settledMessage("assistant-1", "Hi"));
    await writing.promise;
    // Admitted while the binding is still live, but queued behind that fan-out
    // and so never translated at all.
    const queued = adapter.emit({ kind: "turn", state: "completed", turnId: "turn-1" });

    await runtime.command({
      commandId: "command-release-mid-fanout",
      sessionId,
      command: { kind: "adapter.release", attachmentId },
    });
    released.resolve();

    // Neither rejects. A tail that outlived its binding is dropped here, not
    // refused by the ledger and thrown back out through the executor's own
    // observer — which is what makes this the Session's guarantee rather than
    // a side effect of the executor draining before it closes.
    await expect(settling).resolves.toBeUndefined();
    await expect(queued).resolves.toBeUndefined();

    const after = await runtime.snapshot({ sessionId });
    const kinds = after.frames.map((frame) => frame.event.payload.kind);
    expect(after.projection.liveExecutor).toBeNull();
    expect(kinds).toContain("attachment.closed");
    expect(kinds).not.toContain("transcript.referenced");
    expect(kinds).not.toContain("turn.completed");
    expect(after.transcript).toEqual([]);
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
      kind: "message-settled",
      turnId: "turn-1",
      occurredAt: 300,
      message: { entryId: "assistant-1", role: "assistant", text: "Hi" },
    });
    unsubscribe();

    expect(steps).toEqual(["artifact", "published"]);
    expect(seen).toMatchObject([{ payload: { kind: "transcript.referenced" } }]);
    expect((await runtime.snapshot({ sessionId })).transcript).toMatchObject([
      { message: { parts: [{ text: "Hi" }] } },
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
        kind: "message-settled",
        turnId: "turn-1",
        occurredAt: 300,
        message: { entryId: "assistant-1", role: "assistant", text: "Hi" },
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

  it("records failed native attachments as durable outcomes", async () => {
    const misconfigured = composition();
    const misconfiguredSession = await misconfigured.runtime.command({
      commandId: "misconfigured-create",
      command: { kind: "session.create", projectId: "project-1", ticketId: null, title: null },
    });
    misconfigured.adapter.attachFailure = new NativeAttachmentError(
      "No Pi model is configured",
      "PI_CONFIGURATION_INVALID",
      "configuration_invalid",
    );
    const misconfiguredResult = await misconfigured.runtime.command({
      commandId: "misconfigured-attach",
      sessionId: misconfiguredSession.sessionId,
      command: { kind: "adapter.attach", continuity: "fresh" },
    });
    expect(misconfiguredResult.receipt).toMatchObject({
      status: "rejected",
      code: "PI_CONFIGURATION_INVALID",
    });
    expect(
      (await misconfigured.runtime.snapshot({ sessionId: misconfiguredSession.sessionId }))
        .projection.attention.primary,
    ).toMatchObject({
      attachmentId: null,
      kind: "configuration_invalid",
      detail: "No Pi model is configured",
    });
    const firstConfigurationAttention = (
      await misconfigured.runtime.snapshot({ sessionId: misconfiguredSession.sessionId })
    ).projection.attention.primary;
    expect(firstConfigurationAttention).not.toBeNull();
    await misconfigured.runtime.command({
      commandId: "misconfigured-attach-again",
      sessionId: misconfiguredSession.sessionId,
      command: { kind: "adapter.attach", continuity: "fresh" },
    });
    const repeatedConfigurationAttention = (
      await misconfigured.runtime.snapshot({ sessionId: misconfiguredSession.sessionId })
    ).projection.attention.active;
    expect(repeatedConfigurationAttention).toHaveLength(1);
    expect(repeatedConfigurationAttention[0]).toMatchObject({
      id: firstConfigurationAttention!.id,
      attachmentId: null,
      kind: "configuration_invalid",
    });
    misconfigured.adapter.attachFailure = null;
    await misconfigured.runtime.command({
      commandId: "misconfigured-retry",
      sessionId: misconfiguredSession.sessionId,
      command: { kind: "adapter.attach", continuity: "fresh" },
    });
    expect(
      (await misconfigured.runtime.snapshot({ sessionId: misconfiguredSession.sessionId }))
        .projection.attention.primary,
    ).toBeNull();

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
        command: { kind: "adapter.attach", continuity: "fresh" },
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
        command: { kind: "adapter.attach", continuity: "fresh" },
      }),
    ).resolves.toMatchObject({ receipt: { detail: "socket disappeared" } });
  });

  it("retires an unrecoverable attach Attention once an attach succeeds", async () => {
    // The sibling of the configuration case above, and it used to be the one
    // that never ended: the clear path named `configuration_invalid` alone, so
    // a Session that failed recovery once wore the Attention for good. Nothing
    // else clears an attach-failure id. The per-attachment `:recovery` ids
    // share the kind and are therefore retired by this same clear — see
    // "retires a released attachment's recovery Attention", which pins that as
    // the only exit they have once their attachment is gone.
    const unrecoverable = composition();
    const session = await unrecoverable.runtime.command({
      commandId: "unrecoverable-create",
      command: { kind: "session.create", projectId: "project-1", ticketId: null, title: null },
    });
    unrecoverable.adapter.attachFailure = new NativeAttachmentError(
      "Pi recovery sidecar identity does not match this attachment",
      "PI_RECOVERY_FAILED",
      "adapter_unrecoverable",
    );
    await expect(
      unrecoverable.runtime.command({
        commandId: "unrecoverable-attach",
        sessionId: session.sessionId,
        command: { kind: "adapter.attach", continuity: "fresh" },
      }),
    ).resolves.toMatchObject({ receipt: { status: "rejected", code: "PI_RECOVERY_FAILED" } });
    expect(
      (await unrecoverable.runtime.snapshot({ sessionId: session.sessionId })).projection.attention
        .primary,
    ).toMatchObject({ attachmentId: null, kind: "adapter_unrecoverable" });

    unrecoverable.adapter.attachFailure = null;
    await unrecoverable.runtime.command({
      commandId: "unrecoverable-retry",
      sessionId: session.sessionId,
      command: { kind: "adapter.attach", continuity: "fresh" },
    });
    expect(
      (await unrecoverable.runtime.snapshot({ sessionId: session.sessionId })).projection.attention
        .active,
    ).toHaveLength(0);
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
        command: { kind: "adapter.attach", continuity: "fresh" },
      }),
    ).resolves.toMatchObject({
      receipt: { status: "rejected", code: "location_unavailable", detail },
    });
    expect(adapter.attaches).toBe(0);
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
      kind: "interaction",
      state: "opened",
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
      kind: "interaction",
      state: "resolved",
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

  it("records and dispatches an explicit executor retry to the live attachment", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const attachmentId = (await runtime.snapshot({ sessionId })).projection.liveExecutor!.id;

    const retried = await runtime.command({
      commandId: "retry-1",
      sessionId,
      command: { kind: "executor.retry" },
    });

    expect(adapter.commands.at(-1)).toEqual({
      kind: "executor.retry",
      commandId: "retry-1",
      sessionId,
      attachmentId,
    });
    expect(retried).toMatchObject({
      command: { intent: { kind: "executor.retry", attachmentId } },
      receipt: { status: "accepted", result: { kind: "executor.retried" } },
    });
    await runtime.command({
      commandId: "retry-1",
      sessionId,
      command: { kind: "executor.retry", attachmentId },
    });
    expect(adapter.commands.filter(({ kind }) => kind === "executor.retry")).toHaveLength(1);
  });

  it("keeps recovery Attention when replaying an old accepted retry", async () => {
    const first = composition();
    const sessionId = await createAndAttach(first.runtime);
    const attachmentId = (await first.runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    const request = {
      commandId: "accepted-retry-replay",
      sessionId,
      command: { kind: "executor.retry" as const, attachmentId },
    };
    await first.runtime.command(request);
    await first.runtime.close();
    first.adapter.attachFailure = new NativeAttachmentError(
      "The Pi sidecar is temporarily missing",
      "PI_RECOVERY_FAILED",
      "adapter_unrecoverable",
    );
    const recovered = composition({
      engine: first.engine,
      adapter: first.adapter,
      runtimeIdPrefix: "accepted-retry-replay-",
    });
    await expect(recovered.runtime.reconcile({ sessionId, attachmentId })).rejects.toThrow(
      "The Pi sidecar is temporarily missing",
    );

    await expect(recovered.runtime.command(request)).resolves.toMatchObject({
      receipt: { status: "accepted" },
    });
    expect(
      (await recovered.runtime.snapshot({ sessionId })).projection.attention.primary,
    ).toMatchObject({
      id: `${attachmentId}:recovery`,
      kind: "adapter_unrecoverable",
    });
  });

  it("rejects retry when no executor is attached", async () => {
    const { runtime } = composition();
    const created = await runtime.command({
      commandId: "retry-detached-create",
      command: { kind: "session.create", projectId: "project-1", ticketId: null, title: null },
    });

    await expect(
      runtime.command({
        commandId: "retry-detached",
        sessionId: created.sessionId,
        command: { kind: "executor.retry" },
      }),
    ).rejects.toBeInstanceOf(SessionRuntimeConflictError);
  });

  it("reconciles a persisted retry before dispatching it again", async () => {
    const { runtime, adapter, engine } = composition();
    const sessionId = await createAndAttach(runtime);
    const attachmentId = (await runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    await engine.submit({
      commandId: "retry-recovered",
      sessionId,
      intent: { kind: "executor.retry", attachmentId },
      provenance: { source: { kind: "user", id: "session-client", detail: null }, venue },
    });
    adapter.reconcileReceipts = [
      {
        commandId: "retry-recovered",
        status: "accepted",
        acceptedAt: 250,
        native: { id: "retry-recovered", detail: null },
      },
    ];

    const result = await runtime.command({
      commandId: "retry-recovered",
      sessionId,
      command: { kind: "executor.retry", attachmentId },
    });

    expect(result.receipt).toMatchObject({ status: "accepted" });
    expect(adapter.commands.filter(({ kind }) => kind === "executor.retry")).toHaveLength(0);
  });

  it("clears recovery Attention when reconciliation accepts an unreconciled retry", async () => {
    const first = composition();
    const sessionId = await createAndAttach(first.runtime);
    const attachmentId = (await first.runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    const request = {
      commandId: "unreconciled-retry-replay",
      sessionId,
      command: { kind: "executor.retry" as const, attachmentId },
    };
    first.adapter.dispatchReceipt = {
      commandId: request.commandId,
      status: "unknown",
      detail: "Connection closed before acknowledgement",
      native: null,
    };
    await expect(first.runtime.command(request)).resolves.toMatchObject({
      receipt: { status: "unreconciled" },
    });
    await first.runtime.close();
    first.adapter.attachFailure = new NativeAttachmentError(
      "The Pi sidecar is temporarily missing",
      "PI_RECOVERY_FAILED",
      "adapter_unrecoverable",
    );
    const recovered = composition({
      engine: first.engine,
      adapter: first.adapter,
      runtimeIdPrefix: "unreconciled-retry-replay-",
    });
    await expect(recovered.runtime.reconcile({ sessionId, attachmentId })).rejects.toThrow(
      "The Pi sidecar is temporarily missing",
    );
    first.adapter.attachFailure = null;
    first.adapter.reconcileReceipts = [
      {
        commandId: request.commandId,
        status: "accepted",
        acceptedAt: 250,
        native: { id: request.commandId, detail: null },
      },
    ];

    await expect(recovered.runtime.command(request)).resolves.toMatchObject({
      receipt: { status: "accepted" },
    });
    expect(
      (await recovered.runtime.snapshot({ sessionId })).projection.attention.primary,
    ).toBeNull();
    expect(first.adapter.commands.filter(({ kind }) => kind === "executor.retry")).toHaveLength(1);
  });

  it("retires a released attachment's recovery Attention on the next successful attach", async () => {
    // The per-attachment `:recovery` Attention is raised under
    // `adapter_unrecoverable`, so the clear keyed by
    // `ATTACH_FAILURE_ATTENTION_KINDS` retires it as well as the Session-level
    // attach failure. That is deliberate, and it is the only exit this
    // Attention has once its attachment is released: `release` does not clear
    // it, and the retry that would needs the attachment it just closed. A
    // clear narrowed back to `attachmentId === null` would leave it active for
    // the life of the Session — the same stranding the widening was written to
    // end, one id along.
    const first = composition();
    const sessionId = await createAndAttach(first.runtime);
    const attachmentId = (await first.runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    await first.runtime.close();
    first.adapter.attachFailure = new NativeAttachmentError(
      "The Pi sidecar is missing",
      "PI_RECOVERY_FAILED",
      "adapter_unrecoverable",
    );
    const recovered = composition({
      engine: first.engine,
      adapter: first.adapter,
      runtimeIdPrefix: "released-recovery-",
    });
    await recovered.runtime.command({
      commandId: "released-recovery-retry",
      sessionId,
      command: { kind: "executor.retry", attachmentId },
    });
    expect(
      (await recovered.runtime.snapshot({ sessionId })).projection.attention.primary,
    ).toMatchObject({ id: `${attachmentId}:recovery`, attachmentId });

    first.adapter.attachFailure = null;
    await recovered.runtime.command({
      commandId: "released-recovery-release",
      sessionId,
      command: { kind: "adapter.release", attachmentId },
    });
    // Releasing is not an exit. Pinned, because it is what makes the clear below
    // load-bearing rather than incidental.
    expect(
      (await recovered.runtime.snapshot({ sessionId })).projection.attention.active.map(
        ({ id }) => id,
      ),
    ).toEqual([`${attachmentId}:recovery`]);

    await expect(
      recovered.runtime.command({
        commandId: "released-recovery-attach",
        sessionId,
        command: { kind: "adapter.attach", continuity: "fresh" },
      }),
    ).resolves.toMatchObject({ receipt: { status: "accepted" } });
    expect(
      (await recovered.runtime.snapshot({ sessionId })).projection.attention.active,
    ).toHaveLength(0);
  });

  it("settles a cold retry whose native binding cannot be recovered", async () => {
    const first = composition();
    const sessionId = await createAndAttach(first.runtime);
    const attachmentId = (await first.runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    await first.runtime.close();
    first.adapter.attachFailure = new NativeAttachmentError(
      "The Pi sidecar is missing",
      "PI_RECOVERY_FAILED",
      "adapter_unrecoverable",
    );
    const recovered = composition({
      engine: first.engine,
      adapter: first.adapter,
      runtimeIdPrefix: "cold-retry-",
    });

    const result = await recovered.runtime.command({
      commandId: "retry-cold-failure",
      sessionId,
      command: { kind: "executor.retry", attachmentId },
    });

    expect(result.receipt).toMatchObject({
      status: "rejected",
      code: "PI_RECOVERY_FAILED",
    });
    expect(
      (await recovered.runtime.snapshot({ sessionId })).projection.attention.primary,
    ).toMatchObject({
      attachmentId,
      kind: "adapter_unrecoverable",
      detail: "Retry recovery failed: The Pi sidecar is missing",
    });
    await recovered.runtime.command({
      commandId: "retry-cold-failure-again",
      sessionId,
      command: { kind: "executor.retry", attachmentId },
    });
    first.adapter.attachFailure = new Error("generic recovery failure");
    await expect(
      recovered.runtime.command({
        commandId: "retry-cold-generic-failure",
        sessionId,
        command: { kind: "executor.retry", attachmentId },
      }),
    ).resolves.toMatchObject({ receipt: { code: "retry_recovery_failed" } });
    expect(
      (await recovered.runtime.snapshot({ sessionId })).projection.attention.active,
    ).toHaveLength(1);

    first.adapter.attachFailure = null;
    await expect(
      recovered.runtime.command({
        commandId: "retry-cold-success",
        sessionId,
        command: { kind: "executor.retry", attachmentId },
      }),
    ).resolves.toMatchObject({ receipt: { status: "accepted" } });
    expect(
      (await recovered.runtime.snapshot({ sessionId })).projection.attention.primary,
    ).toBeNull();
  });

  it("settles cold retry when its durable directory is unavailable", async () => {
    let unavailable = false;
    const locations: SessionLocationResolver = {
      resolve: async () => ({ directory: "/projects/fake", venue }),
      prepare: async () => ({ directory: "/projects/fake", venue }),
      reaffirm: async () => {
        if (unavailable) throw new Error("worktree is missing");
      },
    };
    const first = composition({ locations });
    const sessionId = await createAndAttach(first.runtime);
    const attachmentId = (await first.runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    await first.runtime.close();
    unavailable = true;
    const recovered = composition({
      engine: first.engine,
      adapter: first.adapter,
      locations,
      runtimeIdPrefix: "retry-location-",
    });

    await expect(
      recovered.runtime.command({
        commandId: "retry-location-unavailable",
        sessionId,
        command: { kind: "executor.retry", attachmentId },
      }),
    ).resolves.toMatchObject({
      receipt: { status: "rejected", code: "location_unavailable" },
    });
  });

  it("records durable Attention when relaunch reconciliation cannot recover its binding", async () => {
    const first = composition();
    const sessionId = await createAndAttach(first.runtime);
    const attachmentId = (await first.runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    await first.runtime.close();
    first.adapter.attachFailure = new NativeAttachmentError(
      "The Pi sidecar cannot be verified",
      "PI_RECOVERY_FAILED",
      "adapter_unrecoverable",
    );
    const recovered = composition({
      engine: first.engine,
      adapter: first.adapter,
      runtimeIdPrefix: "cold-reconcile-",
    });

    await expect(recovered.runtime.reconcile({ sessionId, attachmentId })).rejects.toThrow(
      "The Pi sidecar cannot be verified",
    );
    expect(
      (await recovered.runtime.snapshot({ sessionId })).projection.attention.primary,
    ).toMatchObject({
      attachmentId,
      kind: "adapter_unrecoverable",
      detail: "Recovery failed: The Pi sidecar cannot be verified",
    });
    await expect(recovered.runtime.reconcile({ sessionId, attachmentId })).rejects.toThrow(
      "The Pi sidecar cannot be verified",
    );
    expect(
      (await recovered.runtime.snapshot({ sessionId })).projection.attention.active,
    ).toHaveLength(1);

    first.adapter.attachFailure = null;
    await recovered.runtime.reconcile({ sessionId, attachmentId });
    expect(
      (await recovered.runtime.snapshot({ sessionId })).projection.attention.primary,
    ).toBeNull();
  });

  it("does not turn a transient live reconcile failure into unrecoverable Attention", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const attachmentId = (await runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    adapter.reconcileFailure = new Error("temporary transport failure");

    await expect(runtime.reconcile({ sessionId, attachmentId })).rejects.toThrow(
      "temporary transport failure",
    );
    expect((await runtime.snapshot({ sessionId })).projection.attention.primary).toBeNull();
  });

  it("rejects reconciliation for an attachment the Session does not own", async () => {
    const { runtime } = composition();
    const sessionId = await createAndAttach(runtime);

    await expect(
      runtime.reconcile({ sessionId, attachmentId: "missing-attachment" }),
    ).rejects.toBeInstanceOf(SessionRuntimeNotFoundError);
  });

  it("does not misclassify a transient reconcile after cold binding recovery", async () => {
    const first = composition();
    const sessionId = await createAndAttach(first.runtime);
    const attachmentId = (await first.runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    await first.runtime.close();
    first.adapter.reconcileFailure = new Error("temporary cold transport failure");
    const recovered = composition({
      engine: first.engine,
      adapter: first.adapter,
      runtimeIdPrefix: "cold-transport-",
    });

    await expect(recovered.runtime.reconcile({ sessionId, attachmentId })).rejects.toThrow(
      "temporary cold transport failure",
    );
    expect(
      (await recovered.runtime.snapshot({ sessionId })).projection.attention.primary,
    ).toBeNull();
    first.adapter.reconcileFailure = null;
    await recovered.runtime.reconcile({ sessionId, attachmentId });
  });

  it("does not persist recovery Attention when shutdown wins a failing rehydrate", async () => {
    const first = composition();
    const sessionId = await createAndAttach(first.runtime);
    const attachmentId = (await first.runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    await first.runtime.close();
    const attachStarted = new Gate();
    const releaseAttach = new Gate();
    first.adapter.attachStarted = () => attachStarted.resolve();
    first.adapter.attachGate = releaseAttach.promise;
    first.adapter.attachFailure = new Error("late attach failure");
    const recovered = composition({
      engine: first.engine,
      adapter: first.adapter,
      runtimeIdPrefix: "closed-recovery-",
    });

    const reconciling = recovered.runtime.reconcile({ sessionId, attachmentId });
    await attachStarted.promise;
    await recovered.runtime.close();
    releaseAttach.resolve();

    await expect(reconciling).rejects.toThrow("late attach failure");
    expect((await first.engine.getSession({ sessionId }))?.attention.primary).toBeNull();
  });

  it("does not persist retry recovery Attention when shutdown wins a failing rehydrate", async () => {
    const first = composition();
    const sessionId = await createAndAttach(first.runtime);
    const attachmentId = (await first.runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    await first.runtime.close();
    const attachStarted = new Gate();
    const releaseAttach = new Gate();
    first.adapter.attachStarted = () => attachStarted.resolve();
    first.adapter.attachGate = releaseAttach.promise;
    first.adapter.attachFailure = new Error("late retry attach failure");
    const recovered = composition({
      engine: first.engine,
      adapter: first.adapter,
      runtimeIdPrefix: "closed-retry-",
    });

    const retrying = recovered.runtime.command({
      commandId: "closed-retry",
      sessionId,
      command: { kind: "executor.retry", attachmentId },
    });
    await attachStarted.promise;
    await recovered.runtime.close();
    releaseAttach.resolve();

    await expect(retrying).rejects.toThrow("late retry attach failure");
    expect((await first.engine.getSession({ sessionId }))?.attention.primary).toBeNull();
  });

  it("cancels a pending interaction as a fact, withdrawing the ask without answering it", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const attachmentId = (await runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    await adapter.emit({
      kind: "interaction",
      state: "opened",
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
    // The executor is told to stop waiting, and that is all it is told. A
    // withdrawal is not a dispatch, so no command carried a disposition and no
    // receipt claims one was delivered.
    expect(adapter.dispatches).toBe(dispatchesBefore);
    expect(adapter.withdrawals).toEqual(["question-1"]);
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
    // Nothing is left waiting, so nothing is told again: the second cancel
    // returns on the absent interaction, before the executor is reached.
    expect(adapter.withdrawals).toEqual(["question-1"]);
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
      kind: "interaction",
      state: "opened",
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
    await adapter.emit({ kind: "attachment", state: "closed" });
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
    // There is no binding left to withdraw from, which is where a cancel that
    // outlives its attachment ordinarily lands — and no reason to open one.
    expect(adapter.withdrawals).toEqual([]);
    expect(adapter.attaches).toBe(1);
    expect(frames.map(({ event }) => event.payload).at(-1)).toEqual({
      kind: "interaction.cancelled",
      attachmentId,
      interactionId: "question-2",
      reason: "withdrawn",
    });
  });

  it("cancels cleanly however the executor declines to be told", async () => {
    // Three ways a harness refuses to hear the withdrawal — the optional method
    // is absent, it rejects, or it throws before there is a promise to reject —
    // and one outcome, because the fact is durable before any of them happen.
    const refusals = {
      unimplemented: (adapter: FakeAdapter) => {
        adapter.withdrawsInteractions = false;
      },
      rejected: (adapter: FakeAdapter) => {
        adapter.withdrawFailure = new Error("gate already collected");
      },
      thrown: (adapter: FakeAdapter) => {
        adapter.withdrawThrow = new Error("no gate to open");
      },
    };
    for (const [refusal, arrange] of Object.entries(refusals)) {
      const { runtime, adapter } = composition();
      arrange(adapter);
      const sessionId = await createAndAttach(runtime);
      const interactionId = `question-${refusal}`;
      await adapter.emit({
        kind: "interaction",
        state: "opened",
        occurredAt: 300,
        interaction: {
          id: interactionId,
          kind: "question",
          title: "Which files should I read?",
          detail: null,
          options: [{ id: "prompt:0/option:0", label: "All of them", description: null }],
          multiple: true,
          native: { id: `native-${interactionId}`, detail: null },
        },
      });

      await expect(
        runtime.cancelInteraction({ sessionId, interactionId, reason: "abandoned" }),
      ).resolves.toBeUndefined();

      const { projection, frames } = await runtime.snapshot({ sessionId });
      expect(projection.interactions).toEqual({ active: [], resolved: [] });
      expect(frames.map(({ event }) => event.payload).at(-1)).toMatchObject({
        kind: "interaction.cancelled",
        interactionId,
        reason: "abandoned",
      });
      // The two failing arms only mean something if the call was made at all,
      // so the refusal that survives is pinned to the one that was arranged.
      expect(adapter.withdrawals).toEqual(adapter.withdrawsInteractions ? [interactionId] : []);
    }
  });

  it("files the executor's own withdrawal under the executor's provenance, not the person's", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const attachmentId = (await runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    await adapter.emit({
      kind: "interaction",
      state: "opened",
      occurredAt: 300,
      interaction: {
        id: "question-4",
        kind: "question",
        title: "Which files should I read?",
        detail: null,
        options: [{ id: "prompt:0/option:0", label: "All of them", description: null }],
        multiple: true,
        native: { id: "native-question-4", detail: null },
      },
    });

    await adapter.emit({
      kind: "interaction",
      state: "cancelled",
      interactionId: "question-4",
      reason: "superseded",
      occurredAt: 301,
    });

    const { projection, frames } = await runtime.snapshot({ sessionId });
    // Neither list, on this side too: an ask that stopped being asked was never
    // decided, and the reason it ended must not read back as one.
    expect(projection.interactions).toEqual({ active: [], resolved: [] });
    const { event } = frames.at(-1)!;
    expect(event.payload).toEqual({
      kind: "interaction.cancelled",
      attachmentId,
      interactionId: "question-4",
      reason: "superseded",
    });
    // Same kind as the cancel a person clicks, and the reason the two are
    // written in different places: nobody clicked this one, so it is filed
    // against the executor that stopped asking, at the moment it says it did.
    expect(event.provenance.source).toEqual({
      kind: "adapter",
      id: "fake",
      detail: { adapterVersion: "1.0.0" },
    });
    expect(event.occurredAt).toBe(301);
  });

  it("records attention under one durable id per reason and clears the one it names", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const attachmentId = (await runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    for (const reason of ["auth", "context", "runtime-failure"] as const) {
      await adapter.emit({
        kind: "attention",
        state: "raised",
        reason,
        message: `${reason} needs you`,
        occurredAt: 300,
      });
    }
    await adapter.emit({
      kind: "attention",
      state: "cleared",
      reason: "auth",
      message: "",
      occurredAt: 301,
    });

    // The id is what the clearance above named — one standing claim per reason,
    // and the reason the executor reported is what the Session filed it under.
    expect((await runtime.snapshot({ sessionId })).projection.attention.active).toMatchObject([
      {
        id: `fake:attention:${attachmentId}:context`,
        kind: "context_limit_reached",
        detail: "context needs you",
      },
      {
        id: `fake:attention:${attachmentId}:runtime-failure`,
        kind: "adapter_unrecoverable",
        detail: "runtime-failure needs you",
      },
    ]);
  });

  it("reconciles native observations and known receipts without inventing receipts for unknown commands", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const attachmentId = (await runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    adapter.reconcileObservations = [
      {
        kind: "turn",
        state: "started",
        turnId: "turn-reconciled",
        occurredAt: 400,
        recoveryCursor: "page-2",
      },
      { kind: "turn", state: "completed", turnId: "turn-reconciled", occurredAt: 401 },
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

  /**
   * The durable id, composed end to end and spelled out.
   *
   * Every relaunch re-derives these from live data and the ledger dedupes them
   * by exact string match on a primary key, so a changed derivation does not
   * fail — it writes a second copy of every fact in the Session's history. The
   * dedupe case below proves the derivation is *stable*; this one is what makes
   * a change to it loud.
   */
  it("composes a durable observation id from the adapter, the Session, and the attachment", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    const attachmentId = (await runtime.snapshot({ sessionId })).projection.liveExecutor!.id;

    await adapter.emit({ kind: "turn", state: "started", turnId: "turn-1", occurredAt: 160 });

    const started = (await runtime.snapshot({ sessionId })).frames.find(
      ({ event }) => event.payload.kind === "turn.started",
    );
    expect(started?.event.id).toBe(
      `native-event:fake:${sessionId}:${attachmentId}:fake:turn:turn-1:started`,
    );
  });

  it("deduplicates the same stable reconciliation batch after a cold runtime rebuild", async () => {
    const first = composition();
    const sessionId = await createAndAttach(first.runtime);
    const attachmentId = (await first.runtime.snapshot({ sessionId })).projection.liveExecutor!.id;
    first.adapter.reconcileObservations = [
      {
        kind: "turn",
        state: "started",
        turnId: "stable",
        occurredAt: 500,
        recoveryCursor: "marker-1",
      },
      {
        kind: "turn",
        state: "completed",
        turnId: "stable",
        occurredAt: 501,
        recoveryCursor: "marker-2",
      },
    ];
    await first.runtime.reconcile({ sessionId, attachmentId });
    await first.runtime.close();

    const recovered = composition({
      engine: first.engine,
      adapter: first.adapter,
      runtimeIdPrefix: "cold-",
    });
    await recovered.runtime.reconcile({ sessionId, attachmentId });

    const snapshot = await recovered.runtime.snapshot({ sessionId });
    expect(
      snapshot.frames.filter(({ event }) => event.payload.kind === "turn.started"),
    ).toHaveLength(1);
    expect(
      snapshot.frames.filter(({ event }) => event.payload.kind === "turn.completed"),
    ).toHaveLength(1);
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
        kind: "turn",
        state: "started",
        turnId: "turn-concurrent",
        occurredAt: 450,
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
      kind: "turn",
      state: "started",
      turnId: "turn-after-stop",
      occurredAt: 500,
    });
    expect(seen).toEqual(beforeStop);

    await runtime.close();
    await runtime.close();
    expect(adapter.releases).toBe(1);
    await expect(runtime.snapshot({ sessionId })).rejects.toThrow("Session runtime is closed");
  });

  it("reports missing sessions, bindings, and invalid persisted binding metadata explicitly", async () => {
    const { runtime } = composition();
    await expect(runtime.snapshot({ sessionId: "missing" })).rejects.toBeInstanceOf(
      SessionRuntimeNotFoundError,
    );
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
      malformed.runtime.reconcile({
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
      command: { kind: "adapter.attach", continuity: "fresh" },
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
      kind: "turn",
      state: "started",
      turnId: "discard-me",
      occurredAt: 700,
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
        command: { kind: "adapter.attach", continuity: "fresh" },
      }),
    ).rejects.toThrow("ledger unavailable");
    await adapter.emit({
      kind: "turn",
      state: "completed",
      turnId: "discard-me",
      occurredAt: 701,
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
      kind: "interaction",
      state: "opened",
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
      base.runtime.reconcile({ sessionId, attachmentId: "missing-binding" }),
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
      corrupt.runtime.reconcile({
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
      kind: "interaction",
      state: "opened",
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
      kind: "interaction",
      state: "opened",
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
        if (input.kind === "command.receipt") throw new Error("receipt unavailable");
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
        command: { kind: "adapter.attach", continuity: "fresh" },
      }),
    ).rejects.toThrow("receipt unavailable");
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
      restored.runtime.reconcile({
        sessionId: created.sessionId,
        attachmentId: "locator-attachment",
      }),
    ).resolves.toBeUndefined();
    expect(restored.adapter.reconciles).toBe(1);
  });

  /**
   * The envelope is written once and read on every app start, so both shapes
   * are live at the same time on a machine that has run more than one build.
   */
  it("writes the binding envelope without a profile and reads back both shapes", async () => {
    const fresh = composition();
    const sessionId = await createAndAttach(fresh.runtime);
    const written = (await fresh.runtime.snapshot({ sessionId })).projection.liveExecutor!.native!
      .detail as Record<string, unknown>;
    expect(written).not.toHaveProperty("profileId");
    expect(written).toMatchObject({
      kind: "volli.native-binding.v1",
      directory: "/projects/fake",
    });

    const shapes = {
      "written before profiles were deleted": {
        kind: "volli.native-binding.v1",
        profileId: "native",
        directory: "/projects/fake",
        locator: { provider: "fake" },
      },
      "written by this build": {
        kind: "volli.native-binding.v1",
        directory: "/projects/fake",
        locator: { provider: "fake" },
      },
    } as const;
    for (const [label, detail] of Object.entries(shapes)) {
      const persisted = composition();
      const created = await persisted.runtime.command({
        commandId: `envelope-create-${label}`,
        command: { kind: "session.create", projectId: "project-1", ticketId: null, title: null },
      });
      await persisted.engine.observe({
        id: `envelope-attachment-${label}`,
        sessionId: created.sessionId,
        occurredAt: 1000,
        provenance: { source: { kind: "adapter", id: "fake", detail: null }, venue },
        kind: "attachment.opened",
        attachment: {
          id: `envelope-attachment-${label}`,
          sessionId: created.sessionId,
          adapterId: "fake",
          venue,
          continuity: "native_resume",
          native: { id: `envelope-native-${label}`, detail },
        },
      });
      await expect(
        persisted.runtime.reconcile({
          sessionId: created.sessionId,
          attachmentId: `envelope-attachment-${label}`,
        }),
      ).resolves.toBeUndefined();
      expect(persisted.adapter.reconciles).toBe(1);
    }
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
      kind: "attention",
      state: "raised",
      reason: "auth",
      message: "Sign in to continue.",
      occurredAt: 500,
    });
    const appended = await runtime.projection({ sessionId });

    expect(appended.projection).not.toBe(folded.projection);
    expect(appended.projection.attention.primary?.kind).toBe("auth_required");
    expect(appended.throughSequence).toBeGreaterThan(folded.throughSequence);
    expect(reads).toEqual([sessionId]);
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

/**
 * The attachment `createAndAttach` opens, spelled out because the overlay cases
 * below assert on message ids the translation derives from it.
 */
const OVERLAY_ATTACHMENT_ID = "runtime-attachment:attachment-1";
const OVERLAY_MESSAGE_ID = `fake:${OVERLAY_ATTACHMENT_ID}:turn-1:0`;

function textDelta(text: string, turnId = "turn-1"): RuntimeObservation {
  return { kind: "delta", turnId, channel: "text", text };
}

function settledMessage(entryId: string, text: string, turnId = "turn-1"): RuntimeObservation {
  return {
    kind: "message-settled",
    turnId,
    occurredAt: 500,
    message: { entryId, role: "assistant", text },
  };
}

function startedTurn(turnId: string): RuntimeObservation {
  return { kind: "turn", state: "started", turnId, occurredAt: 400 };
}

function readActivity(
  activityId: string,
  state: "started" | "completed",
  turnId = "turn-1",
): RuntimeObservation {
  return {
    kind: "activity",
    state,
    turnId,
    activityId,
    descriptor: {
      kind: "read-file",
      nativeToolName: "read",
      subject: { label: "README.md", path: "README.md", lineRange: null },
      outcome: null,
      startedAt: 10,
      endedAt: state === "completed" ? 20 : null,
    },
    input: { path: "README.md" },
    output: state === "completed" ? { content: "read" } : null,
    occurredAt: 450,
  };
}

/** The two emissions a message's first delta fans out to: open it, then fill it. */
function openedMessage(text: string, messageId = OVERLAY_MESSAGE_ID): TranscriptDelta[] {
  return [
    { op: "reset", message: { id: messageId, role: "assistant", parts: [] } },
    { op: "part.upsert", key: "text", index: 0, part: { type: "text", text, state: "streaming" } },
  ];
}

function appendedText(text: string): TranscriptDelta {
  return { op: "part.append", key: "text", text };
}

/** What the engine's fold hands a late subscriber for a message still in flight. */
function foldedMessage(text: string, messageId = OVERLAY_MESSAGE_ID): TranscriptDelta {
  return {
    op: "reset",
    message: {
      id: messageId,
      role: "assistant",
      parts: [{ key: "text", part: { type: "text", text, state: "streaming" } }],
    },
  };
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
  it("publishes deltas without a durable trace or a cursor advance", async () => {
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

    await adapter.emit(textDelta("Hel"));
    await adapter.emit(textDelta("lo"));
    await runtime.reconcile({ sessionId, attachmentId });
    stop();

    const after = await runtime.snapshot({ sessionId });
    expect(after.throughSequence).toBe(before.throughSequence);
    expect(after.transcript).toEqual([]);
    expect(emissions).toEqual(
      [...openedMessage("Hel"), appendedText("lo")].map((delta) => ({
        kind: "overlay",
        sessionId,
        throughSequence: before.throughSequence,
        messageId: OVERLAY_MESSAGE_ID,
        delta,
      })),
    );
    // No delta moved the reconcile cursor: the provider is still asked for
    // everything since the last fact this Session actually wrote down.
    expect(adapter.reconcileCursors).toEqual([null]);
  });

  it("serves a late subscriber the folded message as one reset baseline", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    await adapter.emit(textDelta("Hel"));
    await adapter.emit(textDelta("lo"));
    // A new turn leaves the first message in flight and starts a second one.
    await adapter.emit(startedTurn("turn-2"));
    await adapter.emit(textDelta("Second", "turn-2"));

    const latest = (await runtime.snapshot({ sessionId })).throughSequence;
    const emissions: SessionStreamEmission[] = [];
    const stop = await runtime.subscribe({ sessionId, afterSequence: latest }, (emission) => {
      emissions.push(emission);
    });
    stop();

    // One baseline per in-flight message, each carrying the engine's fold —
    // not the deltas that built it.
    const secondMessageId = `fake:${OVERLAY_ATTACHMENT_ID}:turn-2:0`;
    expect(overlaysIn(emissions)).toEqual([
      {
        kind: "overlay",
        sessionId,
        throughSequence: latest,
        messageId: OVERLAY_MESSAGE_ID,
        delta: foldedMessage("Hello"),
      },
      {
        kind: "overlay",
        sessionId,
        throughSequence: latest,
        messageId: secondMessageId,
        delta: foldedMessage("Second", secondMessageId),
      },
    ]);
  });

  /**
   * An activity settles under the very id its overlay was opened with, so
   * nothing withdraws that overlay explicitly — the durable snapshot landing is
   * what retires it. A streamed assistant message cannot show this: it settles
   * under a different id and is withdrawn by name.
   */
  it("clears a message's overlay when its durable snapshot is processed", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    await adapter.emit(textDelta("Hello"));
    await adapter.emit(readActivity("call-1", "started"));
    const activityMessageId = `fake:${OVERLAY_ATTACHMENT_ID}:turn-1:activity:call-1`;
    await adapter.emit(readActivity("call-1", "completed"));

    const emissions: SessionStreamEmission[] = [];
    const stop = await runtime.subscribe(
      { sessionId, afterSequence: (await runtime.snapshot({ sessionId })).throughSequence },
      (emission) => {
        emissions.push(emission);
      },
    );
    stop();

    // Only the still-streaming assistant message is left with a baseline.
    expect(overlaysIn(emissions).map(({ messageId }) => messageId)).toEqual([OVERLAY_MESSAGE_ID]);
    expect((await runtime.snapshot({ sessionId })).transcript).toMatchObject([
      { message: { id: activityMessageId } },
    ]);
  });

  it("stamps a baseline with the durable sequence a later settle can be told from", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    await adapter.emit(textDelta("Hel"));

    const emissions: SessionStreamEmission[] = [];
    const stop = await runtime.subscribe(
      { sessionId, afterSequence: (await runtime.snapshot({ sessionId })).throughSequence },
      (emission) => {
        emissions.push(emission);
      },
    );
    await adapter.emit(settledMessage("entry-1", "Hello"));
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
    // Held on the delta's SECOND emission, not its first: a message opens and
    // fills in one fan-out, and blocking on the open would stall the fill
    // behind the very gate this case uses to let a durable publish in.
    let overlays = 0;
    const stop = await runtime.subscribe(
      { sessionId, afterSequence: (await runtime.snapshot({ sessionId })).throughSequence },
      async (emission) => {
        order.push(isSessionStreamOverlay(emission) ? "overlay" : emission.event.payload.kind);
        if (isSessionStreamOverlay(emission)) overlays += 1;
        if (overlays === 2) {
          entered.resolve();
          await release.promise;
        }
      },
    );

    const streaming = adapter.emit(textDelta("Hel"));
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

    // Both halves of the delta reached the client before the command that was
    // submitted while they were in flight.
    expect(order.slice(0, 2)).toEqual(["overlay", "overlay"]);
    expect(order.slice(2)).not.toContain("overlay");
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
      kind: "turn",
      state: "started",
      turnId: "turn-1",
      occurredAt: 800,
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
      kind: "turn",
      state: "completed",
      turnId: "turn-1",
      occurredAt: 801,
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
    await closing.adapter.emit(textDelta("Hel"));
    await closing.adapter.emit({ kind: "attachment", state: "closed" });
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
    await releasing.adapter.emit(textDelta("Hel"));
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
        command: { kind: "adapter.attach", continuity: "fresh" },
      });
      await adapter.emit(textDelta(`Session ${index}`));
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
    await expect(adapter.emit(textDelta("Hel"))).rejects.toThrow("ledger unavailable");
    failListEvents = false;
    // A new turn is what puts the emitter back at a reset, which is the only
    // delta a fold holding no entry for the message will act on.
    await adapter.emit(startedTurn("turn-2"));
    await adapter.emit(textDelta("Hello", "turn-2"));

    const latest = (await runtime.snapshot({ sessionId })).throughSequence;
    const emissions: SessionStreamEmission[] = [];
    (
      await runtime.subscribe({ sessionId, afterSequence: latest }, (emission) => {
        emissions.push(emission);
      })
    )();

    const messageId = `fake:${OVERLAY_ATTACHMENT_ID}:turn-2:0`;
    expect(overlaysIn(emissions)).toEqual([
      {
        kind: "overlay",
        sessionId,
        throughSequence: latest,
        messageId,
        delta: foldedMessage("Hello", messageId),
      },
    ]);
  });

  it("does not let one subscriber's cursor inflate the sequence other subscribers are stamped with", async () => {
    const { runtime, adapter } = composition();
    const sessionId = await createAndAttach(runtime);
    await adapter.emit(textDelta("Hel"));
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
    await adapter.emit(textDelta("lo"));
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
    await adapter.emit(textDelta("Hel"));
    stop();

    // The number only ever moves forward, so the later of the two wins whichever
    // order they arrive in. Stamping the delta with the seed's older sequence
    // would put it below events the subscriber has already folded, and the
    // staleness guard would throw away an overlay that is not stale at all.
    const durableHead = (await runtime.snapshot({ sessionId })).throughSequence;
    expect(durableHead).toBeGreaterThan(seededFrom);
    expect(overlaysIn(emissions).map(({ throughSequence }) => throughSequence)).toEqual([
      durableHead,
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
    await adapter.emit(textDelta("Hel"));

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
    await failing.adapter.emit(textDelta("Hel"));
    await failing.adapter.emit(settledMessage("entry-1", "Hello"));

    expect(delivered).toEqual(["overlay"]);
    expect(failures).toEqual([expect.objectContaining({ message: "overlay client failed" })]);

    const leaving = composition();
    const leavingSession = await createAndAttach(leaving.runtime);
    // The record exists before the gated emit below, so that emit has only its
    // own awaits left to run before the overlay reaches the chain.
    await leaving.adapter.emit(textDelta("Hel"));
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
    const streaming = leaving.adapter.emit(textDelta("lo"));
    await settleMicrotasks();
    stop();
    release.resolve();
    await Promise.all([submitting, streaming]);

    // The baseline reached the chain before the subscriber left; the append
    // queued behind it never reaches a listener that is no longer listening.
    expect(seen).toEqual(["overlay", "command.recorded"]);
  });
});
