/** A resident stream projection and command client. The host owns pending
 * follow-ups and their release, even when no Client is connected. */
import { isResnapshotRequired } from "@volli/host-protocol";
import type {
  SessionLatestReply,
  SessionStreamCompactionProgress,
  SessionStreamOverlay,
  SessionStreamQueue,
} from "@volli/session-engine";
import { autoTitleFromMessage, blobUrl, errorMessage, skillResourcePart } from "@volli/shared";
import type {
  BlobLinkView,
  CommandRefusalSeverity,
  ModelSelection,
  SessionInteractionResolution,
  SessionPresentationProjection,
  SessionStartResult,
} from "@volli/shared";
import type { UIMessage } from "ai";

import { isUntitledChatSession, type QueuedMessage } from "./session-model";
import {
  movesProjection,
  type ChatSessionFrame,
  type ChatTranscriptState,
  type TranscriptWindow,
} from "./transcript";
import {
  chatSessionCompactionProgress,
  chatSessionFrame,
  chatSessionOverlay,
  chatSessionQueue,
  commandRefusal,
  rejectedReceipt,
} from "./wire";

/**
 * What a Session's plumbing is doing, as a surface has to draw it.
 *
 * There is no `idle`: a slice exists only once a Session is durable, so the
 * absence of one is that state and the store already says it by omission.
 */
export type ChatSessionLifecycle = "starting" | "ready" | "working" | "error";

export type ChatMessageDelivery = "queue" | "steer" | "replace";

/**
 * What became of one message — and specifically, whether a copy of it is still
 * this surface's responsibility.
 *
 * `recorded` is the arm that is easy to miss and expensive to get wrong. The
 * runtime commits the durable intent and the transcript artifact BEFORE it
 * hands the message to an executor, so a rejected receipt describes a message
 * that is already in the ledger and already painted in the transcript. Handing
 * those words back to the composer would invite the reader to send them a
 * second time — "retry transient transport failures without duplicating
 * accepted work" (CLAUDE.md). The recovery for a recorded message is a retry of
 * the turn it started, which the blocker row already offers; the recovery for a
 * `refused` one is the words themselves, because nothing else has them.
 *
 * A throw lands on `refused`. It is the ambiguous case — a transport that never
 * reached main and a failure past the durable write both arrive as exceptions —
 * and keeping the words is the arm that cannot lose anything.
 */
export type MessageDelivery = "delivered" | "recorded" | "refused";

export type ChatSessionProjection = SessionPresentationProjection & {
  queue?: SessionStreamQueue["queue"];
  queueRevision?: number;
};

/**
 * One Session's resident state.
 *
 * The runtime catalog is deliberately absent. Which models exist is a question
 * about the product runtime, asked and re-asked by whatever is on screen. The
 * durable projection owns the Session's selected model.
 */
export interface ChatSessionSlice {
  projection: ChatSessionProjection | null;
  queueRevision?: number;
  transcript: ChatTranscriptState;
  lifecycle: ChatSessionLifecycle;
  /**
   * The one thing about a Session's plumbing a person needs told — a failure
   * that stopped their typing. Everything else the transport knows has no
   * honest home in a chat.
   */
  sessionError: string | null;
  queue: readonly QueuedMessage[];
}

/** A bound executor and a turn the stream has opened. */
export function isWorking(slice: ChatSessionSlice): boolean {
  return (slice.projection?.liveExecutor ?? null) !== null && slice.transcript.turnActive;
}

/**
 * Whether a message typed now could actually leave.
 *
 * Two questions live here that are easy to conflate: a model is what you need to
 * *write* a message, a live executor is what you need to *deliver* one. Anything
 * written before both hold joins the queue instead of being dropped.
 *
 * One rule, whatever the Session was born as. Every structured Session records
 * its model policy durably before anything attaches — a Board chat's is taken
 * from the app default exactly as a Ticket Session's is — so a projection with
 * no selection on it is not a Session that picks its own model, it is a Session
 * whose model nobody has written down yet.
 */
export function isDeliverable(slice: ChatSessionSlice): boolean {
  const projection = slice.projection;
  if (projection === null) return false;
  return projection.liveExecutor !== null && projection.modelSelection !== null;
}

/**
 * The lifecycle a Session settles to when its stream moves.
 *
 * Only a batch that actually crossed a turn boundary — or gained or lost an
 * executor — may move it. Re-deriving on every batch instead is what makes the
 * `working` a delivered message sets evaporate: nothing has started a turn yet
 * in the moment after a harness accepts one, so the very next frame would demote
 * the Session to `ready` and the queued message behind it would be released into
 * a turn that had not begun.
 *
 * Which is why the reading is not the only thing compared. A batch is not one
 * frame, and a turn that opens and closes inside one — a fast refusal, an
 * occluded window folding 50ms at a time, a reconnect replaying what it
 * missed — reads the same at both ends as a batch that never mentioned a turn.
 * Trusting the reading alone left that Session latched at `working` forever,
 * with the queue behind it stranded, until some unrelated command settled it.
 * {@link ChatTranscriptState.turnEpoch} is what separates the two.
 *
 * `starting` and `error` survive regardless: both are latches a command set and
 * only a command clears, so a frame arriving mid-attach must not quietly declare
 * the Session ready.
 */
export function settledLifecycle(
  before: ChatSessionSlice,
  after: ChatSessionSlice,
): ChatSessionLifecycle {
  if (after.lifecycle === "starting" || after.lifecycle === "error") return after.lifecycle;
  const working = isWorking(after);
  const spoke =
    working !== isWorking(before) || after.transcript.turnEpoch !== before.transcript.turnEpoch;
  if (!spoke) return after.lifecycle;
  return working ? "working" : "ready";
}

/** How one attach should report a refusal. */
export interface AttachOptions {
  /**
   * The refusal already has a durable home, so the slice must stay quiet.
   *
   * True for a TICKET Session's attach: a worktree that cannot be materialized
   * is recorded as Ticket Attention, which is the surface a person acts on. A
   * ticketless Session has no such surface, so its refusal is the slice's to
   * carry. A THROWN attach is neither — nothing was recorded anywhere — and is
   * always settled onto the slice and announced through the notification port.
   */
  refusalIsReportedElsewhere?: boolean;
}

/* ---------------------------------------------------------------- the store */

/**
 * Everything a resident client writes back. The desktop's chat-sessions
 * store satisfies it by delegating to the session-slice transitions;
 * `createSurfaceStore` is those transitions with nothing else around them.
 */
