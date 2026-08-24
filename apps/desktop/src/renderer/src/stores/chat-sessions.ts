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
import { errorMessage, isDefaultModelRequired, type ModelSelection } from "@volli/shared";
import { create } from "zustand";

import {
  isWorking,
  settledLifecycle,
  type ChatSessionLifecycle,
  type ChatSessionSlice,
  type ChatSessionTransport,
  type ChatSessionWrites,
} from "@renderer/chat/client";
import { disposeChatClient, getOrCreateChatClient } from "@renderer/chat/registry";
import { renameChatSession } from "@renderer/chat/rename";
import { browserChatTransport } from "@renderer/chat/transport";
import {
  appendFrames,
  EMPTY_TRANSCRIPT,
  enqueueMessage,
  rejectedReceipt,
  removeQueued,
  type QueuedMessage,
} from "@volli/session-presentation";
import { toastError } from "@renderer/lib/toast";
import { useUiStore } from "@renderer/stores/ui";

export interface CreateChatSessionInput {
  projectId: string;
  ticketId: string | null;
  title: string | null;
  /** Skill slugs the Session starts with — attach-time RESOURCE injection. */
  skills?: readonly string[];
  /**
   * The model policy this Session is born with, when the surface opening it
   * chose one. Absent leaves the Role's configured default, which is what
   * every start but the composer's Create & start means (VC-56).
   */
  model?: ModelSelection;
}

