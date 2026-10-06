// @vitest-environment node
import { expect, it, vi } from "vite-plus/test";
import {
  describeContract,
  expectHostError,
  recordSubscription,
} from "@volli/host-protocol/testing";
import type { HostError } from "@volli/host-protocol";
import { createSessionRouter, RpcDiagnosticLog, type RouterCaller } from "@volli/session-rpc";
import { sessionContext } from "@volli/session-rpc/testing";
import {
  SessionRuntimeCommandConflictError,
  type SessionRuntime,
  type SessionStreamFrame,
} from "@volli/session-engine";
import { createSessionProjectionCheckpoint, EMPTY_MODEL_ACCESS_DEFAULTS } from "@volli/shared";
import {
  fakeElectron,
  sessionRouterContractLinks,
  type SessionRouterHost,
} from "./session-rpc-contract.test-support";

vi.mock("electron", () => fakeElectron);
// Production IPC is always the desktop's own window; the harness judges its
// own caller over the same bridge through a test-only router context.
vi.mock("@volli/session-rpc", async (importOriginal) => {
  const { withHarnessIdentity } = await import("./session-rpc-harness-identity.test-support");
  return withHarnessIdentity(await importOriginal());
});

const selection = { providerId: "test", modelId: "model", reasoningLevel: "high" as const };
const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const OTHER_WORKSPACE = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
/** A paired device bound to the fixture's Workspace: what part B's handshake will mint. */
const device: RouterCaller = {
  actor: {
    kind: "device",
    deviceId: "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b",
    workspaceId: WORKSPACE,
  },
  current: () => true,
};
/** Which Workspace owns each Session the host knows; any other id is absent. */
const OWNERS: Readonly<Record<string, string>> = {
  "session-1": WORKSPACE,
  "foreign-session": OTHER_WORKSPACE,
};
const session = {
  id: "session-1",
  projectId: WORKSPACE,
  ticketId: null,
  role: "project" as const,
  parentSessionId: null,
  title: null,
  createdAt: 10,
};
function frame(sequence: number): SessionStreamFrame {
  return {
    sessionId: session.id,
    sequence,
    transcript: null,
    event: {
      id: `event-${sequence}`,
      sessionId: session.id,
      sequence,
      occurredAt: 10,
      recordedAt: 10,
      provenance: { source: { kind: "system", id: "test", detail: null }, venue: null },
      payload: { kind: "session.created", session },
    },
  };
}
function fixture() {
  let emit!: (value: SessionStreamFrame) => void | Promise<void>;
  let fail!: (error: unknown) => void;
  const cursors: number[] = [];
  const snapshot = {
    projection: createSessionProjectionCheckpoint(session, []).projection,
    throughSequence: 4,
    frames: [frame(4)],
    before: 4,
    transcript: [],
    latestReply: null,
  };
  const receipt = {
    id: "receipt-1",
    commandId: "command-1",
    status: "accepted" as const,
    acceptedAt: 10,
    result: { kind: "model.selected" as const, sessionId: session.id },
    recordedAt: 10,
    sequence: 5,
  };
  // Idempotent by command id, as the engine is: the same intent answers the
  // durable result again, and another intent under that id is a conflict.
  const accepted = new Map<string, string>();
  const reads: string[] = [];
  const runtime: SessionRuntime = {
    snapshot: async () => {
      reads.push("snapshot");
      return snapshot;
    },
    history: async ({ before }) => {
      reads.push("history");
      return { frames: [frame(before - 1)], before: before > 2 ? before - 1 : null };
    },
    projection: async () => {
      reads.push("projection");
      return { projection: snapshot.projection, throughSequence: 4 };
    },
    command: async (request) => {
      reads.push("command");
      const intent = JSON.stringify(request.command);
      const prior = accepted.get(request.commandId);
      if (prior !== undefined && prior !== intent) {
        throw new SessionRuntimeCommandConflictError(
          `Command ${request.commandId} was already accepted with different intent`,
        );
      }
      accepted.set(request.commandId, intent);
      return {
        sessionId: session.id,
        command: {
          id: request.commandId,
          sessionId: session.id,
          createdAt: 10,
          route: null,
          intent: { kind: "model.select", selection },
        },
        receipt,
        throughSequence: 5,
        refusal: null,
      };
    },
    subscribe: async ({ afterSequence }, next, onFailure) => {
      reads.push("subscribe");
      cursors.push(afterSequence);
      emit = next;
      fail = onFailure!;
      return () => {};
    },
    cancelInteraction: async () => {},
    reconcile: async () => {},
    close: async () => {},
  };
  const host = {
    caller: device,
    resourceWorkspace: ({ id }: { id: string }) => OWNERS[id] ?? null,
    runtime,
    diagnostics: new RpcDiagnosticLog(),
  } satisfies SessionRouterHost;
  return {
    host,
    receipt,
    cursors,
    reads,
    emit: (value: SessionStreamFrame) => emit(value),
    fail: (error: unknown) => fail(error),
  };
}

