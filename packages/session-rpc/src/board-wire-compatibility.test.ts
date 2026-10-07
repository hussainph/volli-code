// @vitest-environment node
/**
 * N−1 public wire recordings for the board (VC-565; HP § "N−1 public wire
 * recordings (VC-669)").
 *
 * `board-wire-fixtures/current.json` pins the application-wire requests and
 * answers of the board's public features (`board.read`, `board.write`), with
 * transport request ids omitted: a `board.snapshot`, a `board.createTicket`
 * under a stable `commandId` and its retry, `board.changes` tracked frames and
 * their resume after `lastEventId`, and a `workspace-unknown` envelope. They
 * were captured from `fakeBoard()` (deterministic ids and clocks) through the
 * PRODUCTION listener and the stock tRPC client; the host never reads the
 * recording back to answer it.
 *
 * - **Replay:** today's router, through the listener, answers the recorded
 *   requests byte-for-byte as recorded (compact JSON, key order included).
 * - **Grammar:** every recorded request parses with today's published input
 *   schema and every recorded answer with its published output schema
 *   (`boardProcedureSchemas()`), stripping nothing.
 * - **Skew:** a new client against a host that offers only the pre-VC-565
 *   features is granted no board feature and every board operation is refused
 *   `verb-refused` before its input is parsed; an old client that requests no
 *   board feature is granted none by a new host.
 *
 * The board is the first release of these features, so there is no older
 * board recording yet: at the next HP-capable release cut, freeze this
 * recording as `n-minus-one.json` with its release tag (see the Session
 * recordings in `apps/desktop/src/main/session-rpc-wire-fixtures/`).
 *
 * Regenerate (only for an intentional, compatible change, never to make a
 * breaking change green); a regeneration run only writes the file, so run
 * the test again without the variable to check it:
 *
 *   cd packages/session-rpc
 *   UPDATE_BOARD_WIRE_FIXTURES=1 vp test run src/board-wire-compatibility.test.ts
 *   cd ../.. && vp fmt packages/session-rpc/src/board-wire-fixtures/current.json
 */
import { writeFileSync } from "node:fs";

import { createTRPCClient, createWSClient, getUntypedClient, wsLink } from "@trpc/client";
import {
  buildHostHello,
  encodeHostHello,
  HOST_ERROR_REASON_CODES,
  HOST_FEATURE_OPERATIONS,
  HOST_V1_FEATURES,
  type HostErrorReason,
} from "@volli/host-protocol";
import { expectHostError, ipcContractLink, recordSubscription } from "@volli/host-protocol/testing";
import {
  captureCanaryRecording,
  checkNextHost,
  loadCanaryPeer,
  recordingExchanges,
  replayCanaryPeer,
} from "./canary-peer.test-support";
const canary = process.env.VOLLI_CANARY_CAPTURE_DIR ? null : loadCanaryPeer();
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { boardProcedureSchemas } from "./board-router";
import currentRecording from "./board-wire-fixtures/current.json";
import {
  BOARD_DEVICE,
  BOARD_HOST,
  BOARD_WORKSPACE,
  OTHER_WORKSPACE,
  fakeBoard,
  type FakeBoard,
} from "./board-host.test-support";
import { createHostRouter, type HostRouter } from "./host-router";
import { RpcDiagnosticLog } from "./index";
import { sessionHandlersFrom } from "./session-handlers.test-support";
import { startHostProtocolListener } from "./websocket-server";

const FIXTURE = new URL("./board-wire-fixtures/current.json", import.meta.url);
const UPDATE = process.env.UPDATE_BOARD_WIRE_FIXTURES === "1";

/** What a host offered before VC-565: every feature but the board's. */
const PRE_BOARD_FEATURES = [
  "sessions",
  "sessions.queue",
  "sessions.subscribe",
  "sessions.history",
  "session.read",
];
const BOARD_OPERATIONS = [
  ...HOST_FEATURE_OPERATIONS["board.read"],
  ...HOST_FEATURE_OPERATIONS["board.write"],
];

