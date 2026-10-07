/* oxlint-disable typescript/triple-slash-reference -- Ambient types for the reused renderer adapter; imports would load preload index.ts, not its adjacent declaration. */
/// <reference path="../preload/index.d.ts" />
/// <reference path="../renderer/src/env.d.ts" />
/* oxlint-enable typescript/triple-slash-reference */
// @vitest-environment node
import { readFileSync } from "node:fs";
import {
  captureCanaryRecording,
  checkNextHost,
  recordingExchanges,
  replayCanaryPeer,
  peerInput,
  type PeerExchange,
} from "../../../../packages/session-rpc/src/canary-peer.test-support";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  describeContract,
  expectHostError,
  recordSubscription,
  webSocketContractLink,
  type ContractLink,
} from "@volli/host-protocol/testing";
import {
  createSessionRouter,
  HostProcedureError,
  RpcDiagnosticLog,
  sessionProcedureSchemas,
  type AppRouter,
} from "@volli/session-rpc";
import {
  SessionRuntimeCommandConflictError,
  type SessionRuntime,
  type SessionStreamFrame,
  type SessionStreamQueue,
} from "@volli/session-engine";
import { createSessionProjectionCheckpoint } from "@volli/shared";
import {
  electronIpcSessionLink,
  fakeElectron,
  webSocketSessionLink,
  type SessionRouterHost,
} from "../renderer/src/lib/session-rpc-contract.test-support";
import {
  createOldSessionRouter,
  loadCanaryPeer,
  oldCommandInput,
  oldCommandOutput,
  oldProjectionOutput,
  oldQueryInput,
  oldSnapshotOutput,
  oldSubscribeInput,
  oldTrackedOutput,
} from "./session-rpc-n-minus-one.test-support";

vi.mock("electron", () => fakeElectron);
const peer = vi.hoisted(() => ({ old: false, runtime: null as SessionRuntime | null }));
vi.mock("@volli/session-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@volli/session-rpc")>();
  const { withHarnessIdentity } =
    await import("../renderer/src/lib/session-rpc-harness-identity.test-support");
  const { createOldSessionRouter: frozenRouter } =
    await import("./session-rpc-n-minus-one.test-support");
  return withHarnessIdentity({
    ...actual,
    createSessionRouter: () => {
      if (!peer.old) return actual.createSessionRouter();
      // Adapt today's bridge context to the frozen host's historical port;
      // its parser/router stays unchanged and owns the old wire semantics.
      const runtime = peer.runtime!;
      const router = frozenRouter(actual.HostProcedureError);
      return {
        ...router,
        createCaller: (
          context: Parameters<AppRouter["createCaller"]>[0],
          options: Parameters<typeof router.createCaller>[1],
        ) =>
          router.createCaller(
            { ...(context as import("@volli/session-rpc").SessionRouterContext), runtime },
            options,
          ),
      } as unknown as AppRouter;
    },
  });
});

const canary = process.env.VOLLI_CANARY_CAPTURE_DIR ? null : loadCanaryPeer();

const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const session = {
  id: "wire-session",
  projectId: WORKSPACE,
  ticketId: null,
  role: "project" as const,
  parentSessionId: null,
  title: "Recorded Session",
  createdAt: 10,
};
function frame(sequence: number): SessionStreamFrame {
  return {
    sessionId: session.id,
    sequence,
    transcript: null,
    event: {
      id: `wire-event-${sequence}`,
      sessionId: session.id,
      sequence,
      occurredAt: 10,
      recordedAt: 10,
      provenance: { source: { kind: "system", id: "wire-fixture", detail: null }, venue: null },
      payload: { kind: "session.created", session },
    },
  };
}

