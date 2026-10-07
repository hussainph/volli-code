// The host protocol's WebSocket listener, end to end over real loopback
// sockets: the stock tRPC client against the real handshake (VC-663).
import { once } from "node:events";
import { connect as connectTcp, createServer, type AddressInfo, type Socket } from "node:net";

import { createTRPCClient, createWSClient, wsLink, type TRPCClient } from "@trpc/client";
import {
  buildHostHello,
  encodeHostHello,
  HOST_V1_FEATURES,
  isResnapshotRequired,
  LOCAL_DEVICE_ID,
  SUBSCRIPTION_REPLAY_BOUNDS,
  validateWelcome,
  type HostActor,
  type HostConnectionActor,
  type HostConnectionCredentialGrant,
  type HostCredentialVerifier,
  type HostHello,
  type HostConnectionHello,
  type HostHelloInput,
} from "@volli/host-protocol";
import { expectHostError, recordSubscription } from "@volli/host-protocol/testing";
import type {
  SessionRuntime,
  SessionStreamEmission,
  SessionStreamFrame,
} from "@volli/session-engine";
import { createSessionProjectionCheckpoint } from "@volli/shared";
import { AsyncLocalStorage } from "node:async_hooks";

import { HOST_TRACE_FIELD } from "@volli/host-protocol";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { WebSocket } from "ws";

import {
  createSessionRouter,
  RpcDiagnosticLog,
  type AppRouter,
  type SessionRouterContext,
} from "./index";
import { sessionHandlersFrom } from "./session-handlers.test-support";
import {
  HOST_PROTOCOL_CLOSE_CODES,
  boundOutboundSends,
  DEFAULT_LISTENER_LIMITS,
  FRAME_ENVELOPE_BYTES,
  isLoopbackHost,
  startHostProtocolListener,
  validateListenerLimits,
  type BoundedSocket,
  readRequests,
  type HostProtocolListenerEvent,
  type HostProtocolListenerLimits,
  type HostProtocolRequest,
  type HostProtocolRequestScope,
} from "./websocket-server";

/** What the Session router alone serves: every v1 feature but the board's (VC-565). */
const SESSION_ROUTER_FEATURES = HOST_V1_FEATURES.filter(
  (feature) =>
    !feature.startsWith("board.") &&
    feature !== "host.workspaces" &&
    feature !== "host.model-defaults",
);
const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const OTHER_WORKSPACE = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const HOST = "b7c1d2e3-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const DEVICE = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
const SESSION = "session-1";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const session = {
  id: SESSION,
  projectId: WORKSPACE,
  ticketId: null,
  role: "project" as const,
  parentSessionId: null,
  title: null,
  createdAt: 10,
};

function frame(sequence: number, padding = 0): SessionStreamFrame {
  return {
    sessionId: SESSION,
    sequence,
    transcript: null,
    event: {
      id: `event-${sequence}`,
      sessionId: SESSION,
      sequence,
      occurredAt: 10,
      recordedAt: 10,
      provenance: { source: { kind: "system", id: "test", detail: null }, venue: null },
      payload: { kind: "session.retitled", title: `title ${"x".repeat(padding)}` },
    },
  };
}

/** A Session ledger behind a runtime: replays strictly after a cursor, then goes live. */
function ledger(options: { ignoresCancel?: boolean } = {}) {
  const frames: SessionStreamFrame[] = [];
  const listeners = new Set<(emission: SessionStreamEmission) => void | Promise<void>>();
  const reads: string[] = [];
  /** Replayed frames the source handed to a subscription's listener. */
  const handed = { count: 0 };
  const projection = createSessionProjectionCheckpoint(session, []).projection;
  const runtime: SessionRuntime = {
    snapshot: async () => {
      reads.push("snapshot");
      return {
        projection,
        throughSequence: frames.length,
        frames: [...frames],
        before: null,
        transcript: [],
        latestReply: null,
      };
    },
    history: async () => ({ frames: [], before: null }),
    projection: async () => {
      reads.push("projection");
      return { projection, throughSequence: frames.length };
    },
    // Like the real runtime, an aborted signal stops the replay at the next frame.
    subscribe: async ({ afterSequence, signal }, listener) => {
      reads.push(`subscribe:${afterSequence}`);
      for (const replayed of frames.slice(afterSequence)) {
        if (signal?.aborted === true && options.ignoresCancel !== true) return () => {};
        handed.count += 1;
        await listener(replayed);
      }
      if (signal?.aborted === true) return () => {};
      listeners.add(listener);
      signal?.addEventListener("abort", () => listeners.delete(listener));
      return () => listeners.delete(listener);
    },
    command: async () => {
      reads.push("command");
      throw new Error("not reached");
    },
    cancelInteraction: async () => {},
    reconcile: async () => {},
    close: async () => {},
  };
  const append = async (count: number, padding = 0): Promise<void> => {
    for (let index = 0; index < count; index++) {
      const next = frame(frames.length + 1, padding);
      frames.push(next);
      for (const listener of listeners) await listener(next);
    }
  };
  return { runtime, frames, listeners, reads, append, handed };
}

/** One credential the test verifier knows, and the levers that withdraw it. */
function credential(actor: HostConnectionActor, options: { watch?: boolean } = {}) {
  let valid = true;
  let push: (() => void) | null = null;
  const grant: HostConnectionCredentialGrant = {
    actor,
    current: () => valid,
    ...(options.watch === false
      ? {}
      : {
          watch: (revoked: () => void) => {
            push = revoked;
            return () => {
              push = null;
            };
          },
        }),
  };
  return {
    grant,
    /** The verifier's push: the control plane says so. */
    revoke() {
      valid = false;
      push?.();
    },
    /** Silent expiry: only the periodic re-check finds it. */
    expire() {
      valid = false;
    },
    get watched() {
      return push !== null;
    },
  };
}

const device: HostActor = { kind: "device", deviceId: DEVICE, workspaceId: WORKSPACE };

async function serve(
  options: {
    grants?: Record<string, HostConnectionCredentialGrant>;
    verifier?: HostCredentialVerifier;
    limits?: Partial<HostProtocolListenerLimits>;
    /** What a test changes about the connection's context, given the ledger behind it. */
    context?: (source: ReturnType<typeof ledger>) => {
      runtime?: SessionRuntime;
      resourceWorkspace?: SessionRouterContext["resourceWorkspace"];
    };
    /** A source that keeps replaying after it was cancelled. */
    ignoresCancel?: boolean;
    requestScope?: HostProtocolRequestScope;
    /** The host's recent log (VC-699). */
    logs?: Pick<Parameters<typeof sessionHandlersFrom>[0], "readLogs" | "followLogs">;
  } = {},
) {
  // The production refusal window (1 s) unless a test asks otherwise. The
  // stock client sends a call one timer tick after its socket opens, so a
  // window as short as a busy machine's tick would close a refused connection
  // before that call is even sent, and the client would answer "Active
  // connection is not open" instead of the refusal under test. A test that
  // waits for the close shortens the window and speaks over a raw socket,
  // whose calls are on the wire behind the hello before the window starts.
  const limits = { ...options.limits };
  const events: HostProtocolListenerEvent[] = [];
  const source = ledger({ ignoresCancel: options.ignoresCancel === true });
  const grants = options.grants ?? { "device-token": credential(device).grant };
  const listener = await startHostProtocolListener({
    router: createSessionRouter(),
    bind: { host: "127.0.0.1", port: 0 },
    host: { id: HOST, version: "test" },
    features: SESSION_ROUTER_FEATURES,
    workspace: async (id) => (id === WORKSPACE ? { id, epoch: 2 } : null),
    verifier: options.verifier ?? {
      verify: ({ credential: presented }) => grants[presented] ?? null,
    },
    context: () => {
      const changed = options.context?.(source);
      return {
        // The map over the ledger, as a root hands its router (VC-668).
        handlers: sessionHandlersFrom({
          runtime: changed?.runtime ?? source.runtime,
          ...options.logs,
        }),
        diagnostics: new RpcDiagnosticLog(),
        resourceWorkspace:
          changed?.resourceWorkspace ?? (({ id }) => (id === SESSION ? WORKSPACE : null)),
      };
    },
    limits,
    log: (event) => events.push(event),
    ...(options.requestScope === undefined ? {} : { requestScope: options.requestScope }),
  });
  cleanups.push(() => listener.close());
  return { listener, events, ...source };
}

