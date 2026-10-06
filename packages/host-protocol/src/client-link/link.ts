/**
 * One client host link per Workspace (VC-670; HP § The client host link).
 *
 * Every Client that reaches a host over the WebSocket goes through this: a
 * store asks the link, never a tRPC socket. The link owns the socket's whole
 * life, around a *configured* tRPC `wsClient`, because the stock client's
 * defaults are wrong for one authority that is sometimes away:
 *
 * - **It finds a dead socket.** A heartbeat pings after inbound silence and
 *   declares the socket dead when the ping goes unanswered, without waiting
 *   for a close handshake a vanished peer never answers. A wake (power resume,
 *   the network returning) probes at once, or reconnects at once when the link
 *   is already down.
 * - **It handshakes before anything else.** Every connect and reconnect sends
 *   a fresh hello (`buildHostHello`, the credential asked of its provider each
 *   time), reads `protocol.welcome` and judges it with `validateWelcome`, which
 *   ends in the authority fence (`checkWorkspaceFence`). Only a validated
 *   welcome makes the link `ready`; only `ready` sends a call or resubscribes.
 * - **It never queues.** A call while the link is not `ready` fails at once
 *   with `host-unreachable`, and a call in flight when the socket dies fails
 *   with it too: one authority, never sync (Ruling 1). Each connection is its
 *   own `wsClient`, retired whole when the socket ends, so nothing it held
 *   can be sent on the next.
 * - **It resumes subscriptions itself**, from each one's last tracked id, once
 *   the next welcome validates; `subscription-resnapshot-required` goes to the
 *   subscriber's `onResnapshot`, never to a silent reload.
 * - **It says what it is.** One state, observable: `connecting`, `ready`,
 *   `unreachable` (retrying), `refused`, `fenced` or `closed`. Close codes
 *   4400/4401/4413 and their reason text become typed states, never "Active
 *   connection is not open". The state holds no Workspace data (D-C1).
 *
 * Renderer-safe: no Node, no Electron, no `ws`. The WebSocket implementation
 * is the platform's unless a caller injects one; wake signals arrive through
 * {@link HostLink.wake}, so the desktop wires `powerMonitor` and the network
 * itself.
 */
import { createWSClient, type TRPCWebSocketClient } from "@trpc/client";

import {
  hostError,
  isHostErrorReason,
  isResnapshotRequired,
  readHostError,
  type HostError,
} from "../errors";
import {
  buildHostHello,
  encodeHostHello,
  HOST_PROTOCOL_CLOSE_CODES,
  type HostFeature,
  type HostHello,
  type HostWelcome,
  type WorkspaceAuthority,
} from "../handshake";
import type { WorkspaceId } from "../identity";
import { validateWelcome, type ValidateWelcomeOptions } from "../welcome";
import {
  HOST_LINK_TIMING,
  hostLinkBackoffDelay,
  validateHostLinkTiming,
  type HostLinkTiming,
} from "./policy";

/** What the link is doing. Immutable; a new object on every change. */
export type HostLinkState =
  /** An attempt is in flight. `attempt` counts the failures before it (0 on the first). */
  | { readonly status: "connecting"; readonly attempt: number }
  /** The welcome validated; calls go out and subscriptions stream. */
  | { readonly status: "ready"; readonly welcome: HostWelcome }
  /**
   * The last attempt failed or the connection dropped; the next attempt starts
   * at `retryAt` (epoch ms) unless a wake brings it forward. `error` says why,
   * `closeCode` is the socket's close code when there was one.
   */
  | {
      readonly status: "unreachable";
      readonly attempt: number;
      readonly error: HostError;
      readonly closeCode: number | null;
      readonly retryAt: number;
    }
  /** The host refused the handshake (4400/4401, or a welcome this client refused). Stays until {@link HostLink.reconnect}. */
  | { readonly status: "refused"; readonly error: HostError; readonly closeCode: number | null }
  /** The authority fence failed: the Workspace moved, or two hosts claim it. Stays until {@link HostLink.reconnect}. */
  | { readonly status: "fenced"; readonly error: HostError }
  /** The owner closed the link. Final. */
  | { readonly status: "closed" };

export type HostLinkStatus = HostLinkState["status"];

