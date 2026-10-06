/**
 * The host protocol's WebSocket listener (VC-663; HP § Handshake and
 * capabilities, § Commands, subscriptions and errors). Node-only, so it is
 * its own entry, `@volli/session-rpc/websocket`: the renderer never loads it.
 *
 * It is the stock `applyWSSHandler` over a catalog router, plus what a
 * network door owes that router and nothing more:
 *
 * - **The handshake, in `createContext`, before any procedure.** The hello is
 *   read (`hello-invalid`), the credential verified by the injected port
 *   (`credential-invalid`; the verifier's actor is re-checked, so the reserved
 *   local device can never be minted here), the Workspace looked up
 *   (`workspace-unknown`) and the welcome negotiated (version and fence). A
 *   refused connection gets a context that carries only the refusal: every
 *   operation it queued behind its hello answers that reason through the
 *   catalog before anything else is read, no handler or subscription runs,
 *   and the connection is closed (4400, or 4401 for a credential).
 * - **The grant, for the connection's lifetime.** `current()` is asked at
 *   every dispatch. A revocation (the verifier's push, or the periodic
 *   re-check) answers every subscription the connection holds open with
 *   `UNAUTHORIZED` / `credential-invalid`, then closes the socket (4401); the
 *   close ends each stream's source, so no runtime listener outlives it.
 * - **Feature gating.** The context carries the operations the negotiated
 *   features grant; the catalog refuses any other key.
 * - **Replay bounds** (`SUBSCRIPTION_REPLAY_BOUNDS`, D9), set in the context.
 * - **Bounds on the wire.** Inbound frames are capped (`maxPayload`); a peer
 *   that stops reading is terminated once its unsent bytes pass the outbound
 *   bound, never buffered without end; a connection that never says hello is
 *   closed (4408). Server pings find a peer that vanished.
 *
 * Credentials are never logged: the log names a connection by a random id,
 * and a refusal by its reason.
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { getTRPCErrorShape, type AnyRouter, type inferRouterContext } from "@trpc/server";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import {
  HOST_PROTOCOL_VERSIONS,
  HOST_V1_FEATURES,
  isHostActor,
  negotiateWelcome,
  operationsGrantedBy,
  readHostHello,
  SUBSCRIPTION_REPLAY_BOUNDS,
  type HostActorKind,
  type HostCredentialGrant,
  type HostCredentialVerifier,
  type HostErrorReason,
  type HostFeature,
  type HostHello,
  type HostId,
  type HostWelcome,
  type WorkspaceEpoch,
  type WorkspaceId,
} from "@volli/host-protocol";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

import {
  CREDENTIAL_INVALID_MESSAGE,
  HostProcedureError,
  type CatalogCallerContext,
  type HandshakeRefusal,
  type NetworkRouterCaller,
} from "./catalog";

/** Close codes this listener sends, in the 4000–4999 range RFC 6455 leaves to applications. */
export const HOST_PROTOCOL_CLOSE_CODES = {
  /** The handshake was refused for any reason but the credential; the close reason names it. */
  handshakeRefused: 4400,
  /** The credential was refused, revoked or expired. */
  credentialInvalid: 4401,
  /** No hello arrived within the handshake timeout. */
  helloTimeout: 4408,
} as const;

/** What a connection's context is built from, once its handshake succeeded. */
export interface HostProtocolConnection {
  /** Random, per connection; what the log names it by. */
  readonly id: string;
  readonly welcome: HostWelcome;
  readonly caller: NetworkRouterCaller;
}

/** The context keys the listener owns; a composition root supplies every other. */
type ListenerContextKey =
  | "caller"
  | "transport"
  | "operations"
  | "welcome"
  | "replayBounds"
  | "refused";

export interface HostProtocolListenerLimits {
  /** Unsent bytes one connection may hold before it is terminated as a slow peer. */
  readonly maxOutboundBytes: number;
  /** The largest frame a client may send. */
  readonly maxInboundBytes: number;
  /** How long a connection has to send its hello. */
  readonly handshakeTimeoutMs: number;
  /** How long a refused connection stays open to answer what it queued. */
  readonly refusedCloseMs: number;
  /** How often every grant's `current()` is asked again, beside the verifier's push. */
  readonly grantRecheckMs: number;
  /** Silence before the server pings; a peer that does not answer within 5 s is dropped. */
  readonly pingMs: number;
}

