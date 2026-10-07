// The host-owned follow-up queue (VC-675) through the production WebSocket
// listener and the real Session runtime: a queued row and its revision must
// survive every VC-669 network output schema, end to end over loopback.
import {
  getUntypedClient,
  createTRPCClient,
  createWSClient,
  wsLink,
  type TRPCClient,
} from "@trpc/client";
import {
  buildHostHello,
  encodeHostHello,
  HOST_V1_FEATURES,
  type HostActor,
  type HostHelloInput,
} from "@volli/host-protocol";
import { expectHostError, ipcContractLink, recordSubscription } from "@volli/host-protocol/testing";
import {
  createInMemorySessionFollowUpLedger,
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
  createSessionEngine,
  createSessionRuntime,
} from "@volli/session-engine";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  createSessionRouter,
  sessionProcedureSchemas,
  RpcDiagnosticLog,
  type AppRouter,
} from "./index";
import {
  legacyStreamEmissionSchema,
  sessionProjectionOutputSchema,
  sessionSnapshotOutputSchema,
  streamEmissionSchema,
} from "./output-schema";
import { sessionHandlersFrom } from "./session-handlers.test-support";
import { startHostProtocolListener } from "./websocket-server";

import {
  captureCanaryRecording,
  checkNextHost,
  loadCanaryPeer,
  recordingExchanges,
  replayCanaryPeer,
  peerInput,
  type PeerExchange,
} from "./canary-peer.test-support";
const canary = process.env.VOLLI_CANARY_CAPTURE_DIR ? null : loadCanaryPeer();

/** What the Session router alone serves: every v1 feature but the board's (VC-565). */
const SESSION_ROUTER_FEATURES = HOST_V1_FEATURES.filter(
  (feature) =>
    !feature.startsWith("board.") &&
    feature !== "host.workspaces" &&
    feature !== "host.model-defaults",
);
const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const HOST = "b7c1d2e3-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const DEVICE = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const message = (text: string) => ({
  id: "queued",
  role: "user" as const,
  metadata: { draft: [text, null] },
  parts: [{ type: "text" as const, text }],
});

/** A real runtime whose open attention holds the queue, so a submitted follow-up stays queued. */
async function heldRuntime() {
  let tick = 0;
  const clock = { now: () => ++tick };
  const ids = { next: (kind: string) => `${kind}-${++tick}` };
  const engine = createSessionEngine({ ledger: createInMemorySessionLedger(), clock, ids });
  const runtime = createSessionRuntime({
    engine,
    clock,
    ids,
    artifacts: createInMemoryTranscriptArtifactStore(),
    followUps: createInMemorySessionFollowUpLedger(),
    executor: {
      id: "test",
      durableIdNamespace: "test",
      adapterVersion: "1",
      runtime: { path: "/test", version: "1", fingerprint: "test" },
      attach: async () => {
        throw new Error("Attention must hold this queue");
      },
    },
    locations: {
      resolve: async () => ({ directory: "/test", venue: { id: "local", kind: "local" } }),
      prepare: async () => ({ directory: "/test", venue: { id: "local", kind: "local" } }),
      reaffirm: async () => undefined,
    },
  });
  cleanups.push(() => runtime.close());
  const { sessionId } = await runtime.command({
    commandId: "create",
    command: {
      kind: "session.create",
      projectId: WORKSPACE,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: null,
    },
  });
  await engine.observe({
    id: "hold",
    sessionId,
    occurredAt: clock.now(),
    provenance: { source: { kind: "system", id: "test", detail: null }, venue: null },
    kind: "attention.raised",
    attention: {
      id: "hold",
      kind: "permission_required",
      attachmentId: null,
      detail: "Hold queue",
      diagnostic: null,
    },
  });
  return { runtime, sessionId };
}

async function serve() {
  const { runtime, sessionId } = await heldRuntime();
  const actor: HostActor = { kind: "device", deviceId: DEVICE, workspaceId: WORKSPACE };
  const listener = await startHostProtocolListener({
    router: createSessionRouter(),
    bind: { host: "127.0.0.1", port: 0 },
    host: { id: HOST, version: "test" },
    features: SESSION_ROUTER_FEATURES,
    workspace: async (id) => (id === WORKSPACE ? { id, epoch: 2 } : null),
    verifier: {
      verify: ({ credential }) =>
        credential === "device-token" ? { actor, current: () => true } : null,
    },
    context: () => ({
      handlers: sessionHandlersFrom({ runtime }),
      diagnostics: new RpcDiagnosticLog(),
      resourceWorkspace: ({ id }) => (id === sessionId ? WORKSPACE : null),
    }),
    limits: {},
    log: () => {},
  });
  cleanups.push(() => listener.close());
  return { listener, runtime, sessionId };
}