/** What tells a link the world changed under it. The desktop maps `powerMonitor` and `online` here. */
export type HostLinkWakeCause = "power-resume" | "network-online";

/** One subscription's handlers. Every subscription states what a resnapshot means to it. */
export interface HostLinkSubscriptionHandlers {
  /** The host started the stream; again after every resume. */
  onStarted?(): void;
  /** One emission; a tracked one is `{ id, data }`, and the link resumes after its id. */
  onData(data: unknown): void;
  /**
   * The host cannot resume this cursor (`subscription-resnapshot-required`):
   * re-read the snapshot and subscribe from its cursor. The subscription has
   * ended; nothing else is called.
   */
  onResnapshot(error: HostError): void;
  /** The subscription ended on a failure the link does not recover. `readHostError` reads it. */
  onError(error: unknown): void;
  /** The host ended the stream cleanly. */
  onComplete?(): void;
}

export interface HostLinkSubscription {
  unsubscribe(): void;
}

export interface HostLinkSubscribeOptions {
  /** A cursor this subscriber already applied: the first subscribe resumes after it. */
  readonly lastEventId?: string;
}

export interface HostLink {
  readonly workspaceId: WorkspaceId;
  getState(): HostLinkState;
  /** Called on every change, not with the current state: `useSyncExternalStore`'s shape. */
  subscribeState(listener: (state: HostLinkState) => void): () => void;
  /** A query, sent only while `ready`; otherwise it fails at once. */
  query(path: string, input?: unknown): Promise<unknown>;
  /** A mutation, sent only while `ready`; otherwise it fails at once. Never queued, never resent. */
  mutate(path: string, input?: unknown): Promise<unknown>;
  /**
   * A subscription the link keeps across reconnects: opened when the link is
   * `ready`, resumed from its last tracked id after each validated welcome.
   */
  subscribe(
    path: string,
    input: unknown,
    handlers: HostLinkSubscriptionHandlers,
    options?: HostLinkSubscribeOptions,
  ): HostLinkSubscription;
  /** A ready link probes now; an unreachable one reconnects now. Otherwise nothing. */
  wake(cause: HostLinkWakeCause): void;
  /** An explicit retry: from `unreachable`, `refused` or `fenced`, connect now. */
  reconnect(): void;
  /** Ends the link: calls in flight fail, subscriptions end silently, nothing reconnects. */
  close(): void;
}

export interface HostLinkOptions {
  /** `ws:` or `wss:`. */
  readonly url: string;
  readonly workspaceId: WorkspaceId;
  readonly client: HostHello["client"];
  readonly features: readonly HostFeature[];
  /**
   * Asked on every connect and reconnect, never cached by the link, so a
   * short-lived or account-issued credential is fresh on each handshake.
   * Pairing is one source of it, not an assumption.
   */
  readonly credential: () => string | Promise<string>;
  /**
   * The highest authority this client already accepted for the Workspace.
   * The link raises it on every validated welcome; persisting it is the
   * owner's (the `ready` state carries the welcome).
   */
  readonly lastSeen?: WorkspaceAuthority | null;
  readonly verifyProof?: ValidateWelcomeOptions["verifyProof"];
  /** The platform's by default. */
  readonly WebSocket?: typeof WebSocket;
  readonly timing?: Partial<HostLinkTiming>;
  /** Backoff jitter, in [0, 1). */
  readonly random?: () => number;
}

/** A failure the link itself answers, shaped so `readHostError` reads it on either side of tRPC. */
export class HostLinkError extends Error {
  readonly hostError: HostError;
  readonly data: { readonly code: HostError["code"]; readonly hostError: HostError };

  constructor(error: HostError) {
    super(error.message);
    this.name = "HostLinkError";
    this.hostError = error;
    this.data = { code: error.code, hostError: error };
  }
}

/** Reasons a host gives for refusing a handshake. Anything else from `protocol.welcome` is a fault, retried. */
const HANDSHAKE_REFUSALS: ReadonlySet<string> = new Set([
  "hello-invalid",
  "credential-invalid",
  "workspace-unknown",
  "protocol-version-unsupported",
  "welcome-invalid",
  "workspace-epoch-fenced",
  "workspace-split-brain",
]);
const FENCE_REASONS: ReadonlySet<string> = new Set([
  "workspace-epoch-fenced",
  "workspace-split-brain",
]);