const HELLO: HostHelloInput = {
  client: { kind: "cli", version: "test" },
  workspaceId: WORKSPACE,
  credential: "device-token",
  features: ["sessions", "sessions.subscribe", "session.read"],
  lastSeen: null,
};

/** The stock client, saying a fresh hello on every (re)connect; `null` sends none at all. */
function connect(url: string, hello: Partial<HostHelloInput> | null = {}) {
  const closes: number[] = [];
  const hellos: HostHello[] = [];
  const socket = createWSClient({
    url,
    ...(hello === null
      ? {}
      : {
          connectionParams: () => {
            const said = buildHostHello({ ...HELLO, ...hello });
            hellos.push(said);
            return encodeHostHello(said);
          },
        }),
    onClose: (event) => closes.push(event?.code ?? 0),
    retryDelayMs: () => 20,
  });
  const client: TRPCClient<AppRouter> = createTRPCClient<AppRouter>({
    links: [wsLink({ client: socket })],
  });
  cleanups.push(() => socket.close());
  return { client, closes, hellos };
}

/** A raw socket, to stall, skip hello, or observe a refusal without the client's reconnect race. */
async function raw(url: string, hello: HostConnectionHello | null) {
  const socket = new WebSocket(`${url}?connectionParams=1`);
  cleanups.push(() => socket.terminate());
  // Listened for from the start, so a close that comes early is never missed.
  const closed = once(socket, "close") as Promise<[number, Buffer]>;
  const messages: unknown[] = [];
  socket.on("message", (data) => {
    const text = data.toString();
    if (text !== "PING") messages.push(JSON.parse(text));
  });
  await once(socket, "open");
  if (hello !== null) {
    socket.send(JSON.stringify({ method: "connectionParams", data: encodeHostHello(hello) }));
  }
  return { socket, messages, closed };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe("the handshake, before any procedure", () => {
  it.each([{ features: [] }, { features: ["host.logs", "sessions"] }])(
    "bootstraps host scope and gates host operations for $features without a Workspace lookup",
    async ({ features }) => {
      const actor: HostConnectionActor = { kind: "device", deviceId: DEVICE, scope: "host" };
      const workspace = vi.fn(() => {
        throw new Error("Host scope must not look up a Workspace");
      });
      const page = { entries: [], gap: false, cursor: "ring:0" };
      const readLogs = vi.fn(() => page);
      const events: HostProtocolListenerEvent[] = [];
      const listener = await startHostProtocolListener({
        router: createSessionRouter(),
        bind: { host: "127.0.0.1", port: 0 },
        host: { id: HOST, version: "test" },
        features: SESSION_ROUTER_FEATURES,
        workspace,
        verifier: { verify: () => credential(actor).grant },
        context: () => ({
          handlers: sessionHandlersFrom({ runtime: {}, readLogs }),
          diagnostics: new RpcDiagnosticLog(),
        }),
        log: (event) => events.push(event),
      });
      cleanups.push(() => listener.close());
      const hello = buildHostHello({
        scope: "host",
        client: HELLO.client,
        credential: "host-token",
        features,
      });
      const socket = createWSClient({
        url: listener.url,
        connectionParams: encodeHostHello(hello),
      });
      cleanups.push(() => socket.close());
      const client = createTRPCClient<AppRouter>({ links: [wsLink({ client: socket })] });
      const welcome = await client.protocol.hostWelcome.query();
      expect(welcome).toStrictEqual({
        scope: "host",
        protocolVersion: 1,
        host: { id: HOST, version: "test" },
        actor,
        features: features.includes("host.logs") ? ["host.logs"] : [],
        proof: null,
      });
      expect(validateWelcome(welcome, hello)).toStrictEqual({ ok: true, welcome });
      expect(await expectHostError(client.protocol.welcome.query())).toMatchObject({
        reason: "verb-refused",
      });
      expect(
        await expectHostError(client.session.projection.query({ sessionId: "" })),
      ).toMatchObject({ code: "FORBIDDEN", reason: "workspace-scope-required" });
      if (features.includes("host.logs")) {
        expect(await client.logs.tail.query({ limit: 5 })).toStrictEqual(page);
        expect(readLogs).toHaveBeenCalledTimes(1);
        expect(readLogs).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
      } else {
        expect(await expectHostError(client.logs.tail.query({}))).toMatchObject({
          code: "FORBIDDEN",
          reason: "verb-refused",
        });
        expect(readLogs).not.toHaveBeenCalled();
      }
      expect(workspace).not.toHaveBeenCalled();
      const connected = events.find((event) => event.kind === "connected");
      expect(connected).toMatchObject({ kind: "connected", actor: "device" });
      expect(connected).not.toHaveProperty("workspaceId");
    },
  );

  it("refuses host scope on a router without the additive host bootstrap", async () => {
    const events: HostProtocolListenerEvent[] = [];
    // The Session family now has the bootstrap. A separate real listener below
    // preserves only its old protocol.welcome procedure.
    const { initTRPC } = await import("@trpc/server");
    const t = initTRPC.create();
    const original = createSessionRouter();
    // oxlint-disable-next-line no-underscore-dangle -- select the unchanged old procedure.
    const old = t.router({ "protocol.welcome": original._def.record.protocol.welcome });
    const oldListener = await startHostProtocolListener({
      router: old,
      bind: { host: "127.0.0.1", port: 0 },
      host: { id: HOST, version: "old-router" },
      features: [],
      workspace: () => {
        throw new Error("Host scope must not look up a Workspace");
      },
      verifier: {
        verify: () => ({
          actor: { kind: "device", deviceId: DEVICE, scope: "host" },
          current: () => true,
        }),
      },
      context: () => ({}) as never,
      limits: { refusedCloseMs: 20 },
      log: (event) => events.push(event),
    });
    cleanups.push(() => oldListener.close());
    const peer = await raw(
      oldListener.url,
      buildHostHello({ scope: "host", client: HELLO.client, credential: "host", features: [] }),
    );
    const [code, reason] = await peer.closed;
    expect(code).toBe(HOST_PROTOCOL_CLOSE_CODES.handshakeRefused);
    expect(reason.toString()).toBe("hello-invalid");
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "handshake-refused", reason: "hello-invalid" }),
    );
  });

  it("enforces output validation on the network door", async () => {
    const { listener } = await serve({
      context: (source) => ({
        runtime: {
          ...source.runtime,
          projection: async () =>
            ({ projection: { turnActive: "not-a-boolean" }, throughSequence: 0 }) as never,
        },
      }),
    });
    const { client } = connect(listener.url);
    await expect(client.session.projection.query({ sessionId: SESSION })).rejects.toThrow(
      "Output validation failed",
    );
  });

  it("welcomes a verified device with the negotiated welcome its client validates", async () => {
    const { listener, events } = await serve();
    const { client, hellos } = connect(listener.url, { features: ["sessions", "board"] });
    const welcome = await client.protocol.welcome.query();
    expect(welcome).toStrictEqual({
      protocolVersion: 1,
      host: { id: HOST, version: "test" },
      workspace: { id: WORKSPACE, epoch: 2 },
      actor: device,
      features: ["sessions"],
      proof: null,
    });
    expect(validateWelcome(welcome, hellos[0]!)).toStrictEqual({ ok: true, welcome });
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "connected", actor: "device", workspaceId: WORKSPACE }),
    );
  });

  it("refuses a connection that sent no hello, and runs nothing it asked for", async () => {
    const { listener, reads } = await serve();
    const { client } = connect(listener.url, null);
    expect(await expectHostError(client.session.projection.query({ sessionId: SESSION }))).toEqual({
      code: "BAD_REQUEST",
      reason: "hello-invalid",
      message: "This connection sent no valid hello.",
    });
    expect(reads).toStrictEqual([]);
  });

  it("refuses a bad credential, and opens no subscription behind it", async () => {
    const { listener, reads, listeners, events } = await serve();
    const { client } = connect(listener.url, { credential: "stolen" });
    const stream = recordSubscription((handlers) =>
      client.session.subscribe.subscribe({ sessionId: SESSION }, handlers),
    );
    const query = expectHostError(client.session.projection.query({ sessionId: SESSION }));
    expect(await query).toEqual({
      code: "UNAUTHORIZED",
      reason: "credential-invalid",
      message: "The credential is not valid.",
    });
    expect(await stream.ended).toMatchObject({
      kind: "error",
      error: { code: "UNAUTHORIZED", reason: "credential-invalid" },
    });
    expect(reads).toStrictEqual([]);
    expect(listeners.size).toBe(0);
    // The log names the refusal and never the credential.
    expect(JSON.stringify(events)).not.toContain("stolen");
    expect(events).toContainEqual(expect.objectContaining({ reason: "credential-invalid" }));
  });

  it("refuses a version range the host does not speak", async () => {
    const { listener, reads } = await serve();
    const { client } = connect(listener.url, { protocol: { min: 2, max: 3 } });
    expect(await expectHostError(client.protocol.welcome.query())).toMatchObject({
      code: "PRECONDITION_FAILED",
      reason: "protocol-version-unsupported",
    });
    expect(reads).toStrictEqual([]);
  });

  it("answers what was queued behind a refused hello, then closes with the reason", async () => {
    const { listener, reads } = await serve({ limits: { refusedCloseMs: 20 } });
    const { socket, messages, closed } = await raw(
      listener.url,
      buildHostHello({ ...HELLO, protocol: { min: 2, max: 3 } }),
    );
    socket.send(request(1, "query", "protocol.welcome", null));
    const [code, reason] = await closed;
    expect([code, reason.toString()]).toStrictEqual([
      HOST_PROTOCOL_CLOSE_CODES.handshakeRefused,
      "protocol-version-unsupported",
    ]);
    expect(messages.map(reasonOf)).toStrictEqual(["protocol-version-unsupported"]);
    expect(reads).toStrictEqual([]);
  });

  it("refuses a Workspace this host does not serve, and an epoch the client saw moved on", async () => {
    const { listener } = await serve({
      grants: {
        "device-token": credential(device).grant,
        elsewhere: credential({ ...device, workspaceId: OTHER_WORKSPACE }).grant,
      },
    });
    expect(
      await expectHostError(
        connect(listener.url, {
          credential: "elsewhere",
          workspaceId: OTHER_WORKSPACE,
        }).client.protocol.welcome.query(),
      ),
    ).toMatchObject({ code: "NOT_FOUND", reason: "workspace-unknown" });
    expect(
      await expectHostError(
        connect(listener.url, {
          lastSeen: { epoch: 3, hostId: HOST },
        }).client.protocol.welcome.query(),
      ),
    ).toMatchObject({ code: "PRECONDITION_FAILED", reason: "workspace-epoch-fenced" });
  });

  // D7: the desktop's own window is never a network actor.
  it("never lets a verifier mint the reserved local device, a lapsed grant, or a throw", async () => {
    const local = {
      actor: { kind: "device", deviceId: LOCAL_DEVICE_ID, workspaceId: WORKSPACE } as HostActor,
      current: () => true,
    };
    const lapsed = { actor: device, current: () => false };
    const { listener, reads } = await serve({
      verifier: {
        verify: ({ credential: presented }) => {
          if (presented === "throws") throw new Error("verifier down");
          return presented === "local" ? local : lapsed;
        },
      },
    });
    for (const presented of ["local", "lapsed", "throws"]) {
      expect(
        await expectHostError(
          connect(listener.url, { credential: presented }).client.protocol.welcome.query(),
        ),
      ).toMatchObject({ code: "UNAUTHORIZED", reason: "credential-invalid" });
    }
    expect(reads).toStrictEqual([]);
  });

  it("closes a connection that never says hello", async () => {
    const { listener, events } = await serve({ limits: { handshakeTimeoutMs: 30 } });
    const { closed } = await raw(listener.url, null);
    const [code] = await closed;
    expect(code).toBe(HOST_PROTOCOL_CLOSE_CODES.helloTimeout);
    expect(events).toContainEqual(expect.objectContaining({ kind: "hello-timeout" }));
  });

  it("ships no stack and no cause in a refusal, nor in a handler's failure", async () => {
    const { listener } = await serve({ limits: { refusedCloseMs: 20 } });
    const refused = await raw(listener.url, buildHostHello({ ...HELLO, credential: "stolen" }));
    refused.socket.send(
      JSON.stringify({ id: 1, method: "query", params: { path: "protocol.welcome", input: null } }),
    );
    const admitted = await raw(listener.url, buildHostHello(HELLO));
    admitted.socket.send(
      JSON.stringify({
        id: 2,
        method: "mutation",
        params: {
          path: "session.command",
          input: {
            sessionId: SESSION,
            commandId: "c",
            command: { kind: "executor.interrupt" },
          },
        },
      }),
    );
    await until(
      () => refused.messages.length >= 1 && admitted.messages.length >= 1,
      "both answers",
    );
    const text = JSON.stringify([refused.messages, admitted.messages]);
    expect(text).not.toMatch(/stack|cause|at .*\.ts|node:internal/u);
    expect(text).not.toContain("stolen");
    expect(refused.messages[0]).toMatchObject({
      id: 1,
      error: { data: { hostError: { code: "UNAUTHORIZED", reason: "credential-invalid" } } },
    });
    expect(admitted.messages[0]).toMatchObject({
      id: 2,
      error: { data: { hostError: { code: "INTERNAL_SERVER_ERROR", message: "not reached" } } },
    });
    // The refused connection is closed once it has had its answer.
    const [code, reason] = await refused.closed;
    expect([code, reason.toString()]).toStrictEqual([
      HOST_PROTOCOL_CLOSE_CODES.credentialInvalid,
      "credential-invalid",
    ]);
  });

  it("leaves a message it cannot read to tRPC, which refuses it", async () => {
    const { listener } = await serve();
    const { socket, messages } = await raw(listener.url, buildHostHello(HELLO));
    socket.send(
      JSON.stringify({ id: 1, method: "query", params: { path: "protocol.welcome", input: null } }),
    );
    await until(() => messages.length >= 1, "the welcome");
    socket.send("{not json");
    socket.send(JSON.stringify([null, 5, { id: 2, method: "subscription.stop" }]));
    await until(() => messages.length >= 2, "the parse refusal");
    expect(messages[1]).toMatchObject({ id: null, error: { data: { code: "PARSE_ERROR" } } });
  });

  it("forgets a grant whose peer left mid-handshake", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const grant = credential(device);
    let asked = false;
    const { listener } = await serve({
      verifier: {
        verify: async () => {
          asked = true;
          await held;
          return grant.grant;
        },
      },
    });
    const { socket } = await raw(listener.url, buildHostHello(HELLO));
    await until(() => asked, "the verifier to be asked");
    socket.terminate();
    await until(() => listener.connections === 0, "the peer to leave");
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(grant.watched).toBe(false);
  });
});