interface Exchange {
  procedure: string;
  input: unknown;
  output: unknown;
}
interface Recording {
  provenance: Record<string, unknown>;
  snapshot: Exchange;
  mutation: Exchange & { retryOutput: unknown };
  subscription: {
    procedure: string;
    input: { projectId: string; lastEventId?: string };
    write: Exchange;
    resumedInput: { projectId: string; lastEventId?: string };
    afters: (string | null)[];
    frames: unknown[];
  };
  error: Exchange;
}

/** The requests a regeneration sends; a replay sends the recorded ones instead. */
const REQUESTS = {
  snapshot: { projectId: BOARD_WORKSPACE },
  mutation: {
    commandId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    projectId: BOARD_WORKSPACE,
    status: "todo",
    title: "Recorded over the wire",
    priority: "high",
    body: "A *recorded* body.",
    labels: ["ui", "remote"],
  },
  write: {
    commandId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
    ticketId: "ticket-b",
    priority: "low",
  },
  error: { projectId: OTHER_WORKSPACE },
};

const PROVENANCE = {
  revision: "VC-565 branch, first captured on a4fff8271fb2dee4b84afc057ea106484c1c5a2c",
  peer: "VC-565 public board client (board.read, board.write) using tracked-id resume",
  producer:
    "createHostRouter() through startHostProtocolListener, over fakeBoard() (board-host.test-support.ts)",
  sources: [
    "packages/session-rpc/src/board-router.ts",
    "packages/session-rpc/src/board-schema.ts",
    "packages/session-rpc/src/board-host.test-support.ts",
  ],
  format:
    "Application-wire payloads as the stock tRPC WebSocket client receives them through the production listener; transport-local request/subscription ids omitted",
  regenerate:
    "UPDATE_BOARD_WIRE_FIXTURES=1 vp test run src/board-wire-compatibility.test.ts (in packages/session-rpc), then vp fmt the JSON",
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** The production listener over a fake board, and one client that said `requested`. */
async function connect(
  board: FakeBoard,
  options: { offered?: readonly string[]; requested?: readonly string[]; ipc?: boolean } = {},
) {
  if (options.ipc) {
    const connection = await ipcContractLink({
      router: createHostRouter(),
      createContext: () => ({
        caller: {
          actor: { kind: "device" as const, deviceId: BOARD_DEVICE, workspaceId: BOARD_WORKSPACE },
          current: () => true,
        },
        handlers: { ...sessionHandlersFrom({ runtime: {} }), ...board.handlers },
        diagnostics: new RpcDiagnosticLog(),
        resourceWorkspace: (resource) => board.resourceWorkspace(resource),
        transport: "electron-ipc" as const,
      }),
    }).open(null);
    cleanups.push(connection.close);
    return connection.client;
  }
  const listener = await startHostProtocolListener({
    router: createHostRouter(),
    bind: { host: "127.0.0.1", port: 0 },
    host: { id: BOARD_HOST, version: "board-wire" },
    workspace: (id) => (id === BOARD_WORKSPACE ? { id, epoch: 1 } : null),
    verifier: {
      verify: async () => ({
        actor: { kind: "device", deviceId: BOARD_DEVICE, workspaceId: BOARD_WORKSPACE },
        current: () => true,
      }),
    },
    features: options.offered ?? ["board.read", "board.write"],
    context: () => ({
      handlers: { ...sessionHandlersFrom({ runtime: {} }), ...board.handlers },
      diagnostics: new RpcDiagnosticLog(),
      resourceWorkspace: (resource) => board.resourceWorkspace(resource),
    }),
  });
  const socket = createWSClient({
    url: listener.url,
    connectionParams: encodeHostHello(
      buildHostHello({
        client: { kind: "desktop", version: "board-wire" },
        workspaceId: BOARD_WORKSPACE,
        lastSeen: null,
        features: options.requested ?? ["board.read", "board.write"],
        credential: "test-only-credential",
      }),
    ),
  });
  cleanups.push(async () => {
    await socket.close();
    await listener.close();
  });
  return createTRPCClient<HostRouter>({ links: [wsLink({ client: socket })] });
}

/** The recording as the module graph loaded it (a regeneration run only writes it). */
function readRecording(): Recording {
  return structuredClone(currentRecording) as unknown as Recording;
}

type Frame = { id: string; data: unknown };

/** Runs the recorded exchange against today's router; answers what it observed. */
async function observe(recorded: Recording | null, ipc = false): Promise<Recording> {
  const board = fakeBoard();
  const client = await connect(board, { ipc });
  const raw = getUntypedClient(client);
  const snapshotInput = recorded?.snapshot.input ?? REQUESTS.snapshot;
  const snapshot = (await raw.query("board.snapshot", snapshotInput)) as { cursor: string };

  const subscriptionInput = recorded?.subscription.input ?? {
    projectId: BOARD_WORKSPACE,
    lastEventId: snapshot.cursor,
  };
  const live = recordSubscription<Frame>((handlers) =>
    raw.subscription("board.changes", subscriptionInput, handlers as never),
  );
  await live.started;
  await vi.waitFor(() => expect(board.listeners()).toBe(1));

  const mutationInput = recorded?.mutation.input ?? REQUESTS.mutation;
  const created = await raw.mutation("board.createTicket", mutationInput);
  const retried = await raw.mutation("board.createTicket", mutationInput);
  expect(board.effects).toEqual(["board.createTicket"]);
  const [first] = await live.received(1);
  live.unsubscribe();
  await vi.waitFor(() => expect(board.listeners()).toBe(0));

  const writeInput = recorded?.subscription.write.input ?? REQUESTS.write;
  const written = await raw.mutation("board.setPriority", writeInput);
  const resumedInput = recorded?.subscription.resumedInput ?? {
    projectId: BOARD_WORKSPACE,
    lastEventId: first!.id,
  };
  const resumed = recordSubscription<Frame>((handlers) =>
    raw.subscription("board.changes", resumedInput, handlers as never),
  );
  const [second] = await resumed.received(1);
  resumed.unsubscribe();

  const errorInput = recorded?.error.input ?? REQUESTS.error;
  const error = await expectHostError(raw.query("board.snapshot", errorInput));
  return {
    provenance: recorded?.provenance ?? PROVENANCE,
    snapshot: { procedure: "board.snapshot", input: snapshotInput, output: snapshot },
    mutation: {
      procedure: "board.createTicket",
      input: mutationInput,
      output: created,
      retryOutput: retried,
    },
    subscription: {
      procedure: "board.changes",
      input: subscriptionInput as Recording["subscription"]["input"],
      write: { procedure: "board.setPriority", input: writeInput, output: written },
      resumedInput: resumedInput as Recording["subscription"]["resumedInput"],
      afters: [...board.afters],
      frames: [first, second],
    },
    error: { procedure: "board.snapshot", input: errorInput, output: error },
  };
}

describe("the board's current wire recording", () => {
  it.runIf(UPDATE)("is regenerated from the fake host through the real listener", async () => {
    const observed = await observe(null);
    writeFileSync(FIXTURE, `${JSON.stringify(observed, null, 2)}\n`);
  });

  it.skipIf(UPDATE)(
    "is answered byte-for-byte by today's router through the listener",
    async () => {
      const recording = readRecording();
      const observed = await observe(recording);
      expect(observed).toStrictEqual(recording);
      // Byte-equal on the wire's compact JSON, key order included.
      for (const key of ["snapshot", "mutation", "subscription", "error"] as const) {
        expect(JSON.stringify(observed[key])).toBe(JSON.stringify(recording[key]));
      }
    },
  );

  it.skipIf(UPDATE)(
    "pins a receipted retry, a resume after the first frame, and the reason envelope",
    () => {
      const { mutation, subscription, error } = readRecording();
      const output = mutation.output as { receipt: { commandId: string; replayed: boolean } };
      expect(output.receipt).toEqual({
        commandId: (mutation.input as { commandId: string }).commandId,
        status: "completed",
        replayed: false,
      });
      expect(mutation.retryOutput).toStrictEqual({
        ...output,
        receipt: { ...output.receipt, replayed: true },
      });
      const [first, second] = subscription.frames as Frame[];
      expect(subscription.resumedInput.lastEventId).toBe(first!.id);
      expect(subscription.afters).toEqual([subscription.input.lastEventId, first!.id]);
      expect(second!.id).not.toBe(first!.id);
      expect(error.output).toMatchObject({ code: "NOT_FOUND", reason: "workspace-unknown" });
    },
  );

  it.skipIf(UPDATE)("parses with today's published schemas, stripping nothing", () => {
    const schemas = boardProcedureSchemas();
    const recording = readRecording();
    const exchanges: Exchange[] = [
      recording.snapshot,
      recording.mutation,
      { ...recording.mutation, output: recording.mutation.retryOutput },
      recording.subscription.write,
    ];
    for (const { procedure, input, output } of exchanges) {
      expect(schemas[procedure]!.input.parse(input)).toStrictEqual(input);
      expect(schemas[procedure]!.output.parse(output)).toStrictEqual(output);
    }
    const changes = schemas["board.changes"]!;
    for (const input of [recording.subscription.input, recording.subscription.resumedInput]) {
      expect(changes.input.parse(input)).toStrictEqual(input);
    }
    for (const frame of recording.subscription.frames as Frame[]) {
      expect(changes.output.parse(frame.data)).toStrictEqual(frame.data);
      expect(frame.id).toBe((frame.data as { cursor: string }).cursor);
    }
    expect(schemas["board.snapshot"]!.input.parse(recording.error.input)).toStrictEqual(
      recording.error.input,
    );
    const { code, reason } = recording.error.output as { code: string; reason: HostErrorReason };
    expect(HOST_ERROR_REASON_CODES[reason]).toBe(code);
  });
});

/** Every board operation refused `verb-refused`, its malformed input never parsed. */
async function expectEveryBoardOperationRefused(
  client: Awaited<ReturnType<typeof connect>>,
  board: FakeBoard,
) {
  const raw = getUntypedClient(client);
  const schemas = boardProcedureSchemas();
  for (const path of BOARD_OPERATIONS) {
    const type = schemas[path]!.type;
    const malformed = { malformed: true };
    if (type === "subscription") {
      const stream = recordSubscription((handlers) => raw.subscription(path, malformed, handlers));
      expect(await stream.ended).toMatchObject({
        kind: "error",
        error: { code: "FORBIDDEN", reason: "verb-refused" },
      });
      stream.unsubscribe();
    } else {
      const call = type === "query" ? raw.query(path, malformed) : raw.mutation(path, malformed);
      expect(await expectHostError(call)).toMatchObject({
        code: "FORBIDDEN",
        reason: "verb-refused",
      });
    }
  }
  expect(board.reached).toEqual([]);
}

for (const transport of ["ipc", "websocket"] as const) {
  it(`captures the board over ${transport} and replays the recorded canary in both directions`, async () => {
    const name = `board-${transport}`;
    const recorded = canary?.recordings[name]?.recording as Recording | undefined;
    const observed = await observe(recorded ?? null, transport === "ipc");
    captureCanaryRecording(name, transport, observed, recordingExchanges(observed));
    if (canary) {
      checkNextHost(canary, name, observed);
      await replayCanaryPeer(canary, name, boardProcedureSchemas());
    }
  });
}

describe("version skew", () => {
  it.runIf(!canary)(
    "new client × old host: a host offering only the pre-VC-565 features grants no board feature",
    async () => {
      const board = fakeBoard();
      const client = await connect(board, {
        offered: PRE_BOARD_FEATURES,
        requested: HOST_V1_FEATURES,
      });
      const { features } = await client.protocol.welcome.query();
      expect(features).toEqual(PRE_BOARD_FEATURES);
      expect(features.filter((feature) => feature.startsWith("board."))).toEqual([]);
      await expectEveryBoardOperationRefused(client, board);
    },
  );

  it.runIf(!canary)(
    "old client × new host: a client that requests no board feature is granted none",
    async () => {
      const board = fakeBoard();
      const client = await connect(board, {
        offered: HOST_V1_FEATURES,
        requested: PRE_BOARD_FEATURES,
      });
      expect((await client.protocol.welcome.query()).features).toEqual(PRE_BOARD_FEATURES);
      await expectEveryBoardOperationRefused(client, board);
    },
  );
});
