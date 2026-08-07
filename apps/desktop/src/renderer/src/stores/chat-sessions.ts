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
   * Retitles a Session on this surface ahead of its stream.
   *
   * Optimistic, and only that: the title lives on the durable record, so what
   * this writes is overwritten by the next projection the Session commits. It
   * exists so a rename reads instantly rather than at stream latency, exactly
   * as the terminal store's `renameSession` does for a tab. A Session
   * this surface no longer holds is a no-op, and so is one whose projection has
   * not arrived — there is no title to correct yet, and inventing a projection
   * around one would put a Session on screen that nothing has described.
   */
  retitle(sessionId: string, title: string): void;

  /**
   * Owner ids with a chat create in flight — a ticketId for a ticket chat, a
   * projectId for a ticketless one. Its own flag rather than the PTY store's,
   * which is a fact about a pane coming up (see `session-create.ts`).
   */
  starting: Readonly<Record<string, boolean>>;
  setStarting(ownerId: string, starting: boolean): void;

  /**
   * Which chat Sessions have a tab open, per surface owner — a ticketId
   * while its ticket is on the board, the projectId otherwise (a ticketless
   * chat, or one whose ticket left the board), the same owner-id convention
   * `starting` above uses. A Session's tab lives under exactly one owner at a
   * time: `openChatTab` enforces that by stripping the id from every other
   * key before recording it under the new one, and `rehomeChatTabs` moves a
   * whole owner's tabs onto another key (board.ts, when a ticket leaves the
   * board) without ever violating it.
   *
   * Resident for the reason the client is: a chat view mounts and unmounts
   * freely, and the tabs a person left open are not a fact about whether the
   * ticket detail is on screen. Deliberately NOT persisted — a durable Session
   * is recovered from its own record, and the workspace store's active tab id
   * is the only thing that has to survive a restart.
   */
  openTabs: Readonly<Record<string, readonly string[]>>;
  /**
   * Records a tab for `sessionId` under `ownerId`, appending at the end of its
   * strip. First strips the id from every OTHER owner's strip (deleting a
   * strip that empties) — the single-owner invariant `openTabs` documents.
   */
  openChatTab(ownerId: string, sessionId: string): void;
  /**
   * Drops the tab from `ownerId`'s strip and retires the Session's resident
   * state with it. Closing a chat view loses nothing — the Session is durable,
   * and reopening it adopts the same history.
   */
  closeChatTab(ownerId: string, sessionId: string): void;
  /**
   * Moves every tab under each of `fromOwnerIds` onto `toOwnerId` — preserving
   * order, skipping a session id `toOwnerId` already has — and deletes each
   * from-key once emptied. The board's escape hatch for a ticket leaving the
   * board (archived, or deleted): the ticket id no longer names a live
   * surface, so its open chat tabs move to the project instead of vanishing.
   * Tab bookkeeping only — no client is attached, retired, or disposed.
   */
  rehomeChatTabs(fromOwnerIds: readonly string[], toOwnerId: string): void;
  /**
   * Deletes each of `ownerIds`' tab entries outright. Used when a project
   * itself is forgotten — there is no surface left, not even the project, for
   * `rehomeChatTabs` to have moved those tabs onto. Tab bookkeeping only, same
   * as `rehomeChatTabs`.
   */
  dropChatTabs(ownerIds: readonly string[]): void;
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
      starting: {},

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

      retitle(sessionId, title) {
        update(sessionId, (slice) =>
          slice.projection === null
            ? slice
            : {
                ...slice,
                projection: {
                  ...slice.projection,
                  session: { ...slice.projection.session, title },
                },
              },
        );
      },

      setStarting(ownerId, starting) {
        set((state) => {
          if ((state.starting[ownerId] ?? false) === starting) return state;
          const next = { ...state.starting };
          // Cleared by deletion rather than by a `false`, so the map holds only
          // what is actually in flight and never grows a row per owner ever
          // visited.
          if (starting) next[ownerId] = true;
          else delete next[ownerId];
          return { starting: next };
        });
      },

      openChatTab(ownerId, sessionId) {
        set((state) => {
          let strippedElsewhere = false;
          const openTabs: Record<string, readonly string[]> = {};
          for (const [key, tabs] of Object.entries(state.openTabs)) {
            if (key === ownerId || !tabs.includes(sessionId)) {
              openTabs[key] = tabs;
              continue;
            }
            // The single-owner invariant `openTabs` documents: forget the tab
            // everywhere else before it lives here.
            strippedElsewhere = true;
            const remaining = tabs.filter((candidate) => candidate !== sessionId);
            if (remaining.length > 0) openTabs[key] = remaining;
          }
          const ownerTabs = openTabs[ownerId] ?? [];
          if (ownerTabs.includes(sessionId)) {
            return strippedElsewhere ? { openTabs } : state;
          }
          openTabs[ownerId] = [...ownerTabs, sessionId];
          return { openTabs };
        });
      },

      closeChatTab(ownerId, sessionId) {
        // The tab decides, and it decides first: retiring the Session before
        // knowing whether this owner held a tab for it would dispose the client
        // another owner's open tab is still drawing from, leaving a tab on
        // screen with nothing behind it.
        const tabs = get().openTabs[ownerId];
        if (tabs === undefined || !tabs.includes(sessionId)) return;
        get().closeChatSession(sessionId);
        const remaining = tabs.filter((candidate) => candidate !== sessionId);
        set((state) => {
          if (remaining.length > 0) {
            return { openTabs: { ...state.openTabs, [ownerId]: remaining } };
          }
          const openTabs = { ...state.openTabs };
          delete openTabs[ownerId];
          return { openTabs };
        });
      },

      rehomeChatTabs(fromOwnerIds, toOwnerId) {
        set((state) => {
          let changed = false;
          const openTabs = { ...state.openTabs };
          const toTabs = [...(openTabs[toOwnerId] ?? [])];
          for (const fromOwnerId of fromOwnerIds) {
            const fromTabs = openTabs[fromOwnerId];
            if (fromTabs === undefined) continue;
            changed = true;
            for (const sessionId of fromTabs) {
              if (!toTabs.includes(sessionId)) toTabs.push(sessionId);
            }
            delete openTabs[fromOwnerId];
          }
          if (!changed) return state;
          openTabs[toOwnerId] = toTabs;
          return { openTabs };
        });
      },

      dropChatTabs(ownerIds) {
        set((state) => {
          let changed = false;
          const openTabs = { ...state.openTabs };
          for (const ownerId of ownerIds) {
            if (!(ownerId in openTabs)) continue;
            delete openTabs[ownerId];
            changed = true;
          }
          return changed ? { openTabs } : state;
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