describe("features gate operations", () => {
  it("refuses what the negotiated features do not grant, and always answers the welcome", async () => {
    const { listener, reads } = await serve();
    const { client } = connect(listener.url, { features: ["sessions"] });
    expect((await client.protocol.welcome.query()).features).toStrictEqual(["sessions"]);
    const stream = recordSubscription((handlers) =>
      client.session.subscribe.subscribe({ sessionId: SESSION }, handlers),
    );
    expect(await stream.ended).toMatchObject({
      kind: "error",
      error: { code: "FORBIDDEN", reason: "verb-refused" },
    });
    for (const call of [
      client.session.list.query({ projectId: WORKSPACE }),
      // In no v1 feature: VC-572 names theirs.
      client.settings.experiments.query(),
    ]) {
      expect(await expectHostError(call)).toMatchObject({
        code: "FORBIDDEN",
        reason: "verb-refused",
      });
    }
    expect(reads).toStrictEqual([]);
    await expect(client.session.projection.query({ sessionId: SESSION })).resolves.toBeDefined();
  });
});

describe("resumable subscriptions", () => {
  it("resumes a dropped socket from the last event id, with no loss and no duplicate", async () => {
    const { listener, append, reads, listeners } = await serve();
    const network = await proxy(listener.address.port);
    const { client, hellos } = connect(network.url);
    const stream = recordSubscription<{ id: string; data: unknown }>((handlers) =>
      client.session.subscribe.subscribe({ sessionId: SESSION }, handlers),
    );
    await stream.started;
    await append(3);
    await stream.received(3);
    // The network drops; the host's listener for that stream goes with it.
    network.drop();
    await until(() => listeners.size === 0, "the dropped stream's listener to go");
    await append(2);
    // The client reconnects by itself, says a fresh hello, and resumes.
    await stream.received(5);
    await append(1);
    const frames = await stream.received(6);
    expect(frames.map(({ id }) => id)).toStrictEqual(["1", "2", "3", "4", "5", "6"]);
    expect(reads.filter((read) => read.startsWith("subscribe"))).toStrictEqual([
      "subscribe:0",
      "subscribe:3",
    ]);
    expect(hellos).toHaveLength(2);
    expect(hellos[0]!.nonce).not.toBe(hellos[1]!.nonce);
    stream.unsubscribe();
    await until(() => listeners.size === 0, "the runtime listener to go");
  });

  it("answers subscription-resnapshot-required past the event bound, before reading history", async () => {
    const { listener, append, reads, listeners } = await serve();
    await append(5000);
    const { client } = connect(listener.url);
    const stream = recordSubscription((handlers) =>
      client.session.subscribe.subscribe({ sessionId: SESSION, afterSequence: 903 }, handlers),
    );
    const end = await stream.ended;
    expect(end).toMatchObject({
      kind: "error",
      error: { code: "PRECONDITION_FAILED", reason: "subscription-resnapshot-required" },
    });
    expect(stream.frames).toHaveLength(0);
    expect(reads).toStrictEqual(["projection"]);
    expect(listeners.size).toBe(0);
    // 4,096 behind is still a resume, whole.
    const resumed = recordSubscription<{ id: string }>((handlers) =>
      client.session.subscribe.subscribe({ sessionId: SESSION, afterSequence: 904 }, handlers),
    );
    const replayed = await resumed.received(4096);
    expect([replayed[0]?.id, replayed.at(-1)?.id]).toStrictEqual(["905", "5000"]);
    resumed.unsubscribe();
  });

  it("answers subscription-resnapshot-required past the byte bound, having sent nothing", async () => {
    const { listener, append, listeners } = await serve();
    // 17 frames of 1 MiB: within the event bound, past the byte bound.
    await append(17, 1024 * 1024);
    const { client } = connect(listener.url);
    let refusal: unknown = null;
    const stream = recordSubscription((handlers) =>
      client.session.subscribe.subscribe(
        { sessionId: SESSION },
        { ...handlers, onError: (error) => ((refusal = error), handlers.onError(error)) },
      ),
    );
    expect(await stream.ended).toMatchObject({
      kind: "error",
      error: { code: "PRECONDITION_FAILED", reason: "subscription-resnapshot-required" },
    });
    expect(isResnapshotRequired(refusal)).toBe(true);
    expect(stream.frames).toHaveLength(0);
    expect(listeners.size).toBe(0);
  });

  it("takes lower replay bounds from its limits (hostd's, VC-700)", async () => {
    const { listener, append, listeners } = await serve({
      limits: { maxReplayEvents: 3, maxReplayBytes: 2 * 1024 * 1024 },
    });
    await append(4);
    const { client } = connect(listener.url);
    const behind = recordSubscription((handlers) =>
      client.session.subscribe.subscribe({ sessionId: SESSION, afterSequence: 0 }, handlers),
    );
    expect(await behind.ended).toMatchObject({
      error: { reason: "subscription-resnapshot-required" },
    });
    const resumed = recordSubscription<{ id: string }>((handlers) =>
      client.session.subscribe.subscribe({ sessionId: SESSION, afterSequence: 1 }, handlers),
    );
    expect((await resumed.received(3)).map(({ id }) => id)).toStrictEqual(["2", "3", "4"]);
    resumed.unsubscribe();
    await append(3, 1024 * 1024);
    const heavy = recordSubscription((handlers) =>
      client.session.subscribe.subscribe({ sessionId: SESSION, afterSequence: 4 }, handlers),
    );
    expect(await heavy.ended).toMatchObject({
      error: { reason: "subscription-resnapshot-required" },
    });
    await until(() => listeners.size === 0, "the refused streams' listeners to go");
  });

  // The ordering a Client's quiet-resnapshot guard is built on (VC-315 review,
  // B4): tRPC's WebSocket adapter says `started` once the subscription's
  // iterator exists, and the replay that refuses runs in its first `next()`.
  // `started` is therefore no proof that a resume was admitted; only an
  // emission is (`ChatSessionClient`'s `#silentReloads`).
  it("says started before a replay refusal, so started proves nothing about the replay", async () => {
    const { listener, append } = await serve();
    await append(17, 1024 * 1024);
    const { client } = connect(listener.url);
    const order: string[] = [];
    const stream = recordSubscription((handlers) =>
      client.session.subscribe.subscribe(
        { sessionId: SESSION },
        {
          ...handlers,
          onStarted: () => (order.push("started"), handlers.onStarted()),
          onData: (data) => (order.push("data"), handlers.onData(data)),
          onError: (error) => (order.push("error"), handlers.onError(error)),
        },
      ),
    );
    expect(await stream.ended).toMatchObject({
      kind: "error",
      error: { code: "PRECONDITION_FAILED", reason: "subscription-resnapshot-required" },
    });
    expect(order).toStrictEqual(["started", "error"]);
  });

  it("terminates a peer that stops reading instead of buffering for it", async () => {
    const maxOutboundBytes = 512 * 1024;
    const { listener, append, listeners, events } = await serve({
      limits: { maxOutboundBytes, maxFrameBytes: 128 * 1024 },
    });
    const { socket } = await raw(listener.url, buildHostHello(HELLO));
    socket.send(
      JSON.stringify({
        id: 1,
        method: "subscription",
        params: { path: "session.subscribe", input: { sessionId: SESSION } },
      }),
    );
    await until(() => listeners.size === 1, "the subscription to open");
    // The client's process stops reading its socket.
    // oxlint-disable-next-line no-underscore-dangle -- ws keeps its TCP socket here.
    (socket as unknown as { _socket: Socket })._socket.pause();
    const frameBytes = 64 * 1024;
    for (let round = 0; round < 1024 && listeners.size > 0; round++) {
      await append(1, frameBytes);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const shed = events.find((event) => event.kind === "slow-peer");
    expect(shed).toBeDefined();
    // Judged before each send, counting the frame: never past the bound.
    expect(shed!.kind === "slow-peer" && shed!.unsentBytes).toBeLessThanOrEqual(maxOutboundBytes);
    expect(listeners.size).toBe(0);
    await until(() => listener.connections === 0, "the peer to be gone");
  });
});

describe("revocation closes every stream", () => {
  it("ends open streams with credential-invalid, then closes the socket, on the verifier's push", async () => {
    const lever = credential(device);
    const { listener, append, listeners, events } = await serve({
      grants: { "device-token": lever.grant },
      limits: { refusedCloseMs: 20 },
    });
    const { client, closes } = connect(listener.url);
    const streams = [1, 2].map(() =>
      recordSubscription((handlers) =>
        client.session.subscribe.subscribe({ sessionId: SESSION }, handlers),
      ),
    );
    for (const stream of streams) await stream.started;
    await append(1);
    expect(lever.watched).toBe(true);
    // A push that arrives twice is one revocation.
    lever.revoke();
    lever.revoke();
    for (const stream of streams) {
      expect(await stream.ended).toMatchObject({
        kind: "error",
        error: { code: "UNAUTHORIZED", reason: "credential-invalid" },
      });
    }
    await until(() => closes.includes(HOST_PROTOCOL_CLOSE_CODES.credentialInvalid), "the close");
    await until(() => listeners.size === 0, "the runtime listeners to go");
    expect(events).toContainEqual(expect.objectContaining({ kind: "revoked" }));
    // Reconnect with the same credential over a raw socket: the stock client
    // can still be closing or reconnecting here and fail before sending a call.
    const refused = await raw(listener.url, buildHostHello(HELLO));
    refused.socket.send(request(1, "query", "protocol.welcome", null));
    const [code, reason] = await refused.closed;
    expect([code, reason.toString()]).toStrictEqual([
      HOST_PROTOCOL_CLOSE_CODES.credentialInvalid,
      "credential-invalid",
    ]);
    expect(refused.messages).toMatchObject([
      {
        id: 1,
        error: { data: { hostError: { code: "UNAUTHORIZED", reason: "credential-invalid" } } },
      },
    ]);
  });

  it("finds a grant that lapsed silently on its periodic re-check", async () => {
    const lever = credential(device, { watch: false });
    const { listener, listeners } = await serve({
      grants: { "device-token": lever.grant },
      limits: { grantRecheckMs: 10 },
    });
    const { client } = connect(listener.url);
    const stream = recordSubscription((handlers) =>
      client.session.subscribe.subscribe({ sessionId: SESSION }, handlers),
    );
    await stream.started;
    // Re-checked while it is valid, and nothing happens.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(listeners.size).toBe(1);
    lever.expire();
    expect(await stream.ended).toMatchObject({
      kind: "error",
      error: { code: "UNAUTHORIZED", reason: "credential-invalid" },
    });
    await until(() => listeners.size === 0, "the runtime listener to go");
  });
});

describe("the listener's own lifetime", () => {
  it("counts its connections and ends them all on close", async () => {
    const { listener, listeners } = await serve();
    const { client } = connect(listener.url);
    const stream = recordSubscription((handlers) =>
      client.session.subscribe.subscribe({ sessionId: SESSION }, handlers),
    );
    await stream.started;
    expect(listener.connections).toBe(1);
    expect(listener.url).toBe(`ws://127.0.0.1:${listener.address.port}`);
    await listener.close();
    await until(() => listeners.size === 0, "the runtime listener to go");
  });

  it("brackets an IPv6 loopback address in its URL", async () => {
    const listener = await startHostProtocolListener({
      router: createSessionRouter(),
      bind: { host: "::1", port: 0 },
      host: { id: HOST, version: "test" },
      features: SESSION_ROUTER_FEATURES,
      workspace: () => null,
      verifier: { verify: () => null },
      context: () => ({
        handlers: sessionHandlersFrom({ runtime: ledger().runtime }),
        diagnostics: new RpcDiagnosticLog(),
      }),
    });
    cleanups.push(() => listener.close());
    expect(listener.url).toBe(`ws://[::1]:${listener.address.port}`);
    // With no log configured, its events go nowhere, quietly.
    const { socket } = await raw(listener.url, null);
    socket.close();
    await once(socket, "close");
  });
});

/** A TCP hop the test can cut, as a network drops a connection. */
async function proxy(port: number) {
  const sockets = new Set<Socket>();
  const server = createServer((inbound) => {
    const outbound = connectTcp(port, "127.0.0.1");
    for (const side of [inbound, outbound]) {
      sockets.add(side);
      side.on("error", () => {});
      side.on("close", () => {
        inbound.destroy();
        outbound.destroy();
      });
    }
    inbound.pipe(outbound);
    outbound.pipe(inbound);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
  });
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    drop() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}

describe("isLoopbackHost", () => {
  it("admits loopback only, until VC-575", async () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "::1", "localhost"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "example.com", "127.0.0.1.example.com"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
    await expect(
      startHostProtocolListener({
        router: createSessionRouter(),
        bind: { host: "0.0.0.0", port: 0 },
        host: { id: HOST, version: "test" },
        features: SESSION_ROUTER_FEATURES,
        workspace: () => null,
        verifier: { verify: () => null },
        context: () => ({
          handlers: sessionHandlersFrom({ runtime: ledger().runtime }),
          diagnostics: new RpcDiagnosticLog(),
        }),
      }),
    ).rejects.toThrow("binds loopback only until VC-575; refusing 0.0.0.0");
  });
});

