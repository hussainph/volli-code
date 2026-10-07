/**
 * The Chromium backend's wire (VC-619): one Chrome DevTools Protocol
 * connection over the pipe Chromium opens on its fds 3 and 4 when launched
 * with `--remote-debugging-pipe`.
 *
 * The pipe is the VC-110 stance carried to a standalone browser. A debugging
 * PORT is a loopback endpoint every local process can reach, and through it
 * every tab and every credential the browser holds; a pipe is two file
 * descriptors only this process was handed. Nothing here can listen.
 *
 * Framing is Chromium's: one JSON message per frame, frames separated by a NUL
 * byte. Sessions are flattened (`Target.attachToTarget({ flatten: true })`), so
 * a tab's commands and events ride this one connection under their
 * `sessionId` rather than as nested `Target.sendMessageToTarget` envelopes.
 */
import type { Readable, Writable } from "node:stream";
import { hostLogger } from "../log/root";

const log = hostLogger("chromium");

/** One protocol event: a method, its params, and the flattened session it came from. */
export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  /** Absent for the browser target's own events. */
  sessionId?: string;
}

/** The Chromium side said no to one command. */
export class CdpProtocolError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(`${method}: ${message}`);
    this.name = "CdpProtocolError";
  }
}

/** The connection is gone: the browser exited, or the host closed it. */
export class CdpConnectionClosedError extends Error {
  constructor(reason: string) {
    super(`The Chromium connection closed: ${reason}`);
    this.name = "CdpConnectionClosedError";
  }
}

/** A command that could not even be sent: the pipe's own bounds said no. */
export class CdpBackpressureError extends Error {
  constructor(method: string, why: string) {
    super(`${method}: ${why}`);
    this.name = "CdpBackpressureError";
  }
}

/** A command the browser did not answer in its time, or its caller withdrew. */
export class CdpCommandAbandonedError extends Error {
  constructor(method: string, why: string) {
    super(`${method}: ${why}`);
    this.name = "CdpCommandAbandonedError";
  }
}

/**
 * The connection's memory bounds. Each has a default sized for a real
 * browser; a test passes small ones.
 */
export interface CdpPipeLimits {
  /**
   * The largest frame Chromium may send, unterminated bytes included. A
   * screenshot answer is the largest legitimate frame (a 3840×2160 PNG in
   * base64 is tens of megabytes); a frame past this is a broken browser, and
   * the connection closes rather than buffering it.
   */
  maxInboundFrameBytes: number;
  /** Commands waiting for an answer at once; past it a send is refused. */
  maxPendingCommands: number;
  /**
   * Bytes the pipe's writable may hold unsent. The stream's own buffer is the
   * only queue: a browser that stops reading fills it to this bound, and then
   * sends are refused until it drains, so nothing grows without end.
   */
  maxQueuedOutputBytes: number;
  /** How long any one command may wait for its answer before it is abandoned. */
  commandTimeoutMs: number;
}

export const CDP_PIPE_DEFAULT_LIMITS: Readonly<CdpPipeLimits> = Object.freeze({
  maxInboundFrameBytes: 256 * 1024 * 1024,
  maxPendingCommands: 4_096,
  maxQueuedOutputBytes: 32 * 1024 * 1024,
  commandTimeoutMs: 60_000,
});

/** Per-command options: a caller's withdrawal and a tighter deadline. */
export interface CdpSendOptions {
  /** Withdrawing it abandons the command: it rejects and leaves the pending map. */
  signal?: AbortSignal;
  /** A deadline below the connection's own {@link CdpPipeLimits.commandTimeoutMs}. */
  timeoutMs?: number;
}

interface Pending {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  /** Clears the deadline and the abort listener; runs once the command leaves the map. */
  settle: () => void;
}

/**
 * One frame Chromium sent, decoded. A frame that is not a JSON object is a
 * broken browser, not a page's doing: nothing a page controls is framed here
 * unescaped, so it closes the connection rather than being skipped.
 */
type Incoming =
  | { id: number; result?: unknown; error?: { code: number; message: string } }
  | { method: string; params?: Record<string, unknown>; sessionId?: string };

/**
 * A CDP client over a NUL-delimited pipe. Commands are answered by id; events
 * are fanned out to every listener in arrival order, which is the order the
 * browser produced them, so a listener can rely on `Page.frameStartedLoading`
 * arriving before the `Page.frameStoppedLoading` that ends it.
 *
 * Every queue is bounded ({@link CdpPipeLimits}): inbound frame bytes, pending
 * commands, unsent output bytes, and each command's time. A command that is
 * abandoned — timed out or withdrawn — leaves the pending map at once; a late
 * answer to it is ignored like any unknown id.
 */
export class CdpPipeConnection {
  #nextId = 0;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(event: CdpEvent) => void>();
  readonly #closeListeners = new Set<(reason: string) => void>();
  /**
   * The unterminated frame so far, copied into one buffer that grows by
   * doubling (never past the frame bound). One allocation however finely the
   * browser fragments its writes: memory is at most about twice the bytes
   * held, never a Buffer view per fragment.
   */
  #partial: Buffer = Buffer.alloc(0);
  #partialBytes = 0;
  #closed: string | null = null;
  readonly #limits: CdpPipeLimits;

