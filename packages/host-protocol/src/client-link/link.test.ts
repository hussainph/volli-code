// The client host link against a real tRPC WebSocket server over real
// loopback sockets, through a TCP proxy that can drop or black-hole the
// connection the way a lid-close or a lost network does (VC-670).
import { once } from "node:events";
import { connect as connectTcp, createServer, type AddressInfo, type Socket } from "node:net";

import { createTRPCClient } from "@trpc/client";
import { initTRPC, tracked, TRPCError } from "@trpc/server";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";

import type { HostActor } from "../actor";
import { hostError, isResnapshotRequired, readHostError, type HostError } from "../errors";
import {
  HOST_PROTOCOL_CLOSE_CODES,
  negotiateFeatures,
  negotiateWelcome,
  readHostHello,
  type HostHello,
  type HostWelcome,
} from "../handshake";
import { HOST_TRACE_FIELD, type HostTrace } from "../trace";
import {
  createHostLink,
  createHostLinkRegistry,
  HOST_LINK_TIMING,
  hostLinkBackoffDelay,
  HostLinkError,
  hostLinkTrpcLink,
  validateHostLinkTiming,
  type HostLink,
  type HostLinkLogEvent,
  type HostLinkOptions,
  type HostLinkState,
  type HostLinkSubscription,
  type HostLinkSubscriptionHandlers,
} from "./index";

const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const HOST = "b7c1d2e3-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER_HOST = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const DEVICE = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
const device: HostActor = { kind: "device", deviceId: DEVICE, workspaceId: WORKSPACE };

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/* ------------------------------------------------------------- the host */

/** A refusal the server answers with `data.hostError`, as session-rpc's formatter does. */
class Refusal extends Error {
  readonly envelope: HostError;
  constructor(envelope: HostError) {
    super(envelope.message);
    this.envelope = envelope;
  }
}

function refusal(error: HostError): TRPCError {
  return new TRPCError({ code: error.code, message: error.message, cause: new Refusal(error) });
}

interface ServerConnection {
  readonly socket: NodeWebSocket;
  readonly hello: HostHello | null;
  readonly log: string[];
  revoked: boolean;
}

interface HostState {
  epoch: number;
  hostId: string;
  /** Judge the hello's fence on the host too (a real host does; a stale or lying one may not). */
  fence: boolean;
  credentials: Set<string>;
  /** Close each connection at once with this code and reason, answering nothing. */
  closeOnConnect: { code: number; reason: string } | null;
  /** Answer `protocol.welcome` with this instead of the negotiated welcome. */
  welcomeOverride: { value: unknown } | null;
  welcomeError: HostError | null;
  welcomeDelayMs: number;
  /** Never answer `protocol.welcome`. */
  welcomeHangs: boolean;
  /** The feed refuses cursors below this (`subscription-resnapshot-required`). */
  floor: number;
  /** The feed throws `subscription-overflow` once, after this many yields in one open. */
  overflowAfter: number | null;
  feedFailure: HostError | null;
  feedCompletes: boolean;
  /** A mutation waits on this before it answers. */
  hold: Promise<void> | null;
  /** Feed generators running now. */
  openFeeds: number;
  readonly mutations: unknown[];
  readonly events: { id: number; data: string }[];
  readonly connections: ServerConnection[];
}

interface Ctx {
  readonly refused: HostError | null;
  readonly welcome: HostWelcome | null;
  readonly connection: ServerConnection;
}