export const DEFAULT_LISTENER_LIMITS: HostProtocolListenerLimits = Object.freeze({
  // Twice the replay byte bound: a full resume may be in flight at once.
  maxOutboundBytes: 2 * SUBSCRIPTION_REPLAY_BOUNDS.bytes,
  maxInboundBytes: 8 * 1024 * 1024,
  handshakeTimeoutMs: 10_000,
  refusedCloseMs: 1_000,
  grantRecheckMs: 30_000,
  pingMs: 30_000,
});

/** What the listener reports. Never a credential, a hello or a payload. */
export type HostProtocolListenerEvent =
  | {
      readonly kind: "handshake-refused";
      readonly connection: string;
      readonly reason: HostErrorReason;
    }
  | {
      readonly kind: "connected";
      readonly connection: string;
      readonly actor: HostActorKind;
      readonly workspaceId: WorkspaceId;
    }
  | { readonly kind: "revoked"; readonly connection: string; readonly streams: number }
  | { readonly kind: "slow-peer"; readonly connection: string; readonly unsentBytes: number }
  | { readonly kind: "hello-timeout"; readonly connection: string }
  | { readonly kind: "closed"; readonly connection: string; readonly code: number };

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
  /** The features this listener serves. Default: every v1 feature. */
  readonly features?: readonly HostFeature[];
  readonly limits?: Partial<HostProtocolListenerLimits>;
  readonly log?: (event: HostProtocolListenerEvent) => void;
}

export interface HostProtocolListener {
  /** Where it listens, `ws://host:port`. */
  readonly url: string;
  readonly address: { readonly host: string; readonly port: number };
  /** Open connections, authenticated or not yet. */
  readonly connections: number;
  /** Stops accepting and closes every connection; its subscriptions end with it. */
  close(): Promise<void>;
}

/** Until VC-575 brings TLS and device keys, a host protocol listener binds loopback only (Q5). */
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(host);
}

/** One socket's state, from accept to close. */
interface Connection {
  readonly id: string;
  readonly socket: WebSocket;
  state: "hello" | "admitted" | "refused" | "closed";
  /** Pending until the handshake settles, either way. */
  helloTimer: NodeJS.Timeout | undefined;
  /** Subscriptions the client opened and has not stopped, by request id, with their paths. */
  readonly streams: Map<unknown, string>;
  revoked: boolean;
  readonly disposers: (() => void)[];
}

/** What `trackStreams` reads of a client message: tRPC's own envelope, loosely. */
interface TrackedMessage {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: { readonly path?: unknown } | null;
}

/** A refused connection's context: the refusal, and no caller any handler could use. */
const NO_DIAGNOSTICS = Object.freeze({ record: () => undefined });

