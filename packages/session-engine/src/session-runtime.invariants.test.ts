import { describe, expect, it } from "vite-plus/test";
import type { RuntimeObservation, SessionLedgerIds } from "@volli/shared";
import type { UIMessage } from "ai";
import {
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
  createSessionEngine,
  createSessionRuntime,
  isSessionStreamFrame,
  type BindingHandle,
  type NativeHarnessAdapter,
  type ObservationSink,
  type SessionEngine,
  type SessionLocationResolver,
  type SessionRuntime,
} from "./index";

const venue = { id: "invariant-machine", kind: "local" as const };

/** A host with nothing to materialize: preparing a location is resolving it. */
function fixedLocation(
  directory: () => string,
  reaffirm: SessionLocationResolver["reaffirm"] = async () => undefined,
): SessionLocationResolver {
  const at = async () => ({ directory: directory(), venue });
  return { resolve: at, prepare: at, reaffirm };
}

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
  readonly id = "invariant-adapter";
  readonly durableIdNamespace = "invariant";
  readonly adapterVersion = "1.0.0";
  readonly runtime = { path: "/trusted/adapter", version: "1", fingerprint: "sha256:adapter" };
  attaches = 0;
  dispatches = 0;
  reconciles = 0;
  releases = 0;
  attachGate: Promise<void> | null = null;
  attachObservation: RuntimeObservation | null = null;
  reconcileReceipts: Awaited<ReturnType<BindingHandle["reconcile"]>>["receipts"] = [];
  dispatchReceipt: Awaited<ReturnType<BindingHandle["dispatch"]>> | null = null;
  sink: ObservationSink | null = null;
  specs: Parameters<NativeHarnessAdapter["attach"]>[0][] = [];

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

  emit(observation: RuntimeObservation): Promise<void> {
    if (!this.sink) throw new Error("not attached");
    return this.sink.emit(observation);
  }
}

function composition(
  input: {
    adapter?: Adapter;
    engine?: SessionEngine;
    directory?: () => string;
    reaffirm?: SessionLocationResolver["reaffirm"];
    runtimeIdPrefix?: string;
    onSubscriberFailure?: (error: unknown) => void | Promise<void>;
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
      executor: adapter,
      artifacts: createInMemoryTranscriptArtifactStore(),
      locations: fixedLocation(() => input.directory?.() ?? "/ticket/original", input.reaffirm),
      clock: { now: () => now++ },
      ids: runtimeIds(input.runtimeIdPrefix),
      ...(input.onSubscriberFailure ? { onSubscriberFailure: input.onSubscriberFailure } : {}),
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
    command: { kind: "adapter.attach", continuity: "fresh" },
  });
}

