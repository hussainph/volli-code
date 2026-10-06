import { describe, expect, it } from "vite-plus/test";
import type { UIMessage } from "ai";
import type { RuntimeObservation, SessionLedger } from "@volli/shared";
import {
  createInMemorySessionFollowUpLedger,
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
  createSessionEngine,
  createSessionRuntime,
  isSessionStreamQueue,
  sessionFollowUpDeliveryCommandId,
  sessionFollowUpDeliveryEvidence,
  SessionRuntimeCommandConflictError,
  NativeAttachmentError,
  type BindingHandle,
  type HarnessCommand,
  type NativeHarnessAdapter,
  type ObservationSink,
  type SessionFollowUpLedger,
  type SessionStreamEmission,
} from "./index";

const message = (id: string, text = id): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});
class Adapter implements NativeHarnessAdapter {
  id = "fake";
  durableIdNamespace = "fake";
  adapterVersion = "1";
  runtime = { path: "/fake", version: "1", fingerprint: "fake" };
  sink!: ObservationSink;
  commands: HarnessCommand[] = [];
  attaches = 0;
  receipts: Awaited<ReturnType<BindingHandle["reconcile"]>>["receipts"] = [];
  dispatchGate: Promise<void> | undefined;
  startGate: Promise<void> | undefined;
  refuse = false;
  startTurns = true;
  attachFailure: Error | undefined;
  unknown = false;
  crashAfterAcceptance = false;
  ambiguous = false;
  unknownAfterTurn = false;
  reconcileGate: Promise<void> | undefined;
  reconciling = false;
  async attach(
    _spec: Parameters<NativeHarnessAdapter["attach"]>[0],
    sink: ObservationSink,
  ): Promise<BindingHandle> {
    this.sink = sink;
    this.attaches++;
    if (this.attachFailure) throw this.attachFailure;
    return {
      native: { id: "native", detail: null },
      dispatch: async (command) => {
        this.commands.push(command);
        await this.startGate;
        if (this.unknown)
          return {
            commandId: command.commandId,
            status: "unknown",
            detail: "No evidence",
            native: null,
          };
        if (this.refuse)
          return {
            commandId: command.commandId,
            status: "rejected",
            code: "refused",
            detail: "Cannot deliver",
            native: null,
          };
        if (this.startTurns && command.kind === "message.submit" && command.delivery !== "steer")
          await this.emit({
            kind: "turn",
            state: "started",
            turnId: `turn:${command.commandId}`,
            occurredAt: 200,
          });
        if (this.unknownAfterTurn)
          return {
            commandId: command.commandId,
            status: "unknown",
            detail: "No acknowledgement",
            native: null,
          };
        await this.dispatchGate;
        const receipt = {
          commandId: command.commandId,
          status: "accepted" as const,
          acceptedAt: 201,
          native: null,
        };
        if (!this.ambiguous) this.receipts = [...this.receipts, receipt];
        if (this.crashAfterAcceptance || this.ambiguous) throw new Error("executor transport lost");
        return receipt;
      },
      reconcile: async () => {
        this.reconciling = true;
        await this.reconcileGate;
        return {
          cursor: null,
          observations: [],
          receipts: this.crashAfterAcceptance ? [] : this.receipts,
        };
      },
      release: async () => undefined,
    };
  }
  emit(observation: RuntimeObservation) {
    return this.sink.emit(observation);
  }
  complete(commandId: string) {
    return this.emit({
      kind: "turn",
      state: "completed",
      turnId: `turn:${commandId}`,
      occurredAt: 300,
    });
  }
}

function fixture(
  options: {
    followUps?: SessionFollowUpLedger;
    eventLedger?: SessionLedger;
    adapter?: Adapter;
    locate?: () => void | Promise<void>;
    diagnostics?: () => void;
    retryDelays?: readonly number[];
  } = {},
) {
  let sequence = 0;
  const clock = { now: () => ++sequence };
  const eventLedger = options.eventLedger ?? createInMemorySessionLedger();
  const engine = createSessionEngine({
    ledger: eventLedger,
    clock,
    ids: { next: (kind) => `${kind}-${++sequence}` },
  });
  const artifacts = createInMemoryTranscriptArtifactStore();
  const followUps = options.followUps ?? createInMemorySessionFollowUpLedger(eventLedger);
  const adapter = options.adapter ?? new Adapter();
  const errors: unknown[] = [];
  const runtime = (withStorage = true) =>
    createSessionRuntime({
      engine,
      artifacts,
      followUps: withStorage ? followUps : undefined,
      executor: adapter,
      clock,
      ids: { next: (kind) => `${kind}-${++sequence}` },
      locations: {
        resolve: async () => {
          await options.locate?.();
          return { directory: "/fake", venue: { id: "local", kind: "local" } };
        },
        prepare: async () => ({ directory: "/fake", venue: { id: "local", kind: "local" } }),
        reaffirm: async () => undefined,
      },
      onFollowUpFailure: (error) => {
        errors.push(error);
        options.diagnostics?.();
      },
      ...(options.retryDelays === undefined ? {} : { followUpRetryDelaysMs: options.retryDelays }),
    });
  return { engine, artifacts, followUps, adapter, errors, runtime };
}
async function create(runtime: ReturnType<ReturnType<typeof fixture>["runtime"]>) {
  return (
    await runtime.command({
      commandId: "create",
      command: {
        kind: "session.create",
        projectId: "project",
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: null,
      },
    })
  ).sessionId;
}
async function attach(
  runtime: ReturnType<ReturnType<typeof fixture>["runtime"]>,
  sessionId: string,
) {
  await runtime.command({
    commandId: "attach",
    sessionId,
    command: { kind: "adapter.attach", continuity: "fresh" },
  });
}

const deliveryId = (sessionId: string, id: string) => `follow-up:${sessionId}:${id}`;