/** Independent deterministic runtime data, never reconstructed from expected wire responses. */
function hostFixture(rich = false) {
  const cursors: number[] = [];
  const commandIds: string[] = [];
  let emit!: Parameters<SessionRuntime["subscribe"]>[1];
  const accepted = new Map<string, string>();
  const source = createSessionProjectionCheckpoint(session, []).projection;
  const queue: SessionStreamQueue["queue"] = [
    {
      id: "queued",
      commandId: "submit",
      state: "queued",
      message: {
        id: "queued",
        role: "user",
        parts: [{ type: "text", text: "Recorded follow-up" }],
      },
    },
  ];
  const sparse = (
    rich ? { ...source, queue, queueRevision: 1 } : { session: source.session }
  ) as typeof source;
  const runtime: SessionRuntime = {
    projection: async () => ({
      // Sparse projections are part of the pre-669 public contract.
      projection: sparse,
      throughSequence: 4,
    }),
    snapshot: async () => ({
      projection: sparse,
      throughSequence: 4,
      frames: [frame(4)],
      before: null,
      transcript: [],
      latestReply: null,
    }),
    history: async () => ({ frames: [frame(3)], before: null }),
    command: async (input) => {
      if (input.command.kind !== "model.select")
        throw new Error("Recording supports only model.select");
      commandIds.push(input.commandId);
      const intent = JSON.stringify(input.command);
      const prior = accepted.get(input.commandId);
      if (prior !== undefined && prior !== intent) {
        throw new SessionRuntimeCommandConflictError(
          `Command ${input.commandId} was already accepted with different intent`,
        );
      }
      accepted.set(input.commandId, intent);
      return {
        sessionId: session.id,
        command: {
          id: input.commandId,
          sessionId: session.id,
          createdAt: 10,
          route: null,
          intent: input.command,
        },
        receipt: {
          id: `receipt-${input.commandId}`,
          commandId: input.commandId,
          status: "accepted",
          acceptedAt: 10,
          result: { kind: "model.selected", sessionId: session.id },
          recordedAt: 10,
          sequence: 5,
        },
        throughSequence: 5,
        refusal: null,
      };
    },
    subscribe: async ({ afterSequence }, next) => {
      cursors.push(afterSequence);
      emit = next;
      return () => {};
    },
    cancelInteraction: async () => {},
    reconcile: async () => {},
    close: async () => {},
  };
  const host: SessionRouterHost = {
    runtime,
    diagnostics: new RpcDiagnosticLog(),
    caller: {
      actor: {
        kind: "device",
        deviceId: "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b",
        workspaceId: WORKSPACE,
      },
      current: () => true,
    },
    resourceWorkspace: ({ id }) => (id === session.id ? WORKSPACE : null),
  };
  return {
    host,
    cursors,
    commandIds,
    emit: (value: Parameters<typeof emit>[0]) => emit(value),
    queue,
  };
}

function oldHostLinks(): ContractLink<SessionRouterHost, AppRouter>[] {
  const ipc = electronIpcSessionLink();
  return [
    {
      name: ipc.name,
      async open(host) {
        peer.old = true;
        peer.runtime = host.runtime as SessionRuntime;
        try {
          return await ipc.open(host);
        } finally {
          peer.old = false;
          peer.runtime = null;
        }
      },
    },
    webSocketContractLink({
      router: createOldSessionRouter(HostProcedureError),
      createContext: (host: SessionRouterHost) => ({
        ...host,
        runtime: host.runtime as SessionRuntime,
        diagnostics: host.diagnostics ?? new RpcDiagnosticLog(),
      }),
    }) as unknown as ContractLink<SessionRouterHost, AppRouter>,
  ];
}

interface Recording {
  provenance: {
    revision: string;
    peer: string;
    producer: string;
    sources: string[];
    format: string;
  };
  query: { procedure: string; input: unknown; output: unknown };
  snapshot: { procedure: string; input: unknown; output: unknown };
  mutation: { procedure: string; input: unknown; output: unknown };
  subscription: {
    procedure: string;
    input: unknown;
    resumedInput: unknown;
    cursors: number[];
    frames: unknown[];
  };
  error: { procedure: string; input: unknown; output: unknown };
}
function readRecording(name: string): Recording {
  return JSON.parse(
    readFileSync(new URL(`./session-rpc-wire-fixtures/${name}.json`, import.meta.url), "utf8"),
  ) as Recording;
}

