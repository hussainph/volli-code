/**
 * The chat core's Session edge in a cloud launch (VC-931): the same
 * {@link ChatSessionTransport} `chat/transport.ts` hands every
 * `ChatSessionClient`, answered from Volli Cloud instead of This Mac's IPC.
 * Read-only for now: every write, create and attach refuses with
 * {@link CLOUD_SESSION_UNAVAILABLE}.
 *
 * **Reads.** `snapshot` is `sessions.snapshot` (the bounded fold, as the
 * projection) beside the newest window of `sessions.history`, its bodies
 * hydrated (`cloud-transcript-reader.ts`); `history` pages older windows the
 * same way; `projection` re-reads the fold alone.
 *
 * **The stream.** One subscription per open Session holds exactly two live
 * queries:
 *
 * - `sessions.history` after the stream's cursor, a bounded page at a time.
 *   Each new page is hydrated, delivered in sequence order, and the query
 *   moves to the new cursor. A page whose bodies cannot be read asks the
 *   chat core for a fresh snapshot (`subscription-resnapshot-required`), which
 *   it makes quietly a few times before it shows the failure.
 * - `streamChunks.since` from the chunk cursors (`CloudChunkFold`): streamed
 *   text as transcript overlays. A stream is drawn under the runner's
 *   streaming id, so it is taken away here, not by the settled message: once
 *   the backend reports its rows gone and the history has reached the fact
 *   that replaced it, or once its turn's end is delivered. Best effort, like
 *   the chunks themselves: a failed read is logged and retried when the
 *   history next moves.
 *
 * **Presence is separate.** The runner streams text only for a Session
 * someone watches (`sessionViewers`). The chat core keeps a Session's client,
 * and so this stream, resident after its view leaves the screen, so the
 * stream never claims a viewer: the surface that shows the Session does,
 * with {@link showCloudSession}, for as long as it is on screen.
 *
 * **Projection.** A projection is read only once the backend's fold has
 * caught up (`catchingUp` cleared) and reached the last fact this stream
 * delivered, so the state drawn beside the transcript is never older than it.
 * A fold that does not get there in time fails the read as still arriving.
 *
 * Convex resumes its own socket and queries, so this edge declares
 * `"host-link"` recovery: what reaches the chat core is the backend's answer.
 *
 * Convex is loaded only in a cloud launch: this module takes its client and
 * references from the running {@link CloudSession} and imports Convex's types
 * alone.
 */
import { hostError } from "@volli/host-protocol";
import { replyText } from "@volli/session-engine";
import {
  racingFlushScheduler,
  type ChatSessionRpc,
  type ChatSessionTransport,
  type ChatStreamCursor,
  type ChatStreamEvent,
  type FlushScheduler,
} from "@volli/session-presentation";
import { SESSION_VIEWER_HEARTBEAT_MS } from "@volli/shared/cloud";
import type { SessionStreamOverlay } from "@volli/session-engine";
import { decompress } from "fzstd";
import type { UIMessage } from "ai";

import type { CloudSession } from "./cloud-client";
import {
  CLOUD_SESSION_ARRIVING,
  CLOUD_SESSION_UNAVAILABLE,
  CloudChunkFold,
  cloudSnapshotSettled,
  cloudFrames,
  cloudLatestReply,
  readCloudHistory,
  readCloudSnapshot,
  type CloudHistoryEntry,
  type CloudHistoryRead,
  type CloudSnapshotRead,
} from "./cloud-session-view";
import {
  createCloudTranscriptReader,
  type CloudTranscriptReader,
  type CloudTranscriptRequest,
  type CloudTranscriptSource,
} from "./cloud-transcript-reader";

/** What a cloud launch says before its client runs, or after it closed. */
export const CLOUD_NOT_CONNECTED = "Volli Cloud is not connected";

/** Facts a snapshot window, an older page and one live page hold at most. */
const SNAPSHOT_WINDOW = 50;
const OLDER_PAGE = 50;
const LIVE_PAGE = 100;
/**
 * How long a read waits for the backend's fold to catch up. Past it, the read
 * fails as still arriving: a stale state is never drawn as the current one.
 */
const FOLD_WAIT_MS = 15_000;
/** The shortest renewal a lease may ask for; anything shorter is a malformed lease. */
const MIN_HEARTBEAT_MS = 1_000;

