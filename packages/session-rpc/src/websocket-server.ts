import { assertHostFeatureReadiness } from "./feature-readiness";
/**
 * The host protocol's WebSocket listener (VC-663; HP § Handshake and
 * capabilities, § Commands, subscriptions and errors, § The listener). Node-only,
 * so it is its own entry, `@volli/session-rpc/websocket`: the renderer never
 * loads it.
 *
 * It is the stock `applyWSSHandler` over a catalog router, plus what a
 * network door owes that router and nothing more:
 *
 * - **A connection budget, before anything is allocated.** Every accepted TCP
 *   socket takes a slot until it closes, whatever stage it reached (before the
 *   upgrade, waiting for its hello, refused, admitted), and accepting is
 *   rate-limited. Past either, the socket is answered `503` and destroyed
 *   before HTTP, handshake or router state exists for it. A socket that has
 *   not upgraded within the handshake timeout is destroyed.
 * - **The handshake, in `createContext`, before any procedure.** The hello is
 *   read (`hello-invalid`), the credential verified by the injected port
 *   (`credential-invalid`; the verifier's actor is re-checked, so the reserved
 *   local device can never be minted here), the Workspace looked up
 *   (`workspace-unknown`) and the welcome negotiated (version and fence). A
 *   refused connection gets a context that carries only the refusal: every
 *   operation it queued behind its hello answers that reason through the
 *   catalog before anything else is read, no handler or subscription runs,
 *   and the connection is closed (4400, or 4401 for a credential).
 * - **The grant, for the connection's lifetime.** The connection's admission
 *   (`ConnectionAdmission`) ends when the verifier pushes a revocation, when
 *   the periodic re-check finds the grant lapsed, or when the socket closes.
 *   The catalog re-judges every call against it immediately before its
 *   resolver and again before its answer is released, so a call parked in an
 *   awaited authorization step never runs after a revocation. Every open
 *   stream ends with `UNAUTHORIZED` / `credential-invalid` and releases its
 *   runtime listener, then the socket is closed (4401).
 * - **Feature gating.** The context carries the operations the negotiated
 *   features grant; the catalog refuses any other key. Features advertise
 *   what this host serves; each operation's actor policy is still the
 *   enforcement (HP § The listener).
 * - **Bounds on the wire.** Inbound frames are capped (`maxPayload`). No
 *   answer or stream frame is larger than `maxFrameBytes`: the catalog
 *   refuses such an answer with `response-too-large`, `session.subscribe`
 *   ends such a stream with it, and any other frame that size closes the
 *   connection (4413) unsent. A frame that would take the socket's unsent
 *   bytes past `maxOutboundBytes` is not sent, and the peer is terminated as
 *   a slow peer; so is one whose backlog is past it after a send. A
 *   connection holds at most `maxSubscriptions` open streams. A connection
 *   that never says hello is closed (4408). Server pings find a peer that
 *   vanished.
 * - **Replay bounds** (`SUBSCRIPTION_REPLAY_BOUNDS`, D9, unless the limits
 *   lower them: `maxReplayEvents`, `maxReplayBytes`), set in the context.
 *
 * - **Every request in its own trace** (VC-699; HP § Tracing and logs). Each
 *   inbound frame is read for the optional trace beside its id
 *   (`HOST_TRACE_FIELD`), and tRPC handles it inside the composition root's
 *   `requestScope`, so every line the host logs while serving it (the
 *   handler, the Session runtime, the turn it opens) carries that trace. A
 *   batch is split, one scope per request. The hello frame's trace is the
 *   connection's: its handshake and close are logged under it.
 *
 * Credentials are never logged: the log names a connection by a random id,
 * and a refusal by its reason.
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";

import { type AnyRouter, type inferRouterContext } from "@trpc/server";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import {
  HOST_TRACE_FIELD,
  HOST_PROTOCOL_CLOSE_CODES,
  HOST_PROTOCOL_MAX_FRAME_BYTES,
  HOST_PROTOCOL_VERSIONS,
  HOST_SCOPE_BASE_OPERATIONS,
  isHostConnectionActor,
  negotiateWelcome,
  operationsGrantedBy,
  readHostHello,
  SUBSCRIPTION_REPLAY_BOUNDS,
  type HostActorKind,
  type HostConnectionCredentialGrant,
  type HostCredentialVerifier,
  type HostErrorReason,
  type HostFeature,
  type HostConnectionHello,
  type HostId,
  type HostConnectionWelcome,
  type WorkspaceEpoch,
  type WorkspaceId,
} from "@volli/host-protocol";
import { readTraceContext, type TraceContext } from "@volli/shared";
import { WebSocketServer, type WebSocket } from "ws";

import type {
  CatalogCallerContext,
  ConnectionAdmission,
  HandshakeRefusal,
  NetworkRouterCaller,
} from "./catalog";

/** Re-exported for compatibility; the codes live in `@volli/host-protocol`, which a client may load. */
export { HOST_PROTOCOL_CLOSE_CODES };