export interface ChatSessionWrites {
  sessions: Readonly<Record<string, ChatSessionSlice>>;
  applyStream(
    sessionId: string,
    frames: readonly ChatSessionFrame[],
    overlays: readonly SessionStreamOverlay[],
    progress?: readonly SessionStreamCompactionProgress[],
    clearLiveCompaction?: boolean,
  ): void;
  /**
   * A snapshot: the newest window of frames and the projection checkpoint they
   * end at, in one write (VC-315).
   */
  applySnapshot(
    sessionId: string,
    window: TranscriptWindow,
    projection: ChatSessionProjection,
  ): void;
  /**
   * One older page, put above the transcript — only while the transcript still
   * holds `requested`, the cursor the page answers.
   */
  prependHistory(sessionId: string, requested: number, page: TranscriptWindow): void;
  setProjection(sessionId: string, projection: ChatSessionProjection): void;
  /** An attachment attempt is in flight; nothing derives lifecycle until it lands. */
  attaching(sessionId: string): void;
  /**
   * The harness took a message — optimistically, and only while the stream has
   * said nothing since it left.
   *
   * `turnEpoch` is the transcript's count at submit. Pi answers a
   * `message.submit` when the turn it started has ALREADY ENDED (the runtime
   * awaits `agent.prompt`), so an unconditional latch here re-opens a turn the
   * stream has closed. An unchanged epoch is the one case
   * where nothing has been heard and optimism is all there is.
   */
  delivered(sessionId: string, turnEpoch: number): void;
  /** A failure, or `null` to clear one and hand the Session back to its stream. */
  settle(sessionId: string, error: string | null): void;
  setQueue(sessionId: string, queue: SessionStreamQueue["queue"], revision: number): void;
}

export interface ChatSessionStore {
  getState(): ChatSessionWrites;
  subscribe(listener: () => void): () => void;
}

/* ------------------------------------------------------------ the RPC edge */

/** One emission as the transport delivers it: the tracked cursor beside the value. */
export interface ChatStreamEvent {
  id: string;
  data: unknown;
}

export interface ChatStreamCursor {
  sessionId: string;
  afterSequence?: number;
  lastEventId?: string;
}

interface ChatStreamHandlers {
  onStarted(): void;
  onData(event: ChatStreamEvent): void;
  onError(error: unknown): void;
  /**
   * A clean end is not a state a Session stream may rest in. The producer only
   * completes without error on teardown races, and a client that shrugged here
   * kept a dead stream it believed healthy — `turn.completed` never arrived
   * and the composer held Stop forever. Completion is treated exactly like a
   * drop: one resume from the cursor, then surface.
   */
  onComplete(): void;
}

type ChatCommand =
  | {
      kind: "message.submit";
      message: UIMessage;
      delivery?: ChatMessageDelivery;
    }
  | { kind: "model.select"; selection: ModelSelection }
  | { kind: "executor.interrupt"; attachmentId?: string }
  | { kind: "executor.retry"; attachmentId?: string }
  | { kind: "context.compact"; attachmentId?: string; instructions?: string }
  | { kind: "interaction.resolve"; interactionId: string; resolution: WireResolution }
  | { kind: "resume.schedule"; attentionId: string; attachmentId: string; resumeAt: number }
  | { kind: "resume.cancel"; scheduleId: string };

export interface ChatCommandRequest {
  commandId: string;
  sessionId: string;
  command: ChatCommand;
}

/**
 * The Session edge, as this core needs it.
 *
 * Narrower than the tRPC client it is satisfied by, so the whole of what a chat
 * Session asks of a transport is one readable list — and so a test can hand it
 * an honest object instead of casting a router type it does not implement.
 */
export interface ChatSessionRpc {
  session: {
    /**
     * The projection checkpoint plus the newest window of frames, bounded by
     * the host (VC-315). `before` is the cursor for the history above it;
     * absent from a host that predates the bound, which always sent the whole
     * log.
     */
    snapshot: {
      query(input: { sessionId: string }): Promise<{
        projection: ChatSessionProjection;
        frames: readonly unknown[];
        throughSequence: number;
        before?: number | null;
        /** The current turn's latest reply; absent from a host that predates it. */
        latestReply?: unknown;
      }>;
    };
    /** One older window: frames strictly below `before`, and the cursor above them. */
    history: {
      query(input: { sessionId: string; before: number }): Promise<{
        frames: readonly unknown[];
        before: number | null;
      }>;
    };
    projection: {
      query(input: { sessionId: string }): Promise<{ projection: ChatSessionProjection }>;
    };
    subscribe: {
      subscribe(input: ChatStreamCursor, handlers: ChatStreamHandlers): { unsubscribe(): void };
    };
    /** Network bindings supply this after negotiating sessions.queue. IPC keeps its private stream. */
    subscribeQueue?: {
      subscribe(input: ChatStreamCursor, handlers: ChatStreamHandlers): { unsubscribe(): void };
    };
    // Deliberately `unknown`-shaped past the session id: every reader of a
    // command result goes through `wire.ts`, which reads it structurally
    // because this crosses the RPC edge as JSON. A declared field here would
    // be a promise the transport never made.
    command: { mutate(input: ChatCommandRequest): Promise<{ sessionId: string }> };
    cancelQueued: {
      mutate(input: {
        commandId: string;
        sessionId: string;
        messageId: string;
        expectedRevision?: number;
      }): Promise<unknown>;
    };
    editQueued: {
      mutate(input: {
        commandId: string;
        sessionId: string;
        messageId: string;
        message: UIMessage;
        expectedRevision?: number;
      }): Promise<unknown>;
    };
    cancelInteraction: {
      mutate(input: { sessionId: string; interactionId: string }): Promise<unknown>;
    };
    reconcile: { mutate(input: { sessionId: string; attachmentId: string }): Promise<unknown> };
  };
}

/* ------------------------------------------------------------- flush pacing */

/**
 * When a run of stream emissions becomes one store write.
 *
 * Injected rather than reached for, because the fold is the one thing about a
 * resident Session that must keep happening whether or not the surface is being
 * painted, and a test has to be able to say when.
 */
export interface FlushScheduler {
  /**
   * Runs `flush` once, soon, and never before returning: the caller records the
   * cancel this hands back, so a scheduler that flushed synchronously would have
   * that record overwrite the clean slate its own flush just left and no batch
   * after it would ever be scheduled. The returned cancel retires a flush that
   * has not run.
   */
  schedule(flush: () => void): () => void;
}

/** How long a surface with no frame callbacks waits before folding anyway. */
const HIDDEN_FLUSH_MS = 50;

