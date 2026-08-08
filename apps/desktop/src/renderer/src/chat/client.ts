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
import { errorMessage } from "@volli/shared";
import type {
  RuntimeSelection,
  SessionInteractionResolution,
  SessionProjection,
} from "@volli/shared";
import type { UIMessage } from "ai";

import { autoTitleFromMessage, isDefaultChatTitle, renameChatSession } from "@renderer/chat/rename";
import { nextRelease, type QueuedMessage } from "@renderer/chat/session-model";
import {
  movesProjection,
  type ChatSessionFrame,
  type ChatTranscriptState,
} from "@renderer/chat/transcript";
import {
  chatSessionFrame,
  chatSessionOverlay,
  rejectedReceipt,
  startFailure,
} from "@renderer/chat/wire";
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";

/**
 * What a Session's plumbing is doing, as a surface has to draw it.
 *
 * There is no `idle`: a slice exists only once a Session is durable, so the
 * absence of one is that state and the store already says it by omission.
 */
export type ChatSessionLifecycle = "starting" | "ready" | "working" | "error";

export type ChatMessageDelivery = "queue" | "steer" | "replace";

/** Which harness a Session attaches, and under which profile. */
export interface ChatExecutorChoice {
  adapterId: string;
  profileId: string;
}

export const DEFAULT_CHAT_EXECUTOR: ChatExecutorChoice = {
  adapterId: "opencode",
  profileId: "native",
};

// Ticket Sessions attach the singular Pi-backed Agent Runtime; scratch/project
// chats stay on the OpenCode default until their own migration slice.
export const PI_TICKET_EXECUTOR: ChatExecutorChoice = {
  adapterId: "pi",
  profileId: "native",
};

export const EMPTY_CHAT_SELECTION: RuntimeSelection = {
  providerId: "",
  modelId: "",
  variant: "",
  agent: "",
};

/**
 * One Session's resident state.
 *
 * The runtime catalog is deliberately absent. Which models exist is a question
 * about a harness, asked and re-asked by whatever is on screen; only the answer
 * a person picked belongs to the Session, and that is `selection`.
 */
export interface ChatSessionSlice {
  projection: SessionProjection | null;
  transcript: ChatTranscriptState;
  lifecycle: ChatSessionLifecycle;
  /**
   * The one thing about a Session's plumbing a person needs told — a failure
   * that stopped their typing. Everything else the transport knows has no
   * honest home in a chat.
   */
  sessionError: string | null;
  queue: readonly QueuedMessage[];
  selection: RuntimeSelection;
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
 */
export function isDeliverable(slice: ChatSessionSlice): boolean {
  return (slice.projection?.liveExecutor ?? null) !== null && slice.selection.modelId.length > 0;
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
  setProjection(sessionId: string, projection: SessionProjection): void;
  /** An attachment attempt is in flight; nothing derives lifecycle until it lands. */
  attaching(sessionId: string): void;
  /** The harness took a message; the turn is live until the stream says otherwise. */
  delivered(sessionId: string): void;
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
}

type ChatCommand =
  | { kind: "session.create"; projectId: string; ticketId: string | null; title: string | null }
  | { kind: "adapter.attach"; adapterId: string; profileId: string; continuity: "fresh" }
  | {
      kind: "message.submit";
      message: UIMessage;
      delivery: ChatMessageDelivery;
      model: { providerId: string; modelId: string };
      variant: string | null;
      agent: string | null;
    }
  | { kind: "executor.interrupt"; attachmentId?: string }
  | { kind: "interaction.resolve"; interactionId: string; resolution: WireResolution };

export interface ChatCommandRequest {
  commandId: string;
  sessionId?: string;
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
        projection: SessionProjection;
        frames: readonly unknown[];
        throughSequence: number;
      }>;
    };
    projection: {
      query(input: { sessionId: string }): Promise<{ projection: SessionProjection }>;
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
}

export interface ChatSessionClientDeps extends ChatSessionTransport {
  store: ChatSessionStore;
  /** Remembered so a retry re-attaches what was chosen, never a second guess. */
  executor: ChatExecutorChoice;
}

/** The app's transport. Built per call; the RPC client underneath is a singleton. */
export function browserChatTransport(): ChatSessionTransport {
  return {
    rpc: sessionRpcClient(),
    scheduler: racingFlushScheduler(window),
    newCommandId: () => crypto.randomUUID(),
  };
}

export class ChatSessionClient {
  readonly sessionId: string;

  readonly #rpc: ChatSessionRpc;
  readonly #store: ChatSessionStore;
  readonly #scheduler: FlushScheduler;
  readonly #newCommandId: () => string;
  readonly #executor: ChatExecutorChoice;
  readonly #detachStore: () => void;

  #subscription: { unsubscribe(): void } | null = null;
  #cancelFlush: (() => void) | null = null;
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

