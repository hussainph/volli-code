/**
 * The resident state of every open chat Session, projected from its stream.
 *
 * A Session is durable and owns its identity before any adapter attaches, so
 * this store never mints one on the side: {@link ChatSessionsState.createChatSession}
 * persists the intent over the Session edge and seeds a slice against the id
 * that comes back, and everything after it addresses that id. A failed attach
 * leaves the Session in the ledger with the error beside it, which is why the id
 * survives one.
 *
 * The store holds state and applies writes; it does not own a stream. That is
 * {@link ChatSessionClient}'s, one per Session, kept in the chat registry so it
 * outlives every view — the store's three lifecycle actions are the whole of
 * what a client asks of it, plus the fold.
 */
import { errorMessage } from "@volli/shared";
import type { RuntimeSelection } from "@volli/shared";
import { create } from "zustand";

import {
  browserChatTransport,
  isWorking,
  settledLifecycle,
  DEFAULT_CHAT_EXECUTOR,
  EMPTY_CHAT_SELECTION,
  type ChatExecutorChoice,
  type ChatSessionLifecycle,
  type ChatSessionSlice,
  type ChatSessionTransport,
  type ChatSessionWrites,
} from "@renderer/chat/client";
import { disposeChatClient, getOrCreateChatClient } from "@renderer/chat/registry";
import { enqueueMessage, removeQueued, type QueuedMessage } from "@renderer/chat/session-model";
import { appendFrames, EMPTY_TRANSCRIPT } from "@renderer/chat/transcript";
import { startFailure } from "@renderer/chat/wire";
import { toastError } from "@renderer/lib/toast";

export interface CreateChatSessionInput {
  projectId: string;
  ticketId: string | null;
  title: string | null;
  executor?: ChatExecutorChoice;
}

export interface ChatSessionsState extends ChatSessionWrites {
  /**
   * Mints one durable Session and attaches its first executor, resolving the id.
   *
   * `null` means there is no Session: only `session.create` failing gets there,
   * and it is the one failure with no slice to carry it. A failed *attach*
   * resolves the id — the Session exists, it simply has no executor yet, and
   * `retryAttach` addresses it rather than making another.
   */
  createChatSession(input: CreateChatSessionInput): Promise<string | null>;
  /** Attaches a client to a Session that is already durable — the hydration path. */
  adoptChatSession(sessionId: string, executor?: ChatExecutorChoice): void;
  /** Drops the Session from this surface. The Session itself is untouched. */
  closeChatSession(sessionId: string): void;
  setSelection(sessionId: string, selection: RuntimeSelection): void;
  enqueue(sessionId: string, message: QueuedMessage): void;

  /**
   * Which chat Sessions have a tab open, per ticket.
   *
   * Resident for the reason the client is: a chat view mounts and unmounts
   * freely, and the tabs a person left open are not a fact about whether the
   * ticket detail is on screen. Deliberately NOT persisted — a durable Session
   * is recovered from its own record, and the workspace store's active tab id
   * is the only thing that has to survive a restart.
   */
  openTabs: Readonly<Record<string, readonly string[]>>;
  /** Records a tab for `sessionId`, appending at the end of the ticket's strip. */
  openChatTab(ticketId: string, sessionId: string): void;
  /**
   * Drops the tab and retires the Session's resident state with it. Closing a
   * chat view loses nothing — the Session is durable, and reopening it adopts
   * the same history.
   */
  closeChatTab(ticketId: string, sessionId: string): void;
}