const HELLO: HostHelloInput = {
  client: { kind: "cli", version: "test" },
  workspaceId: WORKSPACE,
  credential: "device-token",
  features: ["sessions", "sessions.queue", "sessions.subscribe", "sessions.history"],
  lastSeen: null,
};

function connect(url: string): TRPCClient<AppRouter> {
  const socket = createWSClient({
    url,
    connectionParams: () => encodeHostHello(buildHostHello(HELLO)),
    retryDelayMs: () => 20,
  });
  cleanups.push(() => socket.close());
  return createTRPCClient<AppRouter>({ links: [wsLink({ client: socket })] });
}

type Emission = { id: string; data: unknown };
const isQueue = (data: unknown): data is { kind: "queue"; revision: number; queue: unknown[] } =>
  typeof data === "object" && data !== null && (data as { kind?: unknown }).kind === "queue";

describe("the host follow-up queue over the production WebSocket listener", () => {
  it("keeps a queued row and its revision through snapshot, projection and the queue stream", async () => {
    const { listener, sessionId } = await serve();
    const client = connect(listener.url);
    const exchanges: PeerExchange[] = [];
    const queueStream = recordSubscription<Emission>((handlers) =>
      client.session.subscribeQueue.subscribe({ sessionId }, handlers),
    );
    const legacyStream = recordSubscription<Emission>((handlers) =>
      client.session.subscribe.subscribe({ sessionId }, handlers),
    );
    await Promise.all([queueStream.started, legacyStream.started]);

    const submitInput = peerInput(canary, "queue-websocket", "session.command", {
      commandId: "submit-queued",
      sessionId,
      command: {
        kind: "message.submit" as const,
        delivery: "queue" as const,
        message: message("original"),
      },
    });
    const submitted = await client.session.command.mutate(submitInput);
    expect(submitted.receipt?.status).toBe("accepted");
    exchanges.push({
      procedure: "session.command",
      input: submitInput,
      output: submitted,
    });

    const readInput = peerInput(canary, "queue-websocket", "session.projection", { sessionId });
    const read = await client.session.projection.query(readInput);
    exchanges.push({ procedure: "session.projection", input: { sessionId }, output: read });
    const revision = read.projection.queueRevision!;
    expect(Number.isSafeInteger(revision) && revision >= 0).toBe(true);
    const row = {
      id: "queued",
      commandId: "submit-queued",
      state: "queued",
      message: message("original"),
    };
    expect(read.projection.queue).toEqual([row]);
    expect(sessionProjectionOutputSchema.parse(read)).toEqual(read);

    const snapshot = await client.session.snapshot.query({ sessionId });
    exchanges.push({ procedure: "session.snapshot", input: { sessionId }, output: snapshot });
    const historyInput = peerInput(canary, "queue-websocket", "session.history", {
      sessionId,
      before: snapshot.throughSequence + 1,
    });
    exchanges.push({
      procedure: "session.history",
      input: historyInput,
      output: await client.session.history.query(historyInput),
    });
    expect(snapshot.projection).toMatchObject({ queue: [row], queueRevision: revision });
    expect(sessionSnapshotOutputSchema.parse(snapshot)).toEqual(snapshot);

    // The queue-aware stream receives the change as one whole-queue emission.
    await until(
      () => queueStream.frames.some(({ data }) => isQueue(data) && data.revision === revision),
      "the queue emission",
    );
    const emission = queueStream.frames.map(({ data }) => data).findLast(isQueue)!;
    expect(emission).toEqual({
      kind: "queue",
      sessionId,
      throughSequence: read.throughSequence,
      revision,
      queue: [row],
    });
    exchanges.push({
      procedure: "session.subscribeQueue",
      input: { sessionId },
      frames: [queueStream.frames.find(({ data }) => isQueue(data) && data.revision === revision)!],
    });
    for (const { data } of queueStream.frames)
      expect(streamEmissionSchema.parse(data)).toEqual(data);
    // The frozen VC-669 stream never carries an arm its published union lacks.
    for (const { data } of legacyStream.frames) {
      expect(isQueue(data)).toBe(false);
      expect(legacyStreamEmissionSchema.safeParse(data).success).toBe(true);
    }

    // A stale revision through the network's queue operations is a typed
    // conflict, and leaves the row and its revision exactly as they were.
    const stale = revision + 1;
    for (const [procedure, input] of [
      [
        "session.cancelQueued",
        { commandId: "stale-cancel", sessionId, messageId: "queued", expectedRevision: stale },
      ],
      [
        "session.editQueued",
        {
          commandId: "stale-edit",
          sessionId,
          messageId: "queued",
          message: message("stale"),
          expectedRevision: stale,
        },
      ],
    ] as const) {
      const recordedInput = peerInput(canary, "queue-websocket", procedure, input);
      const error = await expectHostError(
        getUntypedClient(client).mutation(procedure, recordedInput),
      );
      expect(error).toMatchObject({ code: "CONFLICT", reason: "queue-revision-conflict" });
      exchanges.push({ procedure, input: recordedInput, error });
    }
    const after = await client.session.projection.query({ sessionId });
    expect(after.projection).toMatchObject({ queue: [row], queueRevision: revision });

    // The current revision is accepted, and its new queue reaches the stream.
    const editInput = peerInput(
      canary,
      "queue-websocket",
      "session.editQueued",
      {
        commandId: "edit",
        sessionId,
        messageId: "queued",
        message: message("edited"),
        expectedRevision: revision,
      },
      1,
    );
    const edited = await client.session.editQueued.mutate(editInput);
    expect(edited.receipt?.status).toBe("accepted");
    exchanges.push({
      procedure: "session.editQueued",
      input: editInput,
      output: edited,
    });
    await until(
      () => queueStream.frames.some(({ data }) => isQueue(data) && data.revision === revision + 1),
      "the edited queue emission",
    );
    expect(queueStream.frames.map(({ data }) => data).findLast(isQueue)).toMatchObject({
      revision: revision + 1,
      queue: [{ ...row, message: message("edited") }],
    });
    expect(legacyStream.frames.some(({ data }) => isQueue(data))).toBe(false);
    queueStream.unsubscribe();
    legacyStream.unsubscribe();
    captureCanaryRecording(
      "queue-websocket",
      "websocket",
      exchanges,
      recordingExchanges(exchanges),
    );
    if (canary) {
      checkNextHost(canary, "queue-websocket", exchanges);
      await replayCanaryPeer(canary, "queue-websocket", sessionProcedureSchemas());
    }
  });
});

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