/* ------------------------------------------------------------- the port */

export type CloudWatchResult =
  | { kind: "loading" }
  | { kind: "value"; value: unknown }
  | { kind: "error"; error: unknown };

type WatchListener = (result: CloudWatchResult) => void;

/** The backend functions the Session view calls, answers unread (`cloud-session-view.ts` reads them). */
export interface CloudSessionPort {
  snapshot(sessionId: string): Promise<unknown>;
  /** Live `sessions.snapshot`. Like every watch here, never answers inside the call that starts it. */
  watchSnapshot(sessionId: string, listener: WatchListener): () => void;
  history(args: { sessionId: string; beforeSequence: number; limit: number }): Promise<unknown>;
  watchHistory(
    args: { sessionId: string; afterSequence: number; limit: number },
    listener: WatchListener,
  ): () => void;
  watchChunks(
    args: { sessionId: string; cursors: { messageId: string; seq: number }[] },
    listener: WatchListener,
  ): () => void;
  openViewer(args: {
    viewerId: string;
    sessionId: string;
    clientSessionId: string;
  }): Promise<unknown>;
  heartbeatViewer(viewerId: string): Promise<unknown>;
  closeViewer(viewerId: string): Promise<unknown>;
}

interface ConvexWatch {
  onUpdate(callback: () => void): () => void;
  localQueryResult(): unknown;
}

/**
 * One live query as {@link CloudWatchResult}s. A result the client already
 * holds fires no update, so it is read once on the next microtask too.
 */
function follow(watch: ConvexWatch, listener: WatchListener): () => void {
  let active = true;
  const report = () => {
    if (!active) return;
    let value: unknown;
    try {
      value = watch.localQueryResult();
    } catch (error) {
      listener({ kind: "error", error });
      return;
    }
    listener(value === undefined ? { kind: "loading" } : { kind: "value", value });
  };
  const stop = watch.onUpdate(report);
  queueMicrotask(report);
  return () => {
    if (!active) return;
    active = false;
    stop();
  };
}

