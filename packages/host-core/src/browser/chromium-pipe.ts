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

interface Pending {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
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
 */
export class CdpPipeConnection {
  #nextId = 0;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(event: CdpEvent) => void>();
  readonly #closeListeners = new Set<(reason: string) => void>();
  #chunks: Buffer[] = [];
  #closed: string | null = null;

  constructor(
    private readonly output: Writable,
    input: Readable,
  ) {
    input.on("data", (chunk: Buffer) => this.#receive(chunk));
    input.on("close", () => this.close("the browser closed its pipe"));
    input.on("error", (error: Error) => this.close(`pipe read failed: ${error.message}`));
    output.on("error", (error: Error) => this.close(`pipe write failed: ${error.message}`));
  }

  get closed(): boolean {
    return this.#closed !== null;
  }

  /** Sends one command, to the browser or to one flattened session. */
  send(method: string, params: object = {}, sessionId?: string): Promise<unknown> {
    if (this.#closed !== null) return Promise.reject(new CdpConnectionClosedError(this.#closed));
    const id = ++this.#nextId;
    const frame = JSON.stringify({
      id,
      method,
      params,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      this.output.write(`${frame}\0`);
    });
  }

  /** Every event, browser and session alike. Returns the unsubscribe. */
  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Called once, when the connection ends for any reason. Immediately if it already has. */
  onClose(listener: (reason: string) => void): void {
    if (this.#closed !== null) {
      listener(this.#closed);
      return;
    }
    this.#closeListeners.add(listener);
  }

  /** Ends the connection: every command still waiting rejects. Idempotent. */
  close(reason = "closed by the host"): void {
    if (this.#closed !== null) return;
    this.#closed = reason;
    const error = new CdpConnectionClosedError(reason);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#chunks = [];
    for (const listener of this.#closeListeners) listener(reason);
    this.#closeListeners.clear();
    this.#listeners.clear();
  }

  #receive(chunk: Buffer): void {
    if (this.#closed !== null) return;
    let start = 0;
    let end = chunk.indexOf(0, start);
    while (end !== -1) {
      this.#chunks.push(chunk.subarray(start, end));
      const frame = Buffer.concat(this.#chunks).toString("utf8");
      this.#chunks = [];
      this.#dispatch(frame);
      if (this.#closed !== null) return;
      start = end + 1;
      end = chunk.indexOf(0, start);
    }
    if (start < chunk.length) this.#chunks.push(chunk.subarray(start));
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
        console.error(`[volli] Chromium event listener failed on ${event.method}:`, error);
      }
    }
  }
}