/** What a connection's context is built from, once its handshake succeeded. */
export interface HostProtocolConnection {
  /** Random, per connection; what the log names it by. */
  readonly id: string;
  readonly welcome: HostConnectionWelcome;
  readonly caller: NetworkRouterCaller;
}

/** The context keys the listener owns; a composition root supplies every other. */
type ListenerContextKey =
  | "caller"
  | "transport"
  | "operations"
  | "welcome"
  | "replayBounds"
  | "refused"
  | "admission"
  | "maxResponseBytes"
  | "connectionId";

export interface HostProtocolListenerLimits {
  /** Sockets open at once, at every stage from TCP accept to close. */
  readonly maxConnections: number;
  /** Sockets accepted in a burst, before the rate below applies. */
  readonly handshakeBurst: number;
  /** Sockets accepted per second, sustained. */
  readonly handshakesPerSecond: number;
  /** Open subscriptions one connection may hold at once. */
  readonly maxSubscriptions: number;
  /** The largest frame the host sends; an answer or emission past it is refused, never cut. */
  readonly maxFrameBytes: number;
  /**
   * Durable events one resume may replay, and their UTF-8 JSON bytes, before
   * it is refused with `subscription-resnapshot-required` (D9). A stream
   * stages up to twice the byte bound, so with `maxSubscriptions` it bounds
   * what one connection's streams can hold.
   */
  readonly maxReplayEvents: number;
  readonly maxReplayBytes: number;
  /** Unsent bytes one connection may hold before it is terminated as a slow peer. */
  readonly maxOutboundBytes: number;
  /** The largest frame a client may send. */
  readonly maxInboundBytes: number;
  /** How long a socket has to upgrade, and then to send its hello. */
  readonly handshakeTimeoutMs: number;
  /** How long a refused connection stays open to answer what it queued. */
  readonly refusedCloseMs: number;
  /** How often every grant's `current()` is asked again, beside the verifier's push. */
  readonly grantRecheckMs: number;
  /** Silence before the server pings; a peer that does not answer within 5 s is dropped. */
  readonly pingMs: number;
}

/**
 * Room a frame's envelope (request id, result type, tracked id) needs beside
 * its payload: the catalog refuses an answer past `maxFrameBytes` minus this,
 * so the frame that would carry it never reaches the outbound guard.
 */
export const FRAME_ENVELOPE_BYTES = 4096;

export const DEFAULT_LISTENER_LIMITS: HostProtocolListenerLimits = Object.freeze({
  // Loopback-only until VC-575: a desktop, a CLI and a few local tools, with
  // room for each to reconnect while its old socket is still closing.
  maxConnections: 128,
  // Every client reconnecting at once after a restart, then a steady trickle.
  handshakeBurst: 64,
  handshakesPerSecond: 32,
  // One per Session a surface shows live, with room for several surfaces.
  maxSubscriptions: 64,
  maxFrameBytes: HOST_PROTOCOL_MAX_FRAME_BYTES,
  maxReplayEvents: SUBSCRIPTION_REPLAY_BOUNDS.events,
  maxReplayBytes: SUBSCRIPTION_REPLAY_BOUNDS.bytes,
  // Two frames' worth: a full resume, and the next answer behind it.
  maxOutboundBytes: 2 * HOST_PROTOCOL_MAX_FRAME_BYTES,
  maxInboundBytes: 8 * 1024 * 1024,
  handshakeTimeoutMs: 10_000,
  refusedCloseMs: 1_000,
  grantRecheckMs: 30_000,
  pingMs: 30_000,
});