/** A port a test parks a call on, and lets go of. */
function barrier() {
  let release!: () => void;
  let entered = false;
  const held = new Promise<void>((resolve) => (release = resolve));
  return {
    get entered() {
      return entered;
    },
    async wait(): Promise<void> {
      entered = true;
      await held;
    },
    release: () => release(),
  };
}

function request(id: number | string, method: string, path: string, input: unknown): string {
  return JSON.stringify({ id, method, params: { path, input } });
}

const subscribeTo = (id: number | string, input: unknown = { sessionId: SESSION }): string =>
  request(id, "subscription", "session.subscribe", input);

/** The reason a raw answer carries, if it is a refusal. */
function reasonOf(message: unknown): string | undefined {
  return (message as { error?: { data?: { hostError?: { reason?: string } } } }).error?.data
    ?.hostError?.reason;
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a socket over budget is answered: an HTTP status, before any WebSocket exists. */
async function refusedStatus(url: string): Promise<number> {
  const socket = new WebSocket(url);
  socket.on("error", () => {});
  const [, response] = (await once(socket, "unexpected-response")) as [
    unknown,
    { statusCode: number },
  ];
  socket.terminate();
  return response.statusCode;
}

describe("revocation wins over a call still being authorized (B1)", () => {
  it("never runs a query whose authorization was parked when the grant was revoked", async () => {
    const lever = credential(device);
    const gate = barrier();
    const { listener, reads } = await serve({
      grants: { "device-token": lever.grant },
      context: () => ({
        resourceWorkspace: async () => {
          await gate.wait();
          return WORKSPACE;
        },
      }),
    });
    const { socket, closed } = await raw(listener.url, buildHostHello(HELLO));
    socket.send(request(1, "query", "session.projection", { sessionId: SESSION }));
    await until(() => gate.entered, "authorization to park");
    lever.revoke();
    gate.release();
    await closed;
    await settle();
    expect(reads).toStrictEqual([]);
  });

  it("refuses a query whose grant lapsed silently while it was authorized", async () => {
    const lever = credential(device, { watch: false });
    const gate = barrier();
    const { listener, reads } = await serve({
      grants: { "device-token": lever.grant },
      context: () => ({
        resourceWorkspace: async () => {
          await gate.wait();
          return WORKSPACE;
        },
      }),
    });
    const { client } = connect(listener.url);
    const answer = expectHostError(client.session.projection.query({ sessionId: SESSION }));
    await until(() => gate.entered, "authorization to park");
    lever.expire();
    gate.release();
    expect(await answer).toMatchObject({ code: "UNAUTHORIZED", reason: "credential-invalid" });
    expect(reads).toStrictEqual([]);
  });

  it("never accepts a mutation parked in authorization when the socket was revoked and closed", async () => {
    const lever = credential(device);
    const gate = barrier();
    const { listener, reads } = await serve({
      grants: { "device-token": lever.grant },
      context: () => ({
        resourceWorkspace: async () => {
          await gate.wait();
          return WORKSPACE;
        },
      }),
    });
    const { socket, closed } = await raw(listener.url, buildHostHello(HELLO));
    socket.send(
      request(1, "mutation", "session.command", {
        sessionId: SESSION,
        commandId: "c",
        command: { kind: "executor.interrupt" },
      }),
    );
    await until(() => gate.entered, "authorization to park");
    lever.revoke();
    await closed;
    await until(() => listener.connections === 0, "the socket to be gone");
    // The parked call resumes only after its connection is gone.
    gate.release();
    await settle();
    expect(reads).toStrictEqual([]);
  });

  it("withholds the answer of a call whose grant lapsed while its handler ran", async () => {
    const lever = credential(device, { watch: false });
    const gate = barrier();
    const { listener, reads } = await serve({
      grants: { "device-token": lever.grant },
      context: (source) => ({
        runtime: {
          ...source.runtime,
          projection: async (input) => {
            await gate.wait();
            return source.runtime.projection(input);
          },
        },
      }),
    });
    const { client } = connect(listener.url);
    const answer = expectHostError(client.session.projection.query({ sessionId: SESSION }));
    await until(() => gate.entered, "the handler to park");
    lever.expire();
    gate.release();
    expect(await answer).toMatchObject({ code: "UNAUTHORIZED", reason: "credential-invalid" });
    // It ran (it was admitted when it started); what it read never left.
    expect(reads).toStrictEqual(["projection"]);
  });
});

describe("the connection budget (B2)", () => {
  it("answers limit+1 unauthenticated peers 503 before any handshake, and frees a slot on close", async () => {
    const { listener, events } = await serve({ limits: { maxConnections: 3 } });
    const peers = [];
    for (let index = 0; index < 3; index++) peers.push(await raw(listener.url, null));
    expect(listener.connections).toBe(3);
    expect(await refusedStatus(listener.url)).toBe(503);
    expect(events).toContainEqual({ kind: "connection-refused", reason: "connection-limit" });
    // Nothing was allocated for it: no connection was ever opened or closed.
    expect(events.filter(({ kind }) => kind === "closed")).toHaveLength(0);
    expect(listener.connections).toBe(3);
    peers[0]!.socket.close();
    await until(() => listener.connections === 2, "the slot to free");
    const { client } = connect(listener.url);
    expect((await client.protocol.welcome.query()).workspace.id).toBe(WORKSPACE);
  });

  it("holds a slot for a stalled peer only until the handshake deadline", async () => {
    const { listener } = await serve({ limits: { maxConnections: 2, handshakeTimeoutMs: 60 } });
    // One never speaks HTTP; one upgrades and never says hello.
    const silent = connectTcp(listener.address.port, "127.0.0.1");
    silent.on("error", () => {});
    cleanups.push(() => silent.destroy());
    await once(silent, "connect");
    await raw(listener.url, null);
    await until(() => listener.connections === 2, "both to hold a slot");
    expect(await refusedStatus(listener.url)).toBe(503);
    await until(() => listener.connections === 0, "both stalled peers to be dropped");
    const { client } = connect(listener.url);
    expect((await client.protocol.welcome.query()).workspace.id).toBe(WORKSPACE);
  });

  it("rate-limits accepts, and admits again once the bucket refills", async () => {
    const { listener, events } = await serve({
      limits: { handshakeBurst: 2, handshakesPerSecond: 20 },
    });
    await raw(listener.url, null);
    await raw(listener.url, null);
    expect(await refusedStatus(listener.url)).toBe(503);
    expect(events).toContainEqual({ kind: "connection-refused", reason: "handshake-rate" });
    await settle(120);
    await raw(listener.url, null);
    expect(listener.connections).toBe(3);
  });

  it("answers a request that is not an upgrade 426, and nothing else", async () => {
    const { listener } = await serve();
    const response = await fetch(`http://127.0.0.1:${listener.address.port}/`);
    expect(response.status).toBe(426);
  });

  it("refuses limits that are not finite positive integers, or a frame bound outside its bounds", async () => {
    expect(() => validateListenerLimits(DEFAULT_LISTENER_LIMITS)).not.toThrow();
    for (const [limit, value] of [
      ["maxConnections", 0],
      ["maxSubscriptions", 1.5],
      ["pingMs", Number.POSITIVE_INFINITY],
      ["handshakesPerSecond", Number.NaN],
    ] as const) {
      expect(() => validateListenerLimits({ ...DEFAULT_LISTENER_LIMITS, [limit]: value })).toThrow(
        `limit ${limit} must be a positive integer`,
      );
    }
    expect(() =>
      validateListenerLimits({ ...DEFAULT_LISTENER_LIMITS, maxFrameBytes: 4096 }),
    ).toThrow("must exceed the 4096-byte frame envelope");
    expect(() =>
      validateListenerLimits({
        ...DEFAULT_LISTENER_LIMITS,
        maxOutboundBytes: DEFAULT_LISTENER_LIMITS.maxFrameBytes - 1,
      }),
    ).toThrow("maxFrameBytes must not exceed maxOutboundBytes");
    await expect(serve({ limits: { maxConnections: 0 } })).rejects.toThrow("maxConnections");
  });
});

describe("one frame is bounded (B3)", () => {
  it("refuses a live frame past the frame bound, and holds nothing for a paused peer", async () => {
    const send = WebSocket.prototype.send;
    let largestSent = 0;
    let largestBacklog = 0;
    const spy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
      this: WebSocket,
      ...args: Parameters<WebSocket["send"]>
    ) {
      const [data] = args;
      largestSent = Math.max(largestSent, typeof data === "string" ? data.length : 0);
      send.apply(this, args);
      largestBacklog = Math.max(largestBacklog, this.bufferedAmount);
    });
    cleanups.push(() => spy.mockRestore());
    const maxOutboundBytes = 128 * 1024;
    const { listener, append, listeners } = await serve({
      limits: { maxFrameBytes: 64 * 1024, maxOutboundBytes },
    });
    const { socket, messages } = await raw(listener.url, buildHostHello(HELLO));
    socket.send(subscribeTo(1));
    await until(() => listeners.size === 1, "the subscription to open");
    // oxlint-disable-next-line no-underscore-dangle -- ws keeps its TCP socket here.
    const tcp = (socket as unknown as { _socket: Socket })._socket;
    tcp.pause();
    await append(1, 8 * 1024 * 1024);
    // Then silence: the stream ended on its own, and nothing near it was enqueued.
    await until(() => listeners.size === 0 && listener.streams === 0, "the stream to end");
    expect(largestSent).toBeLessThan(64 * 1024);
    expect(largestBacklog).toBeLessThanOrEqual(maxOutboundBytes);
    expect(listener.connections).toBe(1);
    tcp.resume();
    await until(() => messages.some((message) => reasonOf(message) !== undefined), "the refusal");
    expect(messages.find((message) => reasonOf(message) !== undefined)).toMatchObject({
      id: 1,
      error: { data: { hostError: { code: "PAYLOAD_TOO_LARGE", reason: "response-too-large" } } },
    });
  });

  it("refuses an answer past the frame bound, and the connection carries on", async () => {
    const { listener, append } = await serve({ limits: { maxFrameBytes: 64 * 1024 } });
    await append(3, 40 * 1024);
    const { client } = connect(listener.url);
    expect(
      await expectHostError(client.session.snapshot.query({ sessionId: SESSION })),
    ).toMatchObject({ code: "PAYLOAD_TOO_LARGE", reason: "response-too-large" });
    await expect(client.session.projection.query({ sessionId: SESSION })).resolves.toBeDefined();
  });

  it("refuses a replay holding one frame past the frame bound, having read no further", async () => {
    const { listener, append, listeners, handed } = await serve({
      limits: { maxFrameBytes: 64 * 1024 },
    });
    await append(1, 100 * 1024);
    await append(2);
    const { client } = connect(listener.url);
    const stream = recordSubscription((handlers) =>
      client.session.subscribe.subscribe({ sessionId: SESSION }, handlers),
    );
    expect(await stream.ended).toMatchObject({
      kind: "error",
      error: { code: "PAYLOAD_TOO_LARGE", reason: "response-too-large" },
    });
    expect(stream.frames).toHaveLength(0);
    expect(handed.count).toBe(1);
    expect(listeners.size).toBe(0);
  });

  it("closes 4413, unsent, a frame the catalog could not see coming", async () => {
    const { listener, events } = await serve({ limits: { maxFrameBytes: 8 * 1024 } });
    const { socket, closed } = await raw(listener.url, buildHostHello(HELLO));
    // The client's own request id comes back in the envelope.
    socket.send(request("x".repeat(9000), "query", "protocol.welcome", null));
    const [code, reason] = await closed;
    expect([code, reason.toString()]).toStrictEqual([
      HOST_PROTOCOL_CLOSE_CODES.responseTooLarge,
      "response-too-large",
    ]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "oversized-frame" }));
  });

  it("judges the backlog before a send and again after it", () => {
    const sent: unknown[] = [];
    const reports: string[] = [];
    const socket: { -readonly [Key in keyof BoundedSocket]: BoundedSocket[Key] } & {
      closed: number | null;
      terminated: boolean;
    } = {
      bufferedAmount: 0,
      closed: null,
      terminated: false,
      send(data) {
        sent.push(data);
        // The frame's header tips the backlog past what its payload alone would.
        this.bufferedAmount += (data as { length: number }).length + 4;
      },
      terminate() {
        this.terminated = true;
      },
      close(code) {
        this.closed = code;
      },
    };
    boundOutboundSends(
      socket,
      { maxFrameBytes: 32, maxOutboundBytes: 40 },
      {
        shed: (unsent) => reports.push(`shed ${unsent}`),
        oversized: (bytes) => reports.push(`oversized ${bytes}`),
      },
    );
    socket.send(new Uint8Array(40));
    expect([socket.closed, sent]).toStrictEqual([HOST_PROTOCOL_CLOSE_CODES.responseTooLarge, []]);
    socket.send("x".repeat(30));
    expect(socket.terminated).toBe(false);
    // 34 held, 6 more fit by payload; the header takes it to 44, past 40.
    socket.send(Buffer.alloc(6));
    expect(socket.terminated).toBe(true);
    socket.terminated = false;
    // Past the bound before it is sent: never sent at all.
    socket.send("y");
    expect(socket.terminated).toBe(true);
    expect(sent).toHaveLength(2);
    expect(reports).toStrictEqual(["oversized 40", "shed 44", "shed 44"]);
  });
});

