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
 *   own `wsClient` and one socket, retired whole when the socket ends or the
 *   host asks for a reconnect (before tRPC's own reconnect can resend what it
 *   held), so nothing it held can be sent on the next.
 * - **It resumes subscriptions itself**, from each one's last tracked id, once
 *   the next welcome validates; `subscription-resnapshot-required` goes to the
 *   subscriber's `onResnapshot`, never to a silent reload.
 * - **It says what it is.** One state, observable: `connecting`, `ready`,
 *   `unreachable` (retrying), `refused`, `fenced` or `closed`. Close codes
 *   4400/4401/4413 and their reason text become typed states, never "Active
 *   connection is not open". The state holds no Workspace data (D-C1).
 *
 * - **It traces what it sends** (VC-699). Every frame carries a trace beside
 *   its id (`HOST_TRACE_FIELD`): the call's own, the link's flow trace with a
 *   fresh span, or a fresh trace; so a host's log lines for a request carry
 *   the Client's trace. Every state change, wake, resume and resnapshot is
 *   reported to the owner's `log` with its reason and trace.
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
import { classifyHandshakeFailure } from "./handshake-failure";
import { mintHostTrace, nextHostSpan, withHostTrace, type HostTrace } from "../trace";
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
  /**
   * One emission; a tracked one is `{ id, data }`, and the link resumes after
   * its id. `tracked` names that id, for an owner that resumes a stream of its
   * own after it (desktop main's Workspace link relay, VC-711).
   */
  onData(data: unknown, tracked?: { readonly id: string }): void;
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

export interface HostLinkSubscribeOptions extends HostLinkCallOptions {
  /** A cursor this subscriber already applied: the first subscribe resumes after it. */
  readonly lastEventId?: string;
}

/** What one call may say about itself. */
export interface HostLinkCallOptions {
  /**
   * The operation this call belongs to: the trace minted when a person started
   * it. The link sends it with a fresh span. Absent, the link's own `traceId`
   * is used, or the call is an operation of its own.
   */
  readonly trace?: Pick<HostTrace, "traceId">;
}

/**
 * What the link reports to its owner's log (VC-699): every state change with
 * its reason, every wake, and every resume and resnapshot. Identifiers and
 * reasons only, never a credential, a hello or a payload.
 */
export type HostLinkLogEvent =
  | {
      readonly kind: "state";
      readonly from: HostLinkStatus;
      readonly to: HostLinkStatus;
      /** The trace of the connect attempt this change belongs to. */
      readonly traceId: string;
      readonly attempt?: number;
      readonly reason?: string;
      readonly closeCode?: number | null;
      readonly retryInMs?: number;
      readonly hostId?: string;
      readonly epoch?: number;
    }
  | {
      readonly kind: "wake";
      readonly cause: HostLinkWakeCause;
      readonly status: HostLinkStatus;
      readonly traceId: string;
    }
  | {
      readonly kind: "resubscribe";
      readonly path: string;
      /** Whether it resumed after a cursor, or opened from its start. */
      readonly resumed: boolean;
      readonly why: "welcome" | "overflow";
      readonly traceId: string;
    }
  | { readonly kind: "resnapshot"; readonly path: string; readonly traceId: string };