describe("SessionRuntime durable boundary invariants", () => {
  it("publishes an engine-level rejection receipt without an adapter binding", async () => {
    const { runtime } = composition();
    const created = await create(runtime);

    await expect(
      runtime.command({
        commandId: "release-missing",
        sessionId: created.sessionId,
        command: { kind: "adapter.release", attachmentId: "missing-attachment" },
      }),
    ).resolves.toMatchObject({ receipt: { status: "rejected" } });
  });

  it("does not evict an adapter binding until its native terminal fact is durable", async () => {
    const { runtime, adapter } = composition();
    const created = await create(runtime);
    await attach(runtime, created.sessionId);
    const attachmentId = (await runtime.snapshot({ sessionId: created.sessionId })).projection
      .liveExecutor!.id;

    await adapter.emit({
      kind: "attachment",
      state: "failed",
      failure: { reason: "unknown", message: "provider disconnected" },
    });

    expect(
      (await runtime.snapshot({ sessionId: created.sessionId })).projection.attachments,
    ).toMatchObject([{ id: attachmentId, status: "closed", outcome: "failed" }]);
    // The binding went with the attachment: a later operation on it fails
    // rather than quietly attaching a second one, and it fails saying why.
    // Raising the recovery Attention against the closed attachment is rejected
    // too, and that rejection must not stand in for this one.
    await expect(runtime.reconcile({ sessionId: created.sessionId, attachmentId })).rejects.toThrow(
      "is not open",
    );
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
      kind: "turn",
      state: "started",
      turnId: "turn-rehydrated",
      occurredAt: 20,
    };
    const recovered = composition({
      engine: first.engine,
      adapter: first.adapter,
      directory: () => directory,
      runtimeIdPrefix: "recovered-",
    });
    const left = recovered.runtime.reconcile({ sessionId: created.sessionId, attachmentId });
    const right = recovered.runtime.reconcile({ sessionId: created.sessionId, attachmentId });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(first.adapter.attaches).toBe(2);
    releaseAttach();
    await Promise.all([left, right]);

    expect(first.adapter.specs.at(-1)?.directory).toBe("/ticket/original");
    expect(first.adapter.specs.at(-1)?.continuity).toBe("native_resume");
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

  // A worktree deleted out from under an OPEN attachment, which is how it
  // happened: one binding spanned the deletion, `prepare` had run hours earlier
  // and nothing re-asked, and every prompt after that came back a second later
  // as the harness's own NotFound on a path that was no longer there.
  it("re-affirms a live binding's directory before a turn and refuses one it cannot put back", async () => {
    const affirmed: string[] = [];
    let gone: Error | null = null;
    const { runtime, adapter } = composition({
      directory: () => "/w/VC-3",
      reaffirm: async (_session, directory) => {
        affirmed.push(directory);
        if (gone) throw gone;
      },
    });
    const created = await create(runtime);
    await attach(runtime, created.sessionId);

    const prompt = (commandId: string) =>
      runtime.command({
        commandId,
        sessionId: created.sessionId,
        command: { kind: "message.submit", message: message(commandId) },
      });

    await expect(prompt("prompt-recreated")).resolves.toMatchObject({
      receipt: { status: "accepted" },
    });
    // The bound directory, not a fresh read of where the Session would go now.
    expect(affirmed).toEqual(["/w/VC-3"]);
    expect(adapter.dispatches).toBe(1);

    const detail = "The Session's directory /w/VC-3 is gone and couldn't be recreated.";
    gone = new Error(detail);
    await expect(prompt("prompt-refused")).resolves.toMatchObject({
      receipt: { status: "rejected", code: "location_unavailable", detail },
    });
    // Volli's sentence, and the harness was never handed the missing path.
    expect(adapter.dispatches).toBe(1);
    expect(affirmed).toEqual(["/w/VC-3", "/w/VC-3"]);
    expect((await runtime.snapshot({ sessionId: created.sessionId })).projection.receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commandId: "prompt-refused",
          status: "rejected",
          code: "location_unavailable",
          detail,
        }),
      ]),
    );

    // The terminal receipt closes the idempotency loop: replaying the same
    // intent neither asks the host again nor reaches the adapter.
    await expect(prompt("prompt-refused")).resolves.toMatchObject({
      receipt: { status: "rejected", code: "location_unavailable", detail },
    });
    expect(affirmed).toEqual(["/w/VC-3", "/w/VC-3"]);
    expect(adapter.dispatches).toBe(1);
  });

  it("re-affirms before resolving an interaction and keeps a refused one open", async () => {
    const detail = "The Session's directory /w/VC-4 is gone and couldn't be recreated.";
    let gone = false;
    const { runtime, adapter } = composition({
      directory: () => "/w/VC-4",
      reaffirm: async () => {
        if (gone) throw new Error(detail);
      },
    });
    const created = await create(runtime);
    await attach(runtime, created.sessionId);
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
    gone = true;

    await expect(
      runtime.command({
        commandId: "resolve-missing-location",
        sessionId: created.sessionId,
        command: {
          kind: "interaction.resolve",
          interactionId: "permission-1",
          resolution: { optionIds: ["allow"], response: null },
        },
      }),
    ).resolves.toMatchObject({
      receipt: { status: "rejected", code: "location_unavailable", detail },
    });
    expect(adapter.dispatches).toBe(0);
    expect(
      (await runtime.snapshot({ sessionId: created.sessionId })).projection.interactions.active,
    ).toEqual([expect.objectContaining({ id: "permission-1" })]);
  });

  it("names the Session, attachment and directory of every open native binding", async () => {
    const { runtime, adapter } = composition({ directory: () => "/w/VC-5" });
    expect(runtime.openNativeBindings()).toEqual([]);
    const created = await create(runtime);
    await attach(runtime, created.sessionId);
    const attachmentId = (await runtime.snapshot({ sessionId: created.sessionId })).projection
      .liveExecutor!.id;

    // The attachment id travels with the listing so a host that has to end this
    // binding — a worktree being deleted — can route `adapter.release` without
    // re-reading the projection to find it. Its progress stamp is deliberately
    // process-local: the watchdog must see streamed tokens without rewriting
    // the durable activity clock.
    const [binding] = runtime.openNativeBindings();
    expect(binding).toMatchObject({
      sessionId: created.sessionId,
      directory: "/w/VC-5",
      attachmentId,
      lastProgressAt: expect.any(Number),
    });
    const initialProgressAt = binding!.lastProgressAt;
    await adapter.emit({ kind: "delta", turnId: "turn-1", channel: "text", text: "still working" });
    expect(runtime.openNativeBindings()[0]!.lastProgressAt).toBeGreaterThan(initialProgressAt);

    await runtime.command({
      commandId: "release-live-directory",
      sessionId: created.sessionId,
      command: { kind: "adapter.release", attachmentId },
    });
    expect(runtime.openNativeBindings()).toEqual([]);
  });

  // The other half: a binding rebuilt from history — a replayed attach, or the
  // first command after a relaunch — never runs `prepare` at all.
  it("re-affirms the directory a rehydrated binding takes from its attachment", async () => {
    const first = composition({ directory: () => "/ticket/original" });
    const created = await create(first.runtime);
    await attach(first.runtime, created.sessionId);
    const attachmentId = (await first.runtime.snapshot({ sessionId: created.sessionId })).projection
      .liveExecutor!.id;
    await first.runtime.close();

    const rebuilt = new Adapter();
    const affirmed: string[] = [];
    const recovered = composition({
      engine: first.engine,
      adapter: rebuilt,
      directory: () => "/ticket/rerouted",
      reaffirm: async (_session, directory) => {
        affirmed.push(directory);
        throw new Error(`The Session's directory ${directory} is gone and couldn't be recreated.`);
      },
      runtimeIdPrefix: "recovered-",
    });

    await expect(
      recovered.runtime.reconcile({ sessionId: created.sessionId, attachmentId }),
    ).rejects.toThrow(
      "The Session's directory /ticket/original is gone and couldn't be recreated.",
    );
    expect(affirmed).toEqual(["/ticket/original"]);
    expect(rebuilt.attaches).toBe(0);
  });

  it("records a location rejection before a command can rehydrate a missing binding", async () => {
    const first = composition({ directory: () => "/ticket/original" });
    const created = await create(first.runtime);
    await attach(first.runtime, created.sessionId);
    await first.runtime.close();

    const rebuilt = new Adapter();
    const detail = "The Session's directory /ticket/original is gone and couldn't be recreated.";
    const recovered = composition({
      engine: first.engine,
      adapter: rebuilt,
      directory: () => "/ticket/rerouted",
      reaffirm: async () => {
        throw new Error(detail);
      },
      runtimeIdPrefix: "recovered-command-",
    });

    await expect(
      recovered.runtime.command({
        commandId: "message-after-relaunch",
        sessionId: created.sessionId,
        command: { kind: "message.submit", message: message("message-after-relaunch") },
      }),
    ).resolves.toMatchObject({
      receipt: { status: "rejected", code: "location_unavailable", detail },
    });
    expect(rebuilt.attaches).toBe(0);
    expect(rebuilt.dispatches).toBe(0);
  });

  it("does not re-affirm twice while a fresh command rehydrates its binding", async () => {
    const first = composition({ directory: () => "/ticket/original" });
    const created = await create(first.runtime);
    await attach(first.runtime, created.sessionId);
    await first.runtime.close();

    let affirmations = 0;
    const rebuilt = new Adapter();
    const recovered = composition({
      engine: first.engine,
      adapter: rebuilt,
      directory: () => "/ticket/rerouted",
      reaffirm: async () => {
        affirmations += 1;
        if (affirmations > 1) throw new Error("directory vanished between duplicate checks");
      },
      runtimeIdPrefix: "single-reaffirm-",
    });

    await expect(
      recovered.runtime.command({
        commandId: "message-rehydrates-once",
        sessionId: created.sessionId,
        command: { kind: "message.submit", message: message("message-rehydrates-once") },
      }),
    ).resolves.toMatchObject({ receipt: { status: "accepted" } });
    expect(affirmations).toBe(1);
    expect(rebuilt.attaches).toBe(1);
    expect(rebuilt.dispatches).toBe(1);
  });

  it("records cold interrupt and release location failures without touching an adapter", async () => {
    for (const [suffix, command] of [
      ["interrupt", { kind: "executor.interrupt" }],
      ["release", { kind: "adapter.release", attachmentId: "replace-after-attach" }],
    ] as const) {
      const first = composition({ directory: () => `/ticket/${suffix}` });
      const created = await create(first.runtime);
      await attach(first.runtime, created.sessionId);
      const attachmentId = (await first.runtime.snapshot({ sessionId: created.sessionId }))
        .projection.liveExecutor!.id;
      await first.runtime.close();

      let affirmations = 0;
      const rebuilt = new Adapter();
      const detail = `The Session's directory /ticket/${suffix} is unavailable.`;
      const recovered = composition({
        engine: first.engine,
        adapter: rebuilt,
        reaffirm: async () => {
          affirmations += 1;
          throw new Error(detail);
        },
        runtimeIdPrefix: `cold-${suffix}-`,
      });
      const routedCommand =
        command.kind === "adapter.release" ? { ...command, attachmentId } : command;
      const request = {
        commandId: `cold-${suffix}`,
        sessionId: created.sessionId,
        command: routedCommand,
      } as const;

      await expect(recovered.runtime.command(request)).resolves.toMatchObject({
        receipt: { status: "rejected", code: "location_unavailable", detail },
      });
      await expect(recovered.runtime.command(request)).resolves.toMatchObject({
        receipt: { status: "rejected", code: "location_unavailable", detail },
      });
      expect(affirmations).toBe(1);
      expect(rebuilt.attaches).toBe(0);
      expect(rebuilt.dispatches).toBe(0);
      expect(rebuilt.releases).toBe(0);
    }
  });

  it("rehydrates cold interrupt and release commands after one successful affirmation", async () => {
    for (const [suffix, command] of [
      ["interrupt", { kind: "executor.interrupt" }],
      ["release", { kind: "adapter.release", attachmentId: "replace-after-attach" }],
    ] as const) {
      const first = composition({ directory: () => `/ticket/${suffix}` });
      const created = await create(first.runtime);
      await attach(first.runtime, created.sessionId);
      const attachmentId = (await first.runtime.snapshot({ sessionId: created.sessionId }))
        .projection.liveExecutor!.id;
      await first.runtime.close();

      let affirmations = 0;
      const rebuilt = new Adapter();
      const recovered = composition({
        engine: first.engine,
        adapter: rebuilt,
        reaffirm: async () => {
          affirmations += 1;
        },
        runtimeIdPrefix: `cold-${suffix}-accepted-`,
      });
      const routedCommand =
        command.kind === "adapter.release" ? { ...command, attachmentId } : command;

      await expect(
        recovered.runtime.command({
          commandId: `cold-${suffix}-accepted`,
          sessionId: created.sessionId,
          command: routedCommand,
        }),
      ).resolves.toMatchObject({ receipt: { status: "accepted" } });
      expect(affirmations).toBe(1);
      expect(rebuilt.attaches).toBe(1);
      expect(rebuilt.dispatches).toBe(command.kind === "executor.interrupt" ? 1 : 0);
      expect(rebuilt.releases).toBe(command.kind === "adapter.release" ? 1 : 0);
    }
  });

  it("rejects legacy bindings at the resolved location before looking up a missing adapter", async () => {
    const detail = "The resolved Session directory is unavailable.";
    const { runtime, engine } = composition({
      directory: () => "/ticket/resolved",
      reaffirm: async (_session, directory) => {
        expect(directory).toBe("/ticket/resolved");
        throw new Error(detail);
      },
    });
    const created = await create(runtime);
    await engine.observe({
      id: "legacy-binding-opened",
      sessionId: created.sessionId,
      occurredAt: 80,
      provenance: { source: { kind: "adapter", id: "missing-adapter", detail: null }, venue },
      kind: "attachment.opened",
      attachment: {
        id: "legacy-binding",
        sessionId: created.sessionId,
        adapterId: "missing-adapter",
        venue,
        continuity: "native_resume",
        native: {
          id: "legacy-native",
          detail: {
            kind: "volli.native-binding.v1",
            profileId: "native",
            locator: null,
          },
        },
        authority: null,
      },
    });

    await expect(
      runtime.command({
        commandId: "message-to-legacy-binding",
        sessionId: created.sessionId,
        command: { kind: "message.submit", message: message("message-to-legacy-binding") },
      }),
    ).resolves.toMatchObject({
      receipt: { status: "rejected", code: "location_unavailable", detail },
    });
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

  it("keeps distinct unreconciled reconciliation details as distinct durable receipts", async () => {
    const { runtime, adapter } = composition();
    const created = await create(runtime);
    await attach(runtime, created.sessionId);
    const attachmentId = (await runtime.snapshot({ sessionId: created.sessionId })).projection
      .liveExecutor!.id;
    adapter.dispatchReceipt = {
      commandId: "message-ambiguous",
      status: "unknown",
      detail: "first transport outcome",
      native: null,
    };
    await runtime.command({
      commandId: "message-ambiguous",
      sessionId: created.sessionId,
      command: { kind: "message.submit", message: message("ambiguous") },
    });
    adapter.reconcileReceipts = [
      {
        commandId: "message-ambiguous",
        status: "unknown",
        detail: "second transport outcome",
        native: null,
      },
    ];

    await runtime.reconcile({ sessionId: created.sessionId, attachmentId });

    const receipts = (
      await runtime.snapshot({ sessionId: created.sessionId })
    ).projection.receipts.filter(({ commandId }) => commandId === "message-ambiguous");
    expect(receipts).toHaveLength(2);
    expect(receipts.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("first%20transport%20outcome"),
        expect.stringContaining("second%20transport%20outcome"),
      ]),
    );
  });

  it("keeps nullable native receipt details deterministic", async () => {
    const { runtime, adapter } = composition();
    const created = await create(runtime);
    await attach(runtime, created.sessionId);
    adapter.dispatchReceipt = {
      commandId: "message-rejected-null",
      status: "rejected",
      code: "PROVIDER_REJECTED",
      detail: null,
      native: null,
    };
    await expect(
      runtime.command({
        commandId: "message-rejected-null",
        sessionId: created.sessionId,
        command: { kind: "message.submit", message: message("rejected-null") },
      }),
    ).resolves.toMatchObject({ receipt: { id: expect.stringContaining("PROVIDER_REJECTED:") } });

    adapter.dispatchReceipt = {
      commandId: "message-unknown-null",
      status: "unknown",
      detail: null,
      native: null,
    };
    await expect(
      runtime.command({
        commandId: "message-unknown-null",
        sessionId: created.sessionId,
        command: { kind: "message.submit", message: message("unknown-null") },
      }),
    ).resolves.toMatchObject({ receipt: { id: expect.stringContaining("unreconciled:") } });
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
        authority: null,
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

  it("contains poisoned stream subscribers", async () => {
    const failures: unknown[] = [];
    const { runtime, adapter } = composition({
      onSubscriberFailure: (error) => {
        failures.push(error);
      },
    });
    const created = await create(runtime);
    await attach(runtime, created.sessionId);
    await runtime.subscribe({ sessionId: created.sessionId, afterSequence: 0 }, () => {
      throw new Error("client frame failed");
    });

    await expect(
      adapter.emit({ kind: "turn", state: "started", turnId: "turn", occurredAt: 30 }),
    ).resolves.toBeUndefined();
    expect(failures).toEqual([expect.objectContaining({ message: "client frame failed" })]);
  });

  // 500 sequential `observe` calls, and each one lists and folds the whole log
  // it is appending to (`SessionEngine.observe`), so the setup alone is
  // quadratic in the history it builds. That is a real cost in the engine, not
  // in this case — the case just happens to be the one that pays enough of it
  // to notice. It lands near the 5s default without coverage and past it with
  // `test:coverage` on a loaded machine, which is the run CI makes, so the
  // budget is stated rather than left to chance. Fixing `observe` to fold
  // incrementally is what makes this number shrink again.
  it("reads long event histories through bounded engine pages", { timeout: 20_000 }, async () => {
    const { runtime, adapter } = composition();
    const created = await create(runtime);
    await attach(runtime, created.sessionId);
    for (let index = 0; index <= 500; index += 1) {
      await adapter.emit({
        kind: "turn",
        state: "started",
        turnId: `turn-${index}`,
        occurredAt: 1_000 + index,
      });
    }

    const snapshot = await runtime.snapshot({ sessionId: created.sessionId });
    expect(snapshot.frames.length).toBeGreaterThan(500);
    await expect(
      runtime.command({
        commandId: "paged-interrupt",
        sessionId: created.sessionId,
        command: { kind: "executor.interrupt" },
      }),
    ).resolves.toMatchObject({ throughSequence: expect.any(Number) });
  });

  it("keeps ambiguous replayed deliveries unreconciled across every native command route", async () => {
    const first = composition();
    const created = await create(first.runtime);
    await attach(first.runtime, created.sessionId);
    const attachmentId = (await first.runtime.snapshot({ sessionId: created.sessionId })).projection
      .liveExecutor!.id;
    await first.adapter.emit({
      kind: "interaction",
      state: "opened",
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
    const attachFailure = new Error("native resume refused");
    const originalAttach = first.adapter.attach.bind(first.adapter);
    first.adapter.attach = async () => {
      throw attachFailure;
    };
    const recovering = composition({ engine: first.engine, adapter: first.adapter });
    await expect(
      recovering.runtime.reconcile({ sessionId: created.sessionId, attachmentId }),
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
        authority: null,
      },
    });
    await expect(
      missing.runtime.reconcile({
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
    await runtime.subscribe({ sessionId: created.sessionId, afterSequence: 0 }, (emission) => {
      if (!isSessionStreamFrame(emission)) return;
      received.push(emission.event.payload.kind);
    });
    failPeer = true;
    await adapter.emit({ kind: "turn", state: "started", turnId: "turn", occurredAt: 90 });
    await adapter.emit({ kind: "attachment", state: "closed" });

    expect(received).toContain("attachment.closed");
    expect(
      (await runtime.snapshot({ sessionId: created.sessionId })).projection.attachments,
    ).toMatchObject([{ id: attachmentId, status: "closed", outcome: "completed" }]);
  });

  it("records replayed attach recovery failures", async () => {
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
        authority: null,
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
        authority: null,
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