export interface ChatSessionsState extends ChatSessionWrites {
  /**
   * Mints one durable Session and attaches its first executor, resolving the id.
   *
   * `null` means there is no Session: only the product start route failing gets
   * there, and it is the one failure with no slice to carry it. A failed
   * *attach* resolves the id — the Session exists, it simply has no executor
   * yet, and `retryAttach` addresses it rather than making another.
   */
  createChatSession(input: CreateChatSessionInput): Promise<string | null>;
  /** Attaches a client to a Session that is already durable — the hydration path. */
  adoptChatSession(sessionId: string): void;
  /** Drops the Session from this surface. The Session itself is untouched. */
  closeChatSession(sessionId: string): void;
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
   * key before recording it under the new one. `reconcileTicketChatTabs`
   * moves a ticket's tabs onto its project when that ticket leaves the board,
   * then moves only those same tabs back if it returns, without ever violating
   * the invariant.
   *
   * Resident for the reason the client is: a chat view mounts and unmounts
   * freely, and the tabs a person left open are not a fact about whether the
   * ticket detail is on screen. Deliberately NOT persisted — a durable Session
   * is recovered from its own record, and the workspace store's active tab id
   * is the only thing that has to survive a restart.
   */
  openTabs: Readonly<Record<string, readonly string[]>>;
  /**
   * The ticket a project-hosted tab left with while that ticket was absent from
   * the board. This is deliberately renderer-local: it is only the temporary
   * owner transition needed to restore an already-open tab. Durable Session
   * ownership remains its own `ticketId`; this map disappears with `openTabs`
   * on restart and never determines durable history.
   */
  rehomedTicketBySession: Readonly<Record<string, string>>;
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
   * Reconciles ticket-tab owners across one board transition. Departed tickets
   * donate their tabs to `projectId` and stamp their exact ticket origin;
   * returned tickets receive only project-hosted tabs carrying their matching
   * stamp. Ticketless tabs and tabs from other absent tickets remain put.
   * Tab bookkeeping only — no client is attached, retired, or disposed.
   */
  reconcileTicketChatTabs(
    projectId: string,
    departedTicketIds: readonly string[],
    returnedTicketIds: readonly string[],
  ): void;
  /**
   * Clears the temporary origins for a ticket that was permanently deleted.
   * The project-hosted tabs and their resident clients stay open; only their
   * now-impossible restoration path is retired.
   */
  clearRehomedTicketProvenance(ticketId: string): void;
  /**
   * Deletes each of `ownerIds`' tab entries outright. Used when a project
   * itself is forgotten — there is no surface left, not even the project, for
   * a tab to remain on. Retires every resident client named by the removed
   * owner strips and clears matching transient origin records in the same
   * synchronous teardown.
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

    const attach = (sessionId: string) =>
      getOrCreateChatClient(sessionId, {
        ...transport(),
        store: api,
        // The two desktop-owned effects the core names but never imports
        // (VC-169): an event failure surfaces as an error toast, and the
        // auto-title write goes through the shared rename path — which owns
        // the optimistic labels, the rollback, and its own failure toast.
        notify: toastError,
        renameSession: (target, title, refineFrom) => {
          void renameChatSession(target, title, refineFrom);
        },
      });

    return {
      sessions: {},
      openTabs: {},
      rehomedTicketBySession: {},
      starting: {},

      async createChatSession(input) {
        const edge = transport();
        let created: Awaited<ReturnType<ChatSessionTransport["createSession"]>>;
        try {
          created = await edge.createSession({
            operationId: edge.newCommandId(),
            projectId: input.projectId,
            ticketId: input.ticketId,
            title: input.title,
            ...(input.skills !== undefined && input.skills.length > 0
              ? { skills: input.skills }
              : {}),
            ...(input.model === undefined ? {} : { model: input.model }),
          });
        } catch (failure) {
          // A create refused for the missing default model is a predictable
          // configuration state, not an error: the recovery is Model Access,
          // so this opens it instead of raising a toast about it (VC-53).
          if (isDefaultModelRequired(errorMessage(failure))) {
            useUiStore.getState().setSettingsOpen(true, "model-access");
            return null;
          }
          // The one failure with nothing durable to carry it: there is no id, so
          // there is no slice, so a toast is the only place it can be said.
          toastError(`Could not start Session: ${errorMessage(failure)}`);
          return null;
        }
        const sessionId = created.sessionId;
        // The Session is durable and addressable NOW — the id resolves and the
        // caller lands the tab while the attach below is still in flight. The
        // slice seeds `starting`, the latch only a settle clears, so the
        // composer queues anything typed meanwhile and the release loop
        // delivers it once an executor is live (VC-16's optimistic open).
        set((state) => ({ sessions: { ...state.sessions, [sessionId]: seedSlice("starting") } }));
        const client = attach(sessionId);
        void client.connect();
        // The slow half — worktree ensure + Agent Runtime boot — runs in the
        // background, deliberately not awaited. Its outcome still lands on the
        // slice: the same settle rules the bundled start applied, plus the
        // transport-failure arm, because now a Session exists to carry it.
        void (async () => {
          try {
            const attached = await edge.attachSession({
              operationId: edge.newCommandId(),
              sessionId,
            });
            const refusal = rejectedReceipt(attached);
            // A ticketed refusal is reported by durable Ticket Attention on the
            // projection, so a slice-level error here would say the same thing
            // twice. A ticketless Session has no Attention surface, so its
            // refusal is settled onto the slice.
            get().settle(
              sessionId,
              attached.state === "ready" || input.ticketId !== null
                ? null
                : `Could not start Session: ${refusal ?? "Runtime recovery is required."}`,
            );
          } catch (failure) {
            // An attach that never reached main has no receipt and no Attention
            // — the slice is the only surface that can carry it, whatever the
            // Session's Role.
            get().settle(sessionId, `Could not start Session: ${errorMessage(failure)}`);
          }
        })();
        return sessionId;
      },

      // `ready` rather than `starting`, unlike the create above: adopting makes
      // no attachment attempt, so there is nothing in flight for `starting` to
      // name, and the composer is gated by whether an executor is live — which
      // the arriving snapshot answers — and never by this.
      adoptChatSession(sessionId) {
        if (get().sessions[sessionId] !== undefined) return;
        set((state) => ({ sessions: { ...state.sessions, [sessionId]: seedSlice("ready") } }));
        const client = attach(sessionId);
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

      applyStream(sessionId, frames, overlays, progress = [], clearLiveCompaction = false) {
        update(sessionId, (slice) => {
          const transcript = appendFrames(
            slice.transcript,
            frames,
            overlays,
            progress,
            clearLiveCompaction,
          );
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

      delivered(sessionId, turnEpoch) {
        update(sessionId, (slice) => ({
          ...slice,
          // An unchanged epoch means the stream has said nothing about turns
          // since the message left, so the optimistic "a turn is running" is
          // the only reading there is. A moved one means it has spoken — and it
          // outranks a reply that, with Pi, arrives after the turn it started
          // has already ended.
          lifecycle:
            slice.transcript.turnEpoch === turnEpoch || isWorking(slice) ? "working" : "ready",
          sessionError: null,
        }));
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
          const rehomedTicketBySession = { ...state.rehomedTicketBySession };
          delete rehomedTicketBySession[sessionId];
          if (remaining.length > 0) {
            return {
              openTabs: { ...state.openTabs, [ownerId]: remaining },
              rehomedTicketBySession,
            };
          }
          const openTabs = { ...state.openTabs };
          delete openTabs[ownerId];
          return { openTabs, rehomedTicketBySession };
        });
      },

      reconcileTicketChatTabs(projectId, departedTicketIds, returnedTicketIds) {
        set((state) => {
          let changed = false;
          const openTabs: Record<string, readonly string[]> = { ...state.openTabs };
          let projectTabs: string[] = [...(openTabs[projectId] ?? [])];
          let projectTabsChanged = false;
          let nextRehomedTicketBySession: Record<string, string> | undefined;

          const rehomedTicketBySession = (): Readonly<Record<string, string>> =>
            nextRehomedTicketBySession ?? state.rehomedTicketBySession;
          const mutableRehomedTicketBySession = (): Record<string, string> => {
            if (nextRehomedTicketBySession === undefined) {
              nextRehomedTicketBySession = { ...state.rehomedTicketBySession };
            }
            return nextRehomedTicketBySession;
          };

          const markRehomed = (sessionId: string, ticketId: string): void => {
            if (rehomedTicketBySession()[sessionId] === ticketId) return;
            mutableRehomedTicketBySession()[sessionId] = ticketId;
          };

          for (const ticketId of departedTicketIds) {
            const fromTabs = openTabs[ticketId];
            if (fromTabs === undefined) continue;
            changed = true;
            projectTabsChanged = true;
            for (const sessionId of fromTabs) {
              if (!projectTabs.includes(sessionId)) projectTabs.push(sessionId);
              markRehomed(sessionId, ticketId);
            }
            delete openTabs[ticketId];
          }

          for (const ticketId of returnedTicketIds) {
            const restored = projectTabs.filter(
              (sessionId) => rehomedTicketBySession()[sessionId] === ticketId,
            );
            if (restored.length === 0) continue;

            const restoring = new Set(restored);
            projectTabs = projectTabs.filter((sessionId) => !restoring.has(sessionId));
            projectTabsChanged = true;
            const ticketTabs = [...(openTabs[ticketId] ?? [])];
            for (const sessionId of restored) {
              if (!ticketTabs.includes(sessionId)) ticketTabs.push(sessionId);
            }
            openTabs[ticketId] = ticketTabs;
            changed = true;

            const provenance = mutableRehomedTicketBySession();
            for (const sessionId of restored) delete provenance[sessionId];
          }

          if (projectTabsChanged) {
            if (projectTabs.length > 0) openTabs[projectId] = projectTabs;
            else delete openTabs[projectId];
          }
          if (!changed && nextRehomedTicketBySession === undefined) return state;
          return nextRehomedTicketBySession === undefined
            ? { openTabs }
            : { openTabs, rehomedTicketBySession: nextRehomedTicketBySession };
        });
      },

      clearRehomedTicketProvenance(ticketId) {
        set((state) => {
          const sessionIds = Object.entries(state.rehomedTicketBySession)
            .filter(([, sourceTicketId]) => sourceTicketId === ticketId)
            .map(([sessionId]) => sessionId);
          if (sessionIds.length === 0) return state;

          const rehomedTicketBySession = { ...state.rehomedTicketBySession };
          for (const sessionId of sessionIds) delete rehomedTicketBySession[sessionId];
          return { rehomedTicketBySession };
        });
      },

      dropChatTabs(ownerIds) {
        const openTabs = get().openTabs;
        const hasOwner = ownerIds.some((ownerId) => ownerId in openTabs);
        if (!hasOwner) return;
        const removedSessionIds = new Set<string>();
        for (const ownerId of ownerIds) {
          for (const sessionId of openTabs[ownerId] ?? []) removedSessionIds.add(sessionId);
        }

        // A project is leaving the renderer entirely, so its remaining tab
        // owners cannot outlive their clients. Dispose before removing the
        // slices; both loops are synchronous, with no await between them.
        for (const sessionId of removedSessionIds) disposeChatClient(sessionId);
        set((state) => {
          const nextOpenTabs = { ...state.openTabs };
          for (const ownerId of ownerIds) {
            delete nextOpenTabs[ownerId];
          }
          const sessions = { ...state.sessions };
          const rehomedTicketBySession = { ...state.rehomedTicketBySession };
          for (const sessionId of removedSessionIds) {
            delete sessions[sessionId];
            delete rehomedTicketBySession[sessionId];
          }
          return { openTabs: nextOpenTabs, sessions, rehomedTicketBySession };
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
  };
}
