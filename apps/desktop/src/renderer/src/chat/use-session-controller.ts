/**
 * One Session, bound for React.
 *
 * Deliberately empty of rules. Everything a chat Session decides — what a
 * lifecycle means, when a queued message leaves, which recovery a failure
 * earns — belongs to the resident client and the store, both of which outlive
 * every view and are tested without one. What is left here is the binding: the
 * fields a component re-renders on — one subscription each, see
 * {@link SessionView} — and actions addressed to one Session id.
 *
 * The client is looked up rather than created, and a lookup that misses answers
 * `false`. A surface can outlive its Session by a frame — a close and a
 * keystroke can land in either order — and that is not a reason to mint a client
 * with no stream behind it.
 */
import * as React from "react";
import type {
  ModelSelection,
  RendererSessionInteraction,
  SessionInteractionResolution,
  SessionPresentationProjection,
} from "@volli/shared";
import type { UIMessage } from "ai";
import { useStore, type StoreApi } from "zustand";

import {
  getChatClient,
  isDeliverable,
  type ChatMessageDelivery,
  type LiveTranscriptCompaction,
  type MessageDelivery,
  type QueuedMessage,
  type TranscriptCompaction,
} from "@volli/session-presentation";
import { useChatSessionsStore, type ChatSessionsState } from "@renderer/stores/chat-sessions";

const NO_MESSAGES: readonly UIMessage[] = [];
const NO_QUEUE: readonly QueuedMessage[] = [];
const NO_OPENED: ReadonlyMap<string, RendererSessionInteraction> = new Map();
const NO_PROMPT_RESOURCES: readonly string[] = [];
const NO_COMPACTIONS: readonly TranscriptCompaction[] = [];
const NO_LIVE_COMPACTION: LiveTranscriptCompaction | null = null;

/**
 * One Session's resident state, read field by field.
 *
 * NOT the `ChatSessionSlice` itself, and the difference is the whole point of
 * this type. A live turn re-writes its slice once per animation frame — the
 * transcript grows, `turnActive` and `turnEpoch` move — and a component
 * subscribed to the slice re-rendered on every one of those, whether or not it
 * draws a transcript. The composer, the model pill and the blocker row all did,
 * once per frame, under the hand that was typing.
 *
 * So each field is its own subscription, and the two questions read as booleans
 * are stored as booleans: `working` and `deliverable` derive from objects that
 * are replaced wholesale on every projection refresh, and a boolean that did not
 * flip is a subscription that does not fire. `turnActive` and `turnEpoch` are
 * absent because no view reads them from here — the two callbacks that need an
 * epoch read it from `getState()` at the moment they act, which is the only
 * moment its value is meaningful.
 */
export interface SessionView {
  /** `null` until the Session's first durable snapshot arrives. */
  projection: SessionPresentationProjection | null;
  messages: readonly UIMessage[];
  /**
   * The settled transcript only — no live overlay. Its identity moves once
   * per settle rather than once per streamed frame, which is what lets the
   * context meter memoize on it without joining the stream's frame budget.
   */
  durableMessages: readonly UIMessage[];
  /** Every interaction opened this Session, for the receipts they left behind. */
  openedInteractions: ReadonlyMap<string, RendererSessionInteraction>;
  /** The Session's lifecycle is `working` — a turn is live. */
  working: boolean;
  /** A message typed now could actually leave — see {@link isDeliverable}. */
  deliverable: boolean;
  /** The one thing about a Session's plumbing a person needs told. */
  sessionError: string | null;
  queue: readonly QueuedMessage[];
  /**
   * The skills this Session was started with — the durable `prompt-resources`
   * record's names, folded off the stream. The injection itself lives in the
   * system prompt, which no transcript message shows, so this is what lets the
   * chat surface say it happened.
   */
  promptResources: readonly string[];
  /**
   * Every compaction this Session has been through, each pinned to the message
   * it happened after — what the transcript draws its boundaries from. Its own
   * subscription for the reason all of these are: it moves once or twice in a
   * Session, where the transcript beside it moves every frame.
   */
  compactions: readonly TranscriptCompaction[];
  /** The summary currently being generated, absent once its durable result lands. */
  liveCompaction: LiveTranscriptCompaction | null;
}

export interface SessionController {
  /** Empty rather than absent for a Session this surface no longer has. */
  session: SessionView;
  selectModel(selection: ModelSelection): Promise<boolean>;
  enqueue(message: QueuedMessage): void;
  dequeue(id: string): void;
  /** Freezes resident queue release while an explicit steer becomes durable. */
  claimQueued(id: string): boolean;
  /** Resumes ordinary ordered release after an explicit steer aborts. */
  releaseQueuedClaim(id: string): void;
  /** Consumes the claimed row immediately before explicit submission. */
  dequeueClaimed(id: string): boolean;
  submit(message: QueuedMessage, delivery: ChatMessageDelivery): Promise<MessageDelivery>;
  interrupt(): Promise<boolean>;
  resolveInteraction(
    interactionId: string,
    resolution: SessionInteractionResolution,
  ): Promise<boolean>;
  cancelInteraction(interactionId: string): Promise<boolean>;
  /** The single action an error row offers; which one it is is the client's call. */
  recover(): Promise<boolean>;
  retryRuntime(): Promise<boolean>;
  /** Clears the error band — see {@link ChatSessionClient.dismissError}. */
  dismissError(): void;
  /** Summarize the context now, on explicit request. False means it did not. */
  compactContext(instructions: string | null): Promise<boolean>;
  close(): void;
}