describe("subscription bookkeeping is bounded (B4)", () => {
  it("retains nothing for thousands of forbidden or completed subscriptions", async () => {
    // One credential, two connections: each watches it.
    let valid = true;
    const watchers = new Set<() => void>();
    const { listener, append, listeners, events } = await serve({
      verifier: {
        verify: () => ({
          actor: device,
          current: () => valid,
          watch: (revoked) => {
            watchers.add(revoked);
            return () => watchers.delete(revoked);
          },
        }),
      },
    });
    const forbidden = await raw(listener.url, buildHostHello({ ...HELLO, features: ["sessions"] }));
    for (let id = 1; id <= 2000; id++) forbidden.socket.send(subscribeTo(id));
    await until(() => forbidden.messages.length >= 2000, "2,000 refusals");
    expect(forbidden.messages.every((message) => reasonOf(message) === "verb-refused")).toBe(true);
    expect(listener.streams).toBe(0);

    // Completed with an error: refused past the replay bound.
    await append(SUBSCRIPTION_REPLAY_BOUNDS.events + 1);
    const resumed = await raw(listener.url, buildHostHello(HELLO));
    for (let id = 1; id <= 300; id++) resumed.socket.send(subscribeTo(id));
    await until(
      () => resumed.messages.filter((message) => reasonOf(message) !== undefined).length >= 300,
      "300 resnapshot refusals",
    );
    // Completed by the client: opened and stopped, in batches under the budget.
    for (let batch = 0; batch < 5; batch++) {
      const ids = Array.from({ length: 50 }, (_, index) => `stop-${batch}-${index}`);
      const before = resumed.messages.length;
      for (const id of ids)
        resumed.socket.send(subscribeTo(id, { sessionId: SESSION, afterSequence: 4097 }));
      await until(() => resumed.messages.length >= before + 50, "the batch to start");
      for (const id of ids)
        resumed.socket.send(JSON.stringify({ id, method: "subscription.stop" }));
      await until(() => resumed.messages.length >= before + 100, "the batch to stop");
    }
    await until(() => listener.streams === 0 && listeners.size === 0, "nothing retained");
    valid = false;
    for (const revoke of watchers) revoke();
    await until(() => listener.connections === 0, "both closed");
    expect(events.filter(({ kind }) => kind === "revoked")).toStrictEqual([
      expect.objectContaining({ streams: 0 }),
      expect.objectContaining({ streams: 0 }),
    ]);
  });

  it("refuses the subscription past the budget, frees its slot on stop, and revocation ends them all", async () => {
    const lever = credential(device);
    const { listener, listeners } = await serve({
      grants: { "device-token": lever.grant },
      limits: { maxSubscriptions: 3 },
    });
    const { client } = connect(listener.url);
    const subscribe = () =>
      recordSubscription((handlers) =>
        client.session.subscribe.subscribe({ sessionId: SESSION }, handlers),
      );
    const open = [subscribe(), subscribe(), subscribe()];
    for (const stream of open) await stream.started;
    expect(await subscribe().ended).toMatchObject({
      kind: "error",
      error: { code: "TOO_MANY_REQUESTS", reason: "subscription-limit" },
    });
    expect([listener.streams, listeners.size]).toStrictEqual([3, 3]);
    open[0]!.unsubscribe();
    await until(() => listener.streams === 2, "the slot to free");
    const again = subscribe();
    await again.started;
    lever.revoke();
    for (const stream of [...open.slice(1), again]) {
      expect(await stream.ended).toMatchObject({
        kind: "error",
        error: { code: "UNAUTHORIZED", reason: "credential-invalid" },
      });
    }
    await until(() => listener.streams === 0 && listeners.size === 0, "everything released");
  });

  it("answers a subscription sent while the credential was still being verified, on revocation", async () => {
    const lever = credential(device);
    const gate = barrier();
    const { listener, listeners } = await serve({
      verifier: {
        verify: async () => {
          await gate.wait();
          return lever.grant;
        },
      },
    });
    const { client } = connect(listener.url);
    const stream = recordSubscription((handlers) =>
      client.session.subscribe.subscribe({ sessionId: SESSION }, handlers),
    );
    await until(() => gate.entered, "verification to park");
    gate.release();
    await stream.started;
    lever.revoke();
    expect(await stream.ended).toMatchObject({
      kind: "error",
      error: { code: "UNAUTHORIZED", reason: "credential-invalid" },
    });
    await until(() => listeners.size === 0, "the runtime listener to go");
  });
});

