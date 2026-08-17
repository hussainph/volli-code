/**
 * The resident half of a chat Session: one client per durable Session id,
 * owning its subscription, the cadence its stream folds at, and its queue.
 *
 * It lives outside React for the reason the terminal registry does — a Session
 * is durable and its views are lazy, so nothing about a stream may depend on a
 * component staying mounted. A chat left for the board keeps folding, keeps its
 * queued message, and releases it the moment the harness is free, whether or not
 * anyone is looking at the tab.
 *
 * Every effectful dependency arrives through {@link ChatSessionClientDeps}: the
 * RPC edge, the flush pacing, and the store written back to. That is what lets
 * this file be tested without a window, and what will let the lab shell hand it
 * an HTTP client instead of the IPC one.
 *
 * The seams this declares — {@link ChatSessionRpc} and {@link ChatSessionStore} —
 * are stated here rather than imported from either side. The core is the thing
 * that has to be right; its transport and its container are details it names
 * requirements for.
 */
import type { SessionStreamOverlay } from "@volli/session-engine";
import { autoTitleFromMessage, errorMessage, skillResourcePart } from "@volli/shared";
import type {
  ModelSelection,
  SessionInteractionResolution,
  SessionPresentationProjection,
  SessionStartResult,
} from "@volli/shared";
import type { UIMessage } from "ai";

import { isUntitledChatSession, renameChatSession } from "@renderer/chat/rename";
import { toastError } from "@renderer/lib/toast";
import { nextRelease, type QueuedMessage } from "@renderer/chat/session-model";
import {
  movesProjection,
  type ChatSessionFrame,
  type ChatTranscriptState,
} from "@renderer/chat/transcript";
import { chatSessionFrame, chatSessionOverlay, rejectedReceipt } from "@renderer/chat/wire";
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";

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

/**
 * One Session's resident state.
 *
 * The runtime catalog is deliberately absent. Which models exist is a question
 * about the product runtime, asked and re-asked by whatever is on screen. The
 * durable projection owns the Session's selected model.
 */
export interface ChatSessionSlice {
  projection: SessionPresentationProjection | null;
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
 * its model policy durably before anything attaches — a project chat's is taken
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

/* ---------------------------------------------------------------- the store */

/** Everything a resident client writes back. The chat-sessions store is it. */
export interface ChatSessionWrites {
  sessions: Readonly<Record<string, ChatSessionSlice>>;
  applyStream(
    sessionId: string,
    frames: readonly ChatSessionFrame[],
    overlays: readonly SessionStreamOverlay[],
  ): void;
  setProjection(sessionId: string, projection: SessionPresentationProjection): void;
  /** An attachment attempt is in flight; nothing derives lifecycle until it lands. */
  attaching(sessionId: string): void;
  /**
   * The harness took a message — optimistically, and only while the stream has
   * said nothing since it left.
   *
   * `turnEpoch` is the transcript's count at submit. Pi answers a
   * `message.submit` when the turn it started has ALREADY ENDED (the runtime
   * awaits `agent.prompt`), so an unconditional latch here re-opens a turn the
   * stream has closed — and the queue's release rule reads this same field,
   * which strands every message behind it. An unchanged epoch is the one case
   * where nothing has been heard and optimism is all there is.
   */
  delivered(sessionId: string, turnEpoch: number): void;
  /** A failure, or `null` to clear one and hand the Session back to its stream. */
  settle(sessionId: string, error: string | null): void;
  dequeue(sessionId: string, id: string): void;
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
      delivery: ChatMessageDelivery;
    }
  | { kind: "model.select"; selection: ModelSelection }
  | { kind: "executor.interrupt"; attachmentId?: string }
  | { kind: "executor.retry"; attachmentId?: string }
  | { kind: "interaction.resolve"; interactionId: string; resolution: WireResolution };

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
    snapshot: {
      query(input: { sessionId: string }): Promise<{
        projection: SessionPresentationProjection;
        frames: readonly unknown[];
        throughSequence: number;
      }>;
    };
    projection: {
      query(input: { sessionId: string }): Promise<{ projection: SessionPresentationProjection }>;
    };
    subscribe: {
      subscribe(input: ChatStreamCursor, handlers: ChatStreamHandlers): { unsubscribe(): void };
    };
    command: { mutate(input: ChatCommandRequest): Promise<{ sessionId: string }> };
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
 * stream until somebody looks at the tab again", with the queued release and the
 * attention it was carrying frozen behind it. The timer beside it is what keeps
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

export interface ChatSessionTransport {
  rpc: ChatSessionRpc;
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
    /** Skill slugs to inject at attach time. Absent means none. */
    skills?: readonly string[];
  }): Promise<{ sessionId: string }>;
  attachSession(input: { operationId: string; sessionId: string }): Promise<ProductSessionResult>;
}

