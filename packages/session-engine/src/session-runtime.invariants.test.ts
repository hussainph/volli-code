import { describe, expect, it } from "vite-plus/test";
import type { SessionLedgerIds } from "@volli/shared";
import type { UIMessage } from "ai";
import {
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
  createNativeAdapterRegistry,
  createSessionEngine,
  createSessionRuntime,
  type BindingHandle,
  type HarnessObservation,
  type NativeHarnessAdapter,
  type NativeProbeResult,
  type ObservationSink,
  type SessionEngine,
  type SessionRuntime,
} from "./index";

const venue = { id: "invariant-machine", kind: "local" as const };

function ledgerIds(): SessionLedgerIds {
  let sequence = 0;
  return { next: (kind) => `${kind}-${++sequence}` };
}

function runtimeIds(prefix = "") {
  let sequence = 0;
  return { next: (kind: string) => `${prefix}${kind}-${++sequence}` };
}

function message(id = "message", text = "hello"): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

class Adapter implements NativeHarnessAdapter {
  readonly manifest = {
    id: "invariant-adapter",
    displayName: "Invariant Adapter",
    adapterVersion: "1.0.0",
    profiles: [{ id: "native", label: "Native", transport: "native" as const }],
  };
  attaches = 0;
  dispatches = 0;
  reconciles = 0;
  releases = 0;
  probeFailure: unknown = null;
  probeResult: NativeProbeResult | null = null;
  attachGate: Promise<void> | null = null;
  attachObservation: HarnessObservation | null = null;
  reconcileReceipts: Awaited<ReturnType<BindingHandle["reconcile"]>>["receipts"] = [];
  dispatchReceipt: Awaited<ReturnType<BindingHandle["dispatch"]>> | null = null;
  sink: ObservationSink | null = null;
  specs: Parameters<NativeHarnessAdapter["attach"]>[0][] = [];

  async probe(): Promise<NativeProbeResult> {
    if (this.probeFailure) throw this.probeFailure;
    return (
      this.probeResult ?? {
        status: "available",
        runtime: { path: "/trusted/adapter", version: "1", fingerprint: "sha256:adapter" },
        capabilities: { features: [], catalog: [] },
      }
    );
  }

  async attach(spec: Parameters<NativeHarnessAdapter["attach"]>[0], sink: ObservationSink) {
    this.attaches += 1;
    this.specs.push(spec);
    this.sink = sink;
    if (this.attachObservation) await sink.emit(this.attachObservation);
    await this.attachGate;
    return {
      native: { id: "native-session", detail: { locator: "native" } },
      dispatch: async (command) => {
        this.dispatches += 1;
        return (
          this.dispatchReceipt ?? {
            commandId: command.commandId,
            status: "accepted" as const,
            acceptedAt: 50,
            native: { id: command.commandId, detail: null },
          }
        );
      },
      reconcile: async () => {
        this.reconciles += 1;
        return { cursor: null, observations: [], receipts: this.reconcileReceipts };
      },
      release: async () => {
        this.releases += 1;
      },
    } satisfies BindingHandle;
  }

  emit(observation: HarnessObservation): Promise<void> {
    if (!this.sink) throw new Error("not attached");
    return this.sink.emit(observation);
  }
}

function composition(
  input: {
    adapter?: Adapter;
    engine?: SessionEngine;
    directory?: () => string;
    runtimeIdPrefix?: string;
  } = {},
) {
  let now = 1;
  const adapter = input.adapter ?? new Adapter();
  const engine =
    input.engine ??
    createSessionEngine({
      ledger: createInMemorySessionLedger(),
      clock: { now: () => now++ },
      ids: ledgerIds(),
    });
  return {
    adapter,
    engine,
    runtime: createSessionRuntime({
      engine,
      adapters: createNativeAdapterRegistry([adapter]),
      artifacts: createInMemoryTranscriptArtifactStore(),
      locations: {
        resolve: async () => ({ directory: input.directory?.() ?? "/ticket/original", venue }),
      },
      clock: { now: () => now++ },
      ids: runtimeIds(input.runtimeIdPrefix),
    }),
  };
}