describe("host follow-up commands", () => {
  async function queuedActive(f: ReturnType<typeof fixture>) {
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    await attach(runtime, sessionId);
    await runtime.command({
      commandId: "active",
      sessionId,
      command: { kind: "message.submit", message: message("active") },
    });
    await runtime.command({
      commandId: "queued",
      sessionId,
      command: { kind: "message.submit", delivery: "queue", message: message("queued") },
    });
    return {
      runtime,
      sessionId,
      steer: {
        commandId: "steer",
        sessionId,
        command: {
          kind: "message.submit" as const,
          delivery: "steer" as const,
          message: message("queued"),
        },
      },
    };
  }

  it("steers the canonical host payload, never the Client's reconstruction", async () => {
    const f = fixture();
    const { runtime, sessionId, steer } = await queuedActive(f);
    await runtime.command({
      commandId: "edit",
      sessionId,
      command: {
        kind: "message.edit",
        messageId: "queued",
        message: message("queued", "host edit"),
      },
    });
    await runtime.command(steer);
    expect(f.adapter.commands.at(-1)).toMatchObject({ message: message("queued", "host edit") });
  });

  it("atomically steers a host-owned row and replays without redispatch, even after restart", async () => {
    const f = fixture();
    const { runtime, sessionId, steer } = await queuedActive(f);
    const result = await runtime.command(steer);
    expect(result.receipt?.status).toBe("accepted");
    expect(f.adapter.commands.at(-1)).toMatchObject({
      commandId: "steer",
      delivery: "steer",
      targetTurnId: "turn:active",
      message: message("queued"),
    });
    expect((await runtime.projection({ sessionId })).projection.queue).toEqual([]);
    expect((await runtime.command(steer)).receipt).toEqual(result.receipt);
    await expect(
      runtime.command({
        ...steer,
        command: { ...steer.command, message: message("queued", "changed") },
      }),
    ).rejects.toBeInstanceOf(SessionRuntimeCommandConflictError);
    await runtime.close();
    const restarted = f.runtime();
    expect((await restarted.command(steer)).receipt).toEqual(result.receipt);
    await restarted.recoverFollowUps();
    expect(f.adapter.commands).toHaveLength(2);
  });

  it("retains the row when the targeted turn ends during preflight and forbids mutations while claimed", async () => {
    const gate = Promise.withResolvers<void>();
    let steering = false;
    const f = fixture({ locate: () => (steering ? gate.promise : undefined) });
    const { runtime, sessionId, steer } = await queuedActive(f);
    steering = true;
    const sending = runtime.command(steer);
    await expect
      .poll(async () => (await runtime.projection({ sessionId })).projection.queue?.[0].state)
      .toBe("releasing");
    for (const command of [
      { kind: "message.cancel" as const, messageId: "queued" },
      { kind: "message.edit" as const, messageId: "queued", message: message("queued", "edit") },
    ])
      expect(
        (await runtime.command({ commandId: command.kind, sessionId, command })).receipt,
      ).toMatchObject({ status: "rejected", code: "message_releasing" });
    await f.adapter.complete("active");
    await runtime.recoverFollowUps();
    gate.resolve();
    const result = await sending;
    expect(result.receipt).toMatchObject({ status: "rejected", code: "steer_turn_ended" });
    expect((await runtime.projection({ sessionId })).projection.queue?.[0]).toMatchObject({
      id: "queued",
      state: "queued",
    });
    expect((await runtime.command(steer)).receipt).toEqual(result.receipt);
    await runtime.recoverFollowUps();
    expect(f.adapter.commands).toHaveLength(1);
  });

  it("retains ambiguous queued steering with Attention and reconciles without sending twice", async () => {
    const f = fixture();
    const { runtime, sessionId, steer } = await queuedActive(f);
    f.adapter.ambiguous = true;
    await expect(runtime.command(steer)).rejects.toThrow("transport lost");
    await expect(runtime.command({ ...steer, commandId: "another-steer" })).rejects.toThrow(
      "already being delivered",
    );
    await runtime.recoverFollowUps();
    const projection = (await runtime.projection({ sessionId })).projection;
    expect(projection.queue?.[0]).toMatchObject({ id: "queued", state: "releasing" });
    expect(projection.attention.active.some(({ kind }) => kind === "adapter_unrecoverable")).toBe(
      true,
    );
    await runtime.close();
    const restarted = f.runtime();
    await restarted.recoverFollowUps();
    expect(f.adapter.commands).toHaveLength(2);
  });

  it("reconciles accepted steering after a crash before settlement", async () => {
    const f = fixture();
    const { runtime, sessionId, steer } = await queuedActive(f);
    f.adapter.crashAfterAcceptance = true;
    await expect(runtime.command(steer)).rejects.toThrow("transport lost");
    await runtime.close();
    f.adapter.crashAfterAcceptance = false;
    const restarted = f.runtime();
    await restarted.recoverFollowUps();
    expect((await restarted.command(steer)).receipt?.status).toBe("accepted");
    expect((await restarted.projection({ sessionId })).projection.queue).toEqual([]);
    expect(f.adapter.commands).toHaveLength(2);
  });

  it("recovers a queued steer claim that crashed before recording intent without converting delivery", async () => {
    let crash = false;
    const f = fixture({
      locate: () => {
        if (crash) throw new Error("before steer intent");
      },
    });
    const { runtime, sessionId, steer } = await queuedActive(f);
    crash = true;
    await expect(runtime.command(steer)).rejects.toThrow("before steer intent");
    expect((await runtime.projection({ sessionId })).projection.queue?.[0].state).toBe("releasing");
    await runtime.close();
    crash = false;
    const restarted = f.runtime();
    await restarted.recoverFollowUps();
    expect(f.adapter.commands.at(-1)).toMatchObject({ commandId: "steer", delivery: "steer" });
    expect((await restarted.command(steer)).receipt?.status).toBe("accepted");
    expect(f.adapter.commands).toHaveLength(2);
  });

  it("refuses queued steering for a completed turn, command-key reuse, and a terminally refused row", async () => {
    const f = fixture();
    const { runtime, sessionId, steer } = await queuedActive(f);
    await expect(runtime.command({ ...steer, commandId: "active" })).rejects.toBeInstanceOf(
      SessionRuntimeCommandConflictError,
    );
    await f.adapter.emit({
      kind: "attention",
      state: "raised",
      reason: "runtime-failure",
      message: "Needs recovery",
    });
    await f.adapter.complete("active");
    await runtime.recoverFollowUps();
    await expect(runtime.command(steer)).rejects.toThrow("targeted turn has ended");
    expect((await runtime.projection({ sessionId })).projection.queue?.[0].state).toBe("queued");
    const g = fixture();
    const active = await queuedActive(g);
    g.adapter.refuse = true;
    expect((await active.runtime.command(active.steer)).receipt?.status).toBe("rejected");
    await expect(active.runtime.command({ ...active.steer, commandId: "again" })).rejects.toThrow(
      "Edit the refused",
    );
    await active.runtime.command({
      commandId: "edit",
      sessionId: active.sessionId,
      command: { kind: "message.edit", messageId: "queued", message: message("queued", "edited") },
    });
    g.adapter.refuse = false;
    expect(
      (await active.runtime.command({ ...active.steer, commandId: "edited-steer" })).receipt
        ?.status,
    ).toBe("accepted");
  });

  it("retains an unknown queued steer outcome with durable Attention", async () => {
    const f = fixture();
    const { runtime, sessionId, steer } = await queuedActive(f);
    f.adapter.unknown = true;
    await expect(runtime.command(steer)).rejects.toThrow("may have been delivered");
    expect((await runtime.projection({ sessionId })).projection.queue?.[0].state).toBe("releasing");
    await runtime.recoverFollowUps();
    expect(f.adapter.commands).toHaveLength(2);
  });

  it("keeps ordinary steering working with a ledger when there is no queued identity", async () => {
    const f = fixture();
    const { runtime, sessionId } = await queuedActive(f);
    await runtime.command({
      commandId: "missing-cancel",
      sessionId,
      command: { kind: "message.cancel", messageId: "missing" },
    });
    expect(
      (
        await runtime.command({
          commandId: "ordinary-steer",
          sessionId,
          command: {
            kind: "message.submit",
            delivery: "steer",
            message: message("ordinary"),
          },
        })
      ).receipt?.status,
    ).toBe("accepted");
    expect(f.adapter.commands).toHaveLength(2);
  });

  it("never resends when turn-end release wins the identity", async () => {
    const f = fixture();
    const { runtime, steer } = await queuedActive(f);
    await f.adapter.complete("active");
    await runtime.recoverFollowUps();
    await expect(runtime.command(steer)).rejects.toThrow("already been delivered or removed");
    expect(f.adapter.commands).toHaveLength(2);
  });

  it("continues at the next idle boundary after recovering a settled previous delivery", async () => {
    const storage = createInMemorySessionFollowUpLedger();
    let crash = true;
    const followUps: SessionFollowUpLedger = {
      ...storage,
      transaction: (id, work) =>
        storage.transaction(id, (state) => {
          const result = work(state);
          if (crash && Object.hasOwn(state.releases, "first"))
            throw new Error("crash before settlement");
          return result;
        }),
    };
    const f = fixture({ followUps });
    let runtime = f.runtime();
    const sessionId = await create(runtime);
    await attach(runtime, sessionId);
    await runtime.command({
      commandId: "active",
      sessionId,
      command: { kind: "message.submit", message: message("active") },
    });
    for (const id of ["first", "second"])
      await runtime.command({
        commandId: id,
        sessionId,
        command: { kind: "message.submit", delivery: "queue", message: message(id) },
      });
    await f.adapter.complete("active");
    await runtime.recoverFollowUps();
    await f.adapter.complete(deliveryId(sessionId, "first"));
    await runtime.recoverFollowUps();
    expect(f.adapter.commands).toHaveLength(2);
    await runtime.close();
    crash = false;
    runtime = f.runtime();
    await runtime.recoverFollowUps();
    expect(f.adapter.commands.map(({ commandId }) => commandId)).toEqual([
      "active",
      deliveryId(sessionId, "first"),
      deliveryId(sessionId, "second"),
    ]);
    expect((await runtime.projection({ sessionId })).projection.queue).toEqual([]);
  });

  it("reserves host delivery command identities against unrelated caller receipts", async () => {
    const f = fixture();
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    await attach(runtime, sessionId);
    await expect(
      runtime.command({
        commandId: deliveryId(sessionId, "queued"),
        sessionId,
        command: { kind: "message.submit", message: message("unrelated") },
      }),
    ).rejects.toThrow("namespace is reserved");
    await runtime.command({
      commandId: "queued",
      sessionId,
      command: { kind: "message.submit", delivery: "queue", message: message("queued") },
    });
    await runtime.recoverFollowUps();
    expect(
      f.adapter.commands.map((command) => command.kind === "message.submit" && command.message.id),
    ).toEqual(["queued"]);
  });

  it.each(["kind", "payload"] as const)(
    "retains a corrupt recovered delivery with a mismatched %s",
    async (mismatch) => {
      const f = fixture();
      const { runtime, sessionId } = await queuedActive(f);
      const reference = await f.artifacts.write({
        version: 1,
        threadId: "root",
        branchId: "main",
        attemptId: "attempt",
        turnId: null,
        message: message("unrelated"),
      });
      await f.engine.submit({
        commandId: deliveryId(sessionId, "queued"),
        sessionId,
        intent:
          mismatch === "kind"
            ? {
                kind: "model.select",
                selection: { providerId: "p", modelId: "m", reasoningLevel: "off" },
              }
            : { kind: "message.submit", reference },
        provenance: { source: { kind: "system", id: "fixture", detail: null }, venue: null },
      });
      await f.adapter.complete("active");
      await runtime.recoverFollowUps();
      expect(f.adapter.commands).toHaveLength(1);
      expect((await runtime.projection({ sessionId })).projection.queue?.[0]).toMatchObject({
        id: "queued",
        state: "releasing",
      });
      expect(f.errors.some((error) => error instanceof SessionRuntimeCommandConflictError)).toBe(
        true,
      );
    },
  );

  it("derives collision-free delivery command identities", () => {
    expect(sessionFollowUpDeliveryCommandId("a:b", "c")).not.toBe(
      sessionFollowUpDeliveryCommandId("a", "b:c"),
    );
  });
  it("does not infer turn proof without the delivery's recorded intent", async () => {
    const f = fixture();
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    const projection = (await f.engine.getSession({ sessionId }))!;
    expect(sessionFollowUpDeliveryEvidence(sessionId, projection.commands[0], [], [])).toBeNull();
    await runtime.close();
  });

  it("keeps in-memory storage atomic and refuses transactions that escape across an await", async () => {
    const ledger = createInMemorySessionFollowUpLedger();
    expect(await ledger.transaction("session", () => "primitive")).toBe("primitive");
    await expect(
      ledger.transaction("session", (() => Promise.resolve(1)) as never),
    ).rejects.toThrow("must be synchronous");
    await expect(
      ledger.transaction("session", (state) => {
        state.revision = 2;
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await ledger.transaction("session", (state) => state.revision)).toBe(0);
  });
  it("accepts durably without waiting for the active command, then releases without a Client", async () => {
    const f = fixture();
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    await attach(runtime, sessionId);
    const gate = Promise.withResolvers<void>();
    f.adapter.dispatchGate = gate.promise;
    const immediate = runtime.command({
      commandId: "active",
      sessionId,
      command: { kind: "message.submit", message: message("active") },
    });
    await expect
      .poll(async () => (await runtime.projection({ sessionId })).projection.turnActive)
      .toBe(true);
    const accepted = await runtime.command({
      commandId: "queued",
      sessionId,
      command: { kind: "message.submit", delivery: "queue", message: message("queued") },
    });
    expect(accepted.receipt?.status).toBe("accepted");
    expect(await f.followUps.pendingSessionIds()).toEqual([sessionId]);
    expect(f.adapter.commands).toHaveLength(1);
    gate.resolve();
    await immediate;
    await f.adapter.complete("active");
    await runtime.recoverFollowUps();
    expect(f.adapter.commands.map(({ commandId }) => commandId)).toEqual([
      "active",
      deliveryId(sessionId, "queued"),
    ]);
    expect((await runtime.projection({ sessionId })).projection.queue).toEqual([]);
    expect(
      await f.followUps.transaction(sessionId, (state) => state.releases.queued.receipt.status),
    ).toBe("accepted");
  });

  it("releases two queued messages in order, only one per turn end, including duplicate end evidence", async () => {
    const f = fixture();
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    await attach(runtime, sessionId);
    await runtime.command({
      commandId: "active",
      sessionId,
      command: { kind: "message.submit", message: message("active") },
    });
    for (const id of ["first", "second"])
      await runtime.command({
        commandId: id,
        sessionId,
        command: { kind: "message.submit", delivery: "queue", message: message(id) },
      });
    await f.adapter.complete("active");
    await runtime.recoverFollowUps();
    expect(f.adapter.commands.map(({ commandId }) => commandId)).toEqual([
      "active",
      deliveryId(sessionId, "first"),
    ]);
    await f.adapter.complete("active");
    await runtime.recoverFollowUps();
    expect(f.adapter.commands).toHaveLength(2);
    await f.adapter.complete(deliveryId(sessionId, "first"));
    await runtime.recoverFollowUps();
    expect(f.adapter.commands.map(({ commandId }) => commandId)).toEqual([
      "active",
      deliveryId(sessionId, "first"),
      deliveryId(sessionId, "second"),
    ]);
  });

  it("edits/cancels through commands, idempotently, and publishes queue state to another Client", async () => {
    const f = fixture();
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    await attach(runtime, sessionId);
    await runtime.command({
      commandId: "active",
      sessionId,
      command: { kind: "message.submit", message: message("active") },
    });
    const emissions: SessionStreamEmission[] = [];
    const dispose = await runtime.subscribe({ sessionId, afterSequence: 0 }, (emission) => {
      emissions.push(emission);
    });
    for (const id of ["first", "second"])
      await runtime.command({
        commandId: id,
        sessionId,
        command: { kind: "message.submit", delivery: "queue", message: message(id) },
      });
    const edit = {
      commandId: "edit",
      sessionId,
      command: {
        kind: "message.edit" as const,
        messageId: "first",
        message: message("first", "edited"),
      },
    };
    const original = await runtime.command(edit);
    expect(await runtime.command(edit)).toEqual(original);
    await expect(
      runtime.command({
        ...edit,
        command: { ...edit.command, message: message("first", "conflict") },
      }),
    ).rejects.toBeInstanceOf(SessionRuntimeCommandConflictError);
    const cancel = {
      commandId: "cancel",
      sessionId,
      command: { kind: "message.cancel" as const, messageId: "second" },
    };
    const cancelled = await runtime.command(cancel);
    expect(await runtime.command(cancel)).toEqual(cancelled);
    await expect
      .poll(() => emissions.findLast(isSessionStreamQueue)?.queue)
      .toEqual([
        { id: "first", commandId: "first", message: message("first", "edited"), state: "queued" },
      ]);
    expect((await runtime.projection({ sessionId })).projection.queue).toEqual(
      emissions.findLast(isSessionStreamQueue)?.queue,
    );
    await f.adapter.complete("active");
    await runtime.recoverFollowUps();
    expect(f.adapter.commands.at(-1)).toMatchObject({ message: message("first", "edited") });
    dispose();
  });

  it("reattaches and releases an idle queue with no Clients; a new runtime reads the queue baseline", async () => {
    const f = fixture();
    let runtime = f.runtime();
    const sessionId = await create(runtime);
    await runtime.command({
      commandId: "first",
      sessionId,
      command: { kind: "message.submit", delivery: "queue", message: message("first") },
    });
    await runtime.recoverFollowUps();
    expect(f.adapter.attaches).toBe(1);
    expect(f.adapter.commands).toHaveLength(1);
    await runtime.command({
      commandId: "second",
      sessionId,
      command: { kind: "message.submit", delivery: "queue", message: message("second") },
    });
    await runtime.close();
    runtime = f.runtime();
    const emissions: SessionStreamEmission[] = [];
    await runtime.subscribe({ sessionId, afterSequence: 0 }, (emission) => {
      emissions.push(emission);
    });
    expect(emissions.findLast(isSessionStreamQueue)?.queue.map(({ id }) => id)).toEqual(["second"]);
  });

  it("replays a crash after adapter acceptance using durable reconciliation evidence, never resending", async () => {
    const adapter = new Adapter();
    adapter.crashAfterAcceptance = true;
    // No turn evidence either: only the reconciled receipt can settle it.
    adapter.startTurns = false;
    const f = fixture({ adapter });
    let runtime = f.runtime();
    const sessionId = await create(runtime);
    await runtime.command({
      commandId: "first",
      sessionId,
      command: { kind: "message.submit", delivery: "queue", message: message("first") },
    });
    await runtime.recoverFollowUps();
    expect(adapter.commands).toHaveLength(1);
    expect((await runtime.projection({ sessionId })).projection.queue?.[0].state).toBe("releasing");
    await runtime.close();
    adapter.crashAfterAcceptance = false;
    runtime = f.runtime();
    await runtime.recoverFollowUps();
    await runtime.recoverFollowUps();
    expect(adapter.commands).toHaveLength(1);
    expect((await runtime.projection({ sessionId })).projection.queue).toEqual([]);
    expect(
      await f.followUps.transaction(sessionId, (state) => state.releases.first.receipt.status),
    ).toBe("accepted");
  });

  it("replays a crash after durable receipt but before queue settlement without losing or duplicating", async () => {
    const storage = createInMemorySessionFollowUpLedger();
    let crash = true;
    const followUps: SessionFollowUpLedger = {
      ...storage,
      transaction: (id, work) =>
        storage.transaction(id, (state) => {
          const result = work(state);
          if (crash && Object.hasOwn(state.releases, "first"))
            throw new Error("crash before settling queue");
          return result;
        }),
    };
    const f = fixture({ followUps });
    let runtime = f.runtime();
    const sessionId = await create(runtime);
    await runtime.command({
      commandId: "first",
      sessionId,
      command: { kind: "message.submit", delivery: "queue", message: message("first") },
    });
    await runtime.recoverFollowUps();
    expect(f.adapter.commands).toHaveLength(1);
    const attachmentId = (await runtime.projection({ sessionId })).projection.liveExecutor!.id;
    await runtime.command({
      commandId: "release",
      sessionId,
      command: { kind: "adapter.release", attachmentId },
    });
    await runtime.close();
    crash = false;
    runtime = f.runtime();
    await runtime.recoverFollowUps();
    expect(f.adapter.commands).toHaveLength(1);
    expect((await runtime.projection({ sessionId })).projection.queue).toEqual([]);
  });

  it("does not redispatch ambiguous acceptance; retains the payload with durable Attention", async () => {
    const adapter = new Adapter();
    adapter.ambiguous = true;
    adapter.startTurns = false;
    const f = fixture({ adapter });
    let runtime = f.runtime();
    const sessionId = await create(runtime);
    await runtime.command({
      commandId: "first",
      sessionId,
      command: { kind: "message.submit", delivery: "queue", message: message("first") },
    });
    await runtime.recoverFollowUps();
    await runtime.close();
    runtime = f.runtime();
    await runtime.recoverFollowUps();
    expect(adapter.commands).toHaveLength(1);
    const projection = (await runtime.projection({ sessionId })).projection;
    expect(projection.queue?.[0]).toMatchObject({ id: "first", state: "releasing" });
    expect(projection.attention.active).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "adapter_unrecoverable",
          detail: "This follow-up may have been delivered. Check the transcript before resending.",
        }),
      ]),
    );
  });

  it("recovers a crash after turn end before release claim without losing the pending message", async () => {
    const storage = createInMemorySessionFollowUpLedger();
    let crash = false;
    const followUps: SessionFollowUpLedger = {
      ...storage,
      transaction: (id, work) =>
        storage.transaction(id, (state) => {
          const result = work(state);
          if (crash && state.entries.some((entry) => entry.state === "releasing"))
            throw new Error("crash before claim commit");
          return result;
        }),
    };
    const f = fixture({ followUps });
    let runtime = f.runtime();
    const sessionId = await create(runtime);
    await attach(runtime, sessionId);
    await runtime.command({
      commandId: "active",
      sessionId,
      command: { kind: "message.submit", message: message("active") },
    });
    await runtime.command({
      commandId: "first",
      sessionId,
      command: { kind: "message.submit", delivery: "queue", message: message("first") },
    });
    crash = true;
    await f.adapter.complete("active");
    await runtime.recoverFollowUps();
    expect(f.adapter.commands).toHaveLength(1);
    expect((await runtime.projection({ sessionId })).projection.queue?.[0].state).toBe("queued");
    await runtime.close();
    crash = false;
    runtime = f.runtime();
    await runtime.recoverFollowUps();
    expect(f.adapter.commands).toHaveLength(2);
    expect((await runtime.projection({ sessionId })).projection.queue).toEqual([]);
  });

  it("recovers a committed release claim that crashed before recording delivery intent", async () => {
    let crash = false;
    const f = fixture({
      locate: () => {
        if (crash) throw new Error("crash before intent");
      },
    });
    let runtime = f.runtime();
    const sessionId = await create(runtime);
    await attach(runtime, sessionId);
    await runtime.command({
      commandId: "active",
      sessionId,
      command: { kind: "message.submit", message: message("active") },
    });
    await runtime.command({
      commandId: "first",
      sessionId,
      command: { kind: "message.submit", delivery: "queue", message: message("first") },
    });
    crash = true;
    await f.adapter.complete("active");
    await runtime.recoverFollowUps();
    expect(f.adapter.commands).toHaveLength(1);
    expect((await f.engine.getSession({ sessionId }))?.commands.map(({ id }) => id)).not.toContain(
      deliveryId(sessionId, "first"),
    );
    await runtime.close();
    crash = false;
    runtime = f.runtime();
    await runtime.recoverFollowUps();
    expect(f.adapter.commands).toHaveLength(2);
    expect((await runtime.projection({ sessionId })).projection.queue).toEqual([]);
  });

  it("defers a queued release when an immediate message opens a turn ahead of admission", async () => {
    const f = fixture();
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    await attach(runtime, sessionId);
    const gate = Promise.withResolvers<void>();
    f.adapter.startGate = gate.promise;
    const immediate = runtime.command({
      commandId: "active",
      sessionId,
      command: { kind: "message.submit", message: message("active") },
    });
    await expect.poll(() => f.adapter.commands.length).toBe(1);
    await runtime.command({
      commandId: "first",
      sessionId,
      command: { kind: "message.submit", delivery: "queue", message: message("first") },
    });
    await expect
      .poll(async () => (await runtime.projection({ sessionId })).projection.queue?.[0].state)
      .toBe("releasing");
    gate.resolve();
    await immediate;
    await runtime.recoverFollowUps();
    f.adapter.startGate = undefined;
    expect(f.adapter.commands).toHaveLength(1);
    expect((await runtime.projection({ sessionId })).projection.queue?.[0].state).toBe("queued");
    expect(f.errors).toEqual([]);
    await f.adapter.complete("active");
    await runtime.recoverFollowUps();
    expect(f.adapter.commands).toHaveLength(2);
  });

  it("retains definitive refusals for editing/cancellation, never retrying the refused payload", async () => {
    const f = fixture();
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    f.adapter.refuse = true;
    await runtime.command({
      commandId: "first",
      sessionId,
      command: { kind: "message.submit", delivery: "queue", message: message("first") },
    });
    await runtime.recoverFollowUps();
    expect((await runtime.projection({ sessionId })).projection.queue?.[0].state).toBe("queued");
    await runtime.recoverFollowUps();
    expect(f.adapter.commands).toHaveLength(1);
    f.adapter.refuse = false;
    await runtime.command({
      commandId: "edit",
      sessionId,
      command: {
        kind: "message.edit",
        messageId: "first",
        message: message("first", "retry edited"),
      },
    });
    await runtime.recoverFollowUps();
    expect(f.adapter.commands).toHaveLength(2);
    expect(f.adapter.commands.at(-1)).toMatchObject({
      commandId: deliveryId(sessionId, "edit"),
      message: message("first", "retry edited"),
    });
    expect((await runtime.projection({ sessionId })).projection.queue).toEqual([]);
  });

  it("validates queue identities and idempotency without affecting accepted entries", async () => {
    const f = fixture();
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    await attach(runtime, sessionId);
    await runtime.command({
      commandId: "active",
      sessionId,
      command: { kind: "message.submit", message: message("active") },
    });
    const invoke = (commandId: string, command: Parameters<typeof runtime.command>[0]["command"]) =>
      runtime.command({ commandId, sessionId, command } as Parameters<typeof runtime.command>[0]);
    expect(
      (
        await invoke("invalid", {
          kind: "message.submit",
          delivery: "queue",
          message: { ...message("bad"), role: "assistant" },
        })
      ).receipt,
    ).toMatchObject({ status: "rejected", code: "invalid_message" });
    await invoke("first", {
      kind: "message.submit",
      delivery: "queue",
      message: message("first"),
      model: { providerId: "p", modelId: "m" },
      agent: "agent",
      variant: "variant",
    });
    expect(
      (
        await invoke("duplicate", {
          kind: "message.submit",
          delivery: "queue",
          message: message("first"),
        })
      ).receipt,
    ).toMatchObject({ code: "message_exists" });
    expect(
      (await invoke("missing", { kind: "message.cancel", messageId: "missing" })).receipt,
    ).toMatchObject({ code: "message_not_queued" });
    expect(
      (
        await invoke("bad-edit", {
          kind: "message.edit",
          messageId: "first",
          message: message("changed-id"),
        })
      ).receipt,
    ).toMatchObject({ code: "invalid_message" });
    await expect(
      invoke("active", { kind: "message.submit", delivery: "queue", message: message("first") }),
    ).rejects.toBeInstanceOf(SessionRuntimeCommandConflictError);
    await f.adapter.complete("active");
    await runtime.recoverFollowUps();
    expect(f.adapter.commands.at(-1)).toMatchObject({
      model: { providerId: "p", modelId: "m" },
      agent: "agent",
      variant: "variant",
    });
  });

  it("does not release a second message merely because an accepted executor has not emitted a turn start", async () => {
    const f = fixture();
    f.adapter.startTurns = false;
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    await runtime.command({
      commandId: "first",
      sessionId,
      command: { kind: "message.submit", delivery: "queue", message: message("first") },
    });
    await runtime.recoverFollowUps();
    await runtime.command({
      commandId: "second",
      sessionId,
      command: { kind: "message.submit", delivery: "queue", message: message("second") },
    });
    await runtime.recoverFollowUps();
    expect(f.adapter.commands).toHaveLength(1);
  });

  it("fails closed without a durable queue port while keeping ordinary delivery working", async () => {
    const f = fixture();
    const runtime = f.runtime(false);
    const sessionId = await create(runtime);
    await expect(
      runtime.command({
        commandId: "queued",
        sessionId,
        command: { kind: "message.submit", delivery: "queue", message: message("queued") },
      }),
    ).rejects.toThrow("storage is unavailable");
    await runtime.recoverFollowUps();
    await attach(runtime, sessionId);
    await runtime.command({
      commandId: "ordinary",
      sessionId,
      command: { kind: "message.submit", message: message("ordinary") },
    });
    await runtime.command({
      commandId: "ordinary-steer",
      sessionId,
      command: { kind: "message.submit", delivery: "steer", message: message("steer") },
    });
    await f.adapter.complete("ordinary");
    expect(f.adapter.commands).toHaveLength(2);
  });

  it("isolates failed queue publications and diagnostics from durable acceptance", async () => {
    const storage = createInMemorySessionFollowUpLedger();
    let failPublication = false;
    const followUps: SessionFollowUpLedger = {
      ...storage,
      transaction: (id, work) =>
        storage.transaction(id, (state) => {
          const result = work(state);
          if (
            failPublication &&
            result &&
            typeof result === "object" &&
            "queue" in result &&
            "revision" in result
          )
            throw new Error("queue publication failed");
          return result;
        }),
    };
    const f = fixture({
      followUps,
      diagnostics: () => {
        throw new Error("diagnostics failed");
      },
    });
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    await attach(runtime, sessionId);
    await runtime.command({
      commandId: "active",
      sessionId,
      command: { kind: "message.submit", message: message("active") },
    });
    failPublication = true;
    expect(
      (
        await runtime.command({
          commandId: "first",
          sessionId,
          command: { kind: "message.submit", delivery: "queue", message: message("first") },
        })
      ).receipt?.status,
    ).toBe("accepted");
    await expect.poll(() => f.errors.length).toBeGreaterThan(0);
    expect((await runtime.projection({ sessionId })).projection.queue?.[0].id).toBe("first");
  });

  it("keeps an unproven release uneditable but cancellable, and cancellation of terminal refusal is safe", async () => {
    const f = fixture();
    f.adapter.unknown = true;
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    await runtime.command({
      commandId: "first",
      sessionId,
      command: { kind: "message.submit", delivery: "queue", message: message("first") },
    });
    await runtime.recoverFollowUps();
    expect(
      (
        await runtime.command({
          commandId: "edit",
          sessionId,
          command: { kind: "message.edit", messageId: "first", message: message("first", "x") },
        })
      ).receipt,
    ).toMatchObject({ status: "rejected", code: "message_releasing" });
    expect(
      (
        await runtime.command({
          commandId: "cancel",
          sessionId,
          command: { kind: "message.cancel", messageId: "first" },
        })
      ).receipt?.status,
    ).toBe("accepted");
    expect((await runtime.projection({ sessionId })).projection.queue).toEqual([]);
    const g = fixture();
    g.adapter.refuse = true;
    const other = g.runtime();
    const otherId = await create(other);
    await other.command({
      commandId: "first",
      sessionId: otherId,
      command: { kind: "message.submit", delivery: "queue", message: message("first") },
    });
    await other.recoverFollowUps();
    expect(
      (
        await other.command({
          commandId: "cancel",
          sessionId: otherId,
          command: { kind: "message.cancel", messageId: "first" },
        })
      ).receipt?.status,
    ).toBe("accepted");
    expect((await other.projection({ sessionId: otherId })).projection.queue).toEqual([]);
  });

  it("retains queues for stopped/archived Sessions and for an unrelated Attention", async () => {
    const f = fixture();
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    await attach(runtime, sessionId);
    await runtime.command({
      commandId: "active",
      sessionId,
      command: { kind: "message.submit", message: message("active") },
    });
    await runtime.command({
      commandId: "queued",
      sessionId,
      command: { kind: "message.submit", delivery: "queue", message: message("queued") },
    });
    await runtime.command({ commandId: "stop", sessionId, command: { kind: "session.stop" } });
    await runtime.recoverFollowUps();
    expect(f.adapter.commands.filter(({ kind }) => kind === "message.submit")).toHaveLength(1);
    await f.engine.submit({
      commandId: "archive",
      sessionId,
      intent: { kind: "session.archive" },
      provenance: { source: { kind: "user", id: "test", detail: null }, venue: null },
    });
    expect(
      (
        await runtime.command({
          commandId: "archived",
          sessionId,
          command: { kind: "message.submit", delivery: "queue", message: message("another") },
        })
      ).receipt,
    ).toMatchObject({ status: "rejected", code: "session_archived" });
    const g = fixture();
    const other = g.runtime();
    const otherId = await create(other);
    await attach(other, otherId);
    await g.adapter.emit({
      kind: "attention",
      state: "raised",
      reason: "runtime-failure",
      message: "Needs recovery",
    });
    await other.command({
      commandId: "queued",
      sessionId: otherId,
      command: { kind: "message.submit", delivery: "queue", message: message("queued") },
    });
    await other.recoverFollowUps();
    expect(g.adapter.commands).toHaveLength(0);
  });

  it("retains an attach failure and reports even failure to record its Attention", async () => {
    const f = fixture();
    f.adapter.attachFailure = new Error("cannot attach");
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    const observe = f.engine.observe;
    f.engine.observe = (observation) =>
      observation.kind === "attention.raised"
        ? Promise.reject(new Error("attention write failed"))
        : observe(observation);
    await runtime.command({
      commandId: "queued",
      sessionId,
      origin: { kind: "user" },
      command: { kind: "message.submit", delivery: "queue", message: message("queued") },
    });
    await runtime.recoverFollowUps();
    expect(f.errors.length).toBeGreaterThan(1);
    // Nothing was sent, so the row goes back to queued: editable and cancellable.
    expect((await runtime.projection({ sessionId })).projection.queue?.[0].state).toBe("queued");
    const g = fixture();
    g.adapter.attachFailure = new Error("cannot attach");
    const other = g.runtime();
    const otherId = await create(other);
    await other.command({
      commandId: "queued",
      sessionId: otherId,
      command: { kind: "message.submit", delivery: "queue", message: message("queued") },
    });
    await other.recoverFollowUps();
    expect(g.adapter.commands).toHaveLength(0);
    expect(g.errors.length).toBeGreaterThan(0);
  });

  it("settles a retained release when later reconciliation supplies acceptance, without a Client drain", async () => {
    const f = fixture();
    f.adapter.unknown = true;
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    await runtime.command({
      commandId: "first",
      sessionId,
      command: { kind: "message.submit", delivery: "queue", message: message("first") },
    });
    await runtime.recoverFollowUps();
    const attachmentId = (await runtime.projection({ sessionId })).projection.liveExecutor!.id;
    f.adapter.receipts = [
      {
        commandId: deliveryId(sessionId, "first"),
        status: "accepted",
        acceptedAt: 400,
        native: null,
      },
    ];
    await runtime.reconcile({ sessionId, attachmentId });
    await expect
      .poll(async () => (await runtime.projection({ sessionId })).projection.queue)
      .toEqual([]);
    expect(f.adapter.commands).toHaveLength(1);
    await runtime.reconcile({ sessionId, attachmentId });
  });

  it("waits for idle when recovering an unsubmitted claim alongside a new active turn", async () => {
    const f = fixture();
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    await attach(runtime, sessionId);
    await runtime.command({
      commandId: "active",
      sessionId,
      command: { kind: "message.submit", message: message("active") },
    });
    await runtime.command({
      commandId: "first",
      sessionId,
      command: { kind: "message.submit", delivery: "queue", message: message("first") },
    });
    const attachmentId = (await runtime.projection({ sessionId })).projection.liveExecutor!.id;
    await runtime.reconcile({ sessionId, attachmentId });
    await f.followUps.transaction(sessionId, (state) => {
      state.entries[0].state = "releasing";
    });
    await runtime.recoverFollowUps();
    expect(f.adapter.commands).toHaveLength(1);
    await f.adapter.complete("active");
    await runtime.recoverFollowUps();
    expect(f.adapter.commands).toHaveLength(2);
  });

  it("keeps queue-only kinds out of durable events and rejects command-key reuse with immediate intent", async () => {
    const f = fixture();
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    await attach(runtime, sessionId);
    await runtime.command({
      commandId: "active",
      sessionId,
      command: { kind: "message.submit", message: message("active") },
    });
    const request = {
      commandId: "queued",
      sessionId,
      command: {
        kind: "message.submit" as const,
        delivery: "queue" as const,
        message: message("queued"),
      },
    };
    const accepted = await runtime.command(request);
    expect(await runtime.command(request)).toEqual(accepted);
    await expect(
      runtime.command({
        ...request,
        command: { kind: "message.submit", message: message("queued") },
      }),
    ).rejects.toBeInstanceOf(SessionRuntimeCommandConflictError);
    expect((await f.engine.getSession({ sessionId }))?.commands.map(({ id }) => id)).not.toContain(
      "queued",
    );
  });
});