export interface HostLink {
  readonly workspaceId: WorkspaceId;
  getState(): HostLinkState;
  /** Called on every change, not with the current state: `useSyncExternalStore`'s shape. */
  subscribeState(listener: (state: HostLinkState) => void): () => void;
  /** A query, sent only while `ready`; otherwise it fails at once. */
  query(path: string, input?: unknown, options?: HostLinkCallOptions): Promise<unknown>;
  /** A mutation, sent only while `ready`; otherwise it fails at once. Never queued, never resent. */
  mutate(path: string, input?: unknown, options?: HostLinkCallOptions): Promise<unknown>;
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

/**
 * What a typed client and a store send through: a link's calls, without its
 * state or lifecycle. A {@link HostLink} is one; so is the desktop window's
 * relay to a Workspace link main holds (VC-711), whose state it reads elsewhere.
 */
export type HostLinkCalls = Pick<HostLink, "query" | "mutate" | "subscribe">;

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
  /**
   * The operation this link serves, when one person-started flow owns it
   * ("Add a host" connects it): every connect and every call without a trace
   * of its own carries this trace, each with a fresh span. Absent, each
   * connect attempt and each call is its own trace.
   */
  readonly traceId?: string;
  /** Hears every state change, wake, resume and resnapshot (VC-699). */
  readonly log?: (event: HostLinkLogEvent) => void;
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

const FENCE_REASONS: ReadonlySet<string> = new Set([
  "workspace-epoch-fenced",
  "workspace-split-brain",
]);

/** No transformer on the wire (HP § Decisions): JSON in, JSON out. */
const IDENTITY = { serialize: (value: unknown) => value, deserialize: (value: unknown) => value };
const TRANSFORMER = { input: IDENTITY, output: IDENTITY };

/**
 * tRPC's own reconnect never opens anything: the link retires a client at its
 * socket's first error, close or server-requested reconnect, before tRPC hears
 * it, and a retired Connection's captured constructor refuses. This only paces
 * the loop tRPC runs until it reads that it was closed.
 */
const TRPC_RETRY_MS = 1_000;

type Outcome =
  | { readonly status: "unreachable"; readonly error: HostError; readonly closeCode: number | null }
  | { readonly status: "refused"; readonly error: HostError; readonly closeCode: number | null }
  | { readonly status: "fenced"; readonly error: HostError };

/** One socket, one `wsClient`, one hello: everything a connection holds dies with it. */
interface Connection {
  readonly hello: HostHello;
  /** The connect attempt's trace: its hello frame and its state changes carry it. */
  readonly trace: HostTrace;
  /** Each request id's trace, until its frame is sent. */
  readonly traces: Map<number, HostTrace>;
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
  /** The subscription's operation: every open and resume is a span of it. */
  readonly traceId: string;
  /** Whether it was ever opened: the next open is then a resume. */
  opened: boolean;
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
  const log = options.log;
  /** A span of the link's flow, or a fresh trace: what a frame with no trace of its own carries. */
  const traceFor = (given?: Pick<HostTrace, "traceId">): HostTrace => {
    const traceId = given?.traceId ?? options.traceId;
    return traceId === undefined ? mintHostTrace() : nextHostSpan({ traceId });
  };
  /** The trace of the attempt in flight, or of the last one: what a state change is filed under. */
  let attemptTrace: HostTrace = traceFor();

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

  /**
   * Publishes `next`, and says whether it is still the state once every
   * listener heard it. A listener may close, reconnect or subscribe
   * synchronously; once it moved the link on, the rest hear the newer state
   * from that change instead, and the caller must not continue the
   * transition it started.
   */
  function setState(next: HostLinkState): boolean {
    if (log !== undefined) report(state, next);
    state = next;
    for (const listener of listeners) {
      if (state !== next) return false;
      listener(next);
    }
    return state === next;
  }

  /** One state change, with the reason and timing the owner's log needs. */
  function report(from: HostLinkState, to: HostLinkState): void {
    const base = {
      kind: "state" as const,
      from: from.status,
      to: to.status,
      traceId: attemptTrace.traceId,
    };
    switch (to.status) {
      case "connecting":
        return log!({ ...base, attempt: to.attempt });
      case "ready":
        return log!({ ...base, hostId: to.welcome.host.id, epoch: to.welcome.workspace.epoch });
      case "unreachable":
        return log!({
          ...base,
          attempt: to.attempt,
          reason: reasonOf(to.error),
          closeCode: to.closeCode,
          retryInMs: Math.max(0, to.retryAt - Date.now()),
        });
      case "refused":
        return log!({ ...base, reason: reasonOf(to.error), closeCode: to.closeCode });
      case "fenced":
        return log!({ ...base, reason: reasonOf(to.error) });
      case "closed":
        return log!(base);
    }
  }

  /* ------------------------------------------------------------- attempts */