for (const direction of canary ? [] : (["old-client-new-host", "new-client-old-host"] as const)) {
  const oldClient = direction === "old-client-new-host";
  const name = oldClient ? "n-minus-one" : "current";
  const currentLinks = [electronIpcSessionLink(), webSocketSessionLink()];
  const links = oldClient ? currentLinks : oldHostLinks();
  describeContract(direction, links, ({ connect }) => {
    it("replays the recorded public query, mutation retry, subscription resume and reason envelope", async () => {
      const f = hostFixture();
      const client = await connect(f.host);
      const recording = readRecording(name);
      const currentSchemas = sessionProcedureSchemas();
      const inputFor = <T>(path: string, value: unknown, frozen: { parse(value: unknown): T }): T =>
        frozen.parse(oldClient ? value : currentSchemas[path].input!.parse(value));
      expect([
        recording.query.procedure,
        recording.snapshot.procedure,
        recording.mutation.procedure,
        recording.subscription.procedure,
        recording.error.procedure,
      ]).toEqual([
        "session.projection",
        "session.snapshot",
        "session.command",
        "session.subscribe",
        "session.projection",
      ]);
      const query = await client.session.projection.query(
        inputFor("session.projection", recording.query.input, oldQueryInput),
      );
      const snapshot = await client.session.snapshot.query(
        inputFor("session.snapshot", recording.snapshot.input, oldQueryInput),
      );
      const input = inputFor("session.command", recording.mutation.input, oldCommandInput);
      const mutation = await client.session.command.mutate(input);
      expect(await client.session.command.mutate(input)).toStrictEqual(mutation);
      expect(f.commandIds).toEqual([input.commandId, input.commandId]);
      expect(mutation.receipt?.commandId).toBe(input.commandId);
      expect(mutation).not.toHaveProperty("command");
      expect(snapshot).not.toHaveProperty("transcript");
      const stream = recordSubscription<{ id: string; data: unknown }>((handlers) =>
        client.session.subscribe.subscribe(
          inputFor("session.subscribe", recording.subscription.input, oldSubscribeInput),
          handlers,
        ),
      );
      await stream.started;
      f.emit(frame(5));
      const first = (await stream.received(1))[0];
      stream.unsubscribe();
      const resumed = recordSubscription<{ id: string; data: unknown }>((handlers) =>
        client.session.subscribe.subscribe(
          inputFor("session.subscribe", recording.subscription.resumedInput, oldSubscribeInput),
          handlers,
        ),
      );
      await resumed.started;
      f.emit(frame(6));
      const second = (await resumed.received(1))[0];
      resumed.unsubscribe();
      expect(f.cursors).toEqual(recording.subscription.cursors);
      const error = await expectHostError(
        client.session.projection.query(
          inputFor("session.projection", recording.error.input, oldQueryInput),
        ),
      );
      const observed = {
        ...recording,
        query: { ...recording.query, output: query },
        snapshot: { ...recording.snapshot, output: snapshot },
        mutation: { ...recording.mutation, output: mutation },
        subscription: { ...recording.subscription, frames: [first, second] },
        error: { ...recording.error, output: error },
      };
      if (oldClient) {
        oldProjectionOutput.parse(query);
        oldSnapshotOutput.parse(snapshot);
        oldCommandOutput.parse(mutation);
        oldTrackedOutput.parse(first);
        oldTrackedOutput.parse(second);
      } else {
        // The NEW consumer validates an OLD host's payload with today's
        // published validators, not with the old decoder or a direct caller.
        currentSchemas["session.projection"].output!.parse(query);
        currentSchemas["session.snapshot"].output!.parse(snapshot);
        currentSchemas["session.command"].output!.parse(mutation);
        currentSchemas["session.subscribe"].output!.parse(first?.data);
        currentSchemas["session.subscribe"].output!.parse(second?.data);
      }
      expect(observed).toStrictEqual(recording);
    });
  });
}

describe("frozen peer provenance", () => {
  it("uses a separate historical router, not two fixtures on today's router", () => {
    const old = createOldSessionRouter(HostProcedureError);
    const current = createSessionRouter();
    /* oxlint-disable no-underscore-dangle -- tRPC's documented router introspection door. */
    expect(Object.keys(old._def.procedures).toSorted()).toEqual([
      "session.command",
      "session.projection",
      "session.snapshot",
      "session.subscribe",
    ]);
    expect(Object.keys(current._def.procedures).length).toBeGreaterThan(4);
    const oldProcedures = old._def.procedures as unknown as Record<
      string,
      { _def: { output?: unknown } }
    >;
    expect(oldProcedures["session.projection"]._def).not.toHaveProperty("output");
    /* oxlint-enable no-underscore-dangle */
    expect(sessionProcedureSchemas()["session.projection"].output).not.toBeNull();
    expect(
      oldCommandInput.safeParse({
        sessionId: session.id,
        commandId: "id",
        command: { kind: "not-an-old-intent" },
      }).success,
    ).toBe(false);
    const oldRecording = readRecording("n-minus-one");
    const newRecording = readRecording("current");
    expect(oldRecording.provenance.revision).toBe("4c712841ae777dcc178d10552e7b0052fa905b81");
    expect(oldRecording.subscription.resumedInput).not.toHaveProperty("lastEventId");
    expect(newRecording.subscription.resumedInput).toHaveProperty("lastEventId", "5");
    expect(oldRecording).not.toStrictEqual(newRecording);
  });
});