/**
 * What the listener reports. Never a credential, a hello or a payload. An
 * event about a connection carries the trace its hello sent, when it sent one.
 */
export type HostProtocolListenerEvent =
  | {
      readonly kind: "connection-refused";
      readonly reason: "connection-limit" | "handshake-rate";
    }
  | ConnectionEvent<{
      readonly kind: "handshake-refused";
      readonly reason: HostErrorReason;
    }>
  | ConnectionEvent<{
      readonly kind: "connected";
      readonly actor: HostActorKind;
      readonly workspaceId?: WorkspaceId;
    }>
  | ConnectionEvent<{ readonly kind: "revoked"; readonly streams: number }>
  | ConnectionEvent<{ readonly kind: "slow-peer"; readonly unsentBytes: number }>
  | ConnectionEvent<{ readonly kind: "oversized-frame"; readonly bytes: number }>
  | ConnectionEvent<{ readonly kind: "hello-timeout" }>
  | ConnectionEvent<{ readonly kind: "closed"; readonly code: number }>;

type ConnectionEvent<Event> = Event & {
  readonly connection: string;
  /** The trace the connection's hello frame carried. */
  readonly traceId?: string;
};

/**
 * One inbound request, as the listener hands it to the composition root's
 * {@link HostProtocolListenerOptions.requestScope}: identifiers only.
 */
export interface HostProtocolRequest {
  /** The connection's random id. */
  readonly connection: string;
  /** The trace the frame carried, when well formed; the scope mints one otherwise. */
  readonly trace: TraceContext | null;
  /** `connectionParams` for the hello, else the JSON-RPC method (`query`, `mutation`, …). */
  readonly method: string | null;
  /** The procedure path, for a call. */
  readonly path: string | null;
}

/**
 * Runs `handle` (tRPC's handling of one request) inside the host's
 * correlation context for it: hostd and the desktop open an
 * `AsyncLocalStorage` scope here (`@volli/host-core/log`'s `withTrace`).
 */
export type HostProtocolRequestScope = (request: HostProtocolRequest, handle: () => void) => void;

/** A Workspace this host serves, and the epoch it holds it under. */
export interface ServedWorkspace {
  readonly id: WorkspaceId;
  readonly epoch: WorkspaceEpoch;
}

export interface HostProtocolListenerOptions<Router extends AnyRouter> {
  /** A catalog router: its context extends `CatalogCallerContext`. */
  readonly router: Router;
  /** Loopback only until VC-575 (Q5): anything else is refused at start. Port 0 picks one. */
  readonly bind: { readonly host: string; readonly port: number };
  readonly host: { readonly id: HostId; readonly version: string };
  /** The Workspace a hello names, or `null` when this host serves no such one. */
  readonly workspace: (
    workspaceId: WorkspaceId,
  ) => ServedWorkspace | null | Promise<ServedWorkspace | null>;
  readonly verifier: HostCredentialVerifier;
  /** The router context for one authenticated connection, minus the keys the listener sets. */
  readonly context: (
    connection: HostProtocolConnection,
  ) => Omit<inferRouterContext<Router>, ListenerContextKey>;
  /**
   * The features this listener serves: exactly what its `context` composes.
   * Required, so a host never offers by omission a feature it cannot answer.
   */
  readonly features: readonly HostFeature[];
  readonly limits?: Partial<HostProtocolListenerLimits>;
  readonly log?: (event: HostProtocolListenerEvent) => void;
  /** The scope each inbound request is handled in. Absent: handled as it arrives. */
  readonly requestScope?: HostProtocolRequestScope;
}

export interface HostProtocolListener {
  /** Where it listens, `ws://host:port`. */
  readonly url: string;
  readonly address: { readonly host: string; readonly port: number };
  /** Sockets holding a slot: accepted and not yet closed, at any stage. */
  readonly connections: number;
  /** Streams open across every connection. */
  readonly streams: number;
  /** Stops accepting and closes every connection; its subscriptions end with it. */
  close(): Promise<void>;
}

/** The connection's id and its hello's trace, for an event about it. */
function named(connection: Connection): { connection: string; traceId?: string } {
  return connection.trace === null
    ? { connection: connection.id }
    : { connection: connection.id, traceId: connection.trace.traceId };
}