export interface ChatSessionClientDeps extends ChatSessionTransport {
  store: ChatSessionStore;
}

export type ProductSessionResult = SessionStartResult;

/** The app's transport. Built per call; the RPC client underneath is a singleton. */
export function browserChatTransport(): ChatSessionTransport {
  const rpc = sessionRpcClient();
  return {
    rpc,
    scheduler: racingFlushScheduler(window),
    newCommandId: () => crypto.randomUUID(),
    // One procedure per verb: the nullable ticketId IS the Role on create,
    // and an attach needs no Role at all — the server owns the Session's
    // durable state, so nothing here re-derives what it already knows.
    createSession: (input) =>
      rpc.sessions.create.mutate({
        operationId: input.operationId,
        projectId: input.projectId,
        ticketId: input.ticketId,
        title: input.title,
        ...(input.skills === undefined ? {} : { skills: [...input.skills] }),
      }),
    attachSession: (input) =>
      rpc.sessions.attach.mutate({
        operationId: input.operationId,
        sessionId: input.sessionId,
      }),
  };
}

export class ChatSessionClient {
  readonly sessionId: string;

  readonly #rpc: ChatSessionRpc;
  readonly #store: ChatSessionStore;
  readonly #scheduler: FlushScheduler;
  readonly #newCommandId: () => string;
  readonly #attachSession: ChatSessionTransport["attachSession"];
  readonly #detachStore: () => void;

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
  #lastEventId: string | null = null;
  /**
   * Which open owns the stream. Bumped by every reconnect and by dispose, so a
   * snapshot that resolves after the surface moved on cannot seed a second
   * subscription onto the one that replaced it.
   */
  #generation = 0;
  /** One reconnect per stream that actually started — see {@link #dropped}. */
  #reconnectable = false;
  #projectionRefresh: Promise<void> | null = null;
  #projectionQueued = false;
  #draining = false;
  /** Queue ids owned by either an explicit persisted steer or resident drain. */
  readonly #claimedQueued = new Set<string>();