  constructor(sessionId: string, deps: ChatSessionClientDeps) {
    this.sessionId = sessionId;
    this.#rpc = deps.rpc;
    this.#store = deps.store;
    this.#scheduler = deps.scheduler;
    this.#newCommandId = deps.newCommandId;
    this.#executor = deps.executor;
    // The queue's release rule reads lifecycle, projection and selection, and
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
  connect(): Promise<void> {
    return this.#open(null);
  }

  /**
   * One attachment attempt on the durable Session this client owns.
   *
   * A refusal is a completed round trip carrying a rejected receipt; a transport
   * failure is an exception. Neither un-creates the Session, so both land on the
   * same error and the id is never at risk.
   */
  async attach(): Promise<boolean> {
    try {
      const attached = await this.#rpc.session.command.mutate({
        commandId: this.#newCommandId(),
        sessionId: this.sessionId,
        command: {
          kind: "adapter.attach",
          adapterId: this.#executor.adapterId,
          profileId: this.#executor.profileId,
          continuity: "fresh",
        },
      });
      const refusal = rejectedReceipt(attached);
      this.#writes().settle(this.sessionId, refusal === null ? null : startFailure(refusal));
      return refusal === null;
    } catch (failure) {
      this.#writes().settle(this.sessionId, startFailure(errorMessage(failure)));
      return false;
    }
  }

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
    if (slice === undefined || slice.lifecycle === "starting") return false;
    this.#writes().attaching(this.sessionId);
    void this.connect();
    return this.attach();
  }

  /**
   * One action, and working out which one is not the user's problem.
   *
   * A live attachment that stopped answering is reconciled; a durable Session
   * with no executor is re-attached. Starting over is not here at all — minting
   * a Session is the store's job, and reaching for it from a client that already
   * has one would duplicate it.
   */
  recover(): Promise<boolean> {
    const slice = this.#slice();
    if (slice === undefined) return Promise.resolve(false);
    return (slice.projection?.liveExecutor ?? null) === null
      ? this.retryAttach()
      : this.reconcile();
  }

  /**
   * Sends one message.
   *
   * The boolean is the point: a caller chaining a second act onto the first — a
   * redirection after the refusal it belongs to — cannot read that off the error
   * state, which is state and not a result. The words stay in the composer until
   * this returns true.
   */
  async submit(text: string, delivery: ChatMessageDelivery): Promise<boolean> {
    const slice = this.#slice();
    const body = text.trim();
    if (slice === undefined || !isDeliverable(slice) || body.length === 0) return false;
    try {
      const delivered = await this.#rpc.session.command.mutate({
        commandId: this.#newCommandId(),
        sessionId: this.sessionId,
        command: {
          kind: "message.submit",
          message: {
            id: this.#newCommandId(),
            role: "user",
            parts: [{ type: "text", text: body }],
          },
          delivery,
          model: {
            providerId: slice.selection.providerId,
            modelId: slice.selection.modelId,
          },
          variant: slice.selection.variant || null,
          agent: slice.selection.agent || null,
        },
      });
      // A harness that cannot take a message says so in its receipt rather than
      // by throwing, and that receipt is the failure.
      const refusal = rejectedReceipt(delivered);
      if (refusal !== null) {
        this.#writes().settle(this.sessionId, `Message not delivered: ${refusal}`);
        return false;
      }
      this.#writes().delivered(this.sessionId);
      // The first accepted message — direct or released off the queue, this is
      // the one choke point both go through — is the moment a Session gains a
      // subject. Fire-and-forget: a failed rename costs a toast (renameChatSession
      // already surfaces one), never the message that just landed.
      this.#autoTitle(body);
      return true;
    } catch (failure) {
      this.#writes().settle(this.sessionId, `Message not delivered: ${errorMessage(failure)}`);
      return false;
    }
  }

  interrupt(): Promise<boolean> {
    const attachmentId = this.#liveAttachmentId();
    return this.#run("Interrupt", () =>
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
    return this.#run("Decision not delivered", () =>
      this.#rpc.session.command.mutate({
        commandId: this.#newCommandId(),
        sessionId: this.sessionId,
        command: { kind: "interaction.resolve", interactionId, resolution: wire(resolution) },
      }),
    );
  }

  /** Withdraws a decision nobody is going to make, so the card stops blocking. */
  cancelInteraction(interactionId: string): Promise<boolean> {
    return this.#run("Decision not cancelled", () =>
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
    this.#cancelFlush?.();
    this.#cancelFlush = null;
    this.#frames.clear();
    this.#overlays = [];
    this.#subscription?.unsubscribe();
    this.#subscription = null;
    this.#detachStore();
  }

  /* ------------------------------------------------------------- the stream */

  async #open(cursor: string | null): Promise<void> {
    const generation = (this.#generation += 1);
    this.#subscription?.unsubscribe();
    this.#subscription = null;
    this.#reconnectable = false;
    try {
      let afterSequence = this.#slice()?.transcript.throughSequence ?? 0;
      if (cursor === null) {
        const snapshot = await this.#rpc.session.snapshot.query({ sessionId: this.sessionId });
        if (this.#stale(generation)) return;
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
          },
          onData: (event) => {
            this.#lastEventId = event.id;
            this.#receive(event.data);
          },
          onError: (failure) => {
            this.#dropped(failure);
          },
        },
      );
    } catch (failure) {
      if (this.#stale(generation)) return;
      this.#lost(failure);
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
   * view: a queued message written while OpenCode was still coming up has to
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
        const next = nextRelease(slice.queue, {
          working: slice.lifecycle === "working",
          // A failure is explicit recovery, not a reason to keep feeding a
          // harness that just refused the last thing it was handed.
          ready: slice.lifecycle !== "error" && isDeliverable(slice),
        });
        if (next === null) return;
        this.#writes().dequeue(this.sessionId, next.id);
        await this.submit(next.text, "queue");
      }
    } finally {
      this.#draining = false;
    }
  }

  /* ------------------------------------------------------------- the shared */

  /**
   * One command, and whether it landed.
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
   * Retitles this Session from a just-delivered message, if nothing has named
   * it yet. A null projection has no title to read and skips; a title a
   * person (or an earlier delivery) already gave it is left alone — the
   * default predicate is the only guard this needs.
   */
  #autoTitle(body: string): void {
    const title = this.#slice()?.projection?.session.title ?? null;
    if (title === null || !isDefaultChatTitle(title)) return;
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