async function startHost(overrides: Partial<HostState> = {}) {
  const host: HostState = {
    epoch: 2,
    hostId: HOST,
    fence: true,
    credentials: new Set(["good"]),
    closeOnConnect: null,
    welcomeOverride: null,
    welcomeError: null,
    welcomeDelayMs: 0,
    welcomeHangs: false,
    floor: 0,
    overflowAfter: null,
    feedFailure: null,
    feedCompletes: false,
    hold: null,
    openFeeds: 0,
    mutations: [],
    events: [],
    connections: [],
    ...overrides,
  };
  const waiters = new Set<() => void>();
  const changed = (signal: AbortSignal | undefined) =>
    new Promise<void>((resolve) => {
      waiters.add(resolve);
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  const wakeFeeds = () => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };

  const t = initTRPC.context<Ctx>().create({
    errorFormatter: ({ shape, error }) => ({
      ...shape,
      data: {
        ...shape.data,
        hostError: error.cause instanceof Refusal ? error.cause.envelope : null,
      },
    }),
  });
  const procedure = t.procedure.use(({ ctx, path, next }) => {
    ctx.connection.log.push(path);
    if (ctx.refused !== null) throw refusal(ctx.refused);
    return next();
  });
  const router = t.router({
    protocol: t.router({
      welcome: procedure.query(async ({ ctx }) => {
        if (host.welcomeHangs) await new Promise(() => {});
        if (host.welcomeDelayMs > 0) await sleep(host.welcomeDelayMs);
        ctx.connection.log.push("welcome:answered");
        if (host.welcomeError !== null) throw refusal(host.welcomeError);
        return host.welcomeOverride === null ? ctx.welcome : host.welcomeOverride.value;
      }),
    }),
    echo: procedure.input((value) => value as string).query(({ input }) => input),
    /** Untracked: no id to resume from. */
    ticks: procedure.subscription(async function* () {
      yield "tick";
    }),
    record: procedure
      .input((value) => value as { id: string })
      .mutation(async ({ input }) => {
        host.mutations.push(input);
        if (host.hold !== null) await host.hold;
        return { recorded: input.id };
      }),
    feed: procedure
      .input((value) => (value ?? {}) as { lastEventId?: string })
      .subscription(async function* ({ input, signal, ctx }) {
        ctx.connection.log.push(`feed:${input.lastEventId ?? ""}`);
        let cursor = Number(input.lastEventId ?? 0);
        if (cursor < host.floor) {
          throw refusal(hostError("subscription-resnapshot-required", "That cursor is gone"));
        }
        let sent = 0;
        host.openFeeds += 1;
        try {
          const aborted = () => signal?.aborted === true;
          while (!aborted()) {
            if (ctx.connection.revoked) {
              throw refusal(hostError("credential-invalid", "The credential is not valid."));
            }
            for (const event of host.events.filter(({ id }) => id > cursor)) {
              if (host.overflowAfter !== null && sent >= host.overflowAfter) {
                host.overflowAfter = null;
                throw refusal(hostError("subscription-overflow", "Fell behind"));
              }
              cursor = event.id;
              sent += 1;
              yield tracked(String(event.id), event.data);
            }
            if (host.feedFailure !== null) throw refusal(host.feedFailure);
            if (host.feedCompletes) return;
            await changed(signal);
          }
        } finally {
          host.openFeeds -= 1;
        }
      }),
  });

  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  /** Every text frame a client sent, as it arrived. */
  const frames: string[] = [];
  server.on("connection", (socket) => socket.on("message", (data) => frames.push(String(data))));
  const handler = applyWSSHandler({
    wss: server,
    router,
    createContext: ({ res, info }): Ctx => {
      const hello = readHostHello(info.connectionParams);
      const connection: ServerConnection = { socket: res, hello, log: [], revoked: false };
      host.connections.push(connection);
      const refuse = (error: HostError): Ctx => {
        setTimeout(
          () =>
            res.close(
              error.reason === "credential-invalid"
                ? HOST_PROTOCOL_CLOSE_CODES.credentialInvalid
                : HOST_PROTOCOL_CLOSE_CODES.handshakeRefused,
              error.reason,
            ),
          50,
        );
        return { refused: error, welcome: null, connection };
      };
      if (host.closeOnConnect !== null) {
        res.close(host.closeOnConnect.code, host.closeOnConnect.reason);
        return { refused: hostError("hello-invalid", "closed"), welcome: null, connection };
      }
      if (hello === null) return refuse(hostError("hello-invalid", "No hello"));
      if (!host.credentials.has(hello.credential)) {
        return refuse(hostError("credential-invalid", "The credential is not valid."));
      }
      const offer = {
        host: { id: host.hostId, version: "test" },
        protocol: { min: 1, max: 1 },
        workspace: { id: WORKSPACE, epoch: host.epoch },
        features: ["feed"],
      };
      if (!host.fence) {
        const welcome: HostWelcome = {
          protocolVersion: 1,
          host: offer.host,
          workspace: offer.workspace,
          actor: device,
          features: negotiateFeatures(hello.features, offer.features),
          proof: null,
        };
        return { refused: null, welcome, connection };
      }
      const negotiated = negotiateWelcome(hello, offer, device);
      if (!negotiated.ok) return refuse(negotiated.error);
      return { refused: null, welcome: negotiated.welcome, connection };
    },
  });
  const { port } = server.address() as AddressInfo;
  const proxy = await startProxy(port);
  cleanups.push(async () => {
    await proxy.close();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    host,
    proxy,
    frames,
    url: proxy.url,
    emit(count = 1) {
      for (let index = 0; index < count; index++) {
        host.events.push({ id: host.events.length + 1, data: `event ${host.events.length + 1}` });
      }
      wakeFeeds();
    },
    /** The control plane revokes: open streams end `credential-invalid`, then 4401. */
    revoke(credential: string) {
      host.credentials.delete(credential);
      for (const connection of host.connections) {
        if (connection.hello?.credential !== credential) continue;
        connection.revoked = true;
        setTimeout(
          () =>
            connection.socket.close(
              HOST_PROTOCOL_CLOSE_CODES.credentialInvalid,
              "credential-invalid",
            ),
          30,
        );
      }
      wakeFeeds();
    },
    close(code: number, reason = "") {
      for (const connection of host.connections) connection.socket.close(code, reason);
    },
    /** tRPC's own `{ id: null, method: "reconnect" }` to every open client, as a draining host sends it. */
    requestReconnect() {
      handler.broadcastReconnectNotification();
    },
  };
}

/** Loopback TCP in front of the host: `down` refuses and drops, `blackhole` goes silent without a close. */
async function startProxy(target: number) {
  let down = false;
  const pairs = new Set<{ client: Socket; upstream: Socket }>();
  const server = createServer((client) => {
    if (down) {
      client.destroy();
      return;
    }
    const upstream = connectTcp(target, "127.0.0.1");
    const pair = { client, upstream };
    pairs.add(pair);
    client.pipe(upstream);
    upstream.pipe(client);
    const end = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    for (const socket of [client, upstream]) {
      socket.on("error", end);
      socket.on("close", end);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    /** Every connection dropped (no close frame), and new ones refused. */
    down() {
      down = true;
      for (const { client, upstream } of pairs) {
        client.destroy();
        upstream.destroy();
      }
    },
    up() {
      down = false;
    },
    /** Every open connection stops carrying bytes, with no FIN: a lid that closed. */
    blackhole() {
      for (const { client, upstream } of pairs) {
        client.unpipe(upstream);
        upstream.unpipe(client);
        client.pause();
        upstream.pause();
      }
    },
    async close() {
      for (const { client, upstream } of pairs) {
        client.destroy();
        upstream.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/* ------------------------------------------------------------- the link */

const FAST = {
  heartbeatIntervalMs: 200,
  heartbeatTimeoutMs: 100,
  handshakeTimeoutMs: 1_000,
  backoffBaseMs: 20,
  backoffCapMs: 40,
};

function link(url: string, overrides: Partial<HostLinkOptions> = {}) {
  const credentials: string[] = [];
  const states: HostLinkState[] = [];
  const created = createHostLink({
    url,
    workspaceId: WORKSPACE,
    client: { kind: "desktop", version: "test" },
    features: ["feed"],
    credential: () => {
      credentials.push("good");
      return "good";
    },
    WebSocket: NodeWebSocket as unknown as typeof WebSocket,
    timing: FAST,
    ...overrides,
  });
  created.subscribeState((state) => states.push(state));
  cleanups.push(() => created.close());
  return { link: created, credentials, states };
}

async function until<State extends HostLinkState["status"]>(
  target: HostLink,
  status: State,
  timeoutMs = 3_000,
): Promise<Extract<HostLinkState, { status: State }>> {
  const now = target.getState();
  if (now.status === status) return now as Extract<HostLinkState, { status: State }>;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${status}; at ${target.getState().status}`)),
      timeoutMs,
    );
    const stop = target.subscribeState((state) => {
      if (state.status !== status) return;
      clearTimeout(timer);
      stop();
      resolve(state as Extract<HostLinkState, { status: State }>);
    });
  });
}

async function eventually(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (condition()) return;
    await sleep(5);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A subscription's whole life, recorded. */
function record() {
  const seen: { kind: string; value?: unknown }[] = [];
  /** The tracked id each emission was handed beside it (VC-711), `null` for none. */
  const trackedIds: (string | null)[] = [];
  const handlers: HostLinkSubscriptionHandlers = {
    onStarted: () => seen.push({ kind: "started" }),
    onData: (value, meta) => {
      trackedIds.push(meta?.id ?? null);
      seen.push({ kind: "data", value });
    },
    onResnapshot: (error) => seen.push({ kind: "resnapshot", value: error }),
    onError: (error) => seen.push({ kind: "error", value: readHostError(error) }),
    onComplete: () => seen.push({ kind: "complete" }),
  };
  return {
    seen,
    tracked: trackedIds,
    handlers,
    ids: () =>
      seen.filter(({ kind }) => kind === "data").map(({ value }) => (value as { id: string }).id),
    last: () => seen.at(-1),
  };
}

async function expectRejected(call: Promise<unknown>): Promise<HostError> {
  try {
    await call;
  } catch (error) {
    return readHostError(error);
  }
  throw new Error("Expected a rejection");
}

/* ------------------------------------------------------------- the cases */

describe("the handshake, before anything else", () => {
  it("connects with a fresh hello, validates the welcome and only then is ready", async () => {
    const { url, host } = await startHost();
    const { link: subject, credentials, states } = link(url, { lastSeen: null });
    expect(subject.getState()).toStrictEqual({ status: "connecting", attempt: 0 });
    const ready = await until(subject, "ready");
    expect(ready.welcome).toMatchObject({
      host: { id: HOST },
      workspace: { id: WORKSPACE, epoch: 2 },
      actor: device,
      features: ["feed"],
    });
    expect(states.map(({ status }) => status)).toStrictEqual(["ready"]);
    expect(credentials).toHaveLength(1);
    expect(host.connections[0]!.hello).toMatchObject({
      workspaceId: WORKSPACE,
      credential: "good",
      lastSeen: null,
      client: { kind: "desktop", version: "test" },
    });
    expect(host.connections[0]!.log).toStrictEqual(["protocol.welcome", "welcome:answered"]);
    expect(await subject.query("echo", "hi")).toBe("hi");
  });

  it("asks the provider for the credential on every connect, and pins the epoch it accepted", async () => {
    const { url, host, proxy } = await startHost();
    let issued = 0;
    const { link: subject } = link(url, {
      credential: async () => {
        issued += 1;
        host.credentials.add(`token-${issued}`);
        return `token-${issued}`;
      },
    });
    await until(subject, "ready");
    proxy.down();
    await until(subject, "unreachable");
    proxy.up();
    await until(subject, "ready");
    expect(host.connections.map(({ hello }) => hello?.credential)).toStrictEqual([
      "token-1",
      "token-2",
    ]);
    expect(host.connections[1]!.hello!.lastSeen).toStrictEqual({ epoch: 2, hostId: HOST });
    expect(host.connections[0]!.hello!.nonce).not.toBe(host.connections[1]!.hello!.nonce);
  });

  it("resubscribes only after the welcome validated", async () => {
    const started = await startHost();
    const { link: subject } = link(started.url);
    await until(subject, "ready");
    const feed = record();
    subject.subscribe("feed", undefined, feed.handlers);
    started.emit(1);
    await eventually(() => feed.ids().length === 1, "the first event");
    started.host.welcomeDelayMs = 150;
    started.proxy.down();
    await until(subject, "unreachable");
    started.proxy.up();
    await until(subject, "ready");
    await eventually(() => started.host.connections[1]!.log.includes("feed"), "the resubscribe");
    // Had the stream gone out beside the welcome, the host would have logged
    // it while the welcome was still being answered.
    expect(started.host.connections[1]!.log.slice(0, 3)).toStrictEqual([
      "protocol.welcome",
      "welcome:answered",
      "feed",
    ]);
  });

  it("opens a subscription made while connecting once the welcome validates", async () => {
    const started = await startHost({ welcomeDelayMs: 50 });
    const { link: subject } = link(started.url);
    const feed = record();
    subject.subscribe("feed", undefined, feed.handlers);
    started.emit(2);
    await until(subject, "ready");
    await eventually(() => feed.ids().length === 2, "both events");
    expect(started.host.connections[0]!.log.slice(0, 2)).toStrictEqual([
      "protocol.welcome",
      "welcome:answered",
    ]);
  });

  it("refuses a welcome that fails validation, and closes", async () => {
    const { url, host } = await startHost({ welcomeOverride: { value: { garbage: true } } });
    const { link: subject } = link(url);
    const refused = await until(subject, "refused");
    expect(refused.error).toMatchObject({ code: "BAD_GATEWAY", reason: "welcome-invalid" });
    expect(refused.closeCode).toBeNull();
    await eventually(
      () => host.connections[0]!.socket.readyState === NodeWebSocket.CLOSED,
      "the socket to close",
    );
  });

  it("judges the welcome's proof through verifyProof", async () => {
    const { url } = await startHost();
    const verifyProof = vi.fn(() => hostError("welcome-invalid", "Unsigned"));
    const { link: subject } = link(url, { verifyProof });
    expect((await until(subject, "refused")).error.message).toBe("Unsigned");
    expect(verifyProof).toHaveBeenCalledOnce();
  });

  it("retries a welcome the host failed to answer for any other reason", async () => {
    const { url, host } = await startHost({
      welcomeError: hostError("subscription-source-failed", "Busy"),
    });
    const { link: subject } = link(url);
    const unreachable = await until(subject, "unreachable");
    expect(unreachable.error).toMatchObject({ reason: "subscription-source-failed" });
    host.welcomeError = null;
    await until(subject, "ready");
  });

  it("gives up on a handshake that never completes", async () => {
    const { url, host } = await startHost({ welcomeHangs: true });
    const { link: subject } = link(url, { timing: { ...FAST, handshakeTimeoutMs: 150 } });
    const unreachable = await until(subject, "unreachable");
    expect(unreachable.error).toMatchObject({
      reason: "host-unreachable",
      message: "The host did not complete the handshake within 150 ms",
    });
    host.welcomeHangs = false;
    await until(subject, "ready");
  });

  it("is unreachable while the credential provider fails, and retries it", async () => {
    const { url } = await startHost();
    let fails = true;
    const { link: subject } = link(url, {
      credential: () => {
        if (fails) throw new Error("control plane down");
        return "good";
      },
    });
    expect((await until(subject, "unreachable")).error.message).toBe(
      "No credential for the host: control plane down",
    );
    fails = false;
    await until(subject, "ready");
  });

  it("reads a provider that throws a non-Error", async () => {
    const { url } = await startHost();
    const { link: subject } = link(url, {
      credential: () => Promise.reject("nope"),
    });
    expect((await until(subject, "unreachable")).error.message).toBe(
      "No credential for the host: nope",
    );
  });

  it("is unreachable when nothing listens", async () => {
    const { url, proxy } = await startHost();
    proxy.down();
    const { link: subject } = link(url);
    const unreachable = await until(subject, "unreachable");
    expect(unreachable.error.reason).toBe("host-unreachable");
    expect(unreachable.attempt).toBe(1);
  });
});

describe("refusals and fences surface as typed states", () => {
  it("surfaces a credential refusal the host answered", async () => {
    const { url, host } = await startHost({ credentials: new Set() });
    const { link: subject } = link(url);
    const refused = await until(subject, "refused");
    expect(refused.error).toStrictEqual({
      code: "UNAUTHORIZED",
      reason: "credential-invalid",
      message: "The credential is not valid.",
    });
    // Terminal: nothing retries it.
    await sleep(100);
    expect(host.connections).toHaveLength(1);
    expect(subject.getState().status).toBe("refused");
  });

  it.each([
    [4401, "credential-invalid", "refused", { code: "UNAUTHORIZED", reason: "credential-invalid" }],
    [4401, "", "refused", { code: "UNAUTHORIZED", reason: "credential-invalid" }],
    [4400, "hello-invalid", "refused", { code: "BAD_REQUEST", reason: "hello-invalid" }],
    [4400, "something new", "refused", { code: "BAD_REQUEST" }],
    [
      4400,
      "workspace-split-brain",
      "fenced",
      { code: "CONFLICT", reason: "workspace-split-brain" },
    ],
  ] as const)("reads close %i %j before any answer as %s", async (code, reason, status, error) => {
    const { url } = await startHost({ closeOnConnect: { code, reason } });
    const { link: subject } = link(url);
    const state = await until(subject, status);
    expect(state.error).toMatchObject(error);
    if (state.status === "refused") expect(state.closeCode).toBe(code);
    expect(state.error.message).toBe(
      reason === ""
        ? "The host refused the handshake"
        : `The host refused the handshake: ${reason}`,
    );
  });

  it("reads a welcome refusal no handshake names as a fault, and retries it", async () => {
    const { url, host } = await startHost({
      welcomeError: hostError("operation-unavailable", "Not here"),
    });
    const { link: subject } = link(url);
    const state = await until(subject, "unreachable");
    expect(state).toMatchObject({ closeCode: null, error: { reason: "operation-unavailable" } });
    host.welcomeError = null;
    await until(subject, "ready");
  });

  it("fails calls and subscriptions with the refusal, and retries only when asked", async () => {
    const { url, host } = await startHost({ credentials: new Set() });
    const { link: subject } = link(url);
    await until(subject, "refused");
    expect(await expectRejected(subject.mutate("record", { id: "a" }))).toMatchObject({
      reason: "credential-invalid",
    });
    const feed = record();
    subject.subscribe("feed", undefined, feed.handlers);
    await eventually(() => feed.seen.length === 1, "the refusal");
    expect(feed.last()).toMatchObject({ kind: "error", value: { reason: "credential-invalid" } });
    subject.wake("network-online");
    expect(subject.getState().status).toBe("refused");
    host.credentials.add("good");
    subject.reconnect();
    await until(subject, "ready");
    expect(host.mutations).toStrictEqual([]);
  });

  it("fences a host whose epoch went backwards, and resubscribes nothing", async () => {
    const started = await startHost({ fence: false });
    const { link: subject } = link(started.url);
    await until(subject, "ready");
    const feed = record();
    subject.subscribe("feed", undefined, feed.handlers);
    await eventually(() => started.host.connections[0]!.log.includes("feed"), "the stream");
    started.host.epoch = 1;
    started.proxy.down();
    started.proxy.up();
    const fenced = await until(subject, "fenced");
    expect(fenced.error.reason).toBe("workspace-epoch-fenced");
    expect(started.host.connections[1]!.log).toStrictEqual([
      "protocol.welcome",
      "welcome:answered",
    ]);
    expect(feed.last()).toMatchObject({
      kind: "error",
      value: { reason: "workspace-epoch-fenced" },
    });
    expect(await expectRejected(subject.query("echo", "x"))).toMatchObject({
      reason: "workspace-epoch-fenced",
    });
  });

  it("fences a split brain the host itself refuses", async () => {
    const started = await startHost();
    const { link: subject } = link(started.url, { lastSeen: { epoch: 2, hostId: OTHER_HOST } });
    const fenced = await until(subject, "fenced");
    expect(fenced.error).toMatchObject({ code: "CONFLICT", reason: "workspace-split-brain" });
    started.host.hostId = OTHER_HOST;
    subject.reconnect();
    await until(subject, "ready");
  });
});

describe("liveness", () => {
  it("finds a dead socket within the heartbeat window, and fails the call in flight", async () => {
    const started = await startHost();
    const { link: subject } = link(started.url);
    await until(subject, "ready");
    started.host.hold = new Promise(() => {});
    const call = expectRejected(subject.mutate("record", { id: "a" }));
    await eventually(() => started.host.mutations.length === 1, "the mutation to arrive");
    const silent = Date.now();
    started.proxy.blackhole();
    const unreachable = await until(subject, "unreachable");
    const window = FAST.heartbeatIntervalMs + FAST.heartbeatTimeoutMs;
    expect(Date.now() - silent).toBeLessThan(window + 400);
    expect(unreachable.error.message).toBe("The host did not answer a heartbeat within 100 ms");
    expect(await call).toMatchObject({ code: "SERVICE_UNAVAILABLE", reason: "host-unreachable" });
  });

  it("keeps a quiet but live socket: the heartbeat is answered", async () => {
    const { url } = await startHost();
    const { link: subject, states } = link(url);
    await until(subject, "ready");
    await sleep(FAST.heartbeatIntervalMs * 3);
    expect(states.map(({ status }) => status)).toStrictEqual(["ready"]);
  });

  it("probes at once on power resume", async () => {
    const started = await startHost();
    const { link: subject } = link(started.url, {
      timing: { ...FAST, heartbeatIntervalMs: 60_000 },
    });
    await until(subject, "ready");
    started.proxy.blackhole();
    const woke = Date.now();
    subject.wake("power-resume");
    subject.wake("power-resume");
    await until(subject, "unreachable");
    expect(Date.now() - woke).toBeLessThan(FAST.heartbeatTimeoutMs + 400);
  });

  it("reconnects at once when the network returns", async () => {
    const started = await startHost();
    const { link: subject } = link(started.url, {
      timing: { ...FAST, backoffBaseMs: 60_000, backoffCapMs: 60_000 },
    });
    await until(subject, "ready");
    started.proxy.down();
    const waiting = await until(subject, "unreachable");
    expect(waiting.retryAt - Date.now()).toBeGreaterThan(20_000);
    started.proxy.up();
    subject.wake("network-online");
    expect(subject.getState()).toStrictEqual({ status: "connecting", attempt: 0 });
    await until(subject, "ready", 1_000);
  });

  it("ignores a wake while an attempt is in flight", async () => {
    const { url } = await startHost({ welcomeDelayMs: 50 });
    const { link: subject, states } = link(url);
    subject.wake("network-online");
    await until(subject, "ready");
    expect(states.map(({ status }) => status)).toStrictEqual(["ready"]);
  });

  it("backs off within bounds, and resets on a validated welcome", async () => {
    const started = await startHost();
    started.proxy.down();
    const { link: subject, states } = link(started.url, {
      timing: { ...FAST, backoffBaseMs: 40, backoffCapMs: 80 },
      random: () => 0.999,
    });
    const delays: number[] = [];
    subject.subscribeState((state) => {
      if (state.status === "unreachable") delays.push(state.retryAt - Date.now());
    });
    await eventually(() => delays.length >= 4, "four failures");
    // Upper half of 40, 80, 80, 80: the ceiling doubles to the cap and stays.
    for (const [index, delay] of delays.slice(0, 4).entries()) {
      const ceiling = Math.min(80, 40 * 2 ** index);
      expect(delay).toBeGreaterThanOrEqual(ceiling / 2 - 5);
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
    started.proxy.up();
    await until(subject, "ready");
    started.proxy.down();
    const after = await until(subject, "unreachable");
    expect(after.attempt).toBe(1);
    expect(states.filter(({ status }) => status === "connecting")).toContainEqual({
      status: "connecting",
      attempt: 3,
    });
  });

  it("reconnects after a 4413 close, and says why", async () => {
    const started = await startHost();
    const { link: subject } = link(started.url);
    await until(subject, "ready");
    started.close(HOST_PROTOCOL_CLOSE_CODES.responseTooLarge, "response-too-large");
    const unreachable = await until(subject, "unreachable");
    expect(unreachable).toMatchObject({
      closeCode: 4413,
      error: { code: "PAYLOAD_TOO_LARGE", reason: "response-too-large" },
    });
    await until(subject, "ready");
  });

  it("reads any other close as a drop with its code", async () => {
    const started = await startHost();
    const { link: subject } = link(started.url);
    await until(subject, "ready");
    started.close(4000, "bye");
    expect((await until(subject, "unreachable")).error.message).toBe(
      "The host closed the connection (4000): bye",
    );
    await until(subject, "ready");
    started.close(1000);
    expect((await until(subject, "unreachable")).error.message).toBe(
      "The host closed the connection (1000)",
    );
  });
});

describe("calls never queue", () => {
  it("fails a mutation at once while connecting, and never sends it", async () => {
    const { url, host } = await startHost({ welcomeDelayMs: 50 });
    const { link: subject } = link(url);
    expect(await expectRejected(subject.mutate("record", { id: "early" }))).toStrictEqual({
      code: "SERVICE_UNAVAILABLE",
      reason: "host-unreachable",
      message: "The host link has no open connection",
    });
    await until(subject, "ready");
    await sleep(30);
    expect(host.mutations).toStrictEqual([]);
  });

  it("sends nothing after a reconnect: the mutation in flight fails, and one while down fails fast", async () => {
    const started = await startHost();
    const { link: subject } = link(started.url);
    await until(subject, "ready");
    started.host.hold = new Promise(() => {});
    const inflight = expectRejected(subject.mutate("record", { id: "in-flight" }));
    await eventually(() => started.host.mutations.length === 1, "the mutation to arrive");
    started.proxy.down();
    expect(await inflight).toMatchObject({
      reason: "host-unreachable",
      message:
        "The connection to the host ended before it answered; whether the call took effect is unknown",
    });
    await until(subject, "unreachable");
    expect(await expectRejected(subject.mutate("record", { id: "while-down" }))).toMatchObject({
      reason: "host-unreachable",
      message: expect.stringMatching(/^The host is unreachable: /u),
    });
    started.host.hold = null;
    started.proxy.up();
    await until(subject, "ready");
    await sleep(50);
    expect(started.host.mutations).toStrictEqual([{ id: "in-flight" }]);
    expect(await subject.mutate("record", { id: "after" })).toStrictEqual({ recorded: "after" });
    expect(started.host.connections[1]!.log).toStrictEqual([
      "protocol.welcome",
      "welcome:answered",
      "record",
    ]);
  });

  it("passes the host's own refusal of a call through", async () => {
    const { url } = await startHost();
    const { link: subject } = link(url);
    await until(subject, "ready");
    const error = await subject.query("missing", null).catch((caught: unknown) => caught);
    expect(readHostError(error).code).toBe("NOT_FOUND");
  });

  it("fails a call whose send fails, without waiting for the socket", async () => {
    const { url } = await startHost();
    const { link: subject } = link(url, { WebSocket: failingSends(/"echo"/u) });
    await until(subject, "ready");
    expect(await expectRejected(subject.query("echo", "x"))).toMatchObject({
      reason: "host-unreachable",
    });
  });
});

describe("subscriptions resume, resnapshot or end", () => {
  it("resumes from the last id with no loss and no duplicate", async () => {
    const started = await startHost();
    const { link: subject } = link(started.url);
    await until(subject, "ready");
    const feed = record();
    subject.subscribe("feed", undefined, feed.handlers);
    started.emit(3);
    await eventually(() => feed.ids().length === 3, "three events");
    started.proxy.down();
    await until(subject, "unreachable");
    started.emit(2);
    started.proxy.up();
    await until(subject, "ready");
    await eventually(() => feed.ids().length === 5, "the replay");
    started.emit(1);
    await eventually(() => feed.ids().length === 6, "the live event");
    expect(feed.ids()).toStrictEqual(["1", "2", "3", "4", "5", "6"]);
    // Each tracked emission names its id beside it, for an owner that resumes it.
    expect(feed.tracked).toStrictEqual(["1", "2", "3", "4", "5", "6"]);
    expect(started.host.connections[1]!.log).toContain("feed:3");
    expect(feed.seen.filter(({ kind }) => kind === "started")).toHaveLength(2);
  });

  it("passes an untracked emission through without a cursor", async () => {
    const started = await startHost();
    const { link: subject } = link(started.url);
    const ticks = record();
    subject.subscribe("ticks", undefined, ticks.handlers);
    await eventually(() => ticks.last()?.kind === "complete", "the tick");
    expect(ticks.seen).toStrictEqual([
      { kind: "started" },
      { kind: "data", value: "tick" },
      { kind: "complete" },
    ]);
    expect(ticks.tracked).toStrictEqual([null]);
  });

  it("starts from a cursor the subscriber already applied", async () => {
    const started = await startHost();
    started.emit(3);
    const { link: subject } = link(started.url);
    const feed = record();
    subject.subscribe("feed", undefined, feed.handlers, { lastEventId: "2" });
    await eventually(() => feed.ids().length === 1, "the event after the cursor");
    expect(feed.ids()).toStrictEqual(["3"]);
  });

  it("calls onResnapshot when the cursor cannot be resumed, and nothing after", async () => {
    const started = await startHost();
    const { link: subject } = link(started.url);
    await until(subject, "ready");
    const feed = record();
    subject.subscribe("feed", undefined, feed.handlers);
    started.emit(2);
    await eventually(() => feed.ids().length === 2, "two events");
    started.proxy.down();
    await until(subject, "unreachable");
    started.host.floor = 5;
    started.proxy.up();
    await until(subject, "ready");
    await eventually(() => feed.last()?.kind === "resnapshot", "the resnapshot");
    expect(isResnapshotRequired(feed.last()!.value)).toBe(true);
    expect(feed.last()!.value).toMatchObject({
      code: "PRECONDITION_FAILED",
      reason: "subscription-resnapshot-required",
    });
    started.emit(1);
    started.proxy.down();
    // Down first: the link is still "ready" until the drop reaches it.
    await until(subject, "unreachable");
    started.proxy.up();
    await until(subject, "ready");
    await sleep(50);
    expect(feed.seen.filter(({ kind }) => kind === "resnapshot")).toHaveLength(1);
    expect(started.host.connections[2]!.log).not.toContainEqual(expect.stringMatching(/^feed/u));
  });

  it("resumes after an overflow that made progress, and surfaces one that made none", async () => {
    const started = await startHost();
    const { link: subject } = link(started.url);
    await until(subject, "ready");
    started.host.overflowAfter = 2;
    const feed = record();
    const first = subject.subscribe("feed", undefined, feed.handlers);
    started.emit(3);
    await eventually(() => feed.ids().length === 3, "all three, across the overflow");
    expect(feed.ids()).toStrictEqual(["1", "2", "3"]);
    first.unsubscribe();
    await eventually(() => started.host.openFeeds === 0, "the first stream to stop");
    started.host.overflowAfter = 0;
    const stuck = record();
    subject.subscribe("feed", undefined, stuck.handlers, { lastEventId: "3" });
    started.emit(1);
    await eventually(() => stuck.last()?.kind === "error", "the overflow");
    expect(stuck.last()!.value).toMatchObject({ reason: "subscription-overflow" });
  });

  it("ends on a failure it does not recover, and on a clean completion", async () => {
    const started = await startHost();
    const { link: subject } = link(started.url);
    await until(subject, "ready");
    started.host.feedFailure = hostError("subscription-source-failed", "Source gone");
    const failing = record();
    subject.subscribe("feed", undefined, failing.handlers);
    await eventually(() => failing.last()?.kind === "error", "the failure");
    expect(failing.last()!.value).toMatchObject({ reason: "subscription-source-failed" });
    started.host.feedFailure = null;
    started.host.feedCompletes = true;
    const completing = record();
    subject.subscribe("feed", undefined, completing.handlers);
    await eventually(() => completing.last()?.kind === "complete", "the completion");
    // Ended streams are not resumed by the next connection.
    started.proxy.down();
    // Down first: the link is still "ready" until the drop reaches it.
    await until(subject, "unreachable");
    started.proxy.up();
    await until(subject, "ready");
    await sleep(50);
    expect(started.host.connections[1]!.log).toStrictEqual([
      "protocol.welcome",
      "welcome:answered",
    ]);
  });

  it("keeps a stream across a revocation and resumes it with a fresh credential", async () => {
    const started = await startHost();
    let issued = 0;
    const { link: subject } = link(started.url, {
      credential: () => {
        issued += 1;
        started.host.credentials.add(`token-${issued}`);
        return `token-${issued}`;
      },
    });
    await until(subject, "ready");
    const feed = record();
    subject.subscribe("feed", undefined, feed.handlers);
    started.emit(1);
    await eventually(() => feed.ids().length === 1, "the first event");
    started.revoke("token-1");
    const revoked = await until(subject, "unreachable");
    expect(revoked).toMatchObject({
      closeCode: 4401,
      error: {
        reason: "credential-invalid",
        message: "The host revoked this connection: credential-invalid",
      },
    });
    await until(subject, "ready");
    started.emit(1);
    await eventually(() => feed.ids().length === 2, "the resumed stream");
    expect(feed.seen.some(({ kind }) => kind === "error")).toBe(false);
  });

  it("is refused when the fresh credential is refused too", async () => {
    const started = await startHost();
    const { link: subject } = link(started.url);
    await until(subject, "ready");
    const feed = record();
    subject.subscribe("feed", undefined, feed.handlers);
    await eventually(() => started.host.connections[0]!.log.includes("feed"), "the stream");
    started.revoke("good");
    await until(subject, "refused");
    expect(feed.last()).toMatchObject({ kind: "error", value: { reason: "credential-invalid" } });
  });

  it("resumes a stream whose send failed on the next connection", async () => {
    const started = await startHost();
    let failing = true;
    const { link: subject } = link(started.url, {
      WebSocket: failingSends(/"feed"/u, () => failing),
    });
    await until(subject, "ready");
    const feed = record();
    subject.subscribe("feed", undefined, feed.handlers);
    started.emit(1);
    await sleep(50);
    expect(feed.seen).toStrictEqual([]);
    failing = false;
    started.proxy.down();
    started.proxy.up();
    await eventually(() => feed.ids().length === 1, "the stream on the next connection");
  });

  it("waits for the close or the timeout when the welcome's send fails", async () => {
    const { url } = await startHost();
    const { link: subject } = link(url, {
      WebSocket: failingSends(/protocol\.welcome/u),
      timing: { ...FAST, handshakeTimeoutMs: 100 },
    });
    expect((await until(subject, "unreachable")).error.message).toMatch(/handshake/u);
  });

  it("holds a stream subscribed while the socket is closing for the next connection", async () => {
    const started = await startHost();
    const sockets: NodeWebSocket[] = [];
    class Spy extends NodeWebSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    const { link: subject } = link(started.url, { WebSocket: Spy as unknown as typeof WebSocket });
    await until(subject, "ready");
    started.emit(1);
    sockets[0]!.close();
    const feed = record();
    subject.subscribe("feed", undefined, feed.handlers);
    expect(await expectRejected(subject.query("echo", "x"))).toMatchObject({
      reason: "host-unreachable",
    });
    await eventually(() => feed.ids().length === 1, "the stream on the next connection");
    expect(sockets).toHaveLength(2);
    expect(started.host.connections[0]!.log).not.toContain("feed");
  });

  it("stops a stream on unsubscribe, and the next connection does not resume it", async () => {
    const started = await startHost();
    const { link: subject } = link(started.url);
    await until(subject, "ready");
    const feed = record();
    const subscription = subject.subscribe("feed", undefined, feed.handlers);
    await eventually(() => feed.seen.length === 1, "the start");
    subscription.unsubscribe();
    subscription.unsubscribe();
    started.emit(1);
    started.proxy.down();
    // Down first: the link is still "ready" until the drop reaches it.
    await until(subject, "unreachable");
    started.proxy.up();
    await until(subject, "ready");
    await sleep(50);
    expect(feed.ids()).toStrictEqual([]);
    expect(started.host.connections[1]!.log).toStrictEqual([
      "protocol.welcome",
      "welcome:answered",
    ]);
  });
});

describe("the owner", () => {
  it("closes: calls in flight fail, streams end silently, nothing reconnects", async () => {
    const started = await startHost();
    const { link: subject } = link(started.url);
    await until(subject, "ready");
    const feed = record();
    subject.subscribe("feed", undefined, feed.handlers);
    started.host.hold = new Promise(() => {});
    const inflight = expectRejected(subject.mutate("record", { id: "a" }));
    await eventually(() => started.host.mutations.length === 1, "the mutation");
    subject.close();
    subject.close();
    expect(subject.getState()).toStrictEqual({ status: "closed" });
    expect((await inflight).reason).toBe("host-unreachable");
    expect(await expectRejected(subject.query("echo", "x"))).toMatchObject({
      message: "The host link is closed",
    });
    const late = record();
    subject.subscribe("feed", undefined, late.handlers);
    await eventually(() => late.seen.length === 1, "the refusal");
    expect(late.last()).toMatchObject({ kind: "error", value: { reason: "host-unreachable" } });
    subject.wake("power-resume");
    subject.reconnect();
    await sleep(50);
    expect(feed.seen.filter(({ kind }) => kind !== "started")).toStrictEqual([]);
    expect(started.host.connections).toHaveLength(1);
  });

  it("closes while the credential provider fails, and the failure does nothing", async () => {
    const { url, host } = await startHost();
    let fail!: (error: Error) => void;
    const { link: subject } = link(url, {
      credential: () => new Promise<string>((_resolve, reject) => (fail = reject)),
    });
    await sleep(10);
    subject.close();
    fail(new Error("late"));
    await sleep(20);
    expect(subject.getState().status).toBe("closed");
    expect(host.connections).toHaveLength(0);
  });

  it("closes during an attempt, and the attempt does nothing", async () => {
    const { url, host } = await startHost();
    let release!: (credential: string) => void;
    const { link: subject } = link(url, {
      credential: () => new Promise<string>((resolve) => (release = resolve)),
    });
    await sleep(10);
    subject.close();
    release("good");
    await sleep(50);
    expect(host.connections).toHaveLength(0);
    expect(subject.getState().status).toBe("closed");
  });

  it("ignores reconnect while ready, and stops telling a listener that left", async () => {
    const { url, host } = await startHost();
    const { link: subject } = link(url);
    const heard: string[] = [];
    const stop = subject.subscribeState((state) => heard.push(state.status));
    await until(subject, "ready");
    subject.reconnect();
    stop();
    subject.close();
    expect(heard).toStrictEqual(["ready"]);
    expect(host.connections).toHaveLength(1);
  });

  it("refuses a URL that is not a WebSocket, and timing that is not sane", () => {
    const base = {
      workspaceId: WORKSPACE,
      client: { kind: "desktop", version: "test" },
      features: [],
      credential: () => "x",
    } as const;
    expect(() => createHostLink({ ...base, url: "http://127.0.0.1:1" })).toThrow(
      "A host link speaks ws: or wss:, not http:",
    );
    expect(() =>
      createHostLink({ ...base, url: "ws://127.0.0.1:1", timing: { heartbeatIntervalMs: 0 } }),
    ).toThrow("Host link timing heartbeatIntervalMs must be a positive integer");
    expect(() =>
      createHostLink({
        ...base,
        url: "ws://127.0.0.1:1",
        timing: { backoffBaseMs: 20, backoffCapMs: 10 },
      }),
    ).toThrow("Host link backoffBaseMs must not exceed backoffCapMs");
  });

  it("uses the platform WebSocket when none is injected", async () => {
    const { url } = await startHost();
    vi.stubGlobal("WebSocket", NodeWebSocket);
    cleanups.push(() => vi.unstubAllGlobals());
    const subject = createHostLink({
      url,
      workspaceId: WORKSPACE,
      client: { kind: "desktop", version: "test" },
      features: [],
      credential: () => "good",
    });
    cleanups.push(() => subject.close());
    await until(subject, "ready");
  });
});

describe("the backoff and timing policy", () => {
  it("doubles from the base to the cap, in the upper half of each ceiling", () => {
    const timing = { backoffBaseMs: 500, backoffCapMs: 10_000 };
    expect(
      [1, 2, 3, 4, 5, 6, 7].map((n) => hostLinkBackoffDelay(n, timing, () => 0)),
    ).toStrictEqual([250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]);
    expect([1, 6, 100].map((n) => hostLinkBackoffDelay(n, timing, () => 1))).toStrictEqual([
      500, 10_000, 10_000,
    ]);
    expect(hostLinkBackoffDelay(0, timing, () => 2)).toBe(500);
    expect(hostLinkBackoffDelay(1, timing, () => -1)).toBe(250);
    const jittered = hostLinkBackoffDelay(3, timing);
    expect(jittered).toBeGreaterThanOrEqual(1_000);
    expect(jittered).toBeLessThanOrEqual(2_000);
  });

  it("ships the documented defaults", () => {
    expect(HOST_LINK_TIMING).toStrictEqual({
      heartbeatIntervalMs: 5_000,
      heartbeatTimeoutMs: 2_000,
      handshakeTimeoutMs: 10_000,
      backoffBaseMs: 500,
      backoffCapMs: 10_000,
    });
    expect(() => validateHostLinkTiming(HOST_LINK_TIMING)).not.toThrow();
  });
});

describe("one link per Workspace", () => {
  it("shares a Workspace's link, fans a wake out, and forgets a closed one", () => {
    const made: string[] = [];
    const fake = (workspaceId: string): HostLink => {
      made.push(workspaceId);
      let status: HostLinkState = { status: "ready", welcome: {} as HostWelcome };
      return {
        workspaceId,
        getState: () => status,
        subscribeState: () => () => undefined,
        query: async () => undefined,
        mutate: async () => undefined,
        subscribe: () => ({ unsubscribe: () => undefined }),
        wake: vi.fn(),
        reconnect: () => undefined,
        close: vi.fn(() => {
          status = { status: "closed" };
        }),
      };
    };
    const registry = createHostLinkRegistry(fake);
    const a = registry.link("a");
    expect(registry.link("a")).toBe(a);
    const b = registry.link("b");
    registry.wake("power-resume");
    expect(a.wake).toHaveBeenCalledWith("power-resume");
    expect(b.wake).toHaveBeenCalledWith("power-resume");
    a.close();
    const again = registry.link("a");
    expect(again).not.toBe(a);
    registry.close("a");
    registry.close("missing");
    expect(again.close).toHaveBeenCalledOnce();
    registry.closeAll();
    expect(b.close).toHaveBeenCalledOnce();
    expect(made).toStrictEqual(["a", "b", "a"]);
  });
});

describe("a typed tRPC client over the link", () => {
  type Client = {
    echo: { query(input: string): Promise<string> };
    record: {
      mutate(input: { id: string }, opts?: { signal?: AbortSignal }): Promise<{ recorded: string }>;
    };
    feed: {
      subscribe(
        input: undefined,
        handlers: {
          signal?: AbortSignal;
          onStarted?(): void;
          onData?(data: unknown): void;
          onError?(error: unknown): void;
          onComplete?(): void;
        },
      ): { unsubscribe(): void };
    };
  };

  async function typed(url: string) {
    const { link: subject } = link(url);
    const client = createTRPCClient({ links: [hostLinkTrpcLink(subject)] }) as unknown as Client;
    return { subject, client };
  }

  it("answers queries and mutations, and fails fast with the link's error", async () => {
    const started = await startHost({ welcomeDelayMs: 50 });
    const { subject, client } = await typed(started.url);
    const early = await client.echo.query("x").catch((error: unknown) => error);
    expect((early as Error).name).toBe("TRPCClientError");
    expect(readHostError(early)).toMatchObject({ reason: "host-unreachable" });
    await until(subject, "ready");
    expect(await client.echo.query("hi")).toBe("hi");
    expect(await client.record.mutate({ id: "a" })).toStrictEqual({ recorded: "a" });
    const missing = await (client as unknown as { nope: { query(): Promise<unknown> } }).nope
      .query()
      .catch((error: unknown) => error);
    expect(readHostError(missing).code).toBe("NOT_FOUND");
  });

  it("streams, and turns a resnapshot into an error isResnapshotRequired reads", async () => {
    const started = await startHost();
    const { subject, client } = await typed(started.url);
    await until(subject, "ready");
    const seen: unknown[] = [];
    let failure: unknown = null;
    let started$ = 0;
    const subscription = client.feed.subscribe(undefined, {
      onStarted: () => (started$ += 1),
      onData: (data) => seen.push(data),
      onError: (error) => (failure = error),
    });
    started.emit(1);
    await eventually(() => seen.length === 1, "the event");
    expect(seen).toStrictEqual([{ id: "1", data: "event 1" }]);
    started.proxy.down();
    started.host.floor = 9;
    started.proxy.up();
    await eventually(() => failure !== null, "the resnapshot");
    expect(isResnapshotRequired(failure)).toBe(true);
    expect(started$).toBe(2);
    subscription.unsubscribe();
  });

  it("passes a host failure and a completion through", async () => {
    const started = await startHost();
    const { subject, client } = await typed(started.url);
    await until(subject, "ready");
    started.host.feedFailure = hostError("subscription-source-failed", "gone");
    let failure: unknown = null;
    client.feed.subscribe(undefined, { onError: (error) => (failure = error) });
    await eventually(() => failure !== null, "the failure");
    expect(readHostError(failure).reason).toBe("subscription-source-failed");
    started.host.feedFailure = null;
    started.host.feedCompletes = true;
    let completed = false;
    client.feed.subscribe(undefined, { onComplete: () => (completed = true) });
    await eventually(() => completed, "the completion");
  });
});

describe("a typed call honours its AbortSignal on this side of the wire", () => {
  async function typed(url: string) {
    const { link: subject } = link(url);
    const client = createTRPCClient({ links: [hostLinkTrpcLink(subject)] }) as unknown as {
      record: {
        mutate(input: { id: string }, opts?: { signal?: AbortSignal }): Promise<unknown>;
      };
      feed: {
        subscribe(
          input: undefined,
          handlers: { signal?: AbortSignal; onStarted?(): void; onData?(data: unknown): void },
        ): { unsubscribe(): void };
      };
    };
    return { subject, client };
  }

  const ABORTED = {
    code: "CLIENT_CLOSED_REQUEST",
    message:
      "The caller aborted the call; a mutation the host already received may have taken effect",
  };

  it("sends nothing for a call or a stream already aborted", async () => {
    const started = await startHost();
    const { subject, client } = await typed(started.url);
    await until(subject, "ready");
    const controller = new AbortController();
    controller.abort();
    const error = await client.record
      .mutate({ id: "never" }, { signal: controller.signal })
      .catch((caught: unknown) => caught);
    expect((error as Error).name).toBe("TRPCClientError");
    expect(readHostError(error)).toStrictEqual(ABORTED);
    let opened = 0;
    client.feed.subscribe(undefined, { signal: controller.signal, onStarted: () => (opened += 1) });
    await sleep(50);
    expect(opened).toBe(0);
    expect(started.host.mutations).toStrictEqual([]);
    expect(started.host.connections[0]!.log).toStrictEqual([
      "protocol.welcome",
      "welcome:answered",
    ]);
  });

  it("settles a call aborted mid-flight at once, and stops a stream aborted mid-flight", async () => {
    const started = await startHost();
    const { subject, client } = await typed(started.url);
    await until(subject, "ready");
    started.host.hold = new Promise(() => {});
    const controller = new AbortController();
    const call = client.record
      .mutate({ id: "sent" }, { signal: controller.signal })
      .catch((caught: unknown) => caught);
    await eventually(() => started.host.mutations.length === 1, "the mutation to arrive");
    controller.abort();
    // Settled locally; not a rollback: the host already ran it.
    expect(readHostError(await call)).toStrictEqual(ABORTED);
    expect(started.host.mutations).toStrictEqual([{ id: "sent" }]);
    started.host.hold = null;
    // A signal that outlives its answered call aborts nothing.
    const later = new AbortController();
    expect(await client.record.mutate({ id: "answered" }, { signal: later.signal })).toStrictEqual({
      recorded: "answered",
    });
    later.abort();

    const streaming = new AbortController();
    const seen: unknown[] = [];
    client.feed.subscribe(undefined, {
      signal: streaming.signal,
      onData: (data) => seen.push(data),
    });
    started.emit(1);
    await eventually(() => seen.length === 1, "the event");
    streaming.abort();
    await eventually(() => started.host.openFeeds === 0, "the stream to stop");
    started.emit(1);
    await sleep(50);
    expect(seen).toHaveLength(1);
    expect(subject.getState().status).toBe("ready");
  });
});

describe("a server-requested reconnect goes through the link", () => {
  it("fails the mutation in flight and never resends it", async () => {
    const started = await startHost();
    const { link: subject, credentials, states } = link(started.url);
    await until(subject, "ready");
    started.host.hold = new Promise(() => {});
    const pending = expectRejected(subject.mutate("record", { id: "held" }));
    await eventually(() => started.host.mutations.length === 1, "the mutation to arrive");
    started.requestReconnect();
    expect(await pending).toMatchObject({
      reason: "host-unreachable",
      message:
        "The connection to the host ended before it answered; whether the call took effect is unknown",
    });
    expect(states.find(({ status }) => status === "unreachable")).toMatchObject({
      error: { reason: "host-unreachable", message: "The host asked this client to reconnect" },
      closeCode: null,
    });
    await until(subject, "ready");
    // Past tRPC's own retry delay: had its reconnect run, it would have resent by now.
    await sleep(1_200);
    expect(started.host.mutations).toStrictEqual([{ id: "held" }]);
    expect(credentials).toHaveLength(2);
    expect(started.host.connections).toHaveLength(2);
    expect(started.host.connections[1]!.log).toStrictEqual([
      "protocol.welcome",
      "welcome:answered",
    ]);
  });

  it("resubscribes only after a fresh credential's hello is welcomed", async () => {
    const started = await startHost();
    let issued = 0;
    const { link: subject } = link(started.url, {
      credential: () => {
        issued += 1;
        started.host.credentials.add(`token-${issued}`);
        return `token-${issued}`;
      },
    });
    await until(subject, "ready");
    const feed = record();
    subject.subscribe("feed", undefined, feed.handlers);
    started.emit(1);
    await eventually(() => feed.ids().length === 1, "the first event");
    started.host.welcomeDelayMs = 100;
    started.requestReconnect();
    await until(subject, "unreachable");
    started.emit(1);
    await until(subject, "ready");
    await eventually(() => feed.ids().length === 2, "the resumed stream");
    await sleep(1_200);
    expect(feed.ids()).toStrictEqual(["1", "2"]);
    const [first, second] = started.host.connections.map(({ hello }) => hello!);
    expect(started.host.connections).toHaveLength(2);
    expect([first!.credential, second!.credential]).toStrictEqual(["token-1", "token-2"]);
    expect(second!.nonce).not.toBe(first!.nonce);
    expect(started.host.connections[1]!.log).toStrictEqual([
      "protocol.welcome",
      "welcome:answered",
      "feed",
      "feed:1",
    ]);
  });

  it("fences a host whose epoch went backwards across it, and resubscribes nothing", async () => {
    const started = await startHost({ fence: false });
    const { link: subject } = link(started.url);
    await until(subject, "ready");
    const feed = record();
    subject.subscribe("feed", undefined, feed.handlers);
    await eventually(() => started.host.connections[0]!.log.includes("feed"), "the stream");
    started.host.epoch = 1;
    started.requestReconnect();
    expect((await until(subject, "fenced")).error.reason).toBe("workspace-epoch-fenced");
    await sleep(1_200);
    expect(started.host.connections).toHaveLength(2);
    expect(started.host.connections[1]!.log).toStrictEqual([
      "protocol.welcome",
      "welcome:answered",
    ]);
    expect(feed.last()).toMatchObject({
      kind: "error",
      value: { reason: "workspace-epoch-fenced" },
    });
  });

  it("never builds a socket for a connection closed before tRPC built it", async () => {
    const { url, host } = await startHost();
    let built = 0;
    class Counting extends NodeWebSocket {
      constructor(address: string) {
        super(address);
        built += 1;
      }
    }
    const { link: subject } = link(url, { WebSocket: Counting as unknown as typeof WebSocket });
    // The credential answered and the attempt handed tRPC its hello; tRPC
    // builds the socket a few microtasks on, after this close.
    await Promise.resolve();
    subject.close();
    await sleep(1_200);
    expect(built).toBe(0);
    expect(host.connections).toHaveLength(0);
  });
});

describe("a listener that moves the link on is final", () => {
  it("closes from unreachable, and nothing reconnects", async () => {
    const started = await startHost();
    const { link: subject, credentials } = link(started.url);
    await until(subject, "ready");
    subject.subscribeState((state) => {
      if (state.status === "unreachable") subject.close();
    });
    const later: string[] = [];
    subject.subscribeState((state) => later.push(state.status));
    started.proxy.down();
    await eventually(() => subject.getState().status === "closed", "the close");
    started.proxy.up();
    await sleep(150);
    expect(subject.getState().status).toBe("closed");
    // A listener after the one that closed hears the newer state only.
    expect(later).toStrictEqual(["closed"]);
    expect(credentials).toHaveLength(1);
    expect(started.host.connections).toHaveLength(1);
  });

  it("closes from connecting, and the attempt asks for nothing", async () => {
    const started = await startHost();
    const { link: subject, credentials } = link(started.url);
    await until(subject, "ready");
    subject.subscribeState((state) => {
      if (state.status === "connecting") subject.close();
    });
    started.proxy.down();
    await until(subject, "closed");
    started.proxy.up();
    await sleep(150);
    expect(credentials).toHaveLength(1);
    expect(started.host.connections).toHaveLength(1);
  });

  it("closes from ready, and opens no stream", async () => {
    const started = await startHost();
    const { link: subject } = link(started.url);
    const feed = record();
    subject.subscribe("feed", undefined, feed.handlers);
    subject.subscribeState((state) => {
      if (state.status === "ready") subject.close();
    });
    await until(subject, "closed");
    await sleep(50);
    expect(started.host.connections[0]!.log).toStrictEqual([
      "protocol.welcome",
      "welcome:answered",
    ]);
    expect(feed.seen).toStrictEqual([]);
  });

  it("reconnects from refused, and keeps the streams for the next welcome", async () => {
    const started = await startHost({ credentials: new Set() });
    const { link: subject } = link(started.url);
    const feed = record();
    subject.subscribe("feed", undefined, feed.handlers);
    let retried = false;
    subject.subscribeState((state) => {
      if (state.status !== "refused" || retried) return;
      retried = true;
      started.host.credentials.add("good");
      subject.reconnect();
    });
    started.emit(1);
    await eventually(() => feed.ids().length === 1, "the stream after the retry");
    expect(feed.seen.filter(({ kind }) => kind === "error")).toStrictEqual([]);
  });

  it("keeps the streams a failing one's handler reconnected for", async () => {
    const started = await startHost();
    const { link: subject } = link(started.url, { lastSeen: { epoch: 2, hostId: OTHER_HOST } });
    const errors: unknown[] = [];
    subject.subscribe("feed", undefined, {
      onData: () => undefined,
      onResnapshot: () => undefined,
      onError: (error) => {
        errors.push(readHostError(error).reason);
        started.host.hostId = OTHER_HOST;
        subject.reconnect();
      },
    });
    const kept = record();
    subject.subscribe("feed", undefined, kept.handlers);
    started.emit(1);
    await eventually(() => kept.ids().length === 1, "the kept stream");
    expect(errors).toStrictEqual(["workspace-split-brain"]);
    expect(kept.seen.filter(({ kind }) => kind === "error")).toStrictEqual([]);
  });

  it("opens a stream a ready listener subscribes exactly once", async () => {
    const started = await startHost({ welcomeDelayMs: 40 });
    const { link: subject } = link(started.url);
    const feed = record();
    let subscription: HostLinkSubscription | null = null;
    subject.subscribeState((state) => {
      if (state.status === "ready" && subscription === null) {
        subscription = subject.subscribe("feed", undefined, feed.handlers);
      }
    });
    started.emit(1);
    await until(subject, "ready");
    await eventually(() => feed.ids().length === 1, "the event");
    await sleep(80);
    expect(feed.ids()).toStrictEqual(["1"]);
    expect(started.host.openFeeds).toBe(1);
    expect(started.host.connections[0]!.log.filter((path) => path === "feed")).toHaveLength(1);
    subscription!.unsubscribe();
    await eventually(() => started.host.openFeeds === 0, "the stream to stop");
  });
});

it("HostLinkError carries the envelope readHostError reads", () => {
  const error = new HostLinkError(hostError("host-unreachable", "gone"));
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe("HostLinkError");
  expect(readHostError(error)).toStrictEqual({
    code: "SERVICE_UNAVAILABLE",
    reason: "host-unreachable",
    message: "gone",
  });
});

/** A `ws` socket whose sends of matching frames throw, as a socket mid-close does. */
function failingSends(pattern: RegExp, active: () => boolean = () => true): typeof WebSocket {
  class Failing extends NodeWebSocket {
    override send(data: unknown, ...rest: unknown[]): void {
      if (active() && typeof data === "string" && pattern.test(data)) {
        throw new Error("Active connection is not open");
      }
      (super.send as (...args: unknown[]) => void)(data, ...rest);
    }
  }
  return Failing as unknown as typeof WebSocket;
}

/* ---------------------------------------------------------- tracing (VC-699) */

const FLOW = "4bf92f3577b34da6a3ce929d0e0e4736";
const OTHER_FLOW = "a3ce929d0e0e47364bf92f3577b34da6";

/** Each frame a client sent, parsed: the trace it carried, by what it was. */
function sentTraces(frames: readonly string[]) {
  return frames
    .filter((frame) => frame.startsWith("{") || frame.startsWith("["))
    .flatMap((frame) => {
      const parsed = JSON.parse(frame) as unknown;
      return (Array.isArray(parsed) ? parsed : [parsed]) as {
        method?: string;
        params?: { path?: string };
        [HOST_TRACE_FIELD]?: HostTrace;
      }[];
    })
    .map((message) => ({
      what:
        message.method === "connectionParams"
          ? "hello"
          : `${message.params?.path ?? message.method}`,
      trace: message[HOST_TRACE_FIELD],
    }));
}

describe("every frame carries its operation's trace", () => {
  it("sends the link's flow trace with a fresh span on the hello, the welcome and each call", async () => {
    const started = await startHost();
    const { link: subject } = link(started.url, { traceId: FLOW });
    await until(subject, "ready");
    await subject.query("echo", "a");
    await subject.mutate("record", { id: "r" }, { trace: { traceId: OTHER_FLOW } });
    const feed = record();
    subject.subscribe("feed", undefined, feed.handlers, { trace: { traceId: OTHER_FLOW } });
    await eventually(() => started.host.connections[0]!.log.includes("feed"), "the stream");
    const sent = sentTraces(started.frames);
    expect(sent.map(({ what, trace }) => [what, trace?.traceId])).toStrictEqual([
      ["hello", FLOW],
      ["protocol.welcome", FLOW],
      ["echo", FLOW],
      ["record", OTHER_FLOW],
      ["feed", OTHER_FLOW],
    ]);
    const spans = sent.map(({ trace }) => trace!.spanId);
    expect(new Set(spans).size).toBe(spans.length);
    for (const span of spans) expect(span).toMatch(/^[0-9a-f]{16}$/u);
    // The heartbeat goes as it is.
    expect(
      started.frames.filter((frame) => !frame.startsWith("{") && !frame.startsWith("[")),
    ).not.toContainEqual(expect.stringContaining(HOST_TRACE_FIELD));
  });

  it("makes each call its own trace when the link serves no flow, and resumes a stream on its own", async () => {
    const started = await startHost();
    const { link: subject } = link(started.url);
    await until(subject, "ready");
    await subject.query("echo", "a");
    await subject.query("echo", "b");
    const feed = record();
    subject.subscribe("feed", undefined, feed.handlers);
    started.emit(1);
    await eventually(() => feed.ids().length === 1, "one event");
    started.proxy.down();
    await until(subject, "unreachable");
    started.proxy.up();
    await until(subject, "ready");
    await eventually(
      () => started.host.connections[1]?.log.includes("feed") === true,
      "the resume",
    );
    const sent = sentTraces(started.frames);
    const echoes = sent.filter(({ what }) => what === "echo").map(({ trace }) => trace!.traceId);
    expect(new Set(echoes).size).toBe(2);
    const feeds = sent.filter(({ what }) => what === "feed").map(({ trace }) => trace!);
    expect(feeds).toHaveLength(2);
    expect(feeds[0]!.traceId).toBe(feeds[1]!.traceId);
    expect(feeds[0]!.spanId).not.toBe(feeds[1]!.spanId);
    const hellos = sent.filter(({ what }) => what === "hello").map(({ trace }) => trace!.traceId);
    expect(new Set(hellos).size).toBe(2);
  });

  it("carries a typed call's trace from its operation context, and ignores a malformed one", async () => {
    const started = await startHost();
    const { link: subject } = link(started.url, { traceId: FLOW });
    const client = createTRPCClient({ links: [hostLinkTrpcLink(subject)] }) as unknown as {
      echo: { query(input: string, opts?: { context?: Record<string, unknown> }): Promise<string> };
      feed: {
        subscribe(
          input: undefined,
          handlers: { onData?(data: unknown): void; context?: Record<string, unknown> },
        ): { unsubscribe(): void };
      };
    };
    await until(subject, "ready");
    await client.echo.query("a", { context: { trace: { traceId: OTHER_FLOW } } });
    await client.echo.query("b", { context: { trace: { traceId: "nope" } } });
    await client.echo.query("c", { context: { trace: "nope" } });
    client.feed.subscribe(undefined, { context: { trace: { traceId: OTHER_FLOW } } });
    await eventually(() => started.host.connections[0]!.log.includes("feed"), "the stream");
    expect(
      sentTraces(started.frames)
        .filter(({ what }) => what === "echo" || what === "feed")
        .map(({ trace }) => trace!.traceId),
    ).toStrictEqual([OTHER_FLOW, FLOW, FLOW, OTHER_FLOW]);
  });
});

describe("the link's log says why", () => {
  it("reports each state change with its reason, a wake, a resume and a resnapshot", async () => {
    const started = await startHost();
    const events: HostLinkLogEvent[] = [];
    const { link: subject } = link(started.url, {
      traceId: FLOW,
      log: (event) => events.push(event),
    });
    await until(subject, "ready");
    const feed = record();
    subject.subscribe("feed", undefined, feed.handlers);
    started.emit(1);
    await eventually(() => feed.ids().length === 1, "one event");
    subject.wake("power-resume");
    started.proxy.down();
    await until(subject, "unreachable");
    started.proxy.up();
    await until(subject, "ready");
    await eventually(
      () => started.host.connections[1]?.log.includes("feed:1") === true,
      "the resume",
    );
    started.proxy.down();
    await until(subject, "unreachable");
    started.host.floor = 5;
    started.proxy.up();
    await until(subject, "ready");
    await eventually(() => feed.last()?.kind === "resnapshot", "the resnapshot");
    subject.close();
    expect(events.every((event) => event.traceId === FLOW)).toBe(true);
    expect(
      events.map((event) => (event.kind === "state" ? `${event.from}>${event.to}` : event.kind)),
    ).toStrictEqual([
      "connecting>connecting",
      "connecting>ready",
      "wake",
      "ready>unreachable",
      "unreachable>connecting",
      "connecting>ready",
      "resubscribe",
      "ready>unreachable",
      "unreachable>connecting",
      "connecting>ready",
      "resubscribe",
      "resnapshot",
      "ready>closed",
    ]);
    expect(events.find((event) => event.kind === "state" && event.to === "ready")).toMatchObject({
      hostId: HOST,
      epoch: 2,
    });
    expect(
      events.find((event) => event.kind === "state" && event.to === "unreachable"),
    ).toMatchObject({
      attempt: 1,
      reason: "host-unreachable",
      retryInMs: expect.any(Number),
    });
    expect(events.find((event) => event.kind === "resubscribe")).toMatchObject({
      path: "feed",
      resumed: true,
      why: "welcome",
    });
    expect(events.find((event) => event.kind === "wake")).toMatchObject({
      cause: "power-resume",
      status: "ready",
    });
  });

  it("reports a refusal, a fence and an overflow resume", async () => {
    const refusedHost = await startHost({ credentials: new Set() });
    const refusals: HostLinkLogEvent[] = [];
    const { link: refused } = link(refusedHost.url, { log: (event) => refusals.push(event) });
    await until(refused, "refused");
    expect(refusals.at(-1)).toMatchObject({
      kind: "state",
      to: "refused",
      reason: "credential-invalid",
    });

    const unnamedHost = await startHost({
      closeOnConnect: { code: 4400, reason: "something new" },
    });
    const unnamed: HostLinkLogEvent[] = [];
    const { link: closed } = link(unnamedHost.url, { log: (event) => unnamed.push(event) });
    await until(closed, "refused");
    expect(unnamed.at(-1)).toMatchObject({
      kind: "state",
      to: "refused",
      reason: "BAD_REQUEST",
      closeCode: 4400,
    });

    const fencedHost = await startHost();
    const fences: HostLinkLogEvent[] = [];
    const { link: fenced } = link(fencedHost.url, {
      lastSeen: { epoch: 2, hostId: OTHER_HOST },
      log: (event) => fences.push(event),
    });
    await until(fenced, "fenced");
    expect(fences.at(-1)).toMatchObject({
      kind: "state",
      to: "fenced",
      reason: "workspace-split-brain",
    });

    const busy = await startHost();
    const overflows: HostLinkLogEvent[] = [];
    const { link: subject } = link(busy.url, { log: (event) => overflows.push(event) });
    await until(subject, "ready");
    busy.host.overflowAfter = 2;
    const feed = record();
    subject.subscribe("feed", undefined, feed.handlers);
    busy.emit(3);
    await eventually(() => feed.ids().length === 3, "all three, across the overflow");
    expect(overflows).toContainEqual(
      expect.objectContaining({
        kind: "resubscribe",
        why: "overflow",
        resumed: true,
        path: "feed",
      }),
    );
  });
});