type Runtime = ReturnType<ReturnType<typeof fixture>["runtime"]>;
const submits = (adapter: Adapter) =>
  adapter.commands
    .filter(({ kind }) => kind === "message.submit")
    .map(({ commandId }) => commandId);
const queueStates = async (runtime: Runtime, sessionId: string) =>
  (await runtime.projection({ sessionId })).projection.queue?.map(
    ({ id, state }) => `${id}:${state}`,
  );
const attentionDetails = async (runtime: Runtime, sessionId: string) =>
  (await runtime.projection({ sessionId })).projection.attention.active.map(({ detail }) => detail);
const queue = (runtime: Runtime, sessionId: string, id: string) =>
  runtime.command({
    commandId: id,
    sessionId,
    command: { kind: "message.submit", delivery: "queue", message: message(id) },
  });
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

/**
 * VC-675 regressions for follow-ups that could get stuck with no exit (review
 * probes P1–P6, glm N3/N5/N6). Every probe that used to only log is an
 * assertion here.
 */
describe("host follow-ups never strand a row", () => {
  const AMBIGUOUS =
    "This follow-up may have been delivered. Check the transcript before resending.";
  class GatedAdapter extends Adapter {
    gate: Promise<void> | undefined;
    override async attach(...args: Parameters<Adapter["attach"]>) {
      const gate = this.gate;
      this.gate = undefined;
      await gate;
      return super.attach(...args);
    }
  }

  async function activeWithQueue(f: ReturnType<typeof fixture>, ids: readonly string[]) {
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    await attach(runtime, sessionId);
    await runtime.command({
      commandId: "active",
      sessionId,
      command: { kind: "message.submit", message: message("active") },
    });
    for (const id of ids) await queue(runtime, sessionId, id);
    return { runtime, sessionId };
  }

  it("P1: clearing the Attention that held a queue wakes it, with no restart", async () => {
    const f = fixture();
    const { runtime, sessionId } = await activeWithQueue(f, ["q"]);
    await f.adapter.emit({
      kind: "attention",
      state: "raised",
      reason: "partial-turn",
      message: "partial",
    });
    await f.adapter.complete("active");
    await runtime.recoverFollowUps();
    expect(submits(f.adapter)).toEqual(["active"]);
    expect(await queueStates(runtime, sessionId)).toEqual(["q:queued"]);
    await f.adapter.emit({
      kind: "attention",
      state: "cleared",
      reason: "partial-turn",
      message: "Runtime recovered.",
    });
    await expect.poll(() => submits(f.adapter)).toEqual(["active", deliveryId(sessionId, "q")]);
    await expect.poll(() => queueStates(runtime, sessionId)).toEqual([]);
    expect(f.errors).toEqual([]);
  });

  it("wakes a queue held by a Stop when a new attachment lifts it", async () => {
    const f = fixture();
    const { runtime, sessionId } = await activeWithQueue(f, ["q"]);
    await runtime.command({ commandId: "stop", sessionId, command: { kind: "session.stop" } });
    await runtime.recoverFollowUps();
    expect(submits(f.adapter)).toEqual(["active"]);
    await runtime.command({
      commandId: "resume",
      sessionId,
      command: { kind: "adapter.attach", continuity: "context_replay" },
    });
    await expect.poll(() => submits(f.adapter)).toEqual(["active", deliveryId(sessionId, "q")]);
    expect(f.adapter.attaches).toBe(2);
  });

  it("P6: a new chat's opening message waits for the Client's pending attach, then sends once", async () => {
    const adapter = new GatedAdapter();
    const f = fixture({ adapter });
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    const gate = Promise.withResolvers<void>();
    adapter.gate = gate.promise;
    const clientAttach = runtime.command({
      commandId: "client-attach",
      sessionId,
      command: { kind: "adapter.attach", continuity: "fresh" },
    });
    await expect
      .poll(async () => (await f.engine.getSession({ sessionId }))?.pendingExecutorStart?.id)
      .toBe("client-attach");
    await queue(runtime, sessionId, "kickoff");
    await runtime.recoverFollowUps();
    // Not claimed: no `releasing` row with nobody to send it, no Attention.
    expect(await queueStates(runtime, sessionId)).toEqual(["kickoff:queued"]);
    expect(submits(adapter)).toEqual([]);
    gate.resolve();
    expect((await clientAttach).receipt?.status).toBe("accepted");
    await expect.poll(() => submits(adapter)).toEqual([deliveryId(sessionId, "kickoff")]);
    await expect.poll(() => queueStates(runtime, sessionId)).toEqual([]);
    expect(adapter.attaches).toBe(1);
    expect(await attentionDetails(runtime, sessionId)).toEqual([]);
    expect(f.errors).toEqual([]);
  });

  it("P6: a drain attach refused by a racing Client start returns the row unsent, then delivers", async () => {
    const adapter = new GatedAdapter();
    const gate = Promise.withResolvers<void>();
    let race: (() => Promise<void>) | null = null;
    const f = fixture({
      adapter,
      locate: async () => {
        const start = race;
        race = null;
        await start?.();
      },
    });
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    let clientAttach: Promise<unknown> | undefined;
    // The drain read "no start pending", then the Client's start lands first.
    race = async () => {
      adapter.gate = gate.promise;
      clientAttach = runtime.command({
        commandId: "client-attach",
        sessionId,
        command: { kind: "adapter.attach", continuity: "fresh" },
      });
      while (
        (await f.engine.getSession({ sessionId }))?.pendingExecutorStart?.id !== "client-attach"
      )
        await tick();
    };
    await queue(runtime, sessionId, "kickoff");
    await runtime.recoverFollowUps();
    expect(await queueStates(runtime, sessionId)).toEqual(["kickoff:queued"]);
    expect(submits(adapter)).toEqual([]);
    expect(await attentionDetails(runtime, sessionId)).toEqual([]);
    expect(String(f.errors[0])).toContain("executor_start_pending");
    gate.resolve();
    await clientAttach;
    await expect.poll(() => submits(adapter)).toEqual([deliveryId(sessionId, "kickoff")]);
    await expect.poll(() => queueStates(runtime, sessionId)).toEqual([]);
  });

  it("never claims behind a stale start, and returns a recovered claim to the queue", async () => {
    const f = fixture();
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    await f.engine.submit({
      commandId: "stale-start",
      sessionId,
      intent: { kind: "executor.start", adapterId: "fake", continuity: "fresh" },
      provenance: { source: { kind: "user", id: "test", detail: null }, venue: null },
    });
    await queue(runtime, sessionId, "first");
    await runtime.recoverFollowUps();
    expect(await queueStates(runtime, sessionId)).toEqual(["first:queued"]);
    await f.followUps.transaction(sessionId, (state) => {
      state.entries[0].state = "releasing";
    });
    await runtime.recoverFollowUps();
    expect(await queueStates(runtime, sessionId)).toEqual(["first:queued"]);
    expect(f.adapter.attaches).toBe(0);
    // A claim with no recorded intent sent nothing: cancelling it is safe.
    await f.followUps.transaction(sessionId, (state) => {
      state.entries[0].state = "releasing";
    });
    expect(
      (
        await runtime.command({
          commandId: "cancel",
          sessionId,
          command: { kind: "message.cancel", messageId: "first" },
        })
      ).receipt?.status,
    ).toBe("accepted");
    expect(await queueStates(runtime, sessionId)).toEqual([]);
    expect(f.errors).toEqual([]);
  });

  it("P2: a turn opened by an ambiguous delivery proves it; it settles and the FIFO continues", async () => {
    const f = fixture();
    const { runtime, sessionId } = await activeWithQueue(f, ["first", "second"]);
    // The prompt ran (its turn opened), then the transport lost the reply.
    f.adapter.ambiguous = true;
    await f.adapter.complete("active");
    await runtime.recoverFollowUps();
    f.adapter.ambiguous = false;
    expect(await queueStates(runtime, sessionId)).toEqual(["second:queued"]);
    expect(
      await f.followUps.transaction(sessionId, (state) => state.releases.first.receipt),
    ).toMatchObject({ status: "accepted", id: `${deliveryId(sessionId, "first")}:turn-evidence` });
    expect(await attentionDetails(runtime, sessionId)).toEqual([]);
    await f.adapter.complete(deliveryId(sessionId, "first"));
    await runtime.recoverFollowUps();
    expect(submits(f.adapter)).toEqual([
      "active",
      deliveryId(sessionId, "first"),
      deliveryId(sessionId, "second"),
    ]);
  });

  it("P2: a late turn from an ambiguous delivery settles it after a restart, never resending", async () => {
    const f = fixture();
    let { runtime } = await activeWithQueue(f, ["first", "second"]);
    const sessionId = (await f.followUps.pendingSessionIds())[0];
    f.adapter.ambiguous = true;
    f.adapter.startTurns = false;
    await f.adapter.complete("active");
    await runtime.recoverFollowUps();
    expect(await queueStates(runtime, sessionId)).toEqual(["first:releasing", "second:queued"]);
    expect(await attentionDetails(runtime, sessionId)).toEqual([AMBIGUOUS]);
    await runtime.close();
    f.adapter.ambiguous = false;
    f.adapter.startTurns = true;
    runtime = f.runtime();
    await runtime.recoverFollowUps();
    expect(submits(f.adapter)).toEqual(["active", deliveryId(sessionId, "first")]);
    // The executor did run it after all: its turn is the proof.
    const first = deliveryId(sessionId, "first");
    await f.adapter.emit({
      kind: "turn",
      state: "started",
      turnId: `turn:${first}`,
      occurredAt: 400,
    });
    await f.adapter.complete(first);
    await expect
      .poll(() => submits(f.adapter))
      .toEqual(["active", first, deliveryId(sessionId, "second")]);
    await expect.poll(() => attentionDetails(runtime, sessionId)).toEqual([]);
  });

  it("P2: an unproven release is cancellable, clears its Attention, and the FIFO continues", async () => {
    const f = fixture();
    const { runtime, sessionId } = await activeWithQueue(f, ["first", "second"]);
    f.adapter.ambiguous = true;
    f.adapter.startTurns = false;
    await f.adapter.complete("active");
    await runtime.recoverFollowUps();
    // Reloading on the same evidence settles nothing and never resends.
    await runtime.recoverFollowUps();
    expect(submits(f.adapter)).toEqual(["active", deliveryId(sessionId, "first")]);
    expect(await queueStates(runtime, sessionId)).toEqual(["first:releasing", "second:queued"]);
    expect(await attentionDetails(runtime, sessionId)).toEqual([AMBIGUOUS]);
    expect(
      (
        await runtime.command({
          commandId: "edit-first",
          sessionId,
          command: { kind: "message.edit", messageId: "first", message: message("first", "x") },
        })
      ).receipt,
    ).toMatchObject({ status: "rejected", code: "message_releasing" });
    f.adapter.ambiguous = false;
    f.adapter.startTurns = true;
    const cancelled = await runtime.command({
      commandId: "cancel-first",
      sessionId,
      command: { kind: "message.cancel", messageId: "first" },
    });
    expect(cancelled.receipt?.status).toBe("accepted");
    // The person's resend is theirs: the cancel hands back the payload.
    expect(cancelled.command.intent).toEqual({ kind: "message.cancel", messageId: "first" });
    await expect
      .poll(() => submits(f.adapter))
      .toEqual(["active", deliveryId(sessionId, "first"), deliveryId(sessionId, "second")]);
    await expect.poll(() => queueStates(runtime, sessionId)).toEqual([]);
    expect(await attentionDetails(runtime, sessionId)).toEqual([]);
  });

  it.each(["accepted", "rejected"] as const)(
    "lets a person withdraw an unproven claim while its outcome is still being reconciled (%s)",
    async (outcome) => {
      const f = fixture();
      const runtime = f.runtime();
      const sessionId = await create(runtime);
      const first = deliveryId(sessionId, "first");
      f.adapter.unknown = true;
      await queue(runtime, sessionId, "first");
      await runtime.recoverFollowUps();
      expect(await queueStates(runtime, sessionId)).toEqual(["first:releasing"]);
      f.adapter.unknown = false;
      const gate = Promise.withResolvers<void>();
      f.adapter.reconcileGate = gate.promise;
      f.adapter.receipts = [
        outcome === "accepted"
          ? { commandId: first, status: "accepted", acceptedAt: 400, native: null }
          : { commandId: first, status: "rejected", code: "refused", detail: "no", native: null },
      ];
      const recovering = runtime.recoverFollowUps();
      await expect.poll(() => f.adapter.reconciling).toBe(true);
      expect(
        (
          await runtime.command({
            commandId: "cancel",
            sessionId,
            command: { kind: "message.cancel", messageId: "first" },
          })
        ).receipt?.status,
      ).toBe("accepted");
      gate.resolve();
      await recovering;
      expect(await queueStates(runtime, sessionId)).toEqual([]);
      expect(submits(f.adapter)).toEqual([first]);
      expect(await attentionDetails(runtime, sessionId)).toEqual([]);
    },
  );

  it.each(["accepted", "completed", "derived-turn", "explicit-turn"] as const)(
    "rejects cancellation when %s proof lands after the pre-transaction reads",
    async (proof) => {
      const f = fixture();
      const runtime = f.runtime();
      const sessionId = await create(runtime);
      const first = deliveryId(sessionId, "first");
      f.adapter.unknown = true;
      await queue(runtime, sessionId, "first");
      await runtime.recoverFollowUps();
      expect(await queueStates(runtime, sessionId)).toEqual(["first:releasing"]);
      const projection = (await f.engine.getSession({ sessionId }))!;
      expect(
        projection.receipts.some(
          ({ commandId, status }) =>
            commandId === first && (status === "accepted" || status === "completed"),
        ),
      ).toBe(false);

      // The old orphan check ran before this final asynchronous head read.
      // Commit proof here, immediately before entering the cancel transaction.
      const latest = f.engine.latestEventSequence;
      let armed = true;
      f.engine.latestEventSequence = async (query) => {
        const sequence = await latest(query);
        if (armed) {
          armed = false;
          const base = {
            id: "late-proof",
            sessionId,
            occurredAt: 400,
            attachmentId: projection.liveExecutor!.id,
            provenance: {
              source: { kind: "adapter" as const, id: "fake", detail: null },
              venue: null,
            },
          };
          await f.engine.observe(
            proof === "accepted" || proof === "completed"
              ? {
                  ...base,
                  kind: "command.receipt",
                  receipt: {
                    id: "late-receipt",
                    commandId: first,
                    status: proof,
                    acceptedAt: 400,
                    ...(proof === "completed" ? { completedAt: 400 } : {}),
                    result: { kind: "message.submitted", sessionId },
                  },
                }
              : {
                  ...base,
                  kind: "turn.started",
                  attachmentId: projection.liveExecutor!.id,
                  turnId: proof === "derived-turn" ? `turn:${first}` : "explicit-turn",
                  ...(proof === "explicit-turn" ? { commandId: first } : {}),
                },
          );
        }
        return sequence;
      };
      const request = {
        commandId: "cancel",
        sessionId,
        command: { kind: "message.cancel" as const, messageId: "first" },
      };
      const cancelled = await runtime.command(request);
      expect(armed).toBe(false);
      expect(cancelled.receipt).toMatchObject({
        status: "rejected",
        code: "message_releasing",
        detail: "This message was already delivered",
      });
      expect(await runtime.command(request)).toEqual(cancelled);
      await runtime.recoverFollowUps();
      expect(await queueStates(runtime, sessionId)).toEqual([]);
      expect(submits(f.adapter)).toEqual([first]);
      await runtime.close();
    },
  );

  it("fails closed when the queue storage cannot read delivery proof transactionally", async () => {
    const f = fixture({ followUps: createInMemorySessionFollowUpLedger() });
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    f.adapter.unknown = true;
    await queue(runtime, sessionId, "first");
    await runtime.recoverFollowUps();
    expect(
      (
        await runtime.command({
          commandId: "cancel",
          sessionId,
          command: { kind: "message.cancel", messageId: "first" },
        })
      ).receipt,
    ).toMatchObject({ status: "rejected", code: "message_releasing" });
    expect(await queueStates(runtime, sessionId)).toEqual(["first:releasing"]);
    await runtime.close();
  });

  it("settles an unacknowledged dispatch whose turn opened, without Attention", async () => {
    const f = fixture();
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    f.adapter.unknownAfterTurn = true;
    await queue(runtime, sessionId, "first");
    await runtime.recoverFollowUps();
    expect(await queueStates(runtime, sessionId)).toEqual([]);
    expect(await attentionDetails(runtime, sessionId)).toEqual([]);
    expect(f.errors).toEqual([]);
  });

  it("refuses to cancel a release proven by its receipt, and settles it instead", async () => {
    const eventLedger = createInMemorySessionLedger();
    const storage = createInMemorySessionFollowUpLedger(eventLedger);
    let crash = true;
    const followUps: SessionFollowUpLedger = {
      ...storage,
      transaction: (id, work) =>
        storage.transaction(id, (state, proof) => {
          const result = work(state, proof);
          if (crash && Object.hasOwn(state.releases, "first"))
            throw new Error("crash before settling queue");
          return result;
        }),
    };
    const f = fixture({ followUps, eventLedger });
    let runtime = f.runtime();
    const sessionId = await create(runtime);
    await queue(runtime, sessionId, "first");
    await runtime.recoverFollowUps();
    await runtime.close();
    crash = false;
    runtime = f.runtime();
    expect(
      (
        await runtime.command({
          commandId: "cancel",
          sessionId,
          command: { kind: "message.cancel", messageId: "first" },
        })
      ).receipt,
    ).toMatchObject({
      status: "rejected",
      code: "message_releasing",
      detail: "This message was already delivered",
    });
    await runtime.recoverFollowUps();
    expect(await queueStates(runtime, sessionId)).toEqual([]);
    expect(submits(f.adapter)).toEqual([deliveryId(sessionId, "first")]);
  });

  it("never attributes a turn another opener, another attachment, or a turn end could explain", async () => {
    const f = fixture();
    const { runtime, sessionId } = await activeWithQueue(f, ["first"]);
    const first = deliveryId(sessionId, "first");
    f.adapter.ambiguous = true;
    f.adapter.startTurns = false;
    await f.adapter.complete("active");
    await runtime.recoverFollowUps();
    f.adapter.ambiguous = false;
    f.adapter.startTurns = true;
    // Another message opens the next turn: it is that message's, not ours.
    await runtime.command({
      commandId: "other",
      sessionId,
      command: { kind: "message.submit", message: message("other") },
    });
    await f.adapter.complete("other");
    await runtime.recoverFollowUps();
    expect(await queueStates(runtime, sessionId)).toEqual(["first:releasing"]);

    const g = fixture();
    const second = await activeWithQueue(g, ["first"]);
    g.adapter.ambiguous = true;
    g.adapter.startTurns = false;
    await g.adapter.complete("active");
    await second.runtime.recoverFollowUps();
    g.adapter.ambiguous = false;
    const attachmentId = (await second.runtime.projection({ sessionId: second.sessionId }))
      .projection.liveExecutor!.id;
    await second.runtime.command({
      commandId: "release",
      sessionId: second.sessionId,
      command: { kind: "adapter.release", attachmentId },
    });
    await second.runtime.command({
      commandId: "reattach",
      sessionId: second.sessionId,
      command: { kind: "adapter.attach", continuity: "context_replay" },
    });
    // A turn on a different attachment cannot be the released one's.
    await g.adapter.emit({
      kind: "turn",
      state: "started",
      turnId: "spontaneous",
      occurredAt: 500,
    });
    await second.runtime.recoverFollowUps();
    expect(await queueStates(second.runtime, second.sessionId)).toEqual(["first:releasing"]);
    expect(g.adapter.commands.filter(({ kind }) => kind === "message.submit")).toHaveLength(2);
    expect(submits(f.adapter)).toEqual(["active", first, "other"]);
  });

  it("keeps an ambiguous queued steer retained when its turn ends without proof", async () => {
    const f = fixture();
    const { runtime, sessionId } = await activeWithQueue(f, ["queued"]);
    f.adapter.ambiguous = true;
    await expect(
      runtime.command({
        commandId: "steer",
        sessionId,
        command: { kind: "message.submit", delivery: "steer", message: message("queued") },
      }),
    ).rejects.toThrow("transport lost");
    expect(await attentionDetails(runtime, sessionId)).toEqual([AMBIGUOUS]);
    f.adapter.ambiguous = false;
    await f.adapter.complete("active");
    await runtime.recoverFollowUps();
    expect(await queueStates(runtime, sessionId)).toEqual(["queued:releasing"]);
    expect(f.adapter.commands).toHaveLength(2);
  });

  it("P3: a restart after an accepted release attach re-attaches under a new attempt id and delivers", async () => {
    let armed = false;
    let crash = false;
    let dead = false;
    const storage = createInMemorySessionFollowUpLedger();
    const followUps: SessionFollowUpLedger = {
      ...storage,
      transaction: (id, work) => {
        if (dead) return Promise.reject(new Error("process is dead"));
        if (crash) {
          dead = true;
          crash = false;
          armed = false;
          return Promise.reject(new Error("host crash after attach"));
        }
        return storage.transaction(id, work);
      },
    };
    class CrashAdapter extends Adapter {
      override async attach(...args: Parameters<Adapter["attach"]>) {
        const handle = await super.attach(...args);
        if (armed) crash = true;
        return handle;
      }
    }
    const adapter = new CrashAdapter();
    const f = fixture({ followUps, adapter });
    let runtime = f.runtime();
    const sessionId = await create(runtime);
    armed = true;
    await queue(runtime, sessionId, "first");
    await runtime.recoverFollowUps();
    expect(submits(adapter)).toEqual([]);
    const live = (await f.engine.getSession({ sessionId }))!.liveExecutor!;
    await runtime.close();
    dead = false;
    runtime = f.runtime();
    // The executor died with the host; the restarted host closes it.
    await runtime.command({
      commandId: "release",
      sessionId,
      command: { kind: "adapter.release", attachmentId: live.id },
    });
    await runtime.recoverFollowUps();
    const first = deliveryId(sessionId, "first");
    expect(submits(adapter)).toEqual([first]);
    expect(await queueStates(runtime, sessionId)).toEqual([]);
    expect(
      (await f.engine.getSession({ sessionId }))!.commands
        .map(({ id }) => id)
        .filter((id) => id.startsWith(`${first}:attach`)),
    ).toEqual([`${first}:attach:0`, `${first}:attach:1`]);
    // The original attach, the restart's rehydration to release it, the retry.
    expect(adapter.attaches).toBe(3);
  });

  it("retries a release that failed before its intent was recorded, then delivers once", async () => {
    let failures = 0;
    const f = fixture({
      retryDelays: [100],
      locate: () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("location blip");
        }
      },
    });
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    await attach(runtime, sessionId);
    failures = 1;
    // No other wake: only the backoff timer may bring it back.
    await queue(runtime, sessionId, "first");
    await expect
      .poll(() => f.errors.map(String))
      .toEqual([expect.stringContaining("location blip")]);
    expect(await queueStates(runtime, sessionId)).toEqual(["first:queued"]);
    expect(await attentionDetails(runtime, sessionId)).toEqual([
      "Queued message delivery failed: location blip",
    ]);
    await expect.poll(() => submits(f.adapter)).toEqual([deliveryId(sessionId, "first")]);
    await expect.poll(() => queueStates(runtime, sessionId)).toEqual([]);
    await expect.poll(() => attentionDetails(runtime, sessionId)).toEqual([]);
  });

  it("spends a bounded retry budget, then waits visibly until the person acts", async () => {
    let failing = false;
    let attempts = 0;
    const f = fixture({
      retryDelays: [40, 40],
      locate: () => {
        if (!failing) return;
        attempts += 1;
        throw new Error("location down");
      },
    });
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    await attach(runtime, sessionId);
    failing = true;
    await queue(runtime, sessionId, "first");
    // A second wake while a retry is pending does not stack another timer.
    await runtime.recoverFollowUps();
    await expect.poll(() => attempts).toBe(4);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(attempts).toBe(4);
    expect(await queueStates(runtime, sessionId)).toEqual(["first:queued"]);
    expect(await attentionDetails(runtime, sessionId)).toEqual([
      "Queued message delivery failed: location down",
    ]);
    failing = false;
    await runtime.command({
      commandId: "edit",
      sessionId,
      command: { kind: "message.edit", messageId: "first", message: message("first", "again") },
    });
    await expect.poll(() => submits(f.adapter)).toEqual([deliveryId(sessionId, "edit")]);
    await runtime.close();
  });

  it("retries a transient executor attach failure without a Client or unrelated wake", async () => {
    const f = fixture({ retryDelays: [100] });
    f.adapter.attachFailure = new Error("executor offline briefly");
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    await queue(runtime, sessionId, "first");
    await expect.poll(() => f.errors.length).toBe(1);
    expect(await queueStates(runtime, sessionId)).toEqual(["first:queued"]);
    f.adapter.attachFailure = undefined;
    await expect.poll(() => submits(f.adapter)).toEqual([deliveryId(sessionId, "first")]);
    await expect.poll(() => queueStates(runtime, sessionId)).toEqual([]);
    expect(f.adapter.attaches).toBe(2);
    expect(await attentionDetails(runtime, sessionId)).toEqual([]);
    await runtime.close();
  });

  it("keeps an attach configuration Attention blocking automatic retries", async () => {
    const f = fixture({ retryDelays: [10] });
    f.adapter.attachFailure = new NativeAttachmentError(
      "Choose a model",
      "model_missing",
      "configuration_invalid",
    );
    const runtime = f.runtime();
    const sessionId = await create(runtime);
    await queue(runtime, sessionId, "first");
    await runtime.recoverFollowUps();
    f.adapter.attachFailure = undefined;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(submits(f.adapter)).toEqual([]);
    expect(f.adapter.attaches).toBe(1);
    expect(await queueStates(runtime, sessionId)).toEqual(["first:queued"]);
    expect(await attentionDetails(runtime, sessionId)).toContain("Choose a model");
    await runtime.close();
  });

  it("P4: concurrent cancels and release races keep FIFO and never deliver cancelled text", async () => {
    const f = fixture();
    const { runtime, sessionId } = await activeWithQueue(f, ["a", "b", "c"]);
    const cancelC = (commandId: string) =>
      runtime.command({
        commandId,
        sessionId,
        command: { kind: "message.cancel", messageId: "c" },
      });
    const cancelled = await Promise.all([cancelC("client-a"), cancelC("client-b")]);
    expect(cancelled.map(({ receipt }) => receipt?.status).toSorted()).toEqual([
      "accepted",
      "rejected",
    ]);
    const gate = Promise.withResolvers<void>();
    f.adapter.dispatchGate = gate.promise;
    await Promise.all([f.adapter.complete("active"), queue(runtime, sessionId, "d")]);
    await expect.poll(() => submits(f.adapter)).toEqual(["active", deliveryId(sessionId, "a")]);
    for (const command of [
      { kind: "message.cancel" as const, messageId: "a" },
      { kind: "message.edit" as const, messageId: "a", message: message("a", "late edit") },
    ])
      expect(
        (await runtime.command({ commandId: `race-${command.kind}`, sessionId, command })).receipt,
      ).toMatchObject({ status: "rejected", code: "message_releasing" });
    gate.resolve();
    f.adapter.dispatchGate = undefined;
    await runtime.recoverFollowUps();
    for (const id of ["a", "b", "d"]) {
      await f.adapter.complete(deliveryId(sessionId, id));
      await runtime.recoverFollowUps();
    }
    expect(submits(f.adapter)).toEqual([
      "active",
      ...["a", "b", "d"].map((id) => deliveryId(sessionId, id)),
    ]);
    expect(await queueStates(runtime, sessionId)).toEqual([]);
    expect(
      f.adapter.commands
        .filter((command) => command.kind === "message.submit")
        .map((command) => command.message.id),
    ).toEqual(["active", "a", "b", "d"]);
    await runtime.close();
  });

  it("P5: an interrupted turn releases its follow-up with no Client attached", async () => {
    const f = fixture();
    const { runtime, sessionId } = await activeWithQueue(f, ["q"]);
    await f.adapter.emit({
      kind: "turn",
      state: "interrupted",
      turnId: "turn:active",
      occurredAt: 300,
    });
    await expect.poll(() => submits(f.adapter)).toEqual(["active", deliveryId(sessionId, "q")]);
    await expect.poll(() => queueStates(runtime, sessionId)).toEqual([]);
    await runtime.close();
  });

  it.each(["active", "first", "unknown"] as const)(
    "matches explicit turn attribution to the delivery command (%s)",
    async (commandId) => {
      const f = fixture();
      const { runtime, sessionId } = await activeWithQueue(f, ["first"]);
      f.adapter.ambiguous = true;
      f.adapter.startTurns = false;
      await f.adapter.complete("active");
      await runtime.recoverFollowUps();
      const projection = (await f.engine.getSession({ sessionId }))!;
      await f.engine.observe({
        id: "late-other-turn",
        sessionId,
        occurredAt: 400,
        provenance: { source: { kind: "system", id: "test", detail: null }, venue: null },
        ...(commandId === "unknown"
          ? {}
          : { commandId: commandId === "first" ? deliveryId(sessionId, "first") : "active" }),
        kind: "turn.started",
        attachmentId: projection.liveExecutor!.id,
        turnId: "late-other-turn",
      });
      await runtime.recoverFollowUps();
      expect(await queueStates(runtime, sessionId)).toEqual(
        commandId === "first" ? [] : ["first:releasing"],
      );
      expect(submits(f.adapter)).toEqual(["active", deliveryId(sessionId, "first")]);
      await runtime.close();
    },
  );

  it("refuses to guess between two releasing rows (corrupt ledger)", async () => {
    const f = fixture();
    const { runtime, sessionId } = await activeWithQueue(f, ["a", "b"]);
    await f.followUps.transaction(sessionId, (state) => {
      for (const entry of state.entries) entry.state = "releasing";
    });
    await f.adapter.complete("active");
    await runtime.recoverFollowUps();
    expect(submits(f.adapter)).toEqual(["active"]);
    expect(f.errors.map(String)).toContainEqual(expect.stringContaining("More than one"));
    expect(await queueStates(runtime, sessionId)).toEqual(["a:releasing", "b:releasing"]);
  });
});