/** Factory so tests get isolated instances (sessions.ts's convention). */
export function createChatSessionsStore(
  transport: () => ChatSessionTransport = browserChatTransport,
) {
  return create<ChatSessionsState>()((set, get, api) => {
    /**
     * Every write lands through here, so a Session that has been closed under a
     * command still in flight is a no-op rather than a resurrected slice.
     */
    const update = (
      sessionId: string,
      change: (slice: ChatSessionSlice) => ChatSessionSlice,
    ): void => {
      set((state) => {
        const slice = state.sessions[sessionId];
        if (slice === undefined) return state;
        const next = change(slice);
        return next === slice ? state : { sessions: { ...state.sessions, [sessionId]: next } };
      });
    };

    const attach = (sessionId: string, executor: ChatExecutorChoice | undefined) =>
      getOrCreateChatClient(sessionId, {
        ...transport(),
        store: api,
        executor: executor ?? DEFAULT_CHAT_EXECUTOR,
      });

    return {
      sessions: {},
      openTabs: {},

      async createChatSession(input) {
        const edge = transport();
        let sessionId: string;
        try {
          const created = await edge.rpc.session.command.mutate({
            commandId: edge.newCommandId(),
            command: {
              kind: "session.create",
              projectId: input.projectId,
              ticketId: input.ticketId,
              title: input.title,
            },
          });
          sessionId = created.sessionId;
        } catch (failure) {
          // The one failure with nothing durable to carry it: there is no id, so
          // there is no slice, so a toast is the only place it can be said.
          toastError(startFailure(errorMessage(failure)));
          return null;
        }
        set((state) => ({ sessions: { ...state.sessions, [sessionId]: seedSlice("starting") } }));
        const client = attach(sessionId, input.executor);
        // Subscribed before the attach rather than after it, so the frames the
        // attach itself commits are not a gap the surface has to re-read.
        void client.connect();
        await client.attach();
        return sessionId;
      },

      // `ready` rather than `starting`, unlike the create above: adopting makes
      // no attachment attempt, so there is nothing in flight for `starting` to
      // name, and the composer is gated by whether an executor is live — which
      // the arriving snapshot answers — and never by this.
      adoptChatSession(sessionId, executor) {
        if (get().sessions[sessionId] !== undefined) return;
        set((state) => ({ sessions: { ...state.sessions, [sessionId]: seedSlice("ready") } }));
        const client = attach(sessionId, executor);
        void client.connect();
      },

      closeChatSession(sessionId) {
        disposeChatClient(sessionId);
        set((state) => {
          if (state.sessions[sessionId] === undefined) return state;
          const sessions = { ...state.sessions };
          delete sessions[sessionId];
          return { sessions };
        });
      },

      applyStream(sessionId, frames, overlays) {
        update(sessionId, (slice) => {
          const transcript = appendFrames(slice.transcript, frames, overlays);
          // `appendFrames` returns what it was handed when a batch had nothing
          // for it, and a fresh slice here would repaint the chat for nothing.
          if (transcript === slice.transcript) return slice;
          const next = { ...slice, transcript };
          return { ...next, lifecycle: settledLifecycle(slice, next) };
        });
      },

      setProjection(sessionId, projection) {
        update(sessionId, (slice) => {
          const next = { ...slice, projection };
          return { ...next, lifecycle: settledLifecycle(slice, next) };
        });
      },

      attaching(sessionId) {
        update(sessionId, (slice) => ({ ...slice, lifecycle: "starting", sessionError: null }));
      },

      delivered(sessionId) {
        update(sessionId, (slice) => ({ ...slice, lifecycle: "working", sessionError: null }));
      },

      settle(sessionId, error) {
        update(sessionId, (slice) =>
          error === null
            ? // Clearing hands the Session back to its stream. What replaces a
              // failure is what the frames already say, not a guess — and while
              // `error` stood, nothing was deriving lifecycle at all.
              {
                ...slice,
                lifecycle: isWorking(slice) ? "working" : "ready",
                sessionError: null,
              }
            : { ...slice, lifecycle: "error", sessionError: error },
        );
      },

      setSelection(sessionId, selection) {
        update(sessionId, (slice) => ({ ...slice, selection }));
      },

      enqueue(sessionId, message) {
        update(sessionId, (slice) => {
          const queue = enqueueMessage(slice.queue, message);
          // Blank text never reaches the queue, and an unchanged queue must not
          // hand the client a store change to re-run its release rule against.
          return queue.length === slice.queue.length ? slice : { ...slice, queue };
        });
      },

      dequeue(sessionId, id) {
        update(sessionId, (slice) => {
          const queue = removeQueued(slice.queue, id);
          return queue.length === slice.queue.length ? slice : { ...slice, queue };
        });
      },

      openChatTab(ticketId, sessionId) {
        set((state) => {
          const tabs = state.openTabs[ticketId] ?? [];
          if (tabs.includes(sessionId)) return state;
          return { openTabs: { ...state.openTabs, [ticketId]: [...tabs, sessionId] } };
        });
      },

      closeChatTab(ticketId, sessionId) {
        // The tab decides, and it decides first: retiring the Session before
        // knowing whether this ticket held a tab for it would dispose the
        // client another ticket's open tab is still drawing from, leaving a tab
        // on screen with nothing behind it.
        const tabs = get().openTabs[ticketId];
        if (tabs === undefined || !tabs.includes(sessionId)) return;
        get().closeChatSession(sessionId);
        const remaining = tabs.filter((candidate) => candidate !== sessionId);
        set((state) => {
          if (remaining.length > 0) {
            return { openTabs: { ...state.openTabs, [ticketId]: remaining } };
          }
          const openTabs = { ...state.openTabs };
          delete openTabs[ticketId];
          return { openTabs };
        });
      },
    };
  });
}

export const useChatSessionsStore = createChatSessionsStore();

function seedSlice(lifecycle: ChatSessionLifecycle): ChatSessionSlice {
  return {
    projection: null,
    transcript: EMPTY_TRANSCRIPT,
    lifecycle,
    sessionError: null,
    queue: [],
    selection: EMPTY_CHAT_SELECTION,
  };
}