/** One inbound request, read from its frame: what its scope is told, and the frame itself. */
interface InboundRequest {
  readonly request: Omit<HostProtocolRequest, "connection">;
  readonly method: string | null;
  readonly trace: TraceContext | null;
  readonly frame: unknown;
}

/**
 * The requests in one text frame, or null when it is not JSON (the heartbeat,
 * or garbage tRPC answers itself). Only identifiers are read: the trace, the
 * method and the path.
 */
export function readRequests(data: unknown): readonly InboundRequest[] | null {
  if (!Buffer.isBuffer(data)) return null;
  const first = data[0];
  // `{` or `[`: anything else is no request (PING and PONG among them).
  if (first !== 0x7b && first !== 0x5b) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString("utf8"));
  } catch {
    return null;
  }
  const frames = Array.isArray(parsed) ? parsed : [parsed];
  return frames.map((frame) => {
    const message = (typeof frame === "object" && frame !== null ? frame : {}) as {
      method?: unknown;
      params?: { path?: unknown } | null;
      [HOST_TRACE_FIELD]?: unknown;
    };
    const trace = readTraceContext(message[HOST_TRACE_FIELD]);
    const method = typeof message.method === "string" ? message.method : null;
    const path =
      typeof message.params === "object" &&
      message.params !== null &&
      typeof message.params.path === "string"
        ? message.params.path
        : null;
    return { request: { trace, method, path }, method, trace, frame };
  });
}

/** Until VC-575 brings TLS and device keys, a host protocol listener binds loopback only (Q5). */
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(host);
}