/** No transformer on the wire (HP § Decisions): JSON in, JSON out. */
const IDENTITY = { serialize: (value: unknown) => value, deserialize: (value: unknown) => value };
const TRANSFORMER = { input: IDENTITY, output: IDENTITY };

/** tRPC's own reconnect never runs (the link retires a client at its socket's first error or close); this only bounds it if it did. */
const TRPC_RETRY_MS = 1_000;

type Outcome =
  | { readonly status: "unreachable"; readonly error: HostError; readonly closeCode: number | null }
  | { readonly status: "refused"; readonly error: HostError; readonly closeCode: number | null }
  | { readonly status: "fenced"; readonly error: HostError };

/** One socket, one `wsClient`, one hello: everything a connection holds dies with it. */
interface Connection {
  readonly hello: HostHello;
  client: TRPCWebSocketClient | null;
  socket: WebSocket | null;
  phase: "handshake" | "ready";
  /** No traffic after this; every callback from it is ignored. */
  retired: boolean;
  nextId: number;
  /** In-flight calls: each rejects `host-unreachable` when the connection is retired. */
  readonly inflight: Set<() => void>;
  silence: ReturnType<typeof setTimeout> | undefined;
  deadline: ReturnType<typeof setTimeout> | undefined;
}

interface Entry {
  readonly path: string;
  readonly input: unknown;
  readonly handlers: HostLinkSubscriptionHandlers;
  lastEventId: string | undefined;
  ended: boolean;
  /** Whether the current open delivered anything: an overflow resume must make progress. */
  delivered: boolean;
  detach: (() => void) | null;
}