/** The port over the running client. */
export function cloudSessionPort(session: CloudSession): CloudSessionPort {
  const { client, api } = session;
  return {
    snapshot: (sessionId) => client.query(api.sessions.snapshot, { sessionId }),
    watchSnapshot: (sessionId, listener) =>
      follow(client.watchQuery(api.sessions.snapshot, { sessionId }), listener),
    history: (args) => client.query(api.sessions.history, args),
    watchHistory: (args, listener) =>
      follow(client.watchQuery(api.sessions.history, args), listener),
    watchChunks: (args, listener) =>
      follow(client.watchQuery(api.streamChunks.since, args), listener),
    openViewer: (args) => client.mutation(api.sessionViewers.open, args),
    heartbeatViewer: (viewerId) => client.mutation(api.sessionViewers.heartbeat, { viewerId }),
    closeViewer: (viewerId) => client.mutation(api.sessionViewers.close, { viewerId }),
  };
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The transcript reader's reach over the running client and the object store. */
export function cloudTranscriptSource(
  session: CloudSession,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): CloudTranscriptSource {
  const { client, api } = session;
  return {
    artifacts: (sessionId, digests) =>
      client.query(api.sessionTranscript.artifacts, { sessionId, digests: [...digests] }),
    segments: (sessionId, beforeSequence, limit) =>
      client.query(api.sessionTranscript.segments, { sessionId, beforeSequence, limit }),
    presignGet: (sessionId, object) =>
      client.action(api.sessionTranscript.presignGet, { sessionId, object }),
    download: async ({ url, headers }) => {
      const response = await fetcher(url, { method: "GET", headers: { ...headers } });
      if (!response.ok) throw new Error(`The transcript store answered ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    decompress: (bytes) => decompress(bytes),
    sha256Hex: async (bytes) => hex(await crypto.subtle.digest("SHA-256", bytes.slice())),
    warn: (message) => console.warn(message),
  };
}

/* ------------------------------------------------------------- the edge */

/** The clock the edge waits on; injectable for tests. */
export interface CloudClock {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CloudSessionTransportDeps {
  port: CloudSessionPort;
  readTranscripts: CloudTranscriptReader;
  scheduler: FlushScheduler;
  newCommandId(): string;
  clock: CloudClock;
  /** Background failures nobody is waiting on: streamed text. */
  warn(message: string, error?: unknown): void;
}

/** The chat core's resnapshot signal (`isResnapshotRequired`), with the cause's words. */
function resnapshotRequired(cause: unknown): Error {
  const message = `Session history could not be read: ${
    cause instanceof Error ? cause.message : String(cause)
  }`;
  return Object.assign(new Error(message, { cause }), {
    ...hostError("subscription-resnapshot-required", message),
  });
}

function requestsOf(entries: readonly CloudHistoryEntry[]): CloudTranscriptRequest[] {
  return entries.flatMap((entry) =>
    entry.reference === null ? [] : [{ sequence: entry.sequence, reference: entry.reference }],
  );
}

/** The cursor above a window: its first fact, when older ones remain. */
function olderCursor(page: CloudHistoryRead): number | null {
  return page.hasMore && page.entries.length > 0 ? page.entries[0]!.sequence : null;
}

function refuse(message: string): () => Promise<never> {
  return () => Promise.reject(new Error(message));
}

/** A stream that ends at once with `message`, after the caller has its handle. */
function refusingStream(message: string): ChatSessionRpc["session"]["subscribe"] {
  return {
    subscribe: (_input, handlers) => {
      let open = true;
      queueMicrotask(() => {
        if (open) handlers.onError(new Error(message));
      });
      return {
        unsubscribe: () => {
          open = false;
        },
      };
    },
  };
}

/** Every write the chat core can send, refused. */
function readOnlyWrites(message: string) {
  const call = { mutate: refuse(message) };
  return {
    command: call,
    cancelQueued: call,
    editQueued: call,
    cancelInteraction: call,
    reconcile: call,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NOTHING = (): void => {};

interface StreamHandlers {
  onStarted(): void;
  onData(event: ChatStreamEvent): void;
  onError(error: unknown): void;
}

/** One subscription: the history query and the chunk query. */
class CloudSessionStream {
  readonly #deps: CloudSessionTransportDeps;
  readonly #sessionId: string;
  readonly #handlers: StreamHandlers;
  readonly #delivered: (sequence: number) => void;
  readonly #chunks: CloudChunkFold;
  #closed = false;
  #started = false;
  /** The last sequence delivered (or passed over as unreadable). */
  #cursor: number;
  #historyGeneration = 0;
  #stopHistory: () => void = NOTHING;
  /** The newest history answer not yet applied; applying is serial. */
  #pending: { value: unknown } | null = null;
  #applying = false;
  #chunkGeneration = 0;
  #stopChunks: () => void = NOTHING;
  #chunksStopped = false;

  constructor(
    deps: CloudSessionTransportDeps,
    cursor: ChatStreamCursor,
    handlers: StreamHandlers,
    delivered: (sequence: number) => void,
  ) {
    this.#deps = deps;
    this.#sessionId = cursor.sessionId;
    this.#handlers = handlers;
    this.#delivered = delivered;
    this.#cursor = cursor.afterSequence ?? 0;
    this.#chunks = new CloudChunkFold(cursor.sessionId);
    this.#watchHistory();
    this.#watchChunks();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending = null;
    this.#stopHistory();
    this.#stopChunks();
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    this.close();
    this.#handlers.onError(error);
  }

  #watchHistory(): void {
    this.#stopHistory();
    const generation = (this.#historyGeneration += 1);
    this.#stopHistory = this.#deps.port.watchHistory(
      { sessionId: this.#sessionId, afterSequence: this.#cursor, limit: LIVE_PAGE },
      (result) => {
        if (this.#closed || generation !== this.#historyGeneration) return;
        if (result.kind === "loading") return;
        if (result.kind === "error") {
          this.#fail(result.error);
          return;
        }
        this.#pending = { value: result.value };
        void this.#drain();
      },
    );
  }

  async #drain(): Promise<void> {
    if (this.#applying) return;
    this.#applying = true;
    try {
      while (this.#pending !== null) {
        const { value } = this.#pending;
        this.#pending = null;
        await this.#apply(value);
      }
    } catch (failure) {
      this.#fail(failure);
    } finally {
      this.#applying = false;
    }
  }

  async #apply(value: unknown): Promise<void> {
    // A malformed page is corruption, not a gap: it fails the stream loudly.
    const page = readCloudHistory(value);
    if (!this.#started) {
      this.#started = true;
      this.#handlers.onStarted();
    }
    const fresh = page.entries.filter((entry) => entry.sequence > this.#cursor);
    if (fresh.length === 0) return;
    let messages: ReadonlyMap<number, UIMessage>;
    try {
      messages = await this.#deps.readTranscripts(this.#sessionId, requestsOf(fresh));
    } catch (failure) {
      throw resnapshotRequired(failure);
    }
    if (this.#closed) return;
    // Before any delivery: a projection asked for from inside one waits for the whole page.
    this.#delivered(fresh.at(-1)!.sequence);
    for (const frame of cloudFrames(this.#sessionId, fresh, messages) as {
      sequence: number;
    }[]) {
      this.#handlers.onData({ id: String(frame.sequence), data: frame });
      // The subscriber may let go from inside its own handler.
      if (this.#closed) return;
    }
    this.#cursor = fresh.at(-1)!.sequence;
    this.#watchHistory();
    // What the delivered facts end: their turns' streams, every stream of an
    // ended attachment, and streams whose replacing fact has now been delivered.
    let moved = false;
    const overlays: SessionStreamOverlay[] = [];
    for (const entry of fresh) {
      const ended =
        entry.endsTurn !== null
          ? this.#chunks.turnEnded(entry.endsTurn, entry.sequence)
          : entry.endsAttachment
            ? this.#chunks.allEnded(entry.sequence)
            : null;
      if (ended === null) continue;
      moved ||= ended.moved;
      overlays.push(...ended.overlays);
    }
    overlays.push(...this.#chunks.due(this.#cursor));
    if (!this.#emit(overlays)) return;
    if (this.#chunksStopped || moved) {
      this.#chunksStopped = false;
      this.#watchChunks();
    }
  }

  /** Delivers overlays; false once the subscriber let go. */
  #emit(overlays: readonly SessionStreamOverlay[]): boolean {
    for (const overlay of overlays) {
      this.#handlers.onData({ id: String(this.#cursor), data: overlay });
      if (this.#closed) return false;
    }
    return true;
  }

  #watchChunks(): void {
    this.#stopChunks();
    const generation = (this.#chunkGeneration += 1);
    this.#stopChunks = this.#deps.port.watchChunks(
      { sessionId: this.#sessionId, cursors: this.#chunks.cursors() },
      (result) => {
        if (this.#closed || generation !== this.#chunkGeneration) return;
        if (result.kind === "loading") return;
        if (result.kind === "error") {
          this.#stopStreamedText(result.error);
          return;
        }
        let read: ReturnType<CloudChunkFold["read"]>;
        try {
          read = this.#chunks.read(result.value, this.#cursor);
        } catch (failure) {
          this.#stopStreamedText(failure);
          return;
        }
        if (this.#emit(read.overlays) && read.moved) this.#watchChunks();
      },
    );
  }

  /** Streamed text is best effort: the settled message still arrives as a fact. */
  #stopStreamedText(error: unknown): void {
    this.#deps.warn("[cloud-session] streamed text stopped; it resumes with the next fact", error);
    this.#stopChunks();
    this.#stopChunks = NOTHING;
    this.#chunksStopped = true;
  }
}

/** The Session edge over `deps`; {@link cloudChatTransport} is the app's. */
export function createCloudSessionTransport(deps: CloudSessionTransportDeps): ChatSessionTransport {
  const { port } = deps;
  /** The last fact any stream delivered, per Session: what a projection must have folded. */
  const delivered = new Map<string, number>();

  /**
   * The snapshot once the backend's fold is settled through `through`: a
   * Session whose facts it has not folded yet (just created, catching up, or
   * behind the stream) is watched for a while rather than read stale.
   */
  async function settledSnapshot(sessionId: string, through: number): Promise<CloudSnapshotRead> {
    const answer = await port.snapshot(sessionId);
    if (cloudSnapshotSettled(answer, through)) return readCloudSnapshot(answer);
    let latest = answer;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (settle: () => void) => {
        if (done) return;
        done = true;
        deps.clock.clearTimeout(timer);
        stop();
        settle();
      };
      const read = () => {
        try {
          resolve(readCloudSnapshot(latest));
        } catch (failure) {
          reject(failure);
        }
      };
      const timer = deps.clock.setTimeout(
        () => finish(() => reject(new Error(CLOUD_SESSION_ARRIVING))),
        FOLD_WAIT_MS,
      );
      const stop = port.watchSnapshot(sessionId, (result) => {
        if (result.kind === "loading") return;
        if (result.kind === "error") {
          finish(() => reject(result.error));
          return;
        }
        latest = result.value;
        if (cloudSnapshotSettled(latest, through)) finish(read);
      });
    });
  }

  async function readWindow(sessionId: string, args: { beforeSequence: number; limit: number }) {
    const page = readCloudHistory(await port.history({ sessionId, ...args }));
    return { page, requests: requestsOf(page.entries) };
  }

  const rpc: ChatSessionRpc = {
    session: {
      snapshot: {
        async query({ sessionId }) {
          const snapshot = await settledSnapshot(sessionId, 0);
          const { page, requests }: { page: CloudHistoryRead; requests: CloudTranscriptRequest[] } =
            snapshot.throughSequence === 0
              ? { page: { entries: [], hasMore: false }, requests: [] }
              : await readWindow(sessionId, {
                  beforeSequence: snapshot.throughSequence + 1,
                  limit: SNAPSHOT_WINDOW,
                });
          const reply = snapshot.latestReply;
          if (reply !== null && !requests.some(({ sequence }) => sequence === reply.sequence)) {
            requests.push({ sequence: reply.sequence, reference: reply.reference });
          }
          const messages = await deps.readTranscripts(sessionId, requests);
          return {
            projection: snapshot.projection,
            frames: cloudFrames(sessionId, page.entries, messages),
            throughSequence: snapshot.throughSequence,
            before: olderCursor(page),
            latestReply: cloudLatestReply(
              reply,
              reply === null ? undefined : messages.get(reply.sequence),
              replyText,
            ),
          };
        },
      },
      history: {
        async query({ sessionId, before }) {
          const { page, requests } = await readWindow(sessionId, {
            beforeSequence: before,
            limit: OLDER_PAGE,
          });
          const messages = await deps.readTranscripts(sessionId, requests);
          return {
            frames: cloudFrames(sessionId, page.entries, messages),
            before: olderCursor(page),
          };
        },
      },
      projection: {
        async query({ sessionId }) {
          const through = delivered.get(sessionId) ?? 0;
          return { projection: (await settledSnapshot(sessionId, through)).projection };
        },
      },
      subscribe: {
        subscribe(input, handlers) {
          const stream = new CloudSessionStream(deps, input, handlers, (sequence) => {
            delivered.set(input.sessionId, Math.max(sequence, delivered.get(input.sessionId) ?? 0));
          });
          return { unsubscribe: () => stream.close() };
        },
      },
      ...readOnlyWrites(CLOUD_SESSION_UNAVAILABLE),
    },
  };

  return {
    rpc,
    streamRecovery: "host-link",
    scheduler: deps.scheduler,
    newCommandId: deps.newCommandId,
    createSession: refuse(CLOUD_SESSION_UNAVAILABLE),
    attachSession: refuse(CLOUD_SESSION_UNAVAILABLE),
  };
}

/** A transport for a cloud launch whose client is not running: everything refuses, nothing reaches IPC. */
export function disconnectedCloudTransport(scheduler: FlushScheduler): ChatSessionTransport {
  const call = { query: refuse(CLOUD_NOT_CONNECTED) };
  return {
    rpc: {
      session: {
        snapshot: call,
        history: call,
        projection: call,
        subscribe: refusingStream(CLOUD_NOT_CONNECTED),
        ...readOnlyWrites(CLOUD_NOT_CONNECTED),
      },
    },
    streamRecovery: "host-link",
    scheduler,
    newCommandId: () => crypto.randomUUID(),
    createSession: refuse(CLOUD_NOT_CONNECTED),
    attachSession: refuse(CLOUD_NOT_CONNECTED),
  };
}

/* ---------------------------------------------------------- presence */

export interface CloudViewerDeps {
  port: Pick<CloudSessionPort, "openViewer" | "heartbeatViewer" | "closeViewer">;
  /** A viewer id: a UUID (`sessionViewers.open` refuses anything else). */
  newViewerId(): string;
  /** This window, as `sessionViewers.open` records it. */
  clientSessionId: string;
  clock: CloudClock;
  /** Presence is background work: its failures are logged. */
  warn(message: string, error?: unknown): void;
}

function heartbeatMs(lease: unknown): number {
  const ms = isRecord(lease) ? lease.heartbeatMs : undefined;
  return typeof ms === "number" && Number.isSafeInteger(ms) && ms >= MIN_HEARTBEAT_MS
    ? ms
    : SESSION_VIEWER_HEARTBEAT_MS;
}

/**
 * One viewer of one Session: opened now, renewed on the lease's heartbeat
 * (opened again when it lapsed), and closed by the function this returns.
 * Its mutations run in order, so a close waits for an open still in flight
 * and no viewer outlives its surface; a viewer never opened is not closed.
 * Calling the returned function again does nothing.
 */
export function createCloudViewer(deps: CloudViewerDeps, sessionId: string): () => void {
  const viewerId = deps.newViewerId();
  let timer: unknown = null;
  let stopped = false;
  let sent = false;
  let last: Promise<unknown> = Promise.resolve();

  const clear = () => {
    if (timer === null) return;
    deps.clock.clearTimeout(timer);
    timer = null;
  };
  const schedule = (ms: number) => {
    if (stopped) return;
    clear();
    timer = deps.clock.setTimeout(() => {
      timer = null;
      beat();
    }, ms);
  };
  const run = (step: () => Promise<void>) => {
    last = last
      .then(() => (stopped ? undefined : step()))
      .catch((error: unknown) => {
        if (stopped) return;
        deps.warn("[cloud-session] couldn't keep a viewer open", error);
        schedule(SESSION_VIEWER_HEARTBEAT_MS);
      });
  };
  const open = () =>
    run(async () => {
      sent = true;
      const lease = await deps.port.openViewer({
        viewerId,
        sessionId,
        clientSessionId: deps.clientSessionId,
      });
      schedule(heartbeatMs(lease));
    });
  const beat = () =>
    run(async () => {
      const answer = await deps.port.heartbeatViewer(viewerId);
      // Lapsed, closed, or no longer visible: open it again.
      if (isRecord(answer) && answer.open === true) schedule(heartbeatMs(answer));
      else open();
    });

  open();
  return () => {
    if (stopped) return;
    stopped = true;
    clear();
    last = last
      .then(() => (sent ? deps.port.closeViewer(viewerId) : undefined))
      .catch((error: unknown) => deps.warn("[cloud-session] couldn't close a viewer", error));
  };
}

/* ---------------------------------------------------------- the app's */

let windowClientSessionId: string | null = null;

/** This window's id for `sessionViewers.open`, minted once per renderer. */
function clientSessionId(): string {
  windowClientSessionId ??= crypto.randomUUID();
  return windowClientSessionId;
}

const SYSTEM_CLOCK: CloudClock = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const warn = (message: string, error?: unknown): void => console.warn(message, error);

/**
 * Readers kept per running client, so every Session's transport in this
 * window shares one body cache and one pack cache.
 */
const readers = new WeakMap<CloudSession, CloudTranscriptReader>();

function transcriptReaderFor(session: CloudSession): CloudTranscriptReader {
  let reader = readers.get(session);
  if (reader === undefined) {
    reader = createCloudTranscriptReader(cloudTranscriptSource(session));
    readers.set(session, reader);
  }
  return reader;
}

/**
 * The cloud launch's transport for a Session: over the running client, or
 * refusing everything while there is none (starting, or closed).
 */
export function cloudChatTransport(session: CloudSession | null): ChatSessionTransport {
  const scheduler = racingFlushScheduler(window);
  if (session === null) return disconnectedCloudTransport(scheduler);
  return createCloudSessionTransport({
    port: cloudSessionPort(session),
    readTranscripts: transcriptReaderFor(session),
    scheduler,
    newCommandId: () => crypto.randomUUID(),
    clock: SYSTEM_CLOCK,
    warn,
  });
}

/**
 * Marks `sessionId` as on screen in this window, so its runner streams text
 * to it; the returned function marks it off screen (idempotent). For the
 * surface that shows the Session, while it shows it — never for a resident
 * client that is not drawn.
 */
export function showCloudSession(session: CloudSession, sessionId: string): () => void {
  return createCloudViewer(
    {
      port: cloudSessionPort(session),
      newViewerId: () => crypto.randomUUID(),
      clientSessionId: clientSessionId(),
      clock: SYSTEM_CLOCK,
      warn,
    },
    sessionId,
  );
}