export interface FlushHost {
  requestAnimationFrame(callback: () => void): number;
  cancelAnimationFrame(handle: number): void;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

/**
 * The app's pacing: a frame callback and a timer race, and the first one wins.
 *
 * A frame callback is the right cadence while a window is on screen, and it
 * stops firing entirely once Chromium considers the window occluded. For an
 * animation that is a pause; for a resident Session it is "stop folding this
 * stream until somebody looks at the tab again", with the attention it
 * was carrying frozen behind it. The timer beside it is what keeps
 * a hidden Session current, and it costs one cleared timeout per batch while
 * visible.
 *
 * Racing them rather than reading `visibilityState` also settles the case that
 * rule cannot: a window hidden *after* a frame callback was already pending
 * would strand that batch, and every emission after it, behind a callback that
 * is never going to run.
 */
export function racingFlushScheduler(host: FlushHost): FlushScheduler {
  return {
    schedule(flush) {
      let settled = false;
      const retire = () => {
        settled = true;
        host.cancelAnimationFrame(frame);
        host.clearTimeout(timer);
      };
      const run = () => {
        if (settled) return;
        retire();
        flush();
      };
      const frame = host.requestAnimationFrame(run);
      const timer = host.setTimeout(run, HIDDEN_FLUSH_MS);
      return retire;
    },
  };
}

/* ----------------------------------------------------------------- the core */

/**
 * Who recovers a Session stream that ended (VC-670).
 *
 * - `"resume-once"`, the default: the in-process Electron IPC edge, where an
 *   end is a producer's teardown race. A stream that had started resumes once
 *   from its cursor; a `subscription-resnapshot-required` reloads the
 *   snapshot once (VC-315); anything else surfaces. Flag off, this is all
 *   there is.
 * - `"host-link"`: the WebSocket edge, behind a client host link
 *   (`@volli/host-protocol/client-link`). The link already resumed every
 *   transport drop from the last tracked id, after the next welcome
 *   validated, so what reaches this client is the host's own answer. A
 *   `subscription-resnapshot-required` reloads the snapshot and subscribes
 *   from its cursor, up to three times in a row; anything else surfaces.
 *   This client retries nothing else.
 *
 * Both count quiet reloads with the one guard, `#silentReloads`, which only
 * an emission clears — never the transport's `started`.
 */
export type ChatStreamRecovery = "resume-once" | "host-link";

export interface ChatSessionTransport {
  rpc: ChatSessionRpc;
  /** Absent means `"resume-once"`: the IPC edge's policy, unchanged. */
  streamRecovery?: ChatStreamRecovery;
  scheduler: FlushScheduler;
  newCommandId(): string;
  /**
   * Mint the durable Session — create + model policy, NO attach. The fast half
   * of a chat start: the store lands the tab on the id this resolves, and the
   * attach (worktree ensure + Agent Runtime boot, the slow half) follows
   * through {@link attachSession} off the caller's critical path (VC-16).
   */
  createSession(input: {
    operationId: string;
    projectId: string;
    ticketId: string | null;
    title: string | null;
    /** A provisional Draft's UUID, adopted as the durable Session id on promotion. */
    requestedSessionId?: string;
    /** Skill slugs to inject at attach time. Absent means none. */
    skills?: readonly string[];
    /**
     * This Session's model policy, when the surface opening it picked one.
     * Absent means the configured default for the Role, which is what every
     * surface but the New-ticket composer's Create & start sends (VC-56).
     */
    model?: ModelSelection;
    /** The first message, for automatic model choice (VC-432); ignored when `model` is set. */
    autoSelect?: { request: string };
  }): Promise<{ sessionId: string }>;
  attachSession(input: { operationId: string; sessionId: string }): Promise<ProductSessionResult>;
}

/**
 * How loud one {@link ChatSessionClientDeps.notify} line is.
 *
 * The presentation half of {@link CommandRefusalSeverity}: `"failure"` is a
 * thing that went wrong and reads as `"error"`, `"benign"` is a thing that
 * simply did not happen and reads as `"neutral"`. Two vocabularies on purpose
 * — the host judges what a refusal WAS, and the client decides how loudly to
 * say it, which is the one of the two a second client may reasonably differ on.
 */
export type NotifyTone = "error" | "neutral";

export interface ChatSessionClientDeps extends ChatSessionTransport {
  store: ChatSessionStore;
  /**
   * One line to a person about a command outcome or a local transport failure.
   * Transport failures also keep their recovery band, but must reach a person
   * whose chat is not mounted. The desktop passes its error toast; nothing here
   * assumes what the line becomes.
   *
   * `tone` is required rather than defaulted, so a second client cannot ship a
   * `notify` that quietly drops the distinction: `"error"` is a stopped turn,
   * a decision that did not land, a model that would not change. `"neutral"`
   * is a refusal the host vouched for as benign — a history with nothing left
   * to summarize is an outcome the person chose to ask about, not a failure
   * (CLAUDE.md's line between the two).
   */
  notify(message: string, tone: NotifyTone): void;
  /**
   * Retitle the durable Session everywhere it is named — the auto-title's one
   * write ({@link ChatSessionClient.#autoTitle}). Fire-and-forget by
   * signature: a rename's failure is the implementation's to surface (the
   * desktop's `renameChatSession` toasts and rolls back), never the
   * submission that triggered it.
   */
  renameSession(sessionId: string, title: string, refineFrom?: string): void;
}

export type ProductSessionResult = SessionStartResult;

/**
 * Quiet resnapshot reloads a stream may make in a row before one of them
 * delivers anything; see `#silentReloads`. One guard, one budget per edge.
 * Over IPC replay is unbounded, so only retention can refuse a cursor, and a
 * host that refuses the fresh snapshot's own cursor is broken: one reload,
 * then the band (VC-315). Behind the host link a resume is bounded and the
 * link has already resumed every drop it could, so a refusal can recur
 * honestly while the head races ahead: three, then the band (VC-670).
 */
const MAX_SILENT_RELOADS: Readonly<Record<ChatStreamRecovery, number>> = {
  "resume-once": 1,
  "host-link": 3,
};

/** The tone a refusal of each weight is said in. */
const TONE_OF: Readonly<Record<CommandRefusalSeverity, NotifyTone>> = {
  benign: "neutral",
  failure: "error",
};

export class ChatSessionClient {
  readonly sessionId: string;

  readonly #rpc: ChatSessionRpc;
  readonly #streamRecovery: ChatStreamRecovery;
  readonly #store: ChatSessionStore;
  readonly #scheduler: FlushScheduler;
  readonly #newCommandId: () => string;
  readonly #attachSession: ChatSessionTransport["attachSession"];
  readonly #notify: ChatSessionClientDeps["notify"];
  readonly #renameSession: ChatSessionClientDeps["renameSession"];