/** The first distributed peer captures the full Session surface, not the four-entry bootstrap. */
for (const link of [electronIpcSessionLink(), webSocketSessionLink()]) {
  const transport = link.name === "electron-ipc" ? "ipc" : "websocket";
  it(`records Session history and queued follow-ups over ${transport}; both actual-canary skew directions`, async () => {
    const name = `session-${transport}`;
    const f = hostFixture(true);
    const connection = await link.open(f.host);
    const client = connection.client;
    const exchanges: PeerExchange[] = [];
    const input = peerInput(canary, name, "session.projection", { sessionId: session.id });
    try {
      exchanges.push({
        procedure: "session.projection",
        input,
        output: await client.session.projection.query(input),
      });
      exchanges.push({
        procedure: "session.snapshot",
        input,
        output: await client.session.snapshot.query(input),
      });
      const historyInput = peerInput(canary, name, "session.history", { ...input, before: 4 });
      exchanges.push({
        procedure: "session.history",
        input: historyInput,
        output: await client.session.history.query(historyInput),
      });
      const commandInput = peerInput(canary, name, "session.command", {
        ...input,
        commandId: "recorded-model",
        command: {
          kind: "model.select" as const,
          selection: { providerId: "test", modelId: "model", reasoningLevel: "high" as const },
        },
      });
      for (let retry = 0; retry < 2; retry++)
        exchanges.push({
          procedure: "session.command",
          input: commandInput,
          output: await client.session.command.mutate(commandInput),
        });

      for (const afterSequence of [4, 5]) {
        const subscribeInput = peerInput(
          canary,
          name,
          "session.subscribe",
          {
            ...input,
            afterSequence,
            ...(afterSequence === 5 ? { lastEventId: "5" } : {}),
          },
          afterSequence === 4 ? 0 : 1,
        );
        const stream = recordSubscription<{ id: string; data: unknown }>((handlers) =>
          client.session.subscribe.subscribe(subscribeInput, handlers),
        );
        try {
          await stream.started;
          await vi.waitFor(() => expect(f.cursors).toHaveLength(afterSequence === 4 ? 1 : 2));
          f.emit(frame(afterSequence + 1));

          exchanges.push({
            procedure: "session.subscribe",
            input: subscribeInput,
            frames: [...(await stream.received(1))],
          });
        } finally {
          stream.unsubscribe();
        }
      }

      // subscribeQueue is WebSocket-only in the production exposure table.
      if (transport === "websocket") {
        const queueStream = recordSubscription<{ id: string; data: unknown }>((handlers) =>
          client.session.subscribeQueue.subscribe(input, handlers),
        );
        try {
          await queueStream.started;
          await vi.waitFor(() => expect(f.cursors).toHaveLength(3));
          f.emit({
            kind: "queue",
            sessionId: session.id,
            throughSequence: 4,
            revision: 1,
            queue: f.queue!,
          });
          exchanges.push({
            procedure: "session.subscribeQueue",
            input,
            frames: [...(await queueStream.received(1))],
          });
        } finally {
          queueStream.unsubscribe();
        }
      }
      const refusalInput = peerInput(
        canary,
        name,
        "session.projection",
        { sessionId: "foreign-session" },
        1,
      );
      exchanges.push({
        procedure: "session.projection",
        input: refusalInput,
        error: await expectHostError(client.session.projection.query(refusalInput)),
      });
    } finally {
      await connection.close();
    }
    captureCanaryRecording(name, transport, exchanges, recordingExchanges(exchanges));
    if (canary) {
      checkNextHost(canary, name, exchanges);
      await replayCanaryPeer(canary, name, sessionProcedureSchemas());
    }
  });
}