describe("a refused replay is never buffered (B5)", () => {
  it("stops consuming at the first frame past the byte bound, having staged no more than it", async () => {
    const { listener, append, listeners, handed } = await serve();
    const padding = 512 * 1024;
    await append(40, padding);
    const { client } = connect(listener.url);
    const stream = recordSubscription((handlers) =>
      client.session.subscribe.subscribe({ sessionId: SESSION }, handlers),
    );
    expect(await stream.ended).toMatchObject({
      kind: "error",
      error: { code: "PRECONDITION_FAILED", reason: "subscription-resnapshot-required" },
    });
    expect(stream.frames).toHaveLength(0);
    // 31 frames of a little over 512 KiB fit 16 MiB; the 32nd is refused, and
    // the source hands over nothing after it.
    const admitted = Math.floor(SUBSCRIPTION_REPLAY_BOUNDS.bytes / (padding + 1024));
    expect(handed.count).toBe(admitted + 1);
    expect(handed.count).toBeLessThan(40);
    await until(() => listeners.size === 0 && listener.streams === 0, "nothing left behind");
  });

  it("stages nothing past the refusal even from a source that ignores its cancellation", async () => {
    const { listener, append, listeners, handed } = await serve({
      ignoresCancel: true,
      limits: { maxFrameBytes: 64 * 1024 },
    });
    await append(1, 100 * 1024);
    await append(3);
    const { client } = connect(listener.url);
    const stream = recordSubscription((handlers) =>
      client.session.subscribe.subscribe({ sessionId: SESSION }, handlers),
    );
    expect(await stream.ended).toMatchObject({
      kind: "error",
      error: { reason: "response-too-large" },
    });
    // Handed every frame, sent none of them.
    expect(handed.count).toBe(4);
    expect(stream.frames).toHaveLength(0);
    await until(() => listeners.size === 0, "the listener to go");
  });
});