it("records the real runtime's queue mutation/retry/conflict and history through IPC in both skew directions", async () => {
  const { runtime, sessionId } = await heldRuntime();
  const connection = await ipcContractLink({
    router: createSessionRouter(),
    createContext: () => ({
      caller: {
        actor: { kind: "device" as const, deviceId: DEVICE, workspaceId: WORKSPACE },
        current: () => true,
      },
      handlers: sessionHandlersFrom({ runtime }),
      diagnostics: new RpcDiagnosticLog(),
      resourceWorkspace: ({ id }) => (id === sessionId ? WORKSPACE : null),
      transport: "electron-ipc" as const,
    }),
  }).open(null);
  const raw = getUntypedClient(connection.client);
  const exchanges: PeerExchange[] = [];
  const submit = {
    commandId: "submit-queued",
    sessionId,
    command: { kind: "message.submit", delivery: "queue", message: message("original") },
  };
  const mutate = async (procedure: string, fallback: unknown, occurrence = 0) => {
    const input = peerInput(canary, "queue-ipc", procedure, fallback, occurrence);
    const output = await raw.mutation(procedure, input);
    exchanges.push({ procedure, input, output });
    return output;
  };
  try {
    await mutate("session.command", submit);
    await mutate("session.command", submit, 1);
    const read = await connection.client.session.projection.query({ sessionId });
    exchanges.push({ procedure: "session.projection", input: { sessionId }, output: read });
    expect(read.projection.queue).toHaveLength(1);
    const revision = read.projection.queueRevision!;
    const edit = {
      commandId: "edit",
      sessionId,
      messageId: "queued",
      message: message("edited"),
      expectedRevision: revision,
    };
    await mutate("session.editQueued", edit);
    const stale = {
      commandId: "stale-cancel",
      sessionId,
      messageId: "queued",
      expectedRevision: revision,
    };
    const staleInput = peerInput(canary, "queue-ipc", "session.cancelQueued", stale);
    const error = await expectHostError(raw.mutation("session.cancelQueued", staleInput));
    expect(error).toMatchObject({ reason: "queue-revision-conflict" });
    exchanges.push({ procedure: "session.cancelQueued", input: staleInput, error });
    await mutate(
      "session.cancelQueued",
      {
        commandId: "cancel",
        sessionId,
        messageId: "queued",
        expectedRevision: revision + 1,
      },
      1,
    );
    const snapshot = await connection.client.session.snapshot.query({ sessionId });
    exchanges.push({ procedure: "session.snapshot", input: { sessionId }, output: snapshot });
    expect(snapshot.projection.queue).toEqual([]);
    const history = { sessionId, before: snapshot.throughSequence + 1 };
    exchanges.push({
      procedure: "session.history",
      input: history,
      output: await connection.client.session.history.query(history),
    });
  } finally {
    await connection.close();
  }
  captureCanaryRecording("queue-ipc", "ipc", exchanges, recordingExchanges(exchanges));
  if (canary) {
    checkNextHost(canary, "queue-ipc", exchanges);
    await replayCanaryPeer(canary, "queue-ipc", sessionProcedureSchemas());
  }
});