async function create(runtime: SessionRuntime) {
  return runtime.command({
    commandId: "create",
    command: { kind: "session.create", projectId: "project", ticketId: "ticket", title: null },
  });
}

async function attach(runtime: SessionRuntime, sessionId: string, commandId = "attach") {
  return runtime.command({
    commandId,
    sessionId,
    command: {
      kind: "adapter.attach",
      adapterId: "invariant-adapter",
      profileId: "native",
      continuity: "fresh",
    },
  });
}

describe("SessionRuntime durable boundary invariants", () => {
  it("records missing adapters and thrown probes as rejected attachment outcomes", async () => {
    const base = composition();
    const missing = createSessionRuntime({
      engine: base.engine,
      adapters: createNativeAdapterRegistry([]),
      artifacts: createInMemoryTranscriptArtifactStore(),
      locations: { resolve: async () => ({ directory: "/ticket/original", venue }) },
      clock: { now: () => 100 },
      ids: runtimeIds(),
    });
    const created = await create(missing);
    await expect(attach(missing, created.sessionId)).resolves.toMatchObject({
      receipt: { status: "rejected", code: "adapter_missing" },
    });
    expect((await missing.snapshot({ sessionId: created.sessionId })).projection).toMatchObject({
      pendingExecutorStart: null,
      attachments: [{ status: "failed", failure: { code: "adapter_missing" } }],
    });

    const probe = composition();
    probe.adapter.probeFailure = new Error("probe transport broke");
    const probeSession = await create(probe.runtime);
    await expect(attach(probe.runtime, probeSession.sessionId)).resolves.toMatchObject({
      receipt: { status: "rejected", code: "probe_failed", detail: "probe transport broke" },
    });
    expect(
      (await probe.runtime.snapshot({ sessionId: probeSession.sessionId })).projection,
    ).toMatchObject({
      pendingExecutorStart: null,
      attachments: [{ status: "failed", failure: { code: "probe_failed" } }],
    });
  });

  it("does not evict an adapter binding until its native terminal fact is durable", async () => {
    const { runtime, adapter } = composition();
    const created = await create(runtime);
    await attach(runtime, created.sessionId);
    const attachmentId = (await runtime.snapshot({ sessionId: created.sessionId })).projection
      .liveExecutor!.id;

    await adapter.emit({
      id: "provider-lost",
      kind: "attachment.failed",
      occurredAt: 10,
      detail: "provider disconnected",
    });

    expect(
      (await runtime.snapshot({ sessionId: created.sessionId })).projection.attachments,
    ).toMatchObject([{ id: attachmentId, status: "closed", outcome: "failed" }]);
    await expect(
      runtime.refreshCapabilities({ sessionId: created.sessionId, attachmentId }),
    ).rejects.toThrow("is not open");
    expect(adapter.attaches).toBe(1);
  });

  it("single-flights buffered rehydration and resumes from the immutable original directory", async () => {
    let directory = "/ticket/original";
    const first = composition({ directory: () => directory });
    const created = await create(first.runtime);
    await attach(first.runtime, created.sessionId);
    const attachmentId = (await first.runtime.snapshot({ sessionId: created.sessionId })).projection
      .liveExecutor!.id;
    await first.runtime.close();

    directory = "/ticket/rerouted";
    let releaseAttach!: () => void;
    first.adapter.attachGate = new Promise<void>((resolve) => {
      releaseAttach = resolve;
    });
    first.adapter.attachObservation = {
      id: "rehydrated-turn",
      kind: "turn.started",
      occurredAt: 20,
      turnId: "turn-rehydrated",
    };
    const recovered = composition({
      engine: first.engine,
      adapter: first.adapter,
      directory: () => directory,
      runtimeIdPrefix: "recovered-",
    });
    const left = recovered.runtime.refreshCapabilities({
      sessionId: created.sessionId,
      attachmentId,
    });
    const right = recovered.runtime.refreshCapabilities({
      sessionId: created.sessionId,
      attachmentId,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(first.adapter.attaches).toBe(2);
    releaseAttach();
    await Promise.all([left, right]);

    expect(first.adapter.specs.at(-1)?.directory).toBe("/ticket/original");
    expect((await recovered.runtime.snapshot({ sessionId: created.sessionId })).frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            payload: expect.objectContaining({ kind: "turn.started" }),
          }),
        }),
      ]),
    );
  });

  it("reconciles replayed unreconciled work without dispatching it again", async () => {
    const first = composition();
    const created = await create(first.runtime);
    await attach(first.runtime, created.sessionId);
    first.adapter.dispatchReceipt = {
      commandId: "message-unreconciled",
      status: "unknown",
      detail: "socket write outcome unknown",
      native: null,
    };
    await first.runtime.command({
      commandId: "message-unreconciled",
      sessionId: created.sessionId,
      command: { kind: "message.submit", message: message("message-unreconciled") },
    });
    await first.runtime.close();

    const recoveringAdapter = new Adapter();
    recoveringAdapter.reconcileReceipts = [
      {
        commandId: "message-unreconciled",
        status: "accepted",
        acceptedAt: 60,
        native: null,
      },
    ];
    const recovered = composition({
      engine: first.engine,
      adapter: recoveringAdapter,
      runtimeIdPrefix: "recovered-",
    });
    await expect(
      recovered.runtime.command({
        commandId: "message-unreconciled",
        sessionId: created.sessionId,
        command: { kind: "message.submit", message: message("message-unreconciled") },
      }),
    ).resolves.toMatchObject({ receipt: { status: "accepted" } });
    expect(recoveringAdapter.reconciles).toBe(1);
    expect(recoveringAdapter.dispatches).toBe(0);
  });

  it("does not regress an accepted delivery to an unreconciled receipt during reconciliation", async () => {
    const { runtime, adapter } = composition();
    const created = await create(runtime);
    await attach(runtime, created.sessionId);
    const attachmentId = (await runtime.snapshot({ sessionId: created.sessionId })).projection
      .liveExecutor!.id;
    adapter.reconcileReceipts = [
      {
        commandId: "attach",
        status: "unknown",
        detail: "provider forgot its receipt",
        native: null,
      },
    ];

    await runtime.reconcile({ sessionId: created.sessionId, attachmentId });

    expect(
      (await runtime.snapshot({ sessionId: created.sessionId })).projection.receipts.filter(
        ({ commandId }) => commandId === "attach",
      ),
    ).toEqual([expect.objectContaining({ status: "accepted" })]);
  });

  it("recovers an opened replayed attach and marks an outcome-less replay for explicit recovery", async () => {
    const opened = composition();
    const openedSession = await create(opened.runtime);
    await opened.engine.submit({
      commandId: "attach-opened-without-receipt",
      sessionId: openedSession.sessionId,
      intent: { kind: "executor.start", adapterId: "invariant-adapter", continuity: "fresh" },
      provenance: { source: { kind: "user", id: "test", detail: null }, venue },
    });
    await opened.engine.observe({
      id: "opened-without-receipt",
      sessionId: openedSession.sessionId,
      commandId: "attach-opened-without-receipt",
      occurredAt: 40,
      provenance: { source: { kind: "adapter", id: "invariant-adapter", detail: null }, venue },
      kind: "attachment.opened",
      attachment: {
        id: "opened-attachment",
        sessionId: openedSession.sessionId,
        adapterId: "invariant-adapter",
        venue,
        continuity: "fresh",
        native: {
          id: "native-session",
          detail: {
            kind: "volli.native-binding.v1",
            profileId: "native",
            directory: "/ticket/original",
            locator: { locator: "native" },
          },
        },
      },
    });
    opened.adapter.reconcileReceipts = [
      {
        commandId: "attach-opened-without-receipt",
        status: "accepted",
        acceptedAt: 41,
        native: null,
      },
    ];
    await expect(
      attach(opened.runtime, openedSession.sessionId, "attach-opened-without-receipt"),
    ).resolves.toMatchObject({ receipt: { status: "accepted" } });
    expect(opened.adapter.attaches).toBe(1);

    const absent = composition();
    const absentSession = await create(absent.runtime);
    await absent.engine.submit({
      commandId: "attach-without-outcome",
      sessionId: absentSession.sessionId,
      intent: { kind: "executor.start", adapterId: "invariant-adapter", continuity: "fresh" },
      provenance: { source: { kind: "user", id: "test", detail: null }, venue },
    });
    await expect(
      attach(absent.runtime, absentSession.sessionId, "attach-without-outcome"),
    ).resolves.toMatchObject({
      receipt: { status: "unreconciled" },
    });
    expect(absent.adapter.attaches).toBe(0);
  });

  it("contains poisoned stream subscribers and serializes capability revisions", async () => {
    const { runtime, adapter } = composition();
    const created = await create(runtime);
    await attach(runtime, created.sessionId);
    const attachmentId = (await runtime.snapshot({ sessionId: created.sessionId })).projection
      .liveExecutor!.id;
    await runtime.subscribe({ sessionId: created.sessionId, afterSequence: 0 }, () => {
      throw new Error("client frame failed");
    });

    await expect(
      adapter.emit({ id: "after-poison", kind: "turn.started", occurredAt: 30, turnId: "turn" }),
    ).resolves.toBeUndefined();
    const [first, second] = await Promise.all([
      runtime.refreshCapabilities({ sessionId: created.sessionId, attachmentId }),
      runtime.refreshCapabilities({ sessionId: created.sessionId, attachmentId }),
    ]);
    expect([first.revision, second.revision].toSorted((left, right) => left - right)).toEqual([
      2, 3,
    ]);
  });

  it("keeps ambiguous replayed deliveries unreconciled across every native command route", async () => {
    const first = composition();
    const created = await create(first.runtime);
    await attach(first.runtime, created.sessionId);
    const attachmentId = (await first.runtime.snapshot({ sessionId: created.sessionId })).projection
      .liveExecutor!.id;
    await first.adapter.emit({
      id: "ambiguous-interaction",
      kind: "interaction.opened",
      occurredAt: 70,
      interaction: {
        id: "ambiguous-interaction",
        kind: "permission",
        title: "Ambiguous",
        detail: null,
        options: [],
        multiple: false,
        native: { id: "ambiguous-native", detail: null },
      },
    });
    first.adapter.dispatchReceipt = {
      commandId: "ambiguous-message",
      status: "unknown",
      detail: "message delivery unknown",
      native: null,
    };
    await first.runtime.command({
      commandId: "ambiguous-message",
      sessionId: created.sessionId,
      command: { kind: "message.submit", message: message("ambiguous-message") },
    });
    first.adapter.dispatchReceipt = {
      commandId: "ambiguous-interrupt",
      status: "unknown",
      detail: "interrupt delivery unknown",
      native: null,
    };
    await first.runtime.command({
      commandId: "ambiguous-interrupt",
      sessionId: created.sessionId,
      command: { kind: "executor.interrupt", attachmentId },
    });
    first.adapter.dispatchReceipt = {
      commandId: "ambiguous-resolution",
      status: "unknown",
      detail: "resolution delivery unknown",
      native: null,
    };
    await first.runtime.command({
      commandId: "ambiguous-resolution",
      sessionId: created.sessionId,
      command: {
        kind: "interaction.resolve",
        interactionId: "ambiguous-interaction",
        resolution: { optionIds: [], response: null },
      },
    });
    await first.engine.submit({
      commandId: "ambiguous-release",
      sessionId: created.sessionId,
      intent: { kind: "executor.stop", attachmentId },
      provenance: { source: { kind: "user", id: "test", detail: null }, venue },
    });
    await first.engine.observe({
      id: "ambiguous-release-receipt-event",
      sessionId: created.sessionId,
      attachmentId,
      occurredAt: 71,
      provenance: { source: { kind: "adapter", id: "invariant-adapter", detail: null }, venue },
      kind: "command.receipt",
      receipt: {
        id: "ambiguous-release-receipt",
        commandId: "ambiguous-release",
        status: "unreconciled",
        detail: "release delivery unknown",
      },
    });
    await first.runtime.close();

    const replayCalls = new Map<string, number>();
    const receiptOmittingHost: SessionEngine = {
      ...first.engine,
      submit: async (input) => {
        const result = await first.engine.submit(input);
        const calls = (replayCalls.get(input.commandId) ?? 0) + 1;
        replayCalls.set(input.commandId, calls);
        return calls === 2 ? { ...result, receipt: null, receiptEvent: null } : result;
      },
    };
    const recovered = composition({
      engine: receiptOmittingHost,
      adapter: first.adapter,
      runtimeIdPrefix: "recovered-",
    });
    for (const [commandId, command] of [
      ["ambiguous-message", { kind: "message.submit", message: message("ambiguous-message") }],
      ["ambiguous-interrupt", { kind: "executor.interrupt", attachmentId }],
      [
        "ambiguous-resolution",
        {
          kind: "interaction.resolve",
          interactionId: "ambiguous-interaction",
          resolution: { optionIds: [], response: null },
        },
      ],
      ["ambiguous-release", { kind: "adapter.release", attachmentId }],
    ] as const) {
      await expect(
        recovered.runtime.command({ commandId, sessionId: created.sessionId, command }),
      ).resolves.toMatchObject({ receipt: { status: "unreconciled", commandId } });
    }
    expect(first.adapter.dispatches).toBe(3);
    expect(first.adapter.releases).toBe(1);
  });

  it("surfaces rehydration and persisted-adapter failures without inventing a live binding", async () => {
    const first = composition();
    const created = await create(first.runtime);
    await attach(first.runtime, created.sessionId);
    const attachmentId = (await first.runtime.snapshot({ sessionId: created.sessionId })).projection
      .liveExecutor!.id;
    await first.runtime.close();
    first.adapter.attachGate = null;
    first.adapter.probeResult = null;
    const attachFailure = new Error("native resume refused");
    const originalAttach = first.adapter.attach.bind(first.adapter);
    first.adapter.attach = async () => {
      throw attachFailure;
    };
    const recovering = composition({ engine: first.engine, adapter: first.adapter });
    await expect(
      recovering.runtime.refreshCapabilities({ sessionId: created.sessionId, attachmentId }),
    ).rejects.toThrow("native resume refused");
    first.adapter.attach = originalAttach;

    const missing = composition();
    const missingSession = await create(missing.runtime);
    await missing.engine.observe({
      id: "missing-adapter-open",
      sessionId: missingSession.sessionId,
      occurredAt: 80,
      provenance: { source: { kind: "adapter", id: "absent", detail: null }, venue },
      kind: "attachment.opened",
      attachment: {
        id: "missing-adapter-open",
        sessionId: missingSession.sessionId,
        adapterId: "absent",
        venue,
        continuity: "native_resume",
        native: {
          id: "missing-native",
          detail: { kind: "volli.native-binding.v1", profileId: "native", locator: null },
        },
      },
    });
    await expect(
      missing.runtime.refreshCapabilities({
        sessionId: missingSession.sessionId,
        attachmentId: "missing-adapter-open",
      }),
    ).rejects.toThrow("Native adapter absent was not found");
  });

  it("preserves another subscriber when a peer fails and records ordinary adapter closure", async () => {
    const { runtime, adapter } = composition();
    const created = await create(runtime);
    await attach(runtime, created.sessionId);
    const attachmentId = (await runtime.snapshot({ sessionId: created.sessionId })).projection
      .liveExecutor!.id;
    const received: string[] = [];
    let failPeer = false;
    await runtime.subscribe({ sessionId: created.sessionId, afterSequence: 0 }, () => {
      if (failPeer) throw new Error("peer failed");
    });
    await runtime.subscribe({ sessionId: created.sessionId, afterSequence: 0 }, (frame) => {
      received.push(frame.event.payload.kind);
    });
    failPeer = true;
    await adapter.emit({
      id: "peer-failure",
      kind: "turn.started",
      occurredAt: 90,
      turnId: "turn",
    });
    await adapter.emit({
      id: "ordinary-close",
      kind: "attachment.closed",
      occurredAt: 91,
      outcome: "interrupted",
    });

    expect(received).toContain("attachment.closed");
    expect(
      (await runtime.snapshot({ sessionId: created.sessionId })).projection.attachments,
    ).toMatchObject([{ id: attachmentId, status: "closed", outcome: "interrupted" }]);
  });

  it("records replayed attach recovery failures and keeps a prior capability write from poisoning the next refresh", async () => {
    const first = composition();
    const created = await create(first.runtime);
    await first.engine.submit({
      commandId: "recover-failed-attach",
      sessionId: created.sessionId,
      intent: { kind: "executor.start", adapterId: "invariant-adapter", continuity: "fresh" },
      provenance: { source: { kind: "user", id: "test", detail: null }, venue },
    });
    await first.engine.observe({
      id: "recover-failed-attach-opened",
      sessionId: created.sessionId,
      commandId: "recover-failed-attach",
      occurredAt: 100,
      provenance: { source: { kind: "adapter", id: "invariant-adapter", detail: null }, venue },
      kind: "attachment.opened",
      attachment: {
        id: "recover-failed-attach-opened",
        sessionId: created.sessionId,
        adapterId: "invariant-adapter",
        venue,
        continuity: "fresh",
        native: {
          id: "recover-native",
          detail: {
            kind: "volli.native-binding.v1",
            profileId: "native",
            directory: "/ticket/original",
            locator: null,
          },
        },
      },
    });
    const originalAttach = first.adapter.attach.bind(first.adapter);
    first.adapter.attach = async () => {
      throw new Error("resume transport failed");
    };
    await expect(
      attach(first.runtime, created.sessionId, "recover-failed-attach"),
    ).resolves.toMatchObject({
      receipt: {
        status: "unreconciled",
        detail: "Attachment recovery failed: resume transport failed",
      },
    });
    first.adapter.attach = originalAttach;

    let rejectFirstWrite!: (error: Error) => void;
    let capabilityWrites = 0;
    const writeGate = new Promise<never>((_resolve, reject) => {
      rejectFirstWrite = reject;
    });
    const base = composition();
    const engine: SessionEngine = {
      ...base.engine,
      observe: async (input) => {
        if (input.kind === "capabilities.updated") {
          capabilityWrites += 1;
          if (capabilityWrites === 2) return writeGate;
        }
        return base.engine.observe(input);
      },
    };
    const recovering = composition({ engine, adapter: base.adapter });
    const capabilitySession = await create(recovering.runtime);
    await attach(recovering.runtime, capabilitySession.sessionId);
    const attachmentId = (
      await recovering.runtime.snapshot({ sessionId: capabilitySession.sessionId })
    ).projection.liveExecutor!.id;
    const firstRefresh = recovering.runtime.refreshCapabilities({
      sessionId: capabilitySession.sessionId,
      attachmentId,
    });
    const secondRefresh = recovering.runtime.refreshCapabilities({
      sessionId: capabilitySession.sessionId,
      attachmentId,
    });
    rejectFirstWrite(new Error("first capability write failed"));
    await expect(firstRefresh).rejects.toThrow("first capability write failed");
    await expect(secondRefresh).resolves.toMatchObject({ revision: 2 });
  });

  it("keeps the durable attachment identity when an opened attach is replayed without a receipt", async () => {
    const { runtime, engine, adapter } = composition();
    const created = await create(runtime);
    await engine.submit({
      commandId: "opened-without-receipt",
      sessionId: created.sessionId,
      intent: { kind: "executor.start", adapterId: "invariant-adapter", continuity: "fresh" },
      provenance: { source: { kind: "user", id: "test", detail: null }, venue },
    });
    await engine.observe({
      id: "opened-without-receipt-event",
      sessionId: created.sessionId,
      commandId: "opened-without-receipt",
      occurredAt: 110,
      provenance: { source: { kind: "adapter", id: "invariant-adapter", detail: null }, venue },
      kind: "attachment.opened",
      attachment: {
        id: "opened-without-receipt-attachment",
        sessionId: created.sessionId,
        adapterId: "invariant-adapter",
        venue,
        continuity: "fresh",
        native: {
          id: "opened-without-receipt-native",
          detail: {
            kind: "volli.native-binding.v1",
            profileId: "native",
            directory: "/ticket/original",
            locator: null,
          },
        },
      },
    });

    await expect(
      attach(runtime, created.sessionId, "opened-without-receipt"),
    ).resolves.toMatchObject({
      receipt: {
        status: "unreconciled",
        detail: "Attachment outcome is recorded but its delivery receipt is unreconciled",
      },
    });
    expect(adapter.attaches).toBe(1);
  });
});