  constructor(sessionId: string, deps: ChatSessionClientDeps) {
    this.sessionId = sessionId;
    this.#rpc = deps.rpc;
    this.#store = deps.store;
    this.#scheduler = deps.scheduler;
    this.#newCommandId = deps.newCommandId;
    this.#attachSession = deps.attachSession;
    // The queue's release rule reads lifecycle and the durable projection, and
    // any of the three can move without this client having touched it — a person
    // picking a model is enough. Watching the store is what makes one rule
    // answer all of them.
    this.#detachStore = deps.store.subscribe(() => {
      void this.#drain();
    });
  }

  /**
   * Opens the Session stream, replacing whatever was open.
   *
   * The snapshot is the one read that genuinely wants frames: a surface opening
   * on a Session with history has no other way to get it. Everything after it
   * arrives as deltas.
   */
  async connect(): Promise<void> {
    await this.#open(null);
  }

  /**
   * Stops the resident release loop from taking one queued message while the
   * renderer first makes its crash-safe held copy durable.
   */
  claimQueued(id: string): boolean {
    const queued = this.#slice()?.queue.some((entry) => entry.id === id) ?? false;
    if (!queued || this.#claimedQueued.has(id)) return false;
    this.#claimedQueued.add(id);
    return true;
  }

  /** Hands an unconsumed claim back to the ordinary ordered release loop. */
  releaseQueuedClaim(id: string): void {
    if (!this.#claimedQueued.delete(id)) return;
    void this.#drain();
  }

  /**
   * Consumes a claim and its queue row in one synchronous turn, before an
   * explicit steer is submitted.
   */
  dequeueClaimed(id: string): boolean {
    if (!this.#claimedQueued.has(id)) return false;
    const queued = this.#slice()?.queue.some((entry) => entry.id === id) ?? false;
    if (!queued) return false;
    this.#claimedQueued.delete(id);
    this.#writes().dequeue(this.sessionId, id);
    return true;
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
  async retryAttach(): Promise<boolean> {
    const slice = this.#slice();
    if (slice === undefined || slice.lifecycle === "starting" || slice.projection === null) {
      return false;
    }
    this.#writes().attaching(this.sessionId);
    void this.connect();
    try {
      const attached = await this.#attachSession({
        operationId: this.#newCommandId(),
        sessionId: this.sessionId,
      });
      const refusal = rejectedReceipt(attached);
      const failure =
        attached.state === "ready" && refusal === null
          ? null
          : (refusal ?? "attachment needs recovery");
      this.#writes().settle(
        this.sessionId,
        failure === null ? null : `Could not start Session: ${failure}`,
      );
      return failure === null;
    } catch (failure) {
      this.#writes().settle(this.sessionId, `Could not start Session: ${errorMessage(failure)}`);
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
   * Sends one message.
   *
   * The result is the point: a caller chaining a second act onto the first — a
   * redirection after the refusal it belongs to, a composer deciding whether it
   * is still holding the only copy — cannot read that off the error state,
   * which is state and not a result. See {@link MessageDelivery} for why two
   * kinds of failure are not one.
   */
  async submit(message: QueuedMessage, delivery: ChatMessageDelivery): Promise<MessageDelivery> {
    const slice = this.#slice();
    const body = message.text.trim();
    if (slice === undefined || !isDeliverable(slice) || body.length === 0) return "refused";
    try {
      // The message-scoped resource channel (VC-49): each skill body the text's
      // `/slug` references resolved to travels as its own typed part BESIDE the
      // text, never spliced into it — the durable artifact records both halves,
      // the transcript renders the text verbatim with a chip per resource, and
      // the adapter appends the delimited RESOURCE blocks after the text when
      // it composes the delivered prompt.
      const wireMessage = {
        id: message.id,
        role: "user" as const,
        parts: [
          { type: "text" as const, text: body },
          ...(message.resources ?? []).map(skillResourcePart),
        ],
      };
      const command: ChatCommand = { kind: "message.submit", message: wireMessage, delivery };
      const delivered = await this.#rpc.session.command.mutate({
        commandId: message.id,
        sessionId: this.sessionId,
        command,
      });
      // A harness that cannot take a message says so in its receipt rather than
      // by throwing, and that receipt is the failure. It is also proof the
      // round trip completed, which means the runtime committed the intent and
      // the transcript artifact before it ever asked the executor — so the
      // words are recorded, not lost.
      const refusal = rejectedReceipt(delivered);
      if (refusal !== null) {
        this.#writes().settle(this.sessionId, `Message not delivered: ${refusal}`);
        return "recorded";
      }
      this.#writes().delivered(this.sessionId, slice.transcript.turnEpoch);
      // The first accepted message — direct or released off the queue, this is
      // the one choke point both go through — is the moment a Session gains a
      // subject. Fire-and-forget: a failed rename costs a toast (renameChatSession
      // already surfaces one), never the message that just landed.
      this.#autoTitle(body);
      return "delivered";
    } catch (failure) {
      this.#writes().settle(this.sessionId, `Message not delivered: ${errorMessage(failure)}`);
      return "refused";
    }
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
    this.#generation += 1;
    this.#streamAlive = false;
    this.#cancelFlush?.();
    this.#cancelFlush = null;
    this.#frames.clear();
    this.#overlays = [];
    this.#subscription?.unsubscribe();
    this.#subscription = null;
    this.#detachStore();
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
    this.#subscription?.unsubscribe();
    this.#subscription = null;
    this.#reconnectable = false;
    try {
      let afterSequence = this.#slice()?.transcript.throughSequence ?? 0;
      if (cursor === null) {
        const snapshot = await this.#rpc.session.snapshot.query({ sessionId: this.sessionId });
        if (this.#stale(generation)) return false;
        this.#writes().applyStream(this.sessionId, readFrames(snapshot.frames), []);
        this.#writes().setProjection(this.sessionId, snapshot.projection);
        afterSequence = snapshot.throughSequence;
      }
      this.#subscription = this.#rpc.session.subscribe.subscribe(
        // The cursor rides alongside the sequence rather than instead of it: the
        // router resumes from whichever is further on, and an overlay id — which
        // is a durable sequence, not a suffixed one — is safe to hand back.
        cursor === null
          ? { sessionId: this.sessionId, afterSequence }
          : { sessionId: this.sessionId, afterSequence, lastEventId: cursor },
        {
          onStarted: () => {
            this.#reconnectable = true;
            this.#streamAlive = true;
          },
          onData: (event) => {
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
    if (!this.#reconnectable) {
      this.#lost(failure);
      return;
    }
    this.#reconnectable = false;
    void this.#open(this.#lastEventId);
  }

  #lost(failure: unknown): void {
    this.#writes().settle(this.sessionId, `Lost the Session stream: ${errorMessage(failure)}`);
  }

  #receive(emission: unknown): void {
    const overlay = chatSessionOverlay(emission);
    if (overlay !== null) {
      this.#overlays.push(overlay);
    } else {
      const frame = chatSessionFrame(emission);
      if (frame === null) return;
      this.#frames.set(frame.sequence, frame);
      // Not gated behind the paint, unlike the fold below. A permission ask
      // reaches the user through the projection, and a Session that stopped to
      // ask must not wait on a frame callback an occluded window is seconds away
      // from running.
      if (movesProjection(frame)) this.#refreshProjection();
    }
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
    this.#frames.clear();
    this.#overlays = [];
    this.#writes().applyStream(this.sessionId, frames, overlays);
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

  /* -------------------------------------------------------------- the queue */

  /**
   * Drains the queue, one message at a time.
   *
   * The rule the composer used to own, moved to the only thing that survives the
   * view: a queued message written while the runtime was still coming up has to
   * leave when it is ready, and closing the tab in between must not strand it.
   *
   * `#draining` is the latch, and it is a boolean rather than the released id it
   * replaced because the loop is what enforces one at a time: each pass waits for
   * its own send to land, and a delivered message has already made the Session
   * busy by the time the next pass reads it. An id latch could not, because the
   * store write that empties the queue re-enters this synchronously.
   */
  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (;;) {
        const slice = this.#slice();
        // The Session can close mid-release; the words went with it.
        if (slice === undefined) return;
        // An explicit steer freezes the whole ordered queue while its selected
        // row becomes durable. Releasing an earlier neighbor here would start
        // a different turn and make the selected row steer the wrong work.
        if (this.#claimedQueued.size > 0) return;
        const next = nextRelease(slice.queue, {
          working: slice.lifecycle === "working",
          // A failure is explicit recovery, not a reason to keep feeding a
          // harness that just refused the last thing it was handed.
          ready: slice.lifecycle !== "error" && isDeliverable(slice),
        });
        if (next === null) return;
        this.#claimedQueued.add(next.id);
        let outcome: MessageDelivery;
        try {
          outcome = await this.submit(next, "queue");
          if (outcome !== "refused") this.#writes().dequeue(this.sessionId, next.id);
        } finally {
          this.#claimedQueued.delete(next.id);
        }
        if (outcome === "refused") return;
      }
    } finally {
      this.#draining = false;
    }
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
   * pill keeps the selection it had, a stopped turn keeps running. A toast
   * names the failure once; latching the band would instead park a Retry that
   * addresses none of them (VC-97).
   *
   * Neither outcome touches the latch. A failure of `interrupt` is not a
   * failure of the Session's plumbing, and a success of it does not repair
   * one either — clearing a latched transport error on an unrelated command's
   * round trip is how a frozen transcript ended up looking healthy.
   */
  async #eventRun(label: string, call: () => Promise<unknown>): Promise<boolean> {
    try {
      const refusal = rejectedReceipt(await call());
      if (refusal !== null) {
        toastError(`${label}: ${refusal}`);
        return false;
      }
      return true;
    } catch (failure) {
      toastError(`${label}: ${errorMessage(failure)}`);
      return false;
    }
  }

  /**
   * Retitles this Session from a just-delivered message, if nothing has named
   * it yet. A non-null title was explicitly set by a person, including one
   * that happens to read `Chat 1`, so automatic naming never replaces it.
   */
  #autoTitle(body: string): void {
    const title = this.#slice()?.projection?.session.title ?? null;
    if (!isUntitledChatSession(title)) return;
    // `body` is `submit`'s own trimmed, non-empty text — at least one visible
    // line survives it, so `autoTitleFromMessage` can never read null here.
    void renameChatSession(this.sessionId, autoTitleFromMessage(body)!);
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

/** A snapshot's frames, with anything malformed dropped rather than drawn. */
function readFrames(frames: readonly unknown[]): ChatSessionFrame[] {
  return frames.flatMap((frame) => {
    const normalized = chatSessionFrame(frame);
    return normalized === null ? [] : [normalized];
  });
}