  async function connect(): Promise<void> {
    /* v8 ignore next -- every timer that connects is cleared or token-guarded by close; this holds if one ever is not. */
    if (state.status === "closed") return;
    clearTimeout(retryTimer);
    clearTimeout(handshakeTimer);
    const token = ++attemptToken;
    attemptTrace = traceFor();
    // Armed before anyone hears `connecting`, so a listener's close clears it.
    handshakeTimer = setTimeout(() => {
      /* v8 ignore next -- every transition clears this timer; the token holds if one ever does not. */
      if (token !== attemptToken) return;
      fail(
        connection,
        unreachable(
          `The host did not complete the handshake within ${timing.handshakeTimeoutMs} ms`,
        ),
      );
    }, timing.handshakeTimeoutMs);
    if (!setState({ status: "connecting", attempt: failures })) return;
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
      trace: attemptTrace,
      traces: new Map(),
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
    // frames, error and close before tRPC's own listeners do. One Connection
    // is one socket: tRPC never gets a second (its reconnect would resend
    // every pending mutation and resubscribe on the old hello, unwelcomed),
    // nor one for a Connection the link already retired.
    const Captured = new Proxy(Socket, {
      construct(target, args: [string]) {
        if (current.retired || current.socket !== null) {
          fail(current, unreachable("The connection to the host tried to open a second socket"));
          throw new Error("A host link connection opens one socket, once");
        }
        const socket = new target(...args);
        current.socket = socket;
        traceSends(current, socket);
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
    const welcome = request(
      current,
      "query",
      "protocol.welcome",
      undefined,
      nextHostSpan(current.trace),
    ).subscribe({
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
    if (!setState({ status: "ready", welcome: verdict.welcome })) return;
    // Only now: no subscription reaches a host whose welcome this client has
    // not judged. One a listener already opened is left as it is.
    // A stream opened before (it has delivered, or been resumed) is a resume.
    for (const entry of entries) {
      openSubscription(entry, current, entry.opened ? "welcome" : "first");
    }
  }

  /** Settles the link once for a connection that failed, and retires it. */
  function fail(current: Connection | null, outcome: Outcome): void {
    if (current !== null) {
      if (current.retired || connection !== current) return;
      retire(current);
    }
    clearTimeout(handshakeTimer);
    connection = null;
    const token = ++attemptToken;
    if (outcome.status === "unreachable") {
      failures += 1;
      const delay = hostLinkBackoffDelay(failures, timing, random);
      // Armed before anyone hears `unreachable`, so a listener's close or
      // reconnect replaces it; and it only connects for the failure that armed it.
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        /* v8 ignore next -- every transition clears this timer; the token holds if one ever does not. */
        if (token === attemptToken) void connect();
      }, delay);
      setState({
        status: "unreachable",
        attempt: failures,
        error: outcome.error,
        closeCode: outcome.closeCode,
        retryAt: Date.now() + delay,
      });
      return;
    }
    if (!setState(outcome)) return;
    endAll(new HostLinkError(outcome.error), token);
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

  /** Ends every stream with `error`, until a handler moves the link on (its reconnect keeps the rest). */
  function endAll(error: HostLinkError, token: number): void {
    for (const entry of entries) {
      if (token !== attemptToken) return;
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
    socket.addEventListener("message", (event) => {
      // tRPC would answer this with its own reconnect on this client, which
      // resends pending mutations and resubscribes on the old hello. The link
      // retires the Connection before tRPC reads the frame; its own retry
      // asks the provider, says hello and judges the welcome again.
      if (isReconnectRequest(event.data)) {
        fail(current, unreachable("The host asked this client to reconnect"));
        return;
      }
      heard(current);
    });
    // A socket error is always the end of it; the close that follows changes nothing.
    socket.addEventListener("error", () =>
      fail(current, unreachable("The connection to the host failed")),
    );
    socket.addEventListener("close", (event) =>
      fail(current, closeOutcome(event.code, event.reason, current.phase)),
    );
  }

  /**
   * Every frame this connection sends carries its trace (HP § Tracing and
   * logs): a request its call's, the hello its attempt's. The heartbeat and
   * tRPC's own control frames go as they are.
   */
  function traceSends(current: Connection, socket: WebSocket): void {
    const send = socket.send.bind(socket);
    socket.send = (data) =>
      send(
        /* v8 ignore next -- tRPC's client and the heartbeat send text; anything else goes as it is. */
        typeof data === "string" ? traced(current, data) : data,
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
    trace: HostTrace,
    lastEventId?: string,
  ) {
    const id = current.nextId++;
    current.traces.set(id, trace);
    return current.client!.request({
      op: { id, type, path, input, signal: null },
      transformer: TRANSFORMER,
      ...(lastEventId === undefined ? {} : { lastEventId }),
    });
  }

  function call(
    type: "query" | "mutation",
    path: string,
    input: unknown,
    callOptions: HostLinkCallOptions = {},
  ): Promise<unknown> {
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
      const subscription = request(
        current,
        type,
        path,
        input,
        traceFor(callOptions.trace),
      ).subscribe({
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

  /**
   * Opens `entry` on `current`, at most once: an Entry already attached (a
   * listener subscribed it during `ready`), ended, or meeting a Connection
   * that is no longer the live one stays as it is.
   */
  function openSubscription(
    entry: Entry,
    current: Connection,
    why: "first" | "welcome" | "overflow",
  ): void {
    if (entry.ended || entry.detach !== null || current.retired || connection !== current) {
      return;
    }
    // A socket already closing would make tRPC open another for this
    // connection; the stream waits for the next welcome instead.
    if (current.socket!.readyState !== Socket.OPEN) return;
    if (why !== "first") {
      log?.({
        kind: "resubscribe",
        path: entry.path,
        resumed: entry.lastEventId !== undefined,
        why,
        traceId: entry.traceId,
      });
    }
    entry.delivered = false;
    entry.opened = true;
    // Attached before the request exists, so nothing re-enters and opens it
    // twice. tRPC answers nothing synchronously: the binding is set by then.
    let subscription!: { unsubscribe(): void };
    const detach = (): void => subscription.unsubscribe();
    entry.detach = detach;
    subscription = request(
      current,
      "subscription",
      entry.path,
      entry.input,
      nextHostSpan(entry),
      entry.lastEventId,
    ).subscribe({
      // Retiring or unsubscribing deletes the request, so only `complete`
      // (which tRPC calls on the way out) can arrive after either.
      next: (envelope) => {
        const result = envelope.result as { type?: string; id?: unknown; data?: unknown };
        if (result.type === "started") {
          entry.handlers.onStarted?.();
        } else if (result.type === "data") {
          entry.delivered = true;
          if (result.id === undefined) {
            entry.handlers.onData(result.data);
          } else {
            entry.lastEventId = String(result.id);
            entry.handlers.onData(result.data, { id: entry.lastEventId });
          }
        }
      },
      error: (error) => {
        /* v8 ignore next -- retiring or unsubscribing deletes the request first; only this open's own failure arrives. */
        if (entry.detach !== detach) return;
        entry.detach = null;
        failed(entry, current, error);
      },
      // Only this open's own completion ends the Entry: a detached one (retired,
      // unsubscribed, or replaced by a newer open) completes on the way out.
      complete: () => {
        if (entry.detach !== detach) return;
        end(entry);
        entry.handlers.onComplete?.();
      },
    });
  }

  function failed(entry: Entry, current: Connection, error: unknown): void {
    const failure = serverError(error);
    // A transport failure, or a revocation the 4401 close follows: the next
    // connection's welcome decides whether this stream resumes.
    if (failure === null || failure.reason === "credential-invalid") return;
    if (isResnapshotRequired(failure)) {
      log?.({ kind: "resnapshot", path: entry.path, traceId: entry.traceId });
      end(entry);
      entry.handlers.onResnapshot(failure);
      return;
    }
    // HP: an overflow drained what it held; resume from the last applied id.
    // Only after progress, so a stream that cannot keep up at all surfaces.
    if (failure.reason === "subscription-overflow" && entry.delivered) {
      openSubscription(entry, current, "overflow");
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
    query: (path, input, callOptions) => call("query", path, input, callOptions),
    mutate: (path, input, callOptions) => call("mutation", path, input, callOptions),
    subscribe(path, input, handlers, subscribeOptions = {}) {
      const entry: Entry = {
        path,
        input,
        traceId: traceFor(subscribeOptions.trace).traceId,
        opened: false,
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
        if (state.status === "ready") openSubscription(entry, connection!, "first");
      }
      return {
        unsubscribe() {
          if (!entry.ended) end(entry);
        },
      };
    },
    wake(cause) {
      log?.({ kind: "wake", cause, status: state.status, traceId: attemptTrace.traceId });
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

/** One text frame, with each request's trace beside its id (HP § Tracing and logs). */
function traced(current: Connection, data: string): string {
  // Only a JSON object or batch is a request; PING is not.
  if (!data.startsWith("{") && !data.startsWith("[")) return data;
  let frame: { id?: unknown; method?: unknown } | { id?: unknown; method?: unknown }[];
  try {
    frame = JSON.parse(data) as typeof frame;
  } catch {
    /* v8 ignore next 2 -- tRPC's client sends only JSON frames; this keeps anything else as it was. */
    return data;
  }
  const one = (message: { id?: unknown; method?: unknown }): unknown => {
    if (message.method === "connectionParams") return withHostTrace(message, current.trace);
    const trace = current.traces.get(message.id as number);
    // A subscription's stop, or anything else no call of ours made.
    if (trace === undefined) return message;
    current.traces.delete(message.id as number);
    return withHostTrace(message, trace);
  };
  return JSON.stringify(Array.isArray(frame) ? frame.map(one) : one(frame));
}

/** tRPC's server-to-client `{ id: null, method: "reconnect" }`, as its `wsClient` would decode it. */
function isReconnectRequest(data: unknown): boolean {
  // Cheap first: only a frame naming it can be it.
  if (typeof data !== "string" || !data.includes('"reconnect"')) return false;
  try {
    return (JSON.parse(data) as { method?: unknown }).method === "reconnect";
  } catch {
    /* v8 ignore start -- tRPC's host sends only JSON text; tRPC's own decoder is the one that rejects anything else. */
    return false;
    /* v8 ignore stop */
  }
}

/** A server's answer (it carries tRPC error data), read as a HostError; null for a transport failure. */
function serverError(error: unknown): HostError | null {
  const data = (error as { data?: unknown }).data;
  return typeof data === "object" && data !== null ? readHostError(error) : null;
}

function refusalOutcome(error: HostError, closeCode: number | null): Outcome {
  return classifyHandshakeFailure(error, closeCode, "workspace");
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

/** What a log line names a failure by: its reason, or its code when it has none. */
function reasonOf(error: HostError): string {
  return error.reason ?? error.code;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
