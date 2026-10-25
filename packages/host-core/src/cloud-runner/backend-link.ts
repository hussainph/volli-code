/**
 * The backend link: a runner's one connection to the backend, and who owns
 * its reconnects.
 *
 * Everything the runner sends goes through {@link BackendLink.mutate}: the
 * connection's shared {@link MutationGate} keeps it at or under 32 mutations
 * and 256 KB in flight, so the client never holds more than that, offline
 * included (Convex closes a socket past 1,000 pending and the stock client
 * then reconnects in a loop).
 *
 * The link owns reconnecting, because the stock client's own backoff reaches
 * 18 s: while disconnected it checks again at 250 ms doubling with jitter,
 * and once the outage passes 5 s it replaces the connection outright. Calls
 * still pending on a replaced connection reject with {@link LinkResetError}
 * (transient), and their callers resend them: the drain's accepts and the
 * inbox's renew and complete are idempotent; a lost `claim` leaves its jobs
 * leased to this boot until their lease runs out. {@link BackendLink.reconnectNow}
 * replaces the connection at once, up or not: after a sleep a half-open socket
 * can still read as connected for a minute.
 *
 * The connection itself is a port ({@link BackendConnection}); the Convex
 * adapter is `convexBackendConnection` in `convex-connection.ts`, the only
 * runner module that imports the Convex client.
 */
import type { MutationGate, MutationPriority } from "./flow";
import type { RunnerMutationCaller } from "./presence";

export type LinkStatus =
  | { state: "connected" }
  | { state: "connecting" }
  | { state: "offline"; since: number };