/**
 * The store this binding writes to. The app has exactly one; the parameter is
 * for a surface that owns its own instance because it owns its own transport —
 * the UI lab, which drives these components over HTTP instead of Session IPC.
 * The registry underneath is shared either way: a client is found by Session id,
 * whichever store it writes back to.
 */
export type ChatSessionsStore = StoreApi<ChatSessionsState>;

export function useSessionController(
  sessionId: string,
  store: ChatSessionsStore = useChatSessionsStore,
): SessionController {
  // Eight subscriptions rather than one, for the reason {@link SessionView}
  // spells out. Each selector returns a field the store already holds or a
  // boolean derived from one, so none of them mints a value: a selector that
  // built an object here would fire on every write and undo the whole exercise.
  const projection = useStore(store, (state) => state.sessions[sessionId]?.projection ?? null);
  const messages = useStore(
    store,
    (state) => state.sessions[sessionId]?.transcript.messages ?? NO_MESSAGES,
  );
  const durableMessages = useStore(
    store,
    (state) => state.sessions[sessionId]?.transcript.durableMessages ?? NO_MESSAGES,
  );
  const openedInteractions = useStore(
    store,
    (state) => state.sessions[sessionId]?.transcript.openedInteractions ?? NO_OPENED,
  );
  const working = useStore(store, (state) => state.sessions[sessionId]?.lifecycle === "working");
  const deliverable = useStore(store, (state) => {
    const slice = state.sessions[sessionId];
    return slice !== undefined && isDeliverable(slice);
  });
  const sessionError = useStore(store, (state) => state.sessions[sessionId]?.sessionError ?? null);
  const queue = useStore(store, (state) => state.sessions[sessionId]?.queue ?? NO_QUEUE);
  const promptResources = useStore(
    store,
    (state) => state.sessions[sessionId]?.transcript.promptResources ?? NO_PROMPT_RESOURCES,
  );
  const compactions = useStore(
    store,
    (state) => state.sessions[sessionId]?.transcript.compactions ?? NO_COMPACTIONS,
  );
  const liveCompaction = useStore(
    store,
    (state) => state.sessions[sessionId]?.transcript.liveCompaction ?? NO_LIVE_COMPACTION,
  );

  const session = React.useMemo<SessionView>(
    () => ({
      projection,
      messages,
      durableMessages,
      openedInteractions,
      working,
      deliverable,
      sessionError,
      queue,
      promptResources,
      compactions,
      liveCompaction,
    }),
    [
      compactions,
      deliverable,
      durableMessages,
      liveCompaction,
      messages,
      openedInteractions,
      projection,
      promptResources,
      queue,
      sessionError,
      working,
    ],
  );
  const actions = React.useMemo(() => bind(sessionId, store), [sessionId, store]);
  return { session, ...actions };
}

function bind(sessionId: string, store: ChatSessionsStore): Omit<SessionController, "session"> {
  const refused = Promise.resolve(false);
  return {
    selectModel: (selection) => getChatClient(sessionId)?.selectModel(selection) ?? refused,
    enqueue: (message) => {
      store.getState().enqueue(sessionId, message);
    },
    dequeue: (id) => {
      store.getState().dequeue(sessionId, id);
    },
    claimQueued: (id) => getChatClient(sessionId)?.claimQueued(id) ?? false,
    releaseQueuedClaim: (id) => {
      getChatClient(sessionId)?.releaseQueuedClaim(id);
    },
    dequeueClaimed: (id) => getChatClient(sessionId)?.dequeueClaimed(id) ?? false,
    // A lookup that misses is a Session this surface no longer has: nothing was
    // sent and nothing is durable, which is exactly `refused`.
    submit: (message, delivery) =>
      getChatClient(sessionId)?.submit(message, delivery) ?? Promise.resolve("refused" as const),
    interrupt: () => getChatClient(sessionId)?.interrupt() ?? refused,
    resolveInteraction: (interactionId, resolution) =>
      getChatClient(sessionId)?.resolveInteraction(interactionId, resolution) ?? refused,
    cancelInteraction: (interactionId) =>
      getChatClient(sessionId)?.cancelInteraction(interactionId) ?? refused,
    recover: () => getChatClient(sessionId)?.recover() ?? refused,
    retryRuntime: () => getChatClient(sessionId)?.retryRuntime() ?? refused,
    // No client is no band: there is nothing on screen asking to be dismissed.
    dismissError: () => {
      getChatClient(sessionId)?.dismissError();
    },
    compactContext: (instructions) =>
      getChatClient(sessionId)?.compactContext(instructions) ?? refused,
    close: () => {
      store.getState().closeChatSession(sessionId);
    },
  };
}
