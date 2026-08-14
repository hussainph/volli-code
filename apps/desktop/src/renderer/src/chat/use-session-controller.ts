/**
 * One Session, bound for React.
 *
 * Deliberately empty of rules. Everything a chat Session decides — what a
 * lifecycle means, when a queued message leaves, which recovery a failure
 * earns — belongs to the resident client and the store, both of which outlive
 * every view and are tested without one. What is left here is the binding: the
 * slice a component re-renders on, and actions addressed to one Session id.
 *
 * The client is looked up rather than created, and a lookup that misses answers
 * `false`. A surface can outlive its Session by a frame — a close and a
 * keystroke can land in either order — and that is not a reason to mint a client
 * with no stream behind it.
 */
import * as React from "react";
import type { ModelSelection, SessionInteractionResolution } from "@volli/shared";
import { useStore, type StoreApi } from "zustand";

import { getChatClient } from "@renderer/chat/registry";
import type { ChatMessageDelivery, ChatSessionSlice, MessageDelivery } from "@renderer/chat/client";
import type { QueuedMessage } from "@renderer/chat/session-model";
import { useChatSessionsStore, type ChatSessionsState } from "@renderer/stores/chat-sessions";

export interface SessionController {
  /** `undefined` until the Session is durable, and again once it is closed. */
  session: ChatSessionSlice | undefined;
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
  const session = useStore(store, (state) => state.sessions[sessionId]);
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
    close: () => {
      store.getState().closeChatSession(sessionId);
    },
  };
}