describe("features advertise; actor policy enforces (security N1)", () => {
  it("never lets a granted feature reach an operation the actor's policy refuses", async () => {
    const sessionActor: HostActor = { kind: "session", sessionId: SESSION, workspaceId: WORKSPACE };
    const { listener, reads } = await serve({
      grants: { "session-token": credential(sessionActor).grant },
    });
    const { client } = connect(listener.url, {
      credential: "session-token",
      features: ["session.read"],
    });
    expect((await client.protocol.welcome.query()).features).toStrictEqual(["session.read"]);
    expect(
      await expectHostError(client.session.list.query({ projectId: WORKSPACE })),
    ).toMatchObject({ code: "FORBIDDEN", reason: "verb-refused" });
    expect(reads).toStrictEqual([]);
  });
});

describe("every request in its own trace (VC-699)", () => {
  const HELLO_TRACE = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" };
  const CALL_TRACE = { traceId: "a3ce929d0e0e47364bf92f3577b34da6", spanId: "0ba902b700f067aa" };

  it("handles each request inside the root's scope, with the trace its frame carried", async () => {
    const scope = new AsyncLocalStorage<HostProtocolRequest>();
    const scoped: HostProtocolRequest[] = [];
    const seen: (HostProtocolRequest | undefined)[] = [];
    const { listener, events } = await serve({
      requestScope: (inbound, handle) => {
        scoped.push(inbound);
        scope.run(inbound, handle);
      },
      context: (source) => ({
        runtime: {
          ...source.runtime,
          projection: async (input) => {
            // After an await: the scope follows the promise chain.
            await Promise.resolve();
            seen.push(scope.getStore());
            return source.runtime.projection(input);
          },
        },
      }),
    });
    const peer = await raw(listener.url, null);
    peer.socket.send(
      JSON.stringify({
        method: "connectionParams",
        data: encodeHostHello(buildHostHello(HELLO)),
        [HOST_TRACE_FIELD]: HELLO_TRACE,
      }),
    );
    const call = (id: number, trace?: unknown) => ({
      id,
      method: "query",
      params: { path: "session.projection", input: { sessionId: SESSION } },
      ...(trace === undefined ? {} : { [HOST_TRACE_FIELD]: trace }),
    });
    // A batch: each request keeps its own trace; a malformed one is none.
    peer.socket.send(JSON.stringify([call(1, CALL_TRACE), call(2, { traceId: "nope" }), call(3)]));
    peer.socket.send(JSON.stringify(call(4, HELLO_TRACE)));
    await until(() => peer.messages.length === 4, "four answers");
    expect(
      scoped.map(({ method, path, trace }) => [method, path, trace?.traceId ?? null]),
    ).toStrictEqual([
      ["connectionParams", null, HELLO_TRACE.traceId],
      ["query", "session.projection", CALL_TRACE.traceId],
      ["query", "session.projection", null],
      ["query", "session.projection", null],
      ["query", "session.projection", HELLO_TRACE.traceId],
    ]);
    expect(new Set(scoped.map(({ connection }) => connection)).size).toBe(1);
    expect(seen.map((inbound) => inbound?.trace?.traceId ?? null)).toStrictEqual([
      CALL_TRACE.traceId,
      null,
      null,
      HELLO_TRACE.traceId,
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "connected", traceId: HELLO_TRACE.traceId }),
    );
    peer.socket.close();
    await until(() => events.some(({ kind }) => kind === "closed"), "the close");
    expect(events.find(({ kind }) => kind === "closed")).toMatchObject({
      traceId: HELLO_TRACE.traceId,
    });
  });

  it("names a connection without a traced hello by its id alone, and handles requests unscoped when the root gives no scope", async () => {
    const { listener, events } = await serve();
    const { client } = connect(listener.url);
    await client.protocol.welcome.query();
    const connected = events.find(({ kind }) => kind === "connected");
    expect(connected).not.toHaveProperty("traceId");
  });

  it("reads only identifiers from a frame, and nothing from what is not a request", () => {
    expect(readRequests("text")).toBeNull();
    expect(readRequests(Buffer.from("PING"))).toBeNull();
    expect(readRequests(Buffer.from("{not json"))).toBeNull();
    expect(readRequests(Buffer.from("[]"))).toStrictEqual([]);
    expect(
      readRequests(Buffer.from('[1, {"method": 2, "params": null}, {"params": {"path": 3}}]')),
    ).toStrictEqual([
      { request: { trace: null, method: null, path: null }, method: null, trace: null, frame: 1 },
      {
        request: { trace: null, method: null, path: null },
        method: null,
        trace: null,
        frame: { method: 2, params: null },
      },
      {
        request: { trace: null, method: null, path: null },
        method: null,
        trace: null,
        frame: { params: { path: 3 } },
      },
    ]);
  });
});

