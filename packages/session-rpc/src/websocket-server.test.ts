// The host protocol's WebSocket listener, end to end over real loopback
// sockets: the stock tRPC client against the real handshake (VC-663).
import { once } from "node:events";
import { connect as connectTcp, createServer, type AddressInfo, type Socket } from "node:net";

import { createTRPCClient, createWSClient, wsLink, type TRPCClient } from "@trpc/client";
import {
  buildHostHello,
  encodeHostHello,
  isResnapshotRequired,
  LOCAL_DEVICE_ID,
  validateWelcome,
  type HostActor,
  type HostCredentialGrant,
  type HostCredentialVerifier,
  type HostHello,
  type HostHelloInput,
} from "@volli/host-protocol";
import { expectHostError, recordSubscription } from "@volli/host-protocol/testing";
import type {
  SessionRuntime,
  SessionStreamEmission,
  SessionStreamFrame,
} from "@volli/session-engine";
import { createSessionProjectionCheckpoint } from "@volli/shared";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { WebSocket } from "ws";

import { createSessionRouter, RpcDiagnosticLog, type AppRouter } from "./index";
import {
  HOST_PROTOCOL_CLOSE_CODES,
  isLoopbackHost,
  startHostProtocolListener,
  type HostProtocolListenerEvent,
  type HostProtocolListenerLimits,
} from "./websocket-server";

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
function ledger() {
  const frames: SessionStreamFrame[] = [];
  const listeners = new Set<(emission: SessionStreamEmission) => void | Promise<void>>();
  const reads: string[] = [];
  const projection = createSessionProjectionCheckpoint(session, []).projection;
  const runtime: SessionRuntime = {
    snapshot: async () => {
      reads.push("snapshot");
      return { projection, throughSequence: frames.length, frames: [...frames], transcript: [] };
    },
    projection: async () => {
      reads.push("projection");
      return { projection, throughSequence: frames.length };
    },
    subscribe: async ({ afterSequence }, listener) => {
      reads.push(`subscribe:${afterSequence}`);
      for (const replayed of frames.slice(afterSequence)) await listener(replayed);
      listeners.add(listener);
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
  return { runtime, frames, listeners, reads, append };
}

/** One credential the test verifier knows, and the levers that withdraw it. */
function credential(actor: HostActor, options: { watch?: boolean } = {}) {
  let valid = true;
  let push: (() => void) | null = null;
  const grant: HostCredentialGrant = {
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
    grants?: Record<string, HostCredentialGrant>;
    verifier?: HostCredentialVerifier;
    limits?: Partial<HostProtocolListenerLimits>;
  } = {},
) {
  const limits = { refusedCloseMs: 20, ...options.limits };
  const events: HostProtocolListenerEvent[] = [];
  const source = ledger();
  const grants = options.grants ?? { "device-token": credential(device).grant };
  const listener = await startHostProtocolListener({
    router: createSessionRouter(),
    bind: { host: "127.0.0.1", port: 0 },
    host: { id: HOST, version: "test" },
    workspace: async (id) => (id === WORKSPACE ? { id, epoch: 2 } : null),
    verifier: options.verifier ?? {
      verify: ({ credential: presented }) => grants[presented] ?? null,
    },
    context: () => ({
      runtime: source.runtime,
      diagnostics: new RpcDiagnosticLog(),
      resourceWorkspace: ({ id }) => (id === SESSION ? WORKSPACE : null),
    }),
    limits,
    log: (event) => events.push(event),
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

/** A raw socket, for what the stock client will not do: stall, or never say hello. */
async function raw(url: string, hello: HostHello | null) {
  const socket = new WebSocket(`${url}?connectionParams=1`);
  cleanups.push(() => socket.terminate());
  const messages: unknown[] = [];
  socket.on("message", (data) => {
    const text = data.toString();
    if (text !== "PING") messages.push(JSON.parse(text));
  });
  await once(socket, "open");
  if (hello !== null) {
    socket.send(JSON.stringify({ method: "connectionParams", data: encodeHostHello(hello) }));
  }
  return { socket, messages };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe("the handshake, before any procedure", () => {
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
    const { client, closes } = connect(listener.url, { protocol: { min: 2, max: 3 } });
    expect(await expectHostError(client.protocol.welcome.query())).toMatchObject({
      code: "PRECONDITION_FAILED",
      reason: "protocol-version-unsupported",
    });
    expect(reads).toStrictEqual([]);
    await until(() => closes.includes(HOST_PROTOCOL_CLOSE_CODES.handshakeRefused), "the close");
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
    const { socket } = await raw(listener.url, null);
    const [code] = (await once(socket, "close")) as [number];
    expect(code).toBe(HOST_PROTOCOL_CLOSE_CODES.helloTimeout);
    expect(events).toContainEqual(expect.objectContaining({ kind: "hello-timeout" }));
  });

  it("ships no stack and no cause in a refusal, nor in a handler's failure", async () => {
    const { listener } = await serve();
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
    const [code, reason] = (await once(refused.socket, "close")) as [number, Buffer];
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

  it("terminates a peer that stops reading instead of buffering for it", async () => {
    const maxOutboundBytes = 512 * 1024;
    const { listener, append, listeners, events } = await serve({ limits: { maxOutboundBytes } });
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
    // Judged before each send: never more than one frame past the bound.
    expect(shed!.kind === "slow-peer" && shed!.unsentBytes).toBeLessThan(
      maxOutboundBytes + 2 * frameBytes,
    );
    expect(listeners.size).toBe(0);
    await until(() => listener.connections === 0, "the peer to be gone");
  });
});

describe("revocation closes every stream", () => {
  it("ends open streams with credential-invalid, then closes the socket, on the verifier's push", async () => {
    const lever = credential(device);
    const { listener, append, listeners, events } = await serve({
      grants: { "device-token": lever.grant },
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
    // The reconnect the client attempts says the same credential, and is refused.
    expect(await expectHostError(client.protocol.welcome.query())).toMatchObject({
      reason: "credential-invalid",
    });
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
      workspace: () => null,
      verifier: { verify: () => null },
      context: () => ({ runtime: ledger().runtime, diagnostics: new RpcDiagnosticLog() }),
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
        workspace: () => null,
        verifier: { verify: () => null },
        context: () => ({ runtime: ledger().runtime, diagnostics: new RpcDiagnosticLog() }),
      }),
    ).rejects.toThrow("binds loopback only until VC-575; refusing 0.0.0.0");
  });
});