  #subscription: { unsubscribe(): void } | null = null;
  #cancelFlush: (() => void) | null = null;
  // Whether a stream subscription is currently delivering. Every source the
  // error band can name is repairable EXCEPT a dead one: `reconcile` repairs
  // the durable binding and `retryAttach` repairs a missing executor, but
  // neither resubscribes THIS client — so `recover` and `dismissError` read
  // this flag to decide whether the renderer's own stream needs reopening.
  #streamAlive = false;
  // Frames key on sequence and overlays do not: every overlay in one batch
  // carries the same `throughSequence`, so a sequence-keyed map would keep one
  // and silently drop the missing middle of a sentence.
  readonly #frames = new Map<number, ChatSessionFrame>();
  #overlays: SessionStreamOverlay[] = [];
  #compactionProgress: SessionStreamCompactionProgress[] = [];
  #lastEventId: string | null = null;
  /** The one page request in flight, which every caller asking for more shares. */
  #loadingOlder: Promise<boolean> | null = null;
  /**
   * Which open owns the stream. Bumped by every reconnect and by dispose, so a
   * snapshot that resolves after the surface moved on cannot seed a second
   * subscription onto the one that replaced it.
   */
  #generation = 0;
  /** One reconnect per stream that actually started — see {@link #dropped}. */
  #reconnectable = false;
  /**
   * Resnapshot reloads in a row with no emission between them. A host that
   * keeps refusing its own snapshot's cursor would otherwise reload forever,
   * so past {@link MAX_SILENT_RELOADS} the stream surfaces instead.
   *
   * Only an emission clears it — the replay or a baseline actually arriving —
   * never the transport's `started`. tRPC's WebSocket adapter sends `started`
   * as soon as the subscription's iterator exists, before its first `next()`
   * runs the replay that may refuse; a guard cleared there is cleared by
   * every refusal it was meant to count (VC-315 review, B4).
   */
  #silentReloads = 0;
  #projectionRefresh: Promise<void> | null = null;
  #projectionQueued = false;
  // Repeated attach or stream failures should not repeat the same notification.
  // Keep one notification per source until it recovers or the person retries.
  readonly #reportedLocalFailures: Partial<Record<"attach" | "stream", string>> = {};
  #retired = false;
  constructor(sessionId: string, deps: ChatSessionClientDeps) {
    this.sessionId = sessionId;
    this.#rpc = deps.rpc;
    this.#streamRecovery = deps.streamRecovery ?? "resume-once";
    this.#store = deps.store;
    this.#scheduler = deps.scheduler;
    this.#newCommandId = deps.newCommandId;
    this.#attachSession = deps.attachSession;
    this.#notify = deps.notify;
    this.#renameSession = deps.renameSession;
  }

  /**
   * Opens the Session stream, replacing whatever was open.
   *
   * The snapshot is the one read that genuinely wants frames: a surface opening
   * on a Session with history has no other way to get it. Everything after it
   * arrives as deltas.
   */
  async connect(): Promise<void> {
    delete this.#reportedLocalFailures.stream;
    await this.#open(null);
  }