/** One live connection, as the Convex client provides it. */
export interface BackendConnection {
  mutation(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** A live query: `listener` gets each new result. Returns the unsubscribe. */
  onUpdate(
    name: string,
    args: Record<string, unknown>,
    listener: (value: unknown) => void,
  ): () => void;
  isConnected(): boolean;
  onConnectionChange(listener: (connected: boolean) => void): () => void;
  close(): Promise<void>;
}

/** Where a fresh connection comes from; `token` is the runner token source's `token`. */
export type ConnectBackend = (
  token: (options: { forceRefreshToken: boolean }) => Promise<string | null>,
) => BackendConnection;

/** A call that was pending on a connection the link replaced. Resend it. */
export class LinkResetError extends Error {
  readonly code = "link_reset";
  constructor() {
    super("The backend connection was replaced while this call was pending.");
    this.name = "LinkResetError";
  }
}

export const LINK_RECONNECT = { baseMs: 250, maxMs: 5_000 } as const;

export interface BackendLinkOptions {
  connect: ConnectBackend;
  token(options: { forceRefreshToken: boolean }): Promise<string | null>;
  gate: MutationGate;
  now?(): number;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  random?(): number;
}

export interface BackendLink {
  readonly status: LinkStatus;
  onStatus(listener: (status: LinkStatus) => void): () => void;
  /** Sends one mutation through the gate. */
  mutate(
    name: string,
    args: Record<string, unknown>,
    options?: { priority?: MutationPriority; bytes?: number },
  ): Promise<unknown>;
  /** `mutate` at control priority: what the presence loop and the inbox call. */
  readonly call: RunnerMutationCaller;
  /** A live query that survives connection replacement. Returns the unsubscribe. */
  subscribe(
    name: string,
    args: Record<string, unknown>,
    listener: (value: unknown) => void,
  ): () => void;
  /** Replace the connection now, up or not: wake, unlock, network change. */
  reconnectNow(): void;
  close(): Promise<void>;
}

const sizeOf = (args: Record<string, unknown>) =>
  new TextEncoder().encode(JSON.stringify(args)).length;

export function createBackendLink(options: BackendLinkOptions): BackendLink {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const setTimer =
    options.setTimer ??
    ((run: () => void, ms: number) => {
      const handle = setTimeout(run, ms);
      handle.unref?.();
      return handle;
    });
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const listeners = new Set<(status: LinkStatus) => void>();
  let status: LinkStatus = { state: "connecting" };
  let closed = false;
  let connection: BackendConnection;
  let unsubscribe!: () => void;
  let pending = new Set<(error: Error) => void>();
  /** When the current connection went down (its own grace starts at its creation). */
  let downSince: number | null = now();
  /** When the outage began, across replacements: what `offline.since` says. */
  let outageSince: number | null = now();
  let attempt = 0;
  let timer: unknown = null;
  /** Live queries, re-attached to every new connection. */
  const subscriptions = new Set<{
    name: string;
    args: Record<string, unknown>;
    listener: (value: unknown) => void;
    off: () => void;
  }>();

  function setStatus(next: LinkStatus) {
    if (next.state === status.state) return;
    status = next;
    for (const listener of listeners) listener(next);
  }

  function open() {
    connection = options.connect(options.token);
    for (const subscription of subscriptions) {
      subscription.off = connection.onUpdate(
        subscription.name,
        subscription.args,
        subscription.listener,
      );
    }
    unsubscribe = connection.onConnectionChange(onChange);
    onChange(connection.isConnected());
  }

  function replace() {
    // The fresh connection gets its own grace before it is judged.
    downSince = now();
    const old = connection;
    const stranded = pending;
    pending = new Set();
    unsubscribe();
    for (const subscription of subscriptions) subscription.off();
    void old.close().catch(() => {});
    for (const reject of stranded) reject(new LinkResetError());
    open();
  }

  // `close` unsubscribes first, so no change arrives after it.
  function onChange(connected: boolean) {
    if (connected) {
      downSince = null;
      outageSince = null;
      attempt = 0;
      if (timer !== null) clearTimer(timer);
      timer = null;
      setStatus({ state: "connected" });
      return;
    }
    downSince ??= now();
    outageSince ??= now();
    if (status.state === "connected") setStatus({ state: "connecting" });
    schedule();
  }

  function schedule() {
    if (timer !== null || closed) return;
    const ceiling = Math.min(LINK_RECONNECT.maxMs, LINK_RECONNECT.baseMs * 2 ** attempt);
    attempt += 1;
    const delay = Math.round(ceiling / 2 + (random() * ceiling) / 2);
    timer = setTimer(check, delay);
  }

  function check() {
    timer = null;
    if (closed || connection.isConnected()) return;
    // A check runs only while down, and going down set `downSince`.
    if (now() - downSince! >= LINK_RECONNECT.maxMs) {
      setStatus({ state: "offline", since: outageSince! });
      // The stock client's own backoff is past what we accept: start over.
      replace();
      if (connection.isConnected()) return;
    }
    schedule();
  }

  open();

  const mutate: BackendLink["mutate"] = (name, args, callOptions = {}) => {
    if (closed) return Promise.reject(new Error("The backend link is closed."));
    const priority = callOptions.priority ?? "control";
    const bytes = callOptions.bytes ?? sizeOf(args);
    return options.gate.run(priority, bytes, () => {
      // Admitted after `close`: the client is gone.
      if (closed) return Promise.reject(new LinkResetError());
      const on = connection;
      return new Promise((resolve, reject) => {
        const strand = (error: Error) => reject(error);
        pending.add(strand);
        on.mutation(name, args).then(
          (value) => {
            pending.delete(strand);
            resolve(value);
          },
          (error: unknown) => {
            pending.delete(strand);
            reject(error);
          },
        );
      });
    });
  };

  return {
    get status() {
      return status;
    },
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    mutate,
    call: (name, args) => mutate(name, args, { priority: "control" }),
    subscribe(name, args, listener) {
      const subscription = { name, args, listener, off: () => {} };
      if (!closed) subscription.off = connection.onUpdate(name, args, listener);
      subscriptions.add(subscription);
      return () => {
        subscriptions.delete(subscription);
        subscription.off();
      };
    },
    reconnectNow() {
      if (closed) return;
      clearTimer(timer);
      timer = null;
      attempt = 0;
      replace();
      if (!connection.isConnected()) schedule();
    },
    async close() {
      closed = true;
      if (timer !== null) clearTimer(timer);
      unsubscribe();
      for (const subscription of subscriptions) subscription.off();
      subscriptions.clear();
      for (const reject of pending) reject(new LinkResetError());
      pending.clear();
      await connection.close();
    },
  };
}