export function createHostLink(options: HostLinkOptions): HostLink {
  const timing: HostLinkTiming = { ...HOST_LINK_TIMING, ...options.timing };
  validateHostLinkTiming(timing);
  const protocol = new URL(options.url).protocol;
  if (protocol !== "ws:" && protocol !== "wss:") {
    throw new Error(`A host link speaks ws: or wss:, not ${protocol}`);
  }
  const Socket = options.WebSocket ?? globalThis.WebSocket;
  const random = options.random ?? Math.random;

  let state: HostLinkState = { status: "connecting", attempt: 0 };
  const listeners = new Set<(state: HostLinkState) => void>();
  const entries = new Set<Entry>();
  let lastSeen: WorkspaceAuthority | null = options.lastSeen ?? null;
  let connection: Connection | null = null;
  let failures = 0;
  /** Bumped by every attempt and every stop, so an attempt overtaken mid-await does nothing. */
  let attemptToken = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;

  function setState(next: HostLinkState): void {
    state = next;
    for (const listener of listeners) listener(next);
  }

  /* ------------------------------------------------------------- attempts */

  async function connect(): Promise<void> {
    clearTimeout(retryTimer);
    const token = ++attemptToken;
    setState({ status: "connecting", attempt: failures });
    handshakeTimer = setTimeout(() => {
      fail(
        connection,
        unreachable(
          `The host did not complete the handshake within ${timing.handshakeTimeoutMs} ms`,
        ),
      );
    }, timing.handshakeTimeoutMs);
    let credential: string;
    try {
      credential = await options.credential();
    } catch (error) {
      if (token === attemptToken) {
        fail(null, unreachable(`No credential for the host: ${messageOf(error)}`));
      }
      return;
    }
    if (token !== attemptToken) return;
    const hello = buildHostHello({
      client: options.client,
      workspaceId: options.workspaceId,
      credential,
      features: options.features,
      lastSeen,
    });
    open(hello);
  }

  function open(hello: HostHello): void {
    const current: Connection = {
      hello,
      client: null,
      socket: null,
      phase: "handshake",
      retired: false,
      nextId: 1,
      inflight: new Set(),
      silence: undefined,
      deadline: undefined,
    };
    connection = current;
    // The socket is captured as tRPC builds it, so the link hears its open,
    // frames, error and close before tRPC's own listeners do.
    const Captured = new Proxy(Socket, {
      construct(target, args: [string]) {
        const socket = new target(...args);
        current.socket = socket;
        watch(current, socket);
        return socket;
      },
    });
    current.client = createWSClient({
      url: options.url,
      WebSocket: Captured,
      connectionParams: () => encodeHostHello(hello),
      lazy: { enabled: false, closeMs: 0 },
      // The link's heartbeat replaces tRPC's: its timeout only starts a close
      // handshake, which a vanished peer never answers.
      keepAlive: { enabled: false },
      retryDelayMs: () => TRPC_RETRY_MS,
    });
    const welcome = request(current, "query", "protocol.welcome", undefined).subscribe({
      // Retiring unsubscribes it, so neither arrives for a retired connection.
      next: (envelope) => {
        current.inflight.delete(stop);
        welcomed(current, (envelope.result as { data?: unknown }).data);
      },
      error: (error) => {
        current.inflight.delete(stop);
        const refusal = serverError(error);
        // A transport failure here means the socket is going: its close
        // event (or the handshake timeout) is what classifies the attempt.
        if (refusal === null) return;
        fail(current, refusalOutcome(refusal, null));
      },
    });
    // Retiring stops waiting for it, so a dead host's socket closes now.
    const stop = (): void => welcome.unsubscribe();
    current.inflight.add(stop);
  }

  function welcomed(current: Connection, welcome: unknown): void {
    const verdict = validateWelcome(
      welcome,
      current.hello,
      options.verifyProof === undefined ? {} : { verifyProof: options.verifyProof },
    );
    if (!verdict.ok) {
      fail(current, refusalOutcome(verdict.error, null));
      return;
    }
    clearTimeout(handshakeTimer);
    current.phase = "ready";
    failures = 0;
    lastSeen = { epoch: verdict.welcome.workspace.epoch, hostId: verdict.welcome.host.id };
    setState({ status: "ready", welcome: verdict.welcome });
    // Only now: no subscription reaches a host whose welcome this client has not judged.
    for (const entry of entries) openSubscription(entry, current);
  }

  /** Settles the link once for a connection that failed, and retires it. */
  function fail(current: Connection | null, outcome: Outcome): void {
    if (current !== null) {
      if (current.retired || connection !== current) return;
      retire(current);
    }
    clearTimeout(handshakeTimer);
    connection = null;
    attemptToken += 1;
    if (outcome.status === "unreachable") {
      failures += 1;
      const delay = hostLinkBackoffDelay(failures, timing, random);
      setState({
        status: "unreachable",
        attempt: failures,
        error: outcome.error,
        closeCode: outcome.closeCode,
        retryAt: Date.now() + delay,
      });
      retryTimer = setTimeout(() => void connect(), delay);
      return;
    }
    setState(outcome);
    endAll(new HostLinkError(outcome.error));
  }

  /** No traffic after this: calls in flight fail, streams detach and wait for the next connection. */
  function retire(current: Connection): void {
    current.retired = true;
    clearTimeout(current.silence);
    clearTimeout(current.deadline);
    for (const abort of current.inflight) abort();
    for (const entry of entries) {
      const detach = entry.detach;
      entry.detach = null;
      detach?.();
    }
    // Never rejects: it settles what it held and closes.
    void current.client?.close();
    // A no-op on a socket already closing; a dead host's socket stops waiting on it.
    current.socket?.close();
  }

  function endAll(error: HostLinkError): void {
    for (const entry of entries) {
      end(entry);
      entry.handlers.onError(error);
    }
  }

  function end(entry: Entry): void {
    entry.ended = true;
    entries.delete(entry);
    const detach = entry.detach;
    entry.detach = null;
    detach?.();
  }

  /* ------------------------------------------------------------ the socket */

  function watch(current: Connection, socket: WebSocket): void {
    socket.addEventListener("open", () => heard(current));
    socket.addEventListener("message", () => heard(current));
    // A socket error is always the end of it; the close that follows changes nothing.
    socket.addEventListener("error", () =>
      fail(current, unreachable("The connection to the host failed")),
    );
    socket.addEventListener("close", (event) =>
      fail(current, closeOutcome(event.code, event.reason, current.phase)),
    );
  }

  /** Any frame from the host proves the socket alive; silence from here arms the next ping. */
  function heard(current: Connection): void {
    /* v8 ignore next -- a frame that was already in flight when the link retired the socket; nothing arms a timer for it. */
    if (current.retired) return;
    clearTimeout(current.deadline);
    current.deadline = undefined;
    clearTimeout(current.silence);
    current.silence = setTimeout(() => probe(current), timing.heartbeatIntervalMs);
  }

  function probe(current: Connection): void {
    if (current.deadline !== undefined) return;
    // Only ever armed after the socket opened. tRPC's server answers PONG.
    current.socket!.send("PING");
    current.deadline = setTimeout(() => {
      fail(
        current,
        unreachable(`The host did not answer a heartbeat within ${timing.heartbeatTimeoutMs} ms`),
      );
    }, timing.heartbeatTimeoutMs);
  }

  /* ------------------------------------------------------------ the traffic */

  function request(
    current: Connection,
    type: "query" | "mutation" | "subscription",
    path: string,
    input: unknown,
    lastEventId?: string,
  ) {
    return current.client!.request({
      op: { id: current.nextId++, type, path, input, signal: null },
      transformer: TRANSFORMER,
      ...(lastEventId === undefined ? {} : { lastEventId }),
    });
  }

  function call(type: "query" | "mutation", path: string, input: unknown): Promise<unknown> {
    const current = connection;
    if (
      state.status !== "ready" ||
      current === null ||
      current.socket?.readyState !== Socket.OPEN
    ) {
      return Promise.reject(new HostLinkError(unavailable()));
    }
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        current.inflight.delete(abort);
        subscription.unsubscribe();
        reject(abortError());
      };
      current.inflight.add(abort);
      const subscription = request(current, type, path, input).subscribe({
        next: (envelope) => {
          current.inflight.delete(abort);
          resolve((envelope.result as { data?: unknown }).data);
        },
        // Retiring unsubscribes it (and rejects through `abort`), so this is a live connection's.
        error: (error) => {
          current.inflight.delete(abort);
          // A transport failure: the send failed, and the socket is going.
          reject(serverError(error) === null ? abortError() : error);
        },
      });
    });
  }

  function openSubscription(entry: Entry, current: Connection): void {
    // A socket already closing would make tRPC open another for this
    // connection; the stream waits for the next welcome instead.
    if (current.socket!.readyState !== Socket.OPEN) return;
    entry.delivered = false;
    const subscription = request(
      current,
      "subscription",
      entry.path,
      entry.input,
      entry.lastEventId,
    ).subscribe({
      // Retiring or unsubscribing deletes the request, so only `complete`
      // (which tRPC calls on the way out) can arrive after either.
      next: (envelope) => {
        const result = envelope.result as { type?: string; id?: unknown; data?: unknown };
        if (result.type === "started") {
          entry.handlers.onStarted?.();
        } else if (result.type === "data") {
          if (result.id !== undefined) entry.lastEventId = String(result.id);
          entry.delivered = true;
          entry.handlers.onData(result.data);
        }
      },
      error: (error) => {
        entry.detach = null;
        failed(entry, current, error);
      },
      complete: () => {
        if (current.retired || entry.ended) return;
        end(entry);
        entry.handlers.onComplete?.();
      },
    });
    entry.detach = () => subscription.unsubscribe();
  }

  function failed(entry: Entry, current: Connection, error: unknown): void {
    const failure = serverError(error);
    // A transport failure, or a revocation the 4401 close follows: the next
    // connection's welcome decides whether this stream resumes.
    if (failure === null || failure.reason === "credential-invalid") return;
    if (isResnapshotRequired(failure)) {
      end(entry);
      entry.handlers.onResnapshot(failure);
      return;
    }
    // HP: an overflow drained what it held; resume from the last applied id.
    // Only after progress, so a stream that cannot keep up at all surfaces.
    if (failure.reason === "subscription-overflow" && entry.delivered) {
      openSubscription(entry, current);
      return;
    }
    end(entry);
    entry.handlers.onError(error);
  }

  function unavailable(): HostError {
    switch (state.status) {
      case "refused":
      case "fenced":
        return state.error;
      case "unreachable":
        return hostError("host-unreachable", `The host is unreachable: ${state.error.message}`);
      case "closed":
        return hostError("host-unreachable", "The host link is closed");
      default:
        return hostError("host-unreachable", "The host link has no open connection");
    }
  }

  /* ------------------------------------------------------------ the owner */

  const link: HostLink = {
    workspaceId: options.workspaceId,
    getState: () => state,
    subscribeState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    query: (path, input) => call("query", path, input),
    mutate: (path, input) => call("mutation", path, input),
    subscribe(path, input, handlers, subscribeOptions = {}) {
      const entry: Entry = {
        path,
        input,
        handlers,
        lastEventId: subscribeOptions.lastEventId,
        ended: false,
        delivered: false,
        detach: null,
      };
      if (state.status === "refused" || state.status === "fenced" || state.status === "closed") {
        const error = new HostLinkError(unavailable());
        entry.ended = true;
        queueMicrotask(() => handlers.onError(error));
      } else {
        entries.add(entry);
        if (state.status === "ready") openSubscription(entry, connection!);
      }
      return {
        unsubscribe() {
          if (!entry.ended) end(entry);
        },
      };
    },
    wake() {
      if (state.status === "ready") probe(connection!);
      else if (state.status === "unreachable") {
        failures = 0;
        void connect();
      }
    },
    reconnect() {
      if (
        state.status === "unreachable" ||
        state.status === "refused" ||
        state.status === "fenced"
      ) {
        failures = 0;
        void connect();
      }
    },
    close() {
      if (state.status === "closed") return;
      attemptToken += 1;
      clearTimeout(retryTimer);
      clearTimeout(handshakeTimer);
      if (connection !== null) retire(connection);
      connection = null;
      for (const entry of entries) end(entry);
      setState({ status: "closed" });
    },
  };

  void connect();
  return link;
}