describeContract("Session router", sessionRouterContractLinks(), ({ connect }) => {
  it("preserves projection and snapshot exactly as the direct caller answers", async () => {
    const { host } = fixture();
    const caller = createSessionRouter().createCaller(sessionContext(host));
    const client = await connect(host);
    const input = { sessionId: session.id };
    expect(await client.session.projection.query(input)).toStrictEqual(
      await caller.session.projection(input),
    );
    expect(await client.session.snapshot.query(input)).toStrictEqual(
      await caller.session.snapshot(input),
    );
    // The paged history behind the snapshot's tail (VC-315), cursor and all.
    for (const before of [4, 2]) {
      expect(await client.session.history.query({ ...input, before })).toStrictEqual(
        await caller.session.history({ ...input, before }),
      );
    }
    expect(await client.session.history.query({ ...input, before: 2 })).toMatchObject({
      frames: [{ sequence: 1 }],
      before: null,
    });
  });

  it("routes a modelAccess facade and reports an absent facade", async () => {
    const { host } = fixture();
    const client = await connect({
      ...host,
      readModelAccessDefaults: () => EMPTY_MODEL_ACCESS_DEFAULTS,
    });
    expect(await client.modelAccess.defaults.query()).toStrictEqual(EMPTY_MODEL_ACCESS_DEFAULTS);
    expect(await expectHostError(client.modelAccess.inspect.query({}))).toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
  });

  it("passes command receipts through without changing acceptance into completion", async () => {
    const { host, receipt } = fixture();
    const client = await connect(host);
    const result = await client.session.command.mutate({
      sessionId: session.id,
      commandId: "command-1",
      command: { kind: "model.select", selection },
    });
    expect(result.receipt).toStrictEqual(receipt);
    expect(result.throughSequence).toBe(5);
  });

  it("reports invalid inputs as BAD_REQUEST", async () => {
    const client = await connect(fixture().host);
    expect(await expectHostError(client.session.snapshot.query({ sessionId: " " }))).toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("carries tracked ids and resumes from the greatest supplied cursor", async () => {
    const f = fixture();
    const client = await connect(f.host);
    const stream = recordSubscription<{ id: string; data: unknown }>((handlers) =>
      client.session.subscribe.subscribe({ sessionId: session.id }, handlers),
    );
    await stream.started;
    f.emit(frame(5));
    expect((await stream.received(1))[0]).toMatchObject({ id: "5", data: { sequence: 5 } });
    stream.unsubscribe();
    const resumed = recordSubscription<{ id: string; data: unknown }>((handlers) =>
      client.session.subscribe.subscribe(
        { sessionId: session.id, afterSequence: 2, lastEventId: "5" },
        handlers,
      ),
    );
    await resumed.started;
    expect(f.cursors).toStrictEqual([0, 5]);
    f.emit(frame(6));
    expect((await resumed.received(1))[0]?.id).toBe("6");
    resumed.unsubscribe();
  });

  it("ends queue overflow with TOO_MANY_REQUESTS, never clean completion", async () => {
    const f = fixture();
    const client = await connect(f.host);
    const stream = recordSubscription((handlers) =>
      client.session.subscribe.subscribe({ sessionId: session.id }, handlers),
    );
    await stream.started;
    for (let sequence = 1; sequence <= 4098; sequence++) f.emit(frame(sequence));
    expect(await stream.ended).toMatchObject({
      kind: "error",
      error: { code: "TOO_MANY_REQUESTS" },
    });
    expect(stream.frames.length).toBeGreaterThan(0);
  });

  it("ends a source failure with INTERNAL_SERVER_ERROR, never clean completion", async () => {
    const f = fixture();
    const client = await connect(f.host);
    const stream = recordSubscription((handlers) =>
      client.session.subscribe.subscribe({ sessionId: session.id }, handlers),
    );
    await stream.started;
    f.fail(new Error("source drain died"));
    expect(await stream.ended).toMatchObject({
      kind: "error",
      error: { code: "INTERNAL_SERVER_ERROR" },
    });
  });

  // VC-564 (a): a guessed id in another Workspace must reveal nothing that an
  // id nobody holds would not, on every operation kind, before any read.
  it("answers a Session in another Workspace exactly as an absent one", async () => {
    const f = fixture();
    const client = await connect(f.host);
    const refusals = async (sessionId: string): Promise<HostError[]> => {
      const stream = recordSubscription((handlers) =>
        client.session.subscribe.subscribe({ sessionId }, handlers),
      );
      return [
        await expectHostError(client.session.projection.query({ sessionId })),
        await expectHostError(
          client.session.command.mutate({
            sessionId,
            commandId: "command-1",
            command: { kind: "model.select", selection },
          }),
        ),
        await stream.ended.then((end) => (end.kind === "error" ? end.error : null)),
      ].filter((error): error is HostError => error !== null);
    };
    const foreign = await refusals("foreign-session");
    expect(foreign).toHaveLength(3);
    for (const error of foreign) {
      expect(error).toStrictEqual({
        code: "NOT_FOUND",
        message: "Not found in this Workspace.",
        reason: "workspace-unknown",
      });
    }
    expect(await refusals("no-such-session")).toStrictEqual(foreign);
    expect(f.reads).toStrictEqual([]);
  });

  // VC-564 (b): a Session may not read another's transcript through a door
  // that skips `session.peek`'s disclosure policy; every entry is the person's.
  it("refuses a caller the entry's policy does not admit", async () => {
    const f = fixture();
    const agent: RouterCaller = {
      actor: { kind: "session", sessionId: "agent-session", workspaceId: WORKSPACE },
      current: () => true,
    };
    const client = await connect({ ...f.host, caller: agent });
    expect(
      await expectHostError(client.session.projection.query({ sessionId: session.id })),
    ).toStrictEqual({
      code: "FORBIDDEN",
      message: "session.projection is not open to this caller.",
      reason: "verb-refused",
    });
    expect(f.reads).toStrictEqual([]);
  });

  // VC-564 (c): the start guard was keyed on the Electron transport, so the
  // WebSocket link passed a raw create straight to the runtime.
  it("refuses session.command's start kinds on every link", async () => {
    const f = fixture();
    const client = await connect(f.host);
    const refused = await expectHostError(
      client.session.command.mutate({
        commandId: "forged-create",
        command: {
          kind: "session.create",
          projectId: WORKSPACE,
          ticketId: null,
          role: "project",
          parentSessionId: null,
          title: null,
        },
      }),
    );
    expect(refused).toMatchObject({ code: "FORBIDDEN", reason: "verb-refused" });
    expect(
      await expectHostError(
        client.session.command.mutate({
          commandId: "forged-attach",
          sessionId: session.id,
          command: { kind: "adapter.attach", continuity: "fresh" },
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN", reason: "verb-refused" });
    expect(f.reads).toStrictEqual([]);
  });

  // VC-564 (d): retries reuse the key; only a different intent under it is refused.
  it("replays the same command id and intent, and refuses another intent under it", async () => {
    const f = fixture();
    const client = await connect(f.host);
    const request = {
      sessionId: session.id,
      commandId: "command-1",
      command: { kind: "model.select" as const, selection },
    };
    const first = await client.session.command.mutate(request);
    expect(await client.session.command.mutate(request)).toStrictEqual(first);
    expect(
      await expectHostError(
        client.session.command.mutate({
          ...request,
          command: { kind: "model.select", selection: { ...selection, reasoningLevel: "low" } },
        }),
      ),
    ).toStrictEqual({
      code: "CONFLICT",
      message: "Command command-1 was already accepted with different intent",
      reason: "command-conflict",
    });
  });
});

// VC-564 (e): the same refusal reads as the same envelope, reason included,
// whichever link carried it.
it("carries an identical host error on the IPC and WebSocket links", async () => {
  const seen: HostError[] = [];
  for (const link of sessionRouterContractLinks()) {
    const connection = await link.open(fixture().host);
    try {
      seen.push(
        await expectHostError(
          connection.client.session.projection.query({ sessionId: "foreign-session" }),
        ),
        await expectHostError(connection.client.modelAccess.inspect.query({})),
      );
    } finally {
      await connection.close();
    }
  }
  expect(seen).toHaveLength(4);
  expect(seen.slice(2)).toStrictEqual(seen.slice(0, 2));
  expect(seen[0]?.reason).toBe("workspace-unknown");
  expect(seen[1]?.reason).toBe("operation-unavailable");
});