/** Every limit a positive integer, and the frame bound within both byte bounds it sits under. */
export function validateListenerLimits(limits: HostProtocolListenerLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Host protocol listener limit ${name} must be a positive integer`);
    }
  }
  if (limits.maxFrameBytes <= FRAME_ENVELOPE_BYTES) {
    throw new Error(`maxFrameBytes must exceed the ${FRAME_ENVELOPE_BYTES}-byte frame envelope`);
  }
  if (limits.maxFrameBytes > limits.maxOutboundBytes) {
    throw new Error("maxFrameBytes must not exceed maxOutboundBytes");
  }
}

/** What {@link boundOutboundSends} needs of a socket: `ws`'s, or a test's. */
export interface BoundedSocket {
  send(data: unknown, ...rest: unknown[]): void;
  readonly bufferedAmount: number;
  terminate(): void;
  close(code: number, reason: string): void;
}

/**
 * Bounds what one socket may hold unsent. Judged before each send: a frame
 * past the frame bound is never sent, and the socket closes 4413
 * (`response-too-large`); a frame that would take the backlog past the
 * outbound bound is never sent, and the peer is terminated as a slow peer.
 * Judged again after it: a backlog past the bound (the frame's own header is
 * what can still tip it) terminates at once, not at the next send, which may
 * never come.
 */
export function boundOutboundSends(
  socket: BoundedSocket,
  bounds: Pick<HostProtocolListenerLimits, "maxFrameBytes" | "maxOutboundBytes">,
  report: { shed(unsentBytes: number): void; oversized(bytes: number): void },
): void {
  const send = socket.send.bind(socket);
  const shed = (): void => {
    report.shed(socket.bufferedAmount);
    socket.terminate();
  };
  socket.send = (data: unknown, ...rest: unknown[]): void => {
    const bytes =
      typeof data === "string" ? Buffer.byteLength(data) : (data as ArrayBufferView).byteLength;
    if (bytes > bounds.maxFrameBytes) {
      report.oversized(bytes);
      socket.close(HOST_PROTOCOL_CLOSE_CODES.responseTooLarge, "response-too-large");
      return;
    }
    if (socket.bufferedAmount + bytes > bounds.maxOutboundBytes) return shed();
    send(data, ...rest);
    if (socket.bufferedAmount > bounds.maxOutboundBytes) shed();
  };
}

/** One socket's state, from upgrade to close. */
interface Connection {
  readonly id: string;
  readonly socket: WebSocket;
  state: "hello" | "admitted" | "refused" | "closed";
  /** Pending until the handshake settles, either way. */
  helloTimer: NodeJS.Timeout | undefined;
  /** Ends with a revocation, a lapse or the close; never restored. */
  readonly admission: AbortController;
  /** Streams open now. */
  streams: number;
  revoked: boolean;
  readonly disposers: (() => void)[];
  /** The trace its hello frame carried. */
  trace: TraceContext | null;
}

/** A refused connection's context: the refusal, and no caller any handler could use. */
const NO_DIAGNOSTICS = Object.freeze({ record: () => undefined });

function ignore(): void {}

/** The answer to a socket over budget, written before any HTTP is parsed. */
const SERVICE_UNAVAILABLE =
  "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

export async function startHostProtocolListener<Router extends AnyRouter>(
  options: HostProtocolListenerOptions<Router>,
): Promise<HostProtocolListener> {
  if (!isLoopbackHost(options.bind.host)) {
    throw new Error(
      `The host protocol listener binds loopback only until VC-575; refusing ${options.bind.host}`,
    );
  }
  const limits: HostProtocolListenerLimits = { ...DEFAULT_LISTENER_LIMITS, ...options.limits };
  validateListenerLimits(limits);
  const features = [...options.features];
  assertHostFeatureReadiness(options.router, features);
  const log = options.log ?? ignore;
  const connections = new WeakMap<WebSocket, Connection>();
  /** Every accepted TCP socket, until it closes: the connection budget. */
  const sockets = new Set<Socket>();
  let streams = 0;

  // The budget is judged at TCP accept, before HTTP is parsed: the HTTP
  // server below never listens itself, and is handed only what was admitted.
  const http = createHttpServer((_request, response) => {
    response.writeHead(426, { Connection: "close" }).end();
  });
  const tcp = createTcpServer((socket) => accept(socket));
  const server = new WebSocketServer({ server: http, maxPayload: limits.maxInboundBytes });

  let tokens = limits.handshakeBurst;
  let refilledAt = performance.now();

  /** One accept against the connection budget and the handshake rate, or a 503 and nothing else. */
  function accept(socket: Socket): void {
    const now = performance.now();
    tokens = Math.min(
      limits.handshakeBurst,
      tokens + ((now - refilledAt) * limits.handshakesPerSecond) / 1000,
    );
    refilledAt = now;
    const refused =
      sockets.size >= limits.maxConnections
        ? "connection-limit"
        : tokens < 1
          ? "handshake-rate"
          : null;
    if (refused !== null) {
      log({ kind: "connection-refused", reason: refused });
      // A peer that resets before reading its answer is no error of ours.
      socket.on("error", ignore);
      socket.end(SERVICE_UNAVAILABLE);
      socket.destroySoon();
      return;
    }
    tokens -= 1;
    sockets.add(socket);
    // A socket that has not upgraded by the deadline is holding a slot for nothing.
    const upgradeDeadline = setTimeout(() => socket.destroy(), limits.handshakeTimeoutMs);
    socket.once("close", () => {
      clearTimeout(upgradeDeadline);
      sockets.delete(socket);
    });
    // Cleared once the socket is a WebSocket; its hello timer runs from there.
    (socket as Socket & { upgradeDeadline?: NodeJS.Timeout }).upgradeDeadline = upgradeDeadline;
    http.emit("connection", socket);
  }

  tcp.listen(options.bind.port, options.bind.host);
  await once(tcp, "listening");

  // Registered before tRPC's own handler, so every send tRPC makes is bounded.
  server.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    clearTimeout((request.socket as Socket & { upgradeDeadline?: NodeJS.Timeout }).upgradeDeadline);
    const connection: Connection = {
      id: randomUUID(),
      socket,
      state: "hello",
      helloTimer: undefined,
      admission: new AbortController(),
      streams: 0,
      revoked: false,
      disposers: [],
      trace: null,
    };
    connections.set(socket, connection);
    boundOutbound(connection);
    scopeRequests(connection);
    connection.helloTimer = setTimeout(() => {
      log({ kind: "hello-timeout", ...named(connection) });
      socket.close(HOST_PROTOCOL_CLOSE_CODES.helloTimeout, "hello-timeout");
    }, limits.handshakeTimeoutMs);
    connection.disposers.push(() => clearTimeout(connection.helloTimer));
    socket.once("close", (code) => {
      connection.state = "closed";
      // Every in-flight call and open stream on it ends here.
      connection.admission.abort();
      for (const dispose of connection.disposers.splice(0)) dispose();
      log({ kind: "closed", ...named(connection), code });
    });
  });

  applyWSSHandler<Router>({
    wss: server,
    router: options.router,
    keepAlive: { enabled: true, pingMs: limits.pingMs },
    createContext: ({ res, info }) => handshake(connections.get(res)!, info.connectionParams),
  });

  function boundOutbound(connection: Connection): void {
    boundOutboundSends(connection.socket, limits, {
      shed: (unsentBytes) => log({ kind: "slow-peer", ...named(connection), unsentBytes }),
      oversized: (bytes) => log({ kind: "oversized-frame", ...named(connection), bytes }),
    });
  }

  /**
   * Hands each inbound request to tRPC inside the composition root's scope
   * (HP § Tracing and logs). `ws` delivers a frame by emitting `message`;
   * the emit is wrapped, so tRPC's own listener runs in the scope and every
   * promise it starts keeps it. A batch is re-emitted one request at a time,
   * so each keeps its own trace.
   */
  function scopeRequests(connection: Connection): void {
    const scope = options.requestScope;
    const socket = connection.socket;
    const emit = socket.emit.bind(socket) as (
      event: string | symbol,
      ...args: unknown[]
    ) => boolean;
    socket.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
      if (event !== "message" || args[1] === true) return emit(event, ...args);
      const requests = readRequests(args[0]);
      // Not a request (PING, PONG, or something tRPC answers with its own error).
      if (requests === null || requests.length === 0) return emit(event, ...args);
      const hello = requests.find((request) => request.method === "connectionParams");
      if (hello !== undefined && connection.trace === null) connection.trace = hello.trace;
      if (scope === undefined) return emit(event, ...args);
      if (requests.length === 1) {
        scope({ connection: connection.id, ...requests[0]!.request }, () => emit(event, ...args));
        return true;
      }
      for (const { request, frame } of requests) {
        scope({ connection: connection.id, ...request }, () =>
          emit(event, Buffer.from(JSON.stringify(frame)), false),
        );
      }
      return true;
    }) as typeof socket.emit;
  }

  /** The admission the catalog judges this connection's calls and streams by. */
  function admissionOf(connection: Connection): ConnectionAdmission {
    return {
      signal: connection.admission.signal,
      openStream() {
        if (connection.streams >= limits.maxSubscriptions) return false;
        connection.streams += 1;
        streams += 1;
        return true;
      },
      closeStream() {
        connection.streams -= 1;
        streams -= 1;
      },
    };
  }

  async function handshake(
    connection: Connection,
    params: Readonly<Record<string, string | undefined>> | null,
  ): Promise<inferRouterContext<Router>> {
    const hello = readHostHello(params);
    if (hello === null)
      return refuse(connection, "hello-invalid", "This connection sent no valid hello.");
    const grant = await verify(hello);
    if (grant === null)
      return refuse(connection, "credential-invalid", "The credential is not valid.");
    // A router composed before host scope has no host bootstrap. Refuse the
    // hello rather than admit a connection whose welcome cannot be read.
    if (
      "scope" in hello &&
      // oxlint-disable-next-line no-underscore-dangle -- tRPC's served procedure metadata.
      !HOST_SCOPE_BASE_OPERATIONS.every((key) => Object.hasOwn(options.router._def.procedures, key))
    ) {
      return refuse(
        connection,
        "hello-invalid",
        "This host does not serve host-scoped connections.",
      );
    }
    const workspace = "scope" in hello ? undefined : await options.workspace(hello.workspaceId);
    if (workspace === null) {
      return refuse(connection, "workspace-unknown", "No such workspace on this host");
    }
    const negotiated = negotiateWelcome(
      hello,
      workspace === undefined
        ? { scope: "host", host: options.host, protocol: HOST_PROTOCOL_VERSIONS, features }
        : { host: options.host, protocol: HOST_PROTOCOL_VERSIONS, workspace, features },
      grant.actor,
    );
    if (!negotiated.ok) {
      return refuse(connection, negotiated.error.reason!, negotiated.error.message);
    }
    const { welcome } = negotiated;
    admit(connection, grant);
    log({
      kind: "connected",
      ...named(connection),
      actor: grant.actor.kind,
      ...("scope" in welcome ? {} : { workspaceId: welcome.workspace.id }),
    });
    const caller: NetworkRouterCaller = {
      actor: grant.actor,
      current: () =>
        !connection.admission.signal.aborted && !connection.revoked && grant.current() === true,
    };
    const listenerContext: Pick<CatalogCallerContext, ListenerContextKey> = {
      caller,
      transport: "websocket",
      operations: operationsGrantedBy(welcome.features, "scope" in welcome ? "host" : "workspace"),
      welcome,
      replayBounds: { events: limits.maxReplayEvents, bytes: limits.maxReplayBytes },
      admission: admissionOf(connection),
      maxResponseBytes: limits.maxFrameBytes - FRAME_ENVELOPE_BYTES,
      connectionId: connection.id,
    };
    return {
      ...options.context({ id: connection.id, welcome, caller }),
      ...listenerContext,
    } as inferRouterContext<Router>;
  }

  /**
   * A context that answers every call with the refusal, then a close. Nothing
   * the composition root supplies is in it: no runtime, no port, no actor.
   */
  function refuse(
    connection: Connection,
    reason: HostErrorReason,
    message: string,
  ): inferRouterContext<Router> {
    log({ kind: "handshake-refused", ...named(connection), reason });
    connection.state = "refused";
    clearTimeout(connection.helloTimer);
    const timer = setTimeout(
      () =>
        connection.socket.close(
          reason === "credential-invalid"
            ? HOST_PROTOCOL_CLOSE_CODES.credentialInvalid
            : HOST_PROTOCOL_CLOSE_CODES.handshakeRefused,
          reason,
        ),
      limits.refusedCloseMs,
    );
    connection.disposers.push(() => clearTimeout(timer));
    const refused: HandshakeRefusal = { reason, message };
    return {
      refused,
      // Never a caller the catalog admits, should a refusal ever be skipped.
      caller: { actor: null },
      transport: "websocket",
      diagnostics: NO_DIAGNOSTICS,
    } as unknown as inferRouterContext<Router>;
  }

  /** The verifier's grant, or null. A throw, a malformed actor or a lapsed grant are all null. */
  async function verify(hello: HostConnectionHello): Promise<HostConnectionCredentialGrant | null> {
    let grant: HostConnectionCredentialGrant | null;
    try {
      grant = await options.verifier.verify({
        credential: hello.credential,
        ...("scope" in hello ? { scope: "host" as const } : { workspaceId: hello.workspaceId }),
        nonce: hello.nonce,
        client: hello.client,
      });
    } catch {
      return null;
    }
    // `isHostActor` refuses the reserved local device (D7): no verifier can mint it.
    return grant !== null && isHostConnectionActor(grant.actor) && grant.current() === true
      ? grant
      : null;
  }

  /** The connection holds a grant now: watch it for revocation, by push and by re-check. */
  function admit(connection: Connection, grant: HostConnectionCredentialGrant): void {
    // A peer that left mid-handshake has nothing left to watch.
    if (connection.state === "closed") return;
    connection.state = "admitted";
    clearTimeout(connection.helloTimer);
    const revoke = (): void => {
      if (connection.revoked) return;
      connection.revoked = true;
      log({ kind: "revoked", ...named(connection), streams: connection.streams });
      // Every open stream ends with credential-invalid, which tRPC answers
      // under the client's own request id; every parked call is refused at
      // its resolver. The close follows once those answers are queued.
      connection.admission.abort();
      setImmediate(() =>
        connection.socket.close(HOST_PROTOCOL_CLOSE_CODES.credentialInvalid, "credential-invalid"),
      );
    };
    const recheck = setInterval(() => {
      if (grant.current() !== true) revoke();
    }, limits.grantRecheckMs);
    connection.disposers.push(() => clearInterval(recheck));
    const unwatch = grant.watch?.(revoke);
    if (unwatch !== undefined) connection.disposers.push(unwatch);
  }

  const { port } = tcp.address() as AddressInfo;
  const address = { host: options.bind.host, port };
  return {
    url: `ws://${address.host.includes(":") ? `[${address.host}]` : address.host}:${port}`,
    address,
    get connections() {
      return sockets.size;
    },
    get streams() {
      return streams;
    },
    async close() {
      const closed = new Promise<void>((resolve) => tcp.close(() => resolve()));
      for (const socket of server.clients) socket.terminate();
      for (const socket of sockets) socket.destroy();
      server.close();
      await closed;
    },
  };
}