  /**
  /**
   * Reads the window of history above the transcript, if the host has any.
   *
   * The reader is waiting on this — they scrolled up to read it — so a failure
   * is told, once per attempt, and leaves the transcript as it was for the
   * next reveal to ask again. Concurrent asks share one request: the sentinel
   * and the button can both fire for the same scroll.
   */
  loadOlder(): Promise<boolean> {
    const before = this.#slice()?.transcript.before ?? null;
    if (before === null) return Promise.resolve(false);
    this.#loadingOlder ??= this.#readOlder(before).finally(() => {
      this.#loadingOlder = null;
    });
    return this.#loadingOlder;
  }

  async #readOlder(before: number): Promise<boolean> {
    try {
      const page = await this.#rpc.session.history.query({ sessionId: this.sessionId, before });
      if (this.#retired) return false;
      this.#writes().prependHistory(this.sessionId, before, {
        frames: readFrames(page.frames),
        before: readBefore(page.before),
      });
      return true;
    } catch (failure) {
      if (!this.#retired) this.#notify(`Earlier messages: ${errorMessage(failure)}`, "error");
      return false;
    }
  }

  /**
   * One attachment attempt on the durable Session this client owns.
   *
   * A refusal is a completed round trip carrying a rejected receipt; a transport
   * failure is an exception. Neither un-creates the Session, so both land on the
   * same error and the id is never at risk.
   */
  /**
   * Another attachment attempt on the Session that already exists.
   *
   * Never a second `session.create`: a refused attach leaves the Session in the
   * ledger with its history intact, so creating one per press of Retry would
   * file a new row and walk away from it. The stream is reopened alongside,
   * because a snapshot that failed left this client blind to the very projection
   * that says whether an executor is live.
   */
  async retryAttach(options?: AttachOptions): Promise<boolean> {
    const slice = this.#slice();
    if (slice === undefined || slice.lifecycle === "starting" || slice.projection === null) {
      return false;
    }
    delete this.#reportedLocalFailures.attach;
    this.#writes().attaching(this.sessionId);
    void this.connect();
    return this.#attachOnce(options);
  }

  /**
   * The FIRST attach of a Session this surface just brought into residence —
   * a create, or a Chat Draft promoted by its first message (VC-358).
   *
   * Unlike {@link retryAttach} this does not require a projection: there has
   * not been one yet. It opens the stream and attaches in the same gesture,
   * which is what makes the Session live.
   */
  startAttach(options?: AttachOptions): Promise<boolean> {
    this.#writes().attaching(this.sessionId);
    void this.connect();
    return this.#attachOnce(options);
  }

  /** The explicit start/recovery attach, separate from opening the stream. */
  async #attachOnce(options?: AttachOptions): Promise<boolean> {
    try {
      const attached = await this.#attachSession({
        operationId: this.#newCommandId(),
        sessionId: this.sessionId,
      });
      const refusal = rejectedReceipt(attached);
      // One wording for the receiptless case, whichever door asked. The store
      // used to own the first attach and said this; the client said
      // "attachment needs recovery" for every other. Now that there is one
      // attacher there is one sentence, and it is the one written as a
      // sentence — a person meeting it twice can tell it is the same state.
      const failure =
        attached.state === "ready" && refusal === null
          ? null
          : (refusal ?? "Runtime recovery is required.");
      // A retired client must not settle over a replacement surface's slice.
      if (this.#retired) return failure === null;
      // A refusal with a durable home is told once, there. An outstanding local
      // stream failure is independent: attach success cannot repair that stream
      // or clear the band that offers its recovery.
      const attachPart =
        failure === null || options?.refusalIsReportedElsewhere === true
          ? null
          : `Could not start Session: ${failure}`;
      const slicePart = attachPart ?? this.#reportedLocalFailures.stream ?? null;
      if (failure === null) delete this.#reportedLocalFailures.attach;
      this.#writes().settle(this.sessionId, slicePart);
      return failure === null;
    } catch (failure) {
      // A throw has no durable Attention to report it. Keep the recovery band,
      // but also notify: a background kickoff need not have a mounted chat.
      this.#reportLocalFailure("attach", `Could not start Session: ${errorMessage(failure)}`);
      return false;
    }
  }

  /**
   * One action, and working out which one is not the user's problem.
   *
   * A live attachment that stopped answering is reconciled; a durable Session
   * with no executor is re-attached. Starting over is not here at all — minting
   * a Session is the store's job, and reaching for it from a client that already
   * has one would duplicate it.
   *
   * A stream this client terminally lost is reopened FIRST, whichever arm
   * follows. `#lost` leaves no subscription behind, and neither reconcile nor
   * a live executor ever reopens one — a Retry that reconciled without
   * resubscribing would clear the band while the transcript stayed frozen,
   * which is the failure this Session can least afford to hide (VC-97). The
   * re-attach arm needs no help: `retryAttach` reopens the stream itself.
   */
  recover(): Promise<boolean> {
    const slice = this.#slice();
    if (slice === undefined) return Promise.resolve(false);
    if ((slice.projection?.liveExecutor ?? null) === null) return this.retryAttach();
    return this.#streamAlive ? this.reconcile() : this.#reopenThenReconcile();
  }

  /**
   * The reopen, and only then the reconcile that depends on it.
   *
   * Ordered rather than raced, because the two settle the same latch and the
   * reconcile is the louder writer: a reopen that failed fast would latch the
   * honest `#lost` band and a reconcile succeeding after it would clear that
   * band, restoring the exact frozen-transcript-behind-a-healthy-face this
   * Retry exists to prevent. A reopen that fails ends the recovery instead,
   * leaving the band it just wrote to say so.
   */
  async #reopenThenReconcile(): Promise<boolean> {
    delete this.#reportedLocalFailures.stream;
    if (!(await this.#open(null))) return false;
    return this.reconcile();
  }

  /**
   * Clears the error band without demanding anything of the transport.
   *
   * The latch is renderer-local state, and dismissing it is the reader's call:
   * nothing durable changes, and the Session is handed back to whatever its
   * stream says. One exception is not the reader's to accept — a stream this
   * client terminally lost is quietly reopened, because a dismissal that left
   * the transcript frozen would trade an honest band for an invisible one.
   */
  dismissError(): void {
    this.#writes().settle(this.sessionId, null);
    if (!this.#streamAlive) void this.connect();
  }

  /** Retry Pi's last failed run without submitting the user's message twice. */
  retryRuntime(): Promise<boolean> {
    const attachmentId = this.#liveAttachmentId();
    if (attachmentId === null) return Promise.resolve(false);
    return this.#eventRun("Retry", () =>
      this.#rpc.session.command.mutate({
        commandId: this.#newCommandId(),
        sessionId: this.sessionId,
        command: { kind: "executor.retry", attachmentId },
      }),
    );
  }

  /**
   * Resume the run a spent allowance stopped, at the reset its Attention
   * stated — a person's choice, recorded now and run by the host at that time.
   * A refusal (the Attention moved on, the executor closed) toasts, as every
   * one-shot command here does.
   */
  scheduleResume(input: {
    attentionId: string;
    attachmentId: string;
    resumeAt: number;
  }): Promise<boolean> {
    return this.#eventRun("Resume", () =>
      this.#rpc.session.command.mutate({
        commandId: this.#newCommandId(),
        sessionId: this.sessionId,
        command: {
          kind: "resume.schedule",
          attentionId: input.attentionId,
          attachmentId: input.attachmentId,
          resumeAt: input.resumeAt,
        },
      }),
    );
  }

  /** Withdraw the scheduled resume named by its schedule id. */
  cancelScheduledResume(scheduleId: string): Promise<boolean> {
    return this.#eventRun("Cancel", () =>
      this.#rpc.session.command.mutate({
        commandId: this.#newCommandId(),
        sessionId: this.sessionId,
        command: { kind: "resume.cancel", scheduleId },
      }),
    );
  }

  /**
   * Summarize this Session's context now, because someone typed `/compact`.
   *
   * Every way it does not happen comes back as a refused receipt — a turn
   * still running, a compaction already running, a history with nothing left
   * to summarize, a summary the provider refused. VC-141: all of them are a
   * one-shot toast, never the `sessionError` band {@link #run} would have
   * latched. A refusal is not a failure of the Session's plumbing, and a
   * persistent error row with a Retry button that re-attaches a perfectly fine
   * executor is the wrong report for any of them — least of all for the one a
   * person's own `/compact` simply ran into (CLAUDE.md's line between the two).
   *
   * Which refusals are benign is not decided here. The host marks each one,
   * and {@link #eventRun} says it in that weight using the runtime's own
   * sentence — which is why a context busy with a live turn and a context busy
   * with another compaction read differently, as the runtime wrote them.
   */
  compactContext(instructions: string | null): Promise<boolean> {
    const attachmentId = this.#liveAttachmentId();
    if (attachmentId === null) {
      // The one refusal this side can see, and it still owes a person a word
      // (VC-141): a `/compact` that vanished because nothing was attached is
      // the same "did that work?" silence the rest of this method exists to
      // end. Said in the composer verb's own voice, which refuses the sibling
      // case — a turn already live — in the same breath.
      this.#notify("Compaction can't run until the Session is live", "error");
      return Promise.resolve(false);
    }
    return this.#eventRun("Compact", () =>
      this.#rpc.session.command.mutate({
        commandId: this.#newCommandId(),
        sessionId: this.sessionId,
        // Absent, never explicitly `undefined` — `interrupt`'s rule, for
        // `interrupt`'s reason: structured clone keeps a key JSON would drop.
        command:
          instructions === null
            ? { kind: "context.compact", attachmentId }
            : { kind: "context.compact", attachmentId, instructions },
      }),
    );
  }

  /**
   * Sends one message.
   *
   * The result is the point: a caller chaining a second act onto the first — a
   * redirection after the refusal it belongs to, a composer deciding whether it
   * is still holding the only copy — cannot read that off the error state,
   * which is state and not a result. See {@link MessageDelivery} for why two
   * kinds of failure are not one.
   */
  async submit(message: QueuedMessage, delivery?: ChatMessageDelivery): Promise<MessageDelivery> {
    const slice = this.#slice();
    const body = message.text.trim();
    const attachments = message.attachments ?? [];
    // An attachment makes an otherwise-empty message a real one (VC-50): a
    // dropped screenshot with no words is a question, and refusing it here
    // would drop the file the person just chose.
    if (slice === undefined || (delivery !== "queue" && !isDeliverable(slice))) return "refused";
    if (body.length === 0 && attachments.length === 0) return "refused";
    try {
      // The message-scoped resource channel (VC-49): each skill body the text's
      // `/slug` references resolved to travels as its own typed part BESIDE the
      // text, never spliced into it — the durable artifact records both halves,
      // the transcript renders the text verbatim with a chip per resource, and
      // the adapter appends the delimited RESOURCE blocks after the text when
      // it composes the delivered prompt.
      // Link views and the title baseline belong to pending host queue work,
      // not every immediate transcript message. File/resource parts still travel.
      const wireMessage = queuedWireMessage(message, delivery === "queue");
      const command: ChatCommand = {
        kind: "message.submit",
        message: wireMessage,
        ...(delivery === undefined ? {} : { delivery }),
      };
      const deliveryResult = this.#rpc.session.command.mutate({
        commandId: message.id,
        sessionId: this.sessionId,
        command,
      });
      // Pi answers an opening prompt only after its whole turn settles. Its
      // subject is already known when this message starts, so the detached
      // title write cannot wait on that answer: a steering message can resolve
      // first and would otherwise name the Session instead of this prompt.
      //
      // So the moment a Session gains a subject is the first message it STARTS
      // delivering, no longer the first one accepted (VC-180). Firing ahead of
      // the receipt is the whole point and costs the acceptance guarantee: a
      // delivery that then fails leaves the Session named after a prompt the
      // person did type, which is a truer subject than `Chat 3` and is the same
      // name their retry would produce. Synchronous, before the `await`, so no
      // steer can interleave — and so the promise above is never left floating.
      this.#autoTitle(message, body, attachments);
      const delivered = await deliveryResult;
      // A harness that cannot take a message says so in its receipt rather than
      // by throwing, and that receipt is the failure. It is also proof the
      // round trip completed, which means the runtime committed the intent and
      // the transcript artifact before it ever asked the executor — so the
      // words are recorded, not lost.
      const refusal = rejectedReceipt(delivered);
      if (refusal !== null) {
        this.#writes().settle(this.sessionId, `Message not delivered: ${refusal}`);
        if (delivery === "queue") this.#notify(`Message not queued: ${refusal}`, "error");
        return delivery === "queue" ? "refused" : "recorded";
      }
      if (delivery === "queue") this.#refreshProjection();
      else this.#writes().delivered(this.sessionId, slice.transcript.turnEpoch);
      return "delivered";
    } catch (failure) {
      this.#writes().settle(this.sessionId, `Message not delivered: ${errorMessage(failure)}`);
      if (delivery === "queue")
        this.#notify(`Message not queued: ${errorMessage(failure)}`, "error");
      return "refused";
    }
  }

  /** Queue mutations never optimistically remove a row: release may already own it. */
  async cancelQueued(
    messageId: string,
    expectedRevision = this.#slice()?.queueRevision,
  ): Promise<boolean> {
    const accepted = await this.#eventRun("Message not removed", () =>
      this.#rpc.session.cancelQueued.mutate({
        commandId: this.#newCommandId(),
        sessionId: this.sessionId,
        messageId,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }),
    );
    if (accepted) this.#refreshProjection();
    return accepted;
  }

  async editQueued(
    message: QueuedMessage,
    expectedRevision = this.#slice()?.queueRevision,
  ): Promise<boolean> {
    const accepted = await this.#eventRun("Message not changed", () =>
      this.#rpc.session.editQueued.mutate({
        commandId: this.#newCommandId(),
        sessionId: this.sessionId,
        messageId: message.id,
        message: queuedWireMessage(message),
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }),
    );
    if (accepted) this.#refreshProjection();
    return accepted;
  }

  /** The host atomically claims the queued identity; never cancel before steering. */
  async steerQueued(messageId: string): Promise<MessageDelivery> {
    const slice = this.#slice();
    const message = slice?.queue.find((entry) => entry.id === messageId);
    if (!message || message.queueState === "releasing" || slice?.projection?.turnActive !== true) {
      this.#notify(
        "Message not steered: the queued message or targeted turn is no longer available",
        "error",
      );
      return "refused";
    }
    const accepted = await this.#eventRun("Message not steered", () =>
      this.#rpc.session.command.mutate({
        commandId: this.#newCommandId(),
        sessionId: this.sessionId,
        command: { kind: "message.submit", delivery: "steer", message: queuedWireMessage(message) },
      }),
    );
    if (!accepted) return "refused";
    this.#refreshProjection();
    return "delivered";
  }

  /** Records and applies a per-Session model override. The engine enforces idle-only changes. */
  selectModel(selection: ModelSelection): Promise<boolean> {
    const slice = this.#slice();
    if (slice === undefined || slice.projection?.turnActive === true) return Promise.resolve(false);
    return this.#eventRun("Model not changed", () =>
      this.#rpc.session.command.mutate({
        commandId: this.#newCommandId(),
        sessionId: this.sessionId,
        command: { kind: "model.select", selection },
      }),
    );
  }

  interrupt(): Promise<boolean> {
    const attachmentId = this.#liveAttachmentId();
    return this.#eventRun("Interrupt", () =>
      this.#rpc.session.command.mutate({
        commandId: this.#newCommandId(),
        sessionId: this.sessionId,
        // Absent, never explicitly `undefined`: structured clone keeps a key
        // JSON would have dropped, and the ledger asserts strict JSON.
        command:
          attachmentId === null
            ? { kind: "executor.interrupt" }
            : { kind: "executor.interrupt", attachmentId },
      }),
    );
  }

  resolveInteraction(
    interactionId: string,
    resolution: SessionInteractionResolution,
  ): Promise<boolean> {
    return this.#eventRun("Decision not delivered", () =>
      this.#rpc.session.command.mutate({
        commandId: this.#newCommandId(),
        sessionId: this.sessionId,
        command: { kind: "interaction.resolve", interactionId, resolution: wire(resolution) },
      }),
    );
  }

  /** Withdraws a decision nobody is going to make, so the card stops blocking. */
  cancelInteraction(interactionId: string): Promise<boolean> {
    return this.#eventRun("Decision not cancelled", () =>
      this.#rpc.session.cancelInteraction.mutate({ sessionId: this.sessionId, interactionId }),
    );
  }

  reconcile(): Promise<boolean> {
    const attachmentId = this.#liveAttachmentId();
    // No attachment is not a success: this is addressed to one, so it reports
    // the same `false` a failed round trip does.
    if (attachmentId === null) return Promise.resolve(false);
    return this.#run("Reconcile", () =>
      this.#rpc.session.reconcile.mutate({ sessionId: this.sessionId, attachmentId }),
    );
  }

  /** Retires this client. Releases nothing on the harness — the Session outlives it. */
  dispose(): void {
    this.#retired = true;
    this.#generation += 1;
    this.#streamAlive = false;
    this.#cancelFlush?.();
    this.#cancelFlush = null;
    this.#frames.clear();
    this.#overlays = [];
    this.#compactionProgress = [];
    this.#subscription?.unsubscribe();
    this.#subscription = null;
  }

  /* ------------------------------------------------------------- the stream */

  /**
   * Opens the stream, reporting whether THIS call established it — the signal
   * `#reopenThenReconcile` needs to know a recovery is worth continuing. A
   * superseded generation reports false too: it established nothing for the
   * caller that asked, whatever the open that overtook it goes on to do.
   */
  async #open(cursor: string | null): Promise<boolean> {
    const generation = (this.#generation += 1);
    // A compaction marker says what this particular live subscription knows.
    // It is not recoverable state: if the stream is replaced, wait for its fresh
    // baseline rather than letting the previous connection's spinner linger.
    this.#compactionProgress = [];
    this.#writes().applyStream(this.sessionId, [], [], [], true);
    this.#subscription?.unsubscribe();
    this.#subscription = null;
    this.#reconnectable = false;
    try {
      let afterSequence = this.#slice()?.transcript.throughSequence ?? 0;
      if (cursor === null) {
        const snapshot = await this.#rpc.session.snapshot.query({ sessionId: this.sessionId });
        if (this.#stale(generation)) return false;
        this.#writes().applySnapshot(
          this.sessionId,
          {
            frames: readFrames(snapshot.frames),
            before: readBefore(snapshot.before),
            latestReply: readLatestReply(snapshot.latestReply),
          },
          snapshot.projection,
        );
        afterSequence = snapshot.throughSequence;
      }
      const source =
        this.#streamRecovery === "host-link"
          ? (this.#rpc.session.subscribeQueue ?? this.#rpc.session.subscribe)
          : this.#rpc.session.subscribe;
      this.#subscription = source.subscribe(
        // The cursor rides alongside the sequence rather than instead of it: the
        // router resumes from whichever is further on, and an overlay id — which
        // is a durable sequence, not a suffixed one — is safe to hand back.
        cursor === null
          ? { sessionId: this.sessionId, afterSequence }
          : { sessionId: this.sessionId, afterSequence, lastEventId: cursor },
        {
          onStarted: () => {
            delete this.#reportedLocalFailures.stream;
            this.#reconnectable = true;
            this.#streamAlive = true;
          },
          onData: (event) => {
            this.#silentReloads = 0;
            this.#lastEventId = event.id;
            this.#receive(event.data);
          },
          onError: (failure) => {
            this.#dropped(failure);
          },
          onComplete: () => {
            this.#dropped(new Error("the Session stream ended"));
          },
        },
      );
      return true;
    } catch (failure) {
      if (this.#stale(generation)) return false;
      this.#streamAlive = false;
      this.#lost(failure);
      return false;
    }
  }

  /**
   * A stream that ended on an error, and the one retry it may have earned.
   *
   * A subscription that delivered its start and then broke is a transport that
   * dropped, and resuming from the last cursor costs nothing and duplicates
   * nothing. One that failed *before* it started is reporting a fault a retry
   * would only repeat, so it surfaces instead — which is also what bounds this
   * to a single attempt per healthy stream rather than a loop.
   */
  #dropped(failure: unknown): void {
    this.#subscription?.unsubscribe();
    this.#subscription = null;
    this.#streamAlive = false;
    // The host could not resume from this cursor — retention moved past it, or
    // the backlog is beyond its replay bound — and said so instead of leaving a
    // gap. That is not a broken stream: reading a fresh tail and resuming after
    // it is the whole recovery, and it needs no one's attention (VC-315). It is
    // asked before the reconnect budget because a resume refused this way
    // fails before it delivers anything, whether or not the transport said
    // `started` first. Past the edge's budget of reloads that delivered
    // nothing, the host cannot be resumed at all: the band, not a loop.
    if (isResnapshotRequired(failure)) {
      this.#reconnectable = false;
      if (this.#silentReloads < MAX_SILENT_RELOADS[this.#streamRecovery]) {
        this.#silentReloads += 1;
        void this.#open(null);
      } else {
        this.#lost(failure);
      }
      return;
    }
    if (this.#streamRecovery === "host-link") {
      // The link resumed every drop it could; this is the host's answer.
      this.#lost(failure);
      return;
    }
    if (!this.#reconnectable) {
      this.#lost(failure);
      return;
    }
    this.#reconnectable = false;
    void this.#open(this.#lastEventId);
  }

  #lost(failure: unknown): void {
    this.#reportLocalFailure("stream", `Lost the Session stream: ${errorMessage(failure)}`);
  }

  /**
   * Transport failures have no host-owned Attention. The resident band keeps
   * recovery available when the chat is opened, while the client's notification
   * port reports the failure even when that chat has never been mounted.
   * A surface that let go of the Session owes no late notification.
   */
  #reportLocalFailure(source: "attach" | "stream", message: string): void {
    if (this.#slice() === undefined || this.#retired) return;
    const previous = this.#reportedLocalFailures[source];
    this.#reportedLocalFailures[source] = message;
    this.#writes().settle(this.sessionId, message);
    if (previous !== message) this.#notify(message, "error");
  }

  #receive(emission: unknown): void {
    // Each arm of the stream in turn, first match wins; an emission none of
    // them recognizes is dropped rather than drawn.
    const queue = chatSessionQueue(emission);
    if (queue !== null) {
      if (queue.sessionId === this.sessionId)
        this.#writes().setQueue(this.sessionId, queue.queue, queue.revision);
      return;
    }
    const progress = chatSessionCompactionProgress(emission);
    const overlay = progress === null ? chatSessionOverlay(emission) : null;
    const frame = progress === null && overlay === null ? chatSessionFrame(emission) : null;
    if (progress !== null) this.#compactionProgress.push(progress);
    else if (overlay !== null) this.#overlays.push(overlay);
    else if (frame !== null) {
      this.#frames.set(frame.sequence, frame);
      // Not gated behind the paint, unlike the fold below. A permission ask
      // reaches the user through the projection, and a Session that stopped to
      // ask must not wait on a frame callback an occluded window is seconds away
      // from running.
      if (movesProjection(frame)) this.#refreshProjection();
    } else return;
    if (this.#cancelFlush !== null) return;
    this.#cancelFlush = this.#scheduler.schedule(() => {
      this.#flush();
    });
  }

  /**
   * One store write per batch — the whole reason emissions are buffered.
   *
   * A native adapter emits several frames per paint and a streaming message far
   * more overlays than that; folding each one on arrival would put a render pass
   * between every two words.
   */
  #flush(): void {
    this.#cancelFlush = null;
    const frames = [...this.#frames.values()];
    const overlays = this.#overlays;
    const progress = this.#compactionProgress;
    this.#frames.clear();
    this.#overlays = [];
    this.#compactionProgress = [];
    this.#writes().applyStream(this.sessionId, frames, overlays, progress);
  }

  /**
   * Session state only, and only when a frame could have moved it.
   *
   * Coalesced rather than counted: a burst of projection-moving frames costs one
   * round trip in flight plus at most one more behind it, so the answer is never
   * older than the last frame that could have changed it.
   */
  #refreshProjection(): void {
    if (this.#projectionRefresh !== null) {
      this.#projectionQueued = true;
      return;
    }
    this.#projectionRefresh = this.#rpc.session.projection
      .query({ sessionId: this.sessionId })
      .then((snapshot) => {
        this.#writes().setProjection(this.sessionId, snapshot.projection);
      })
      .catch((failure: unknown) => {
        this.#lost(failure);
      })
      .finally(() => {
        this.#projectionRefresh = null;
        if (!this.#projectionQueued) return;
        this.#projectionQueued = false;
        this.#refreshProjection();
      });
  }

  /* ------------------------------------------------------------- the shared */

  /**
   * One recovery command, and whether it landed — the arm `recover` reaches
   * for, where a failure IS the Session's plumbing and must latch the band
   * until recovered or dismissed.
   *
   * A resolved round trip is not the same as a delivered command: a harness that
   * will not serve one answers with a rejected receipt rather than by throwing.
   */
  async #run(label: string, call: () => Promise<unknown>): Promise<boolean> {
    try {
      const refusal = rejectedReceipt(await call());
      if (refusal !== null) {
        this.#writes().settle(this.sessionId, `${label}: ${refusal}`);
        return false;
      }
      this.#writes().settle(this.sessionId, null);
      return true;
    } catch (failure) {
      this.#writes().settle(this.sessionId, `${label}: ${errorMessage(failure)}`);
      return false;
    }
  }

  /**
   * One event-shaped command, and whether it landed — where the failure is a
   * moment, not a state, and its consequence is already visible where it
   * happened: the card the decision never reached stays answerable, the model
   * pill keeps the selection it had, a stopped turn keeps running. One
   * `notify` line names the failure once (the desktop surfaces it as a
   * toast); latching the band would instead park a Retry that addresses none
   * of them (VC-97).
   *
   * Neither outcome touches the latch. A failure of `interrupt` is not a
   * failure of the Session's plumbing, and a success of it does not repair
   * one either — clearing a latched transport error on an unrelated command's
   * round trip is how a frozen transcript ended up looking healthy.
   *
   * Two weights, not one (VC-141). A refusal the host marked benign is read
   * out in the host's own words at a neutral tone and nothing is prefixed onto
   * it: it is a whole sentence about the thing the person asked for, and
   * naming the command again would be calling an outcome a fault. Every other
   * refusal — including every refusal nobody vouched for — keeps the
   * `Label: reason` shape that says which command went wrong.
   */
  async #eventRun(label: string, call: () => Promise<unknown>): Promise<boolean> {
    try {
      const refusal = commandRefusal(await call());
      if (refusal === null) return true;
      const tone = TONE_OF[refusal.severity];
      this.#notify(tone === "neutral" ? refusal.message : `${label}: ${refusal.message}`, tone);
      return false;
    } catch (failure) {
      this.#notify(`${label}: ${errorMessage(failure)}`, "error");
      return false;
    }
  }

  /**
   * Retitles this Session from the first message it starts delivering. A
   * normal chat must still be untitled; a composed start may instead carry the
   * exact fallback it seeded at birth. Every other non-null title was explicitly
   * set by a person, including one that happens to read `Chat 1`, so automatic
   * naming never replaces it.
   *
   * The rename carries the first user message with it (VC-81), which asks
   * main to derive a sharper title behind this write with one model call.
   * Main owns the model ladder, the call, and the guard that a person's
   * rename during the call wins; an unavailable model or a refusal simply
   * leaves the heuristic name that is already on screen.
   */
  #autoTitle(message: QueuedMessage, body: string, attachments: readonly BlobLinkView[]): void {
    const title = this.#slice()?.projection?.session.title ?? null;
    const seededBaseline = message.autoTitleBaseline;
    // A normal chat has no title. A composed start is the one exception: its
    // stock kickoff cannot produce a useful local title, so it is born with a
    // deterministic fallback and carries that exact value on this opening
    // message. Equality is the guard — if a person renamed before delivery,
    // the message no longer owns the title and the model gets no call.
    if (!isUntitledChatSession(title) && title !== seededBaseline) return;
    // `body` can now be empty: a message that is nothing but an attachment is
    // a real message (VC-50), and it has no words to name itself with. The
    // file's label is the only honest subject in that case — "shot.png" says
    // more about the Session than "Chat 3" does.
    // Neither is unreachable from `submit`, which refuses a message with no
    // text AND no attachments, and a label is never empty at rest (the
    // `blob_links` CHECK). Returning rather than asserting anyway: a Session's
    // name is not worth a throw if that invariant ever moves.
    const subject = seededBaseline ?? autoTitleFromMessage(body) ?? attachments[0]?.label;
    /* v8 ignore next -- submit refuses a message with neither text nor attachments */
    if (subject === undefined) return;
    // The model reads the same first user message the heuristic read: the body
    // when there are words, the attachment's label when there are not.
    /* v8 ignore next -- submit refuses a message with no text AND no attachments */
    const firstMessage = body.trim().length > 0 ? body : (attachments[0]?.label ?? "");
    this.#renameSession(this.sessionId, subject, firstMessage);
  }

  #writes(): ChatSessionWrites {
    return this.#store.getState();
  }

  #slice(): ChatSessionSlice | undefined {
    return this.#store.getState().sessions[this.sessionId];
  }

  #liveAttachmentId(): string | null {
    return this.#slice()?.projection?.liveExecutor?.id ?? null;
  }

  #stale(generation: number): boolean {
    return this.#generation !== generation;
  }
}