describe("host.logs: the person's, never a Session's (VC-699)", () => {
  /** What one answer may hold on the default listener: its frame, less the envelope. */
  const FRAME_BUDGET = DEFAULT_LISTENER_LIMITS.maxFrameBytes - FRAME_ENVELOPE_BYTES;
  const page = {
    entries: [
      {
        cursor: "ring:1",
        record: {
          ts: "2026-10-07T00:00:00.000Z",
          level: "info" as const,
          component: "c",
          msg: "m",
        },
      },
    ],
    gap: false,
    cursor: "ring:1",
  };
  const sessionActor: HostActor = { kind: "session", sessionId: SESSION, workspaceId: WORKSPACE };

  it("answers a paired device, and refuses a Session's credential with verb-refused", async () => {
    const reads: unknown[] = [];
    const { listener } = await serve({
      grants: {
        "device-token": credential(device).grant,
        "session-token": credential(sessionActor).grant,
      },
      logs: {
        readLogs: (query) => {
          reads.push(query);
          return page;
        },
      },
    });
    const person = connect(listener.url, { features: ["host.logs"] });
    expect(await person.client.logs.tail.query({ limit: 5 })).toStrictEqual(page);
    const agent = connect(listener.url, { credential: "session-token", features: ["host.logs"] });
    expect(await expectHostError(agent.client.logs.tail.query({}))).toMatchObject({
      code: "FORBIDDEN",
      reason: "verb-refused",
    });
    // A connection that did not negotiate the feature reaches neither operation.
    const ungranted = connect(listener.url, { features: ["sessions"] });
    expect(await expectHostError(ungranted.client.logs.tail.query({}))).toMatchObject({
      code: "FORBIDDEN",
      reason: "verb-refused",
    });
    // The door's frame budget rides beside the reader's query (VC-712).
    expect(reads).toStrictEqual([{ limit: 5, maxBytes: FRAME_BUDGET }]);
  });

  it("follows the log over the wire, tracked by its newest line, and resumes after it", async () => {
    let emit!: (batch: typeof page) => void;
    const follows: unknown[] = [];
    const { listener } = await serve({
      logs: {
        followLogs: (query, onBatch) => {
          follows.push(query);
          emit = onBatch as (batch: typeof page) => void;
          return () => undefined;
        },
      },
    });
    const { client } = connect(listener.url, { features: ["host.logs"] });
    const stream = recordSubscription((handlers) =>
      client.logs.follow.subscribe({ minLevel: "info", lastEventId: "ring:0" }, handlers),
    );
    await stream.started;
    emit(page);
    expect(await stream.received(1)).toStrictEqual([{ id: "ring:1", data: page }]);
    stream.unsubscribe();
    expect(follows).toStrictEqual([{ minLevel: "info", after: "ring:0", maxBytes: FRAME_BUDGET }]);
  });

  it("hands the host a smaller listener's own frame budget (VC-712)", async () => {
    const reads: unknown[] = [];
    const { listener } = await serve({
      limits: { maxFrameBytes: 64 * 1024 },
      logs: {
        readLogs: (query) => {
          reads.push(query);
          return page;
        },
      },
    });
    const { client } = connect(listener.url, { features: ["host.logs"] });
    await client.logs.tail.query({});
    expect(reads).toStrictEqual([{ maxBytes: 64 * 1024 - FRAME_ENVELOPE_BYTES }]);
  });
});
