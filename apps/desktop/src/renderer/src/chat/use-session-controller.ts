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
import type { RuntimeSelection, SessionInteractionResolution } from "@volli/shared";
import { useStore, type StoreApi } from "zustand";

import { getChatClient } from "@renderer/chat/registry";
import {
  DEFAULT_CHAT_EXECUTOR,
  sessionAdapterId,
  type ChatMessageDelivery,
  type ChatSessionSlice,
} from "@renderer/chat/client";
import type { QueuedMessage } from "@renderer/chat/session-model";
import { useChatSessionsStore, type ChatSessionsState } from "@renderer/stores/chat-sessions";

export interface SessionController {
  /** `undefined` until the Session is durable, and again once it is closed. */
  session: ChatSessionSlice | undefined;
  /**
   * Which executor this Session runs — the one thing about a Session a surface
   * has to know before it can say what the composer is even waiting for.
   */
  adapterId: string;
  setSelection(selection: RuntimeSelection): void;
  enqueue(message: QueuedMessage): void;
  dequeue(id: string): void;
  submit(text: string, delivery: ChatMessageDelivery): Promise<boolean>;
  interrupt(): Promise<boolean>;
  resolveInteraction(
    interactionId: string,
    resolution: SessionInteractionResolution,
  ): Promise<boolean>;
  cancelInteraction(interactionId: string): Promise<boolean>;
  /** The single action an error row offers; which one it is is the client's call. */
  recover(): Promise<boolean>;
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
  // Read per render rather than memoized: the durable answer arrives with the
  // first snapshot, and until then the client's own choice is standing in for it.
  const adapterId = sessionAdapterId(
    session,
    getChatClient(sessionId)?.executor ?? DEFAULT_CHAT_EXECUTOR,
  );
  return { session, adapterId, ...actions };
}

function bind(
  sessionId: string,
  store: ChatSessionsStore,
): Omit<SessionController, "session" | "adapterId"> {
  const refused = Promise.resolve(false);
  return {
    setSelection: (selection) => {
      store.getState().setSelection(sessionId, selection);
    },
    enqueue: (message) => {
      store.getState().enqueue(sessionId, message);
    },
    dequeue: (id) => {
      store.getState().dequeue(sessionId, id);
    },
    submit: (text, delivery) => getChatClient(sessionId)?.submit(text, delivery) ?? refused,
    interrupt: () => getChatClient(sessionId)?.interrupt() ?? refused,
    resolveInteraction: (interactionId, resolution) =>
      getChatClient(sessionId)?.resolveInteraction(interactionId, resolution) ?? refused,
    cancelInteraction: (interactionId) =>
      getChatClient(sessionId)?.cancelInteraction(interactionId) ?? refused,
    recover: () => getChatClient(sessionId)?.recover() ?? refused,
    close: () => {
      store.getState().closeChatSession(sessionId);
    },
  };
}