/** A server's answer (it carries tRPC error data), read as a HostError; null for a transport failure. */
function serverError(error: unknown): HostError | null {
  const data = (error as { data?: unknown }).data;
  return typeof data === "object" && data !== null ? readHostError(error) : null;
}

function refusalOutcome(error: HostError, closeCode: number | null): Outcome {
  if (error.reason !== undefined && FENCE_REASONS.has(error.reason)) {
    return { status: "fenced", error };
  }
  if (error.reason !== undefined && HANDSHAKE_REFUSALS.has(error.reason)) {
    return { status: "refused", error, closeCode };
  }
  return { status: "unreachable", error, closeCode };
}

/** A close, read by its code and reason text: refusals during the handshake, everything else a drop. */
function closeOutcome(code: number, reason: string, phase: Connection["phase"]): Outcome {
  const refusal = code === HOST_PROTOCOL_CLOSE_CODES.handshakeRefused;
  const credential = code === HOST_PROTOCOL_CLOSE_CODES.credentialInvalid;
  if (phase === "handshake" && (refusal || credential)) {
    // The code is the refusal; the reason text names it when this build knows the name.
    const named = isHostErrorReason(reason) ? reason : credential ? "credential-invalid" : null;
    const message = describeClose("refused the handshake", reason);
    if (named !== null && FENCE_REASONS.has(named)) {
      return { status: "fenced", error: hostError(named, message) };
    }
    const error =
      named === null ? { code: "BAD_REQUEST" as const, message } : hostError(named, message);
    return { status: "refused", error, closeCode: code };
  }
  if (credential) {
    // A grant that ended mid-connection: the next handshake asks the
    // provider for a fresh credential, and is refused if there is none.
    return {
      status: "unreachable",
      error: hostError("credential-invalid", describeClose("revoked this connection", reason)),
      closeCode: code,
    };
  }
  if (code === HOST_PROTOCOL_CLOSE_CODES.responseTooLarge) {
    return {
      status: "unreachable",
      error: hostError(
        "response-too-large",
        "The host closed the connection rather than send a frame past its bound",
      ),
      closeCode: code,
    };
  }
  return {
    status: "unreachable",
    error: hostError("host-unreachable", describeClose(`closed the connection (${code})`, reason)),
    closeCode: code,
  };
}

function describeClose(what: string, reason: string): string {
  return reason === "" ? `The host ${what}` : `The host ${what}: ${reason}`;
}

function unreachable(message: string): Outcome {
  return { status: "unreachable", error: hostError("host-unreachable", message), closeCode: null };
}

function abortError(): HostLinkError {
  return new HostLinkError(
    hostError(
      "host-unreachable",
      "The connection to the host ended before it answered; whether the call took effect is unknown",
    ),
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