/**
 * The wire shape of a resolution.
 *
 * `answers` is spread rather than assigned because it is optional, and a key
 * that arrives explicitly `undefined` is a key that is present and
 * unserialisable once structured clone has kept what JSON would have dropped.
 */
interface WireResolution {
  optionIds: string[];
  response: string | null;
  answers?: { promptId: string; optionIds: string[]; response: string | null }[];
}

function wire(resolution: SessionInteractionResolution): WireResolution {
  return {
    optionIds: [...resolution.optionIds],
    response: resolution.response,
    ...(resolution.answers
      ? {
          answers: resolution.answers.map((answer) => ({
            promptId: answer.promptId,
            optionIds: [...answer.optionIds],
            response: answer.response,
          })),
        }
      : {}),
  };
}

/**
 * A window's older cursor. Anything but a positive integer reads as "nothing
 * above": a host that predates the bound sent no cursor because it sent the
 * whole log, and a malformed one is not a page worth asking for.
 */
function readBefore(before: unknown): number | null {
  return typeof before === "number" && Number.isSafeInteger(before) && before > 0 ? before : null;
}

/** A snapshot's reply baseline, read structurally: anything malformed is no baseline. */
function readLatestReply(value: unknown): SessionLatestReply | null {
  if (value === null || typeof value !== "object") return null;
  const { sequence, text } = value as { sequence?: unknown; text?: unknown };
  return typeof sequence === "number" && Number.isSafeInteger(sequence) && typeof text === "string"
    ? { sequence, text }
    : null;
}

/** A snapshot's frames, with anything malformed dropped rather than drawn. */
function readFrames(frames: readonly unknown[]): ChatSessionFrame[] {
  return frames.flatMap((frame) => {
    const normalized = chatSessionFrame(frame);
    return normalized === null ? [] : [normalized];
  });
}

/** The host retains the complete message, including the link views needed for editing. */
export function queuedWireMessage(message: QueuedMessage, retainQueueMetadata = true): UIMessage {
  return {
    id: message.id,
    role: "user",
    ...(!retainQueueMetadata ||
    (message.attachments === undefined && message.autoTitleBaseline === undefined)
      ? {}
      : {
          metadata: {
            ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
            ...(message.autoTitleBaseline === undefined
              ? {}
              : { autoTitleBaseline: message.autoTitleBaseline }),
          },
        }),
    parts: [
      { type: "text", text: message.text.trim() },
      ...(message.resources ?? []).map(skillResourcePart),
      ...(message.attachments ?? []).map((attachment) => ({
        type: "file" as const,
        url: blobUrl(attachment.blobHash),
        mediaType: attachment.mime,
        filename: attachment.originalName,
      })),
    ],
  };
}