  constructor(
    private readonly output: Writable,
    input: Readable,
    limits: Partial<CdpPipeLimits> = {},
  ) {
    this.#limits = { ...CDP_PIPE_DEFAULT_LIMITS, ...limits };
    input.on("data", (chunk: Buffer) => this.#receive(chunk));
    input.on("close", () => this.close("the browser closed its pipe"));
    input.on("error", (error: Error) => this.close(`pipe read failed: ${error.message}`));
    output.on("error", (error: Error) => this.close(`pipe write failed: ${error.message}`));
    output.on("close", () => this.close("the browser's command pipe closed"));
  }

  get closed(): boolean {
    return this.#closed !== null;
  }

  /** Commands waiting for an answer now; for tests and diagnostics. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /** Close listeners registered now; for tests and diagnostics. */
  get closeListenerCount(): number {
    return this.#closeListeners.size;
  }

  /** Sends one command, to the browser or to one flattened session. */
  send(
    method: string,
    params: object = {},
    sessionId?: string,
    options: CdpSendOptions = {},
  ): Promise<unknown> {
    if (this.#closed !== null) return Promise.reject(new CdpConnectionClosedError(this.#closed));
    if (options.signal?.aborted) {
      return Promise.reject(new CdpCommandAbandonedError(method, "withdrawn before it was sent"));
    }
    if (this.#pending.size >= this.#limits.maxPendingCommands) {
      return Promise.reject(
        new CdpBackpressureError(method, "too many commands are waiting on the browser"),
      );
    }
    const id = ++this.#nextId;
    const frame = `${JSON.stringify({
      id,
      method,
      params,
      ...(sessionId === undefined ? {} : { sessionId }),
    })}\0`;
    const bytes = Buffer.byteLength(frame, "utf8");
    if (this.output.writableLength + bytes > this.#limits.maxQueuedOutputBytes) {
      return Promise.reject(
        new CdpBackpressureError(method, "the browser is not reading its command pipe"),
      );
    }
    return new Promise((resolve, reject) => {
      const timeoutMs = Math.min(
        options.timeoutMs ?? this.#limits.commandTimeoutMs,
        this.#limits.commandTimeoutMs,
      );
      const abandon = (why: string): void => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        pending.settle();
        pending.reject(new CdpCommandAbandonedError(method, why));
      };
      const timer = setTimeout(() => abandon(`no answer within ${timeoutMs}ms`), timeoutMs);
      timer.unref?.();
      const onAbort = (): void => abandon("withdrawn by its caller");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        method,
        resolve,
        reject,
        settle: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
        },
      });
      this.output.write(frame);
    });
  }

  /** Every event, browser and session alike. Returns the unsubscribe. */
  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Called once, when the connection ends for any reason; immediately if it
   * already has. Returns the unsubscribe, so a waiter that settled another
   * way leaves nothing behind.
   */
  onClose(listener: (reason: string) => void): () => void {
    if (this.#closed !== null) {
      listener(this.#closed);
      return () => undefined;
    }
    this.#closeListeners.add(listener);
    return () => {
      this.#closeListeners.delete(listener);
    };
  }

  /** Ends the connection: every command still waiting rejects. Idempotent. */
  close(reason = "closed by the host"): void {
    if (this.#closed !== null) return;
    this.#closed = reason;
    const error = new CdpConnectionClosedError(reason);
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const each of pending) {
      each.settle();
      each.reject(error);
    }
    this.#partial = Buffer.alloc(0);
    this.#partialBytes = 0;
    const listeners = [...this.#closeListeners];
    this.#closeListeners.clear();
    this.#listeners.clear();
    for (const listener of listeners) listener(reason);
  }

  /** Bytes reserved for the unterminated frame now; for tests and diagnostics. */
  get inboundCapacity(): number {
    return this.#partial.length;
  }

  #receive(chunk: Buffer): void {
    if (this.#closed !== null) return;
    let start = 0;
    let end = chunk.indexOf(0, start);
    while (end !== -1) {
      if (!this.#hold(chunk.subarray(start, end))) return;
      const frame = this.#partial.toString("utf8", 0, this.#partialBytes);
      this.#partialBytes = 0;
      this.#dispatch(frame);
      if (this.#closed !== null) return;
      start = end + 1;
      end = chunk.indexOf(0, start);
    }
    if (start < chunk.length) this.#hold(chunk.subarray(start));
    // A frame that ended exactly at a chunk's end leaves nothing to keep big.
    if (this.#partialBytes === 0 && this.#partial.length > 64 * 1_024) {
      this.#partial = Buffer.alloc(0);
    }
  }

  /** Appends to the unterminated frame; false (and closed) past the frame bound. */
  #hold(bytes: Buffer): boolean {
    const needed = this.#partialBytes + bytes.length;
    if (needed > this.#limits.maxInboundFrameBytes) {
      this.close("the browser sent a frame larger than the pipe accepts");
      return false;
    }
    if (needed > this.#partial.length) {
      let capacity = Math.max(this.#partial.length, 4_096);
      while (capacity < needed) capacity *= 2;
      const grown = Buffer.allocUnsafe(Math.min(capacity, this.#limits.maxInboundFrameBytes));
      this.#partial.copy(grown, 0, 0, this.#partialBytes);
      this.#partial = grown;
    }
    bytes.copy(this.#partial, this.#partialBytes);
    this.#partialBytes = needed;
    return true;
  }

  #dispatch(frame: string): void {
    let message: Incoming;
    try {
      message = JSON.parse(frame) as Incoming;
    } catch {
      this.close("the browser sent a frame that is not JSON");
      return;
    }
    if (typeof message !== "object" || message === null) {
      this.close("the browser sent a frame that is not an object");
      return;
    }
    if ("id" in message) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      pending.settle();
      if (message.error !== undefined) {
        pending.reject(
          new CdpProtocolError(pending.method, message.error.code, message.error.message),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    const event: CdpEvent = {
      method: message.method,
      params: message.params ?? {},
      ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
    };
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        // One listener's bug must not starve the rest of the events, and no
        // caller awaits an event; it stays visible in the host's log.
        log.error("chromium event listener failed", { method: event.method, error });
      }
    }
  }
}