export async function startHostProtocolListener<Router extends AnyRouter>(
  options: HostProtocolListenerOptions<Router>,
): Promise<HostProtocolListener> {
  if (!isLoopbackHost(options.bind.host)) {
    throw new Error(
      `The host protocol listener binds loopback only until VC-575; refusing ${options.bind.host}`,
    );
  }
  const limits = { ...DEFAULT_LISTENER_LIMITS, ...options.limits };
  const features = options.features ?? HOST_V1_FEATURES;
  const log = options.log ?? (() => {});
  const connections = new WeakMap<WebSocket, Connection>();

  const server = new WebSocketServer({
    host: options.bind.host,
    port: options.bind.port,
    maxPayload: limits.maxInboundBytes,
  });
  await once(server, "listening");

  // Registered before tRPC's own handler, so every message tRPC reads was
  // seen here first and every send it makes is bounded.
  server.on("connection", (socket) => {
    const connection: Connection = {
      id: randomUUID(),
      socket,
      state: "hello",
      helloTimer: undefined,
      streams: new Map(),
      revoked: false,
      disposers: [],
    };
    connections.set(socket, connection);
    boundOutbound(connection);
    socket.on("message", (data) => trackStreams(connection, data));
    connection.helloTimer = setTimeout(() => {
      log({ kind: "hello-timeout", connection: connection.id });
      socket.close(HOST_PROTOCOL_CLOSE_CODES.helloTimeout, "hello-timeout");
    }, limits.handshakeTimeoutMs);
    connection.disposers.push(() => clearTimeout(connection.helloTimer));
    socket.once("close", (code) => {
      connection.state = "closed";
      for (const dispose of connection.disposers.splice(0)) dispose();
      log({ kind: "closed", connection: connection.id, code });
    });
  });

  applyWSSHandler<Router>({
    wss: server,
    router: options.router,
    keepAlive: { enabled: true, pingMs: limits.pingMs },
    createContext: ({ res, info }) => handshake(connections.get(res)!, info.connectionParams),
  });

  /**
   * Terminates a peer that stopped reading. Judged before each send: a single
   * large answer may go out whole, but a connection that still holds more
   * than the bound when the next frame is due is not draining.
   */
  function boundOutbound(connection: Connection): void {
    const { socket } = connection;
    const send = socket.send.bind(socket) as (...args: unknown[]) => void;
    socket.send = ((...args: unknown[]) => {
      if (socket.bufferedAmount > limits.maxOutboundBytes) {
        log({ kind: "slow-peer", connection: connection.id, unsentBytes: socket.bufferedAmount });
        socket.terminate();
        return;
      }
      send(...args);
    }) as WebSocket["send"];
  }

  /**
   * Which subscriptions the client holds open, from what it sends: what a
   * revocation must answer. Malformed input is tRPC's to refuse, not ours.
   */
  function trackStreams(connection: Connection, data: RawData): void {
    if (connection.state !== "admitted") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    for (const message of [parsed].flat() as (TrackedMessage | null)[]) {
      if (message?.method === "subscription.stop") connection.streams.delete(message.id);
      const path = message?.params?.path;
      if (message?.method === "subscription" && typeof path === "string") {
        connection.streams.set(message.id, path);
      }
    }
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
    const workspace = await options.workspace(hello.workspaceId);
    if (workspace === null) {
      return refuse(connection, "workspace-unknown", "No such workspace on this host");
    }
    const negotiated = negotiateWelcome(
      hello,
      { host: options.host, protocol: HOST_PROTOCOL_VERSIONS, workspace, features },
      grant.actor,
    );
    if (!negotiated.ok) {
      return refuse(connection, negotiated.error.reason!, negotiated.error.message);
    }
    const { welcome } = negotiated;
    admit(connection, grant);
    log({
      kind: "connected",
      connection: connection.id,
      actor: grant.actor.kind,
      workspaceId: welcome.workspace.id,
    });
    const caller: NetworkRouterCaller = {
      actor: grant.actor,
      current: () => !connection.revoked && grant.current() === true,
    };
    const listenerContext: Pick<CatalogCallerContext, ListenerContextKey> = {
      caller,
      transport: "websocket",
      operations: operationsGrantedBy(welcome.features),
      welcome,
      replayBounds: SUBSCRIPTION_REPLAY_BOUNDS,
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
    log({ kind: "handshake-refused", connection: connection.id, reason });
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
  async function verify(hello: HostHello): Promise<HostCredentialGrant | null> {
    let grant: HostCredentialGrant | null;
    try {
      grant = await options.verifier.verify({
        credential: hello.credential,
        workspaceId: hello.workspaceId,
        nonce: hello.nonce,
        client: hello.client,
      });
    } catch {
      return null;
    }
    // `isHostActor` refuses the reserved local device (D7): no verifier can mint it.
    return grant !== null && isHostActor(grant.actor) && grant.current() === true ? grant : null;
  }

  /** The connection holds a grant now: watch it for revocation, by push and by re-check. */
  function admit(connection: Connection, grant: HostCredentialGrant): void {
    // A peer that left mid-handshake has nothing left to watch.
    if (connection.state === "closed") return;
    connection.state = "admitted";
    clearTimeout(connection.helloTimer);
    const revoke = (): void => {
      if (connection.revoked) return;
      connection.revoked = true;
      log({ kind: "revoked", connection: connection.id, streams: connection.streams.size });
      // Each open stream hears why, then the close ends every source behind them.
      for (const [id, path] of connection.streams) {
        const error = new HostProcedureError("credential-invalid", CREDENTIAL_INVALID_MESSAGE);
        const shape = getTRPCErrorShape({
          // oxlint-disable-next-line no-underscore-dangle -- tRPC's router config, as its adapter reads it.
          config: options.router._def._config,
          error,
          type: "subscription",
          path,
          input: undefined,
          ctx: undefined,
        });
        connection.socket.send(JSON.stringify({ id, error: shape }));
      }
      connection.socket.close(HOST_PROTOCOL_CLOSE_CODES.credentialInvalid, "credential-invalid");
    };
    const recheck = setInterval(() => {
      if (grant.current() !== true) revoke();
    }, limits.grantRecheckMs);
    connection.disposers.push(() => clearInterval(recheck));
    const unwatch = grant.watch?.(revoke);
    if (unwatch !== undefined) connection.disposers.push(unwatch);
  }

  const { port } = server.address() as AddressInfo;
  const address = { host: options.bind.host, port };
  return {
    url: `ws://${address.host.includes(":") ? `[${address.host}]` : address.host}:${port}`,
    address,
    get connections() {
      return server.clients.size;
    },
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
