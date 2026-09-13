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
  applyProjection,
  dequeueSlice,
  disposeChatClient,
  enqueueSlice,
  foldStreamBatch,
  getOrCreateChatClient,
  markAttaching,
  markDelivered,
  rejectedReceipt,
  retitleSlice,
  seedSlice,
  settleSlice,
  type ChatSessionSlice,
  type ChatSessionTransport,
  type ChatSessionWrites,
  type QueuedMessage,
} from "@volli/session-presentation";

import { renameChatSession } from "@renderer/chat/rename";
import { browserChatTransport } from "@renderer/chat/transport";
import { toastError } from "@renderer/lib/toast";
import { useChatDraftsStore, type ChatDraft } from "@renderer/stores/chat-drafts";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useUiStore } from "@renderer/stores/ui";

export interface CreateChatSessionInput {
  projectId: string;
  ticketId: string | null;
  title: string | null;
  /** Stable for a promotion retry; omitted by every eager creator. */
  operationId?: string;
  /** The provisional UUID the durable Session adopts. */
  requestedSessionId?: string;
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
  /** Promotes one provisional Draft in place, serialized across concurrent sends. */
  promoteChatSession(sessionId: string): Promise<boolean>;
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
   * Renderer-only focus for an empty provisional Draft. It must be usable
   * without writing the workspace app_state row that relaunches durable tabs.
   */
  provisionalActive: Readonly<Record<string, string>>;
  setProvisionalActive(ownerId: string, sessionId: string | null): void;

  /**
   * Which chat Sessions and provisional Drafts have a tab open, per surface owner — a ticketId
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
  /** Reopens every persisted typed Draft after the app_state hydrate. */
  restoreProvisionalChatTabs(
    drafts: Readonly<Record<string, ChatDraft>>,
    liveTicketIds?: ReadonlySet<string>,
    liveProjectIds?: ReadonlySet<string>,
  ): void;
  /**
   * Drops the tab from `ownerId`'s strip and retires resident Session state.
   * A still-uncreated Draft is explicitly abandoned with the view; a create
   * that already landed stays durable and keeps its promotion recovery state.
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
   * Durable project-hosted Sessions stay open, but an uncreated Draft scoped
   * to that ticket is abandoned: it cannot honestly promote without its owner.
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

/** Every ownerless Blob a provisional Draft has to hand to its Session, once per hash. */
function provisionalBlobDrafts(draft: ChatDraft): { blobHash: string; label?: string }[] {
  const byHash = new Map<string, { blobHash: string; label?: string }>();
  const remember = (
    attachments: readonly { linkId: string | null; blobHash: string; label: string }[] | undefined,
  ) => {
    for (const attachment of attachments ?? []) {
      if (attachment.linkId === null && !byHash.has(attachment.blobHash)) {
        byHash.set(attachment.blobHash, {
          blobHash: attachment.blobHash,
          ...(attachment.label.length === 0 ? {} : { label: attachment.label }),
        });
      }
    }
  };
  remember(draft.attachments);
  for (const message of draft.held) remember(message.attachments);
  return [...byHash.values()];
}

/** Factory so tests get isolated instances (sessions.ts's convention). */
export function createChatSessionsStore(
  transport: () => ChatSessionTransport = browserChatTransport,
) {
  return create<ChatSessionsState>()((set, get, api) => {
    // A close after create but before Blob transfer finishes cannot delete the
    // durable row, but it must stop that in-flight promotion from attaching a
    // resident runtime behind the closed tab.
    const closedCreatedDrafts = new Set<string>();
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

    /** Seed one resident slice/client after create, without disturbing a replayed promotion. */
    const makeResident = (sessionId: string): void => {
      if (get().sessions[sessionId] === undefined) {
        set((state) => ({ sessions: { ...state.sessions, [sessionId]: seedSlice("starting") } }));
        const client = attach(sessionId);
        void client.connect();
        return;
      }
      get().attaching(sessionId);
    };

    /** Worktree ensure + Agent Runtime boot, always off the create/promotion critical path. */
    const startAttach = (
      edge: ChatSessionTransport,
      sessionId: string,
      ticketId: string | null,
      operationId: string = edge.newCommandId(),
    ): void => {
      void (async () => {
        try {
          const attached = await edge.attachSession({ operationId, sessionId });
          const refusal = rejectedReceipt(attached);
          // A ticketed refusal is reported by durable Ticket Attention on the
          // projection, so a slice-level error here would say the same thing
          // twice. A ticketless Session has no Attention surface, so its
          // refusal is settled onto the slice.
          get().settle(
            sessionId,
            attached.state === "ready" || ticketId !== null
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
    };

    /** The durable mint shared by eager starts and Draft promotion. */
    const mint = async (
      edge: ChatSessionTransport,
      input: CreateChatSessionInput,
      makeClient: boolean,
    ): Promise<string | null> => {
      let created: Awaited<ReturnType<ChatSessionTransport["createSession"]>>;
      try {
        created = await edge.createSession({
          operationId: input.operationId ?? edge.newCommandId(),
          projectId: input.projectId,
          ticketId: input.ticketId,
          title: input.title,
          ...(input.requestedSessionId === undefined
            ? {}
            : { requestedSessionId: input.requestedSessionId }),
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
      if (
        input.requestedSessionId !== undefined &&
        created.sessionId !== input.requestedSessionId
      ) {
        toastError(
          `Could not start Session: promotion returned ${created.sessionId}, not ${input.requestedSessionId}`,
        );
        return null;
      }
      if (makeClient) makeResident(created.sessionId);
      return created.sessionId;
    };

    return {
      sessions: {},
      openTabs: {},
      rehomedTicketBySession: {},
      starting: {},
      provisionalActive: {},

      async createChatSession(input) {
        const edge = transport();
        const sessionId = await mint(edge, input, true);
        if (sessionId === null) return null;
        // The Session is durable and addressable NOW — the id resolves and the
        // caller lands the tab while this slow half runs in the background.
        startAttach(edge, sessionId, input.ticketId);
        return sessionId;
      },

      promoteChatSession(sessionId) {
        return useChatDraftsStore.getState().promote(sessionId, async (provisional) => {
          const edge = transport();
          const createdId = await mint(
            edge,
            {
              projectId: provisional.projectId,
              ticketId: provisional.ticketId,
              title: provisional.title,
              operationId: provisional.operationId,
              requestedSessionId: sessionId,
              ...(provisional.skills === undefined ? {} : { skills: provisional.skills }),
              ...(provisional.model === undefined ? {} : { model: provisional.model }),
            },
            // A provisional view owns no resident client yet. Wait until create
            // is still wanted and every staged Blob has a Session owner; a
            // close racing create must not briefly connect a client it then
            // disposes, and attach must not observe ownerless prompt files.
            false,
          );
          if (createdId === null) return false;

          // Close may have abandoned the renderer-owned Draft while create was
          // in flight. The row that just landed is durable and stays honest in
          // history, but withdrawn intent earns neither an attachment/runtime
          // nor a resident client.
          if (useChatDraftsStore.getState().drafts[sessionId]?.provisional === undefined) {
            get().closeChatSession(sessionId);
            return true;
          }

          useChatDraftsStore.getState().markProvisionalSessionCreated(sessionId);
          // Files that began before Send may finish while create or a previous
          // link batch is in flight. Wait for their strip commits and re-read
          // after every awaited transfer. ChatPlane holds later gestures until
          // this flight settles, so the final empty read closes the ownerless
          // Blob boundary.
          while (true) {
            await useChatDraftsStore.getState().waitForAttachmentImports(sessionId);
            const draft = useChatDraftsStore.getState().drafts[sessionId];
            const blobs = draft === undefined ? [] : provisionalBlobDrafts(draft);
            if (blobs.length === 0) break;
            try {
              const linked = await window.api.attachments.linkDrafts({ sessionId, blobs });
              if (!linked.ok) {
                toastError(`Could not prepare attachments: ${linked.error}`);
                return false;
              }
              const linkedHashes = new Set(linked.blobs.map(({ blobHash }) => blobHash));
              const missing = blobs.find(({ blobHash }) => !linkedHashes.has(blobHash));
              if (missing !== undefined) {
                toastError(`Could not prepare attachment: ${missing.label ?? missing.blobHash}`);
                return false;
              }
              useChatDraftsStore.getState().adoptLinkedAttachments(sessionId, linked.blobs);
            } catch (failure) {
              toastError(`Could not prepare attachments: ${errorMessage(failure)}`);
              return false;
            }
          }

          // Keep the `session-created` recovery marker until ChatPlane has put
          // the held first message into its runtime queue. A renderer crash in
          // that last handoff must restore an unsent provisional row rather
          // than a durable Draft whose `sending` copy has no retry surface.
          if (provisional.ticketId !== null) {
            void useTicketSessionRecordsStore.getState().refresh(provisional.ticketId);
          }
          // The link transfer has landed before either the resident projection
          // client connects or main materializes the checkout. A tab closed
          // after create remains a durable Session, but it does not earn a
          // hidden resident client/runtime.
          // Project teardown can remove the tab and Draft after create while a
          // Blob transfer is awaited. The durable row may survive elsewhere,
          // but no removed project earns a hidden resident runtime.
          if (useChatDraftsStore.getState().drafts[sessionId]?.provisional === undefined) {
            get().closeChatSession(sessionId);
            return true;
          }
          if (closedCreatedDrafts.delete(sessionId)) {
            const drafts = useChatDraftsStore.getState();
            for (const message of drafts.drafts[sessionId]?.held ?? []) {
              if (message.state === "sending") drafts.markHeld(sessionId, message.id, "unsent");
            }
            drafts.completePromotion(sessionId);
            get().closeChatSession(sessionId);
            return true;
          }
          makeResident(sessionId);
          // Create replay keeps the stable Draft operation/id. Runtime attach
          // is a new attempt: replaying a prior rejected attach receipt after
          // relaunch would make recovery permanently refuse the same work.
          startAttach(edge, sessionId, provisional.ticketId);
          return true;
        });
      },

      // `ready` rather than `starting`, unlike the create above: adopting makes
      // no attachment attempt, so there is nothing in flight for `starting` to
      // name, and the composer is gated by whether an executor is live — which
      // the arriving snapshot answers — and never by this.
      adoptChatSession(sessionId) {
        // A Draft tab can travel through the same sidebar/split doors as a
        // durable chat. Opening that view must not manufacture a resident
        // client (and therefore an attach) before its first message promotes it.
        if (useChatDraftsStore.getState().drafts[sessionId]?.provisional !== undefined) return;
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

      // The per-slice rules behind each write — the fold-and-settle, the
      // turn-epoch guard, the settle handback, the identity-preserving no-ops
      // — live in the package's session-slice transitions, one write-model
      // for every store that satisfies ChatSessionWrites (VC-169). What stays
      // here is the zustand shell and the desktop policy around it.
      applyStream(sessionId, frames, overlays, progress = [], clearLiveCompaction = false) {
        update(sessionId, (slice) =>
          foldStreamBatch(slice, frames, overlays, progress, clearLiveCompaction),
        );
      },

      setProjection(sessionId, projection) {
        update(sessionId, (slice) => applyProjection(slice, projection));
      },

      attaching(sessionId) {
        update(sessionId, markAttaching);
      },

      delivered(sessionId, turnEpoch) {
        update(sessionId, (slice) => markDelivered(slice, turnEpoch));
      },

      settle(sessionId, error) {
        update(sessionId, (slice) => settleSlice(slice, error));
      },

      enqueue(sessionId, message) {
        update(sessionId, (slice) => enqueueSlice(slice, message));
      },

      dequeue(sessionId, id) {
        update(sessionId, (slice) => dequeueSlice(slice, id));
      },

      retitle(sessionId, title) {
        update(sessionId, (slice) => retitleSlice(slice, title));
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

      setProvisionalActive(ownerId, sessionId) {
        set((state) => {
          if ((state.provisionalActive[ownerId] ?? null) === sessionId) return state;
          const provisionalActive = { ...state.provisionalActive };
          if (sessionId === null) delete provisionalActive[ownerId];
          else provisionalActive[ownerId] = sessionId;
          return { provisionalActive };
        });
      },

      openChatTab(ownerId, sessionId) {
        closedCreatedDrafts.delete(sessionId);
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

      restoreProvisionalChatTabs(drafts, liveTicketIds, liveProjectIds) {
        const rehomed: Record<string, string> = {};
        const activeByOwner = new Map<string, { sessionId: string; touchedAt: number }>();
        for (const [sessionId, draft] of Object.entries(drafts)) {
          const provisional = draft.provisional;
          if (provisional === undefined) continue;
          // A removed project has no reachable surface and its durable removal
          // has already cascaded any partial Session row. Retire the stale Draft
          // rather than restoring an owner key no renderer can ever select.
          if (liveProjectIds !== undefined && !liveProjectIds.has(provisional.projectId)) {
            useChatDraftsStore.getState().discardProvisional(sessionId);
            continue;
          }
          // A ticket that left the live board while the app was away has no
          // workspace to host this tab. Keep the Draft reachable under Home,
          // while retaining its ticket birth scope for promotion and for a
          // later board return.
          const ticketIsLive =
            provisional.ticketId === null ||
            liveTicketIds === undefined ||
            liveTicketIds.has(provisional.ticketId);
          const ownerId = ticketIsLive
            ? (provisional.ticketId ?? provisional.projectId)
            : provisional.projectId;
          if (!ticketIsLive && provisional.ticketId !== null) {
            rehomed[sessionId] = provisional.ticketId;
          }
          const active = activeByOwner.get(ownerId);
          if (active === undefined || draft.touchedAt >= active.touchedAt) {
            activeByOwner.set(ownerId, { sessionId, touchedAt: draft.touchedAt });
          }
          get().openChatTab(ownerId, sessionId);
        }
        if (Object.keys(rehomed).length > 0 || activeByOwner.size > 0) {
          set((state) => ({
            rehomedTicketBySession: { ...state.rehomedTicketBySession, ...rehomed },
            provisionalActive: {
              ...state.provisionalActive,
              ...Object.fromEntries(
                [...activeByOwner].map(([ownerId, { sessionId }]) => [ownerId, sessionId]),
              ),
            },
          }));
        }
      },

      closeChatTab(ownerId, sessionId) {
        // The tab decides, and it decides first: retiring the Session before
        // knowing whether this owner held a tab for it would dispose the client
        // another owner's open tab is still drawing from, leaving a tab on
        // screen with nothing behind it.
        const tabs = get().openTabs[ownerId];
        if (tabs === undefined || !tabs.includes(sessionId)) return;
        get().closeChatSession(sessionId);
        const draft = useChatDraftsStore.getState().drafts[sessionId];
        // Close is the explicit abandon gesture for a Draft whether or not it
        // has typed/staged content. Once create has landed, though, the durable
        // Session cannot be hidden or deleted; keep its recovery metadata until
        // Blob transfer finishes while preventing that flight from attaching.
        const abandonDraft = draft?.provisional?.phase === "draft";
        if (draft?.provisional?.phase === "session-created") {
          closedCreatedDrafts.add(sessionId);
        }
        const remaining = tabs.filter((candidate) => candidate !== sessionId);
        set((state) => {
          const rehomedTicketBySession = { ...state.rehomedTicketBySession };
          delete rehomedTicketBySession[sessionId];
          const provisionalActive = { ...state.provisionalActive };
          if (provisionalActive[ownerId] === sessionId) delete provisionalActive[ownerId];
          if (remaining.length > 0) {
            return {
              openTabs: { ...state.openTabs, [ownerId]: remaining },
              rehomedTicketBySession,
              provisionalActive,
            };
          }
          const openTabs = { ...state.openTabs };
          delete openTabs[ownerId];
          return { openTabs, rehomedTicketBySession, provisionalActive };
        });
        // An uncreated provisional tab was the only handle to this Draft.
        // Closing it abandons the renderer/app_state copy completely.
        if (abandonDraft) useChatDraftsStore.getState().discardProvisional(sessionId);
      },

      reconcileTicketChatTabs(projectId, departedTicketIds, returnedTicketIds) {
        set((state) => {
          let changed = false;
          const openTabs: Record<string, readonly string[]> = { ...state.openTabs };
          let projectTabs: string[] = [...(openTabs[projectId] ?? [])];
          let projectTabsChanged = false;
          let nextRehomedTicketBySession: Record<string, string> | undefined;
          let nextProvisionalActive: Record<string, string> | undefined;

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
          const provisionalActive = (): Readonly<Record<string, string>> =>
            nextProvisionalActive ?? state.provisionalActive;
          const mutableProvisionalActive = (): Record<string, string> => {
            if (nextProvisionalActive === undefined) {
              nextProvisionalActive = { ...state.provisionalActive };
            }
            return nextProvisionalActive;
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
            const active = provisionalActive()[ticketId];
            if (active !== undefined && fromTabs.includes(active)) {
              const mutable = mutableProvisionalActive();
              delete mutable[ticketId];
              mutable[projectId] = active;
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
            const active = provisionalActive()[projectId];
            if (active !== undefined && restoring.has(active)) {
              const mutable = mutableProvisionalActive();
              delete mutable[projectId];
              mutable[ticketId] = active;
            }
          }

          if (projectTabsChanged) {
            if (projectTabs.length > 0) openTabs[projectId] = projectTabs;
            else delete openTabs[projectId];
          }
          if (
            !changed &&
            nextRehomedTicketBySession === undefined &&
            nextProvisionalActive === undefined
          ) {
            return state;
          }
          return {
            openTabs,
            ...(nextRehomedTicketBySession === undefined
              ? {}
              : { rehomedTicketBySession: nextRehomedTicketBySession }),
            ...(nextProvisionalActive === undefined
              ? {}
              : { provisionalActive: nextProvisionalActive }),
          };
        });
      },

      clearRehomedTicketProvenance(ticketId) {
        const abandonedDraftIds = new Set(
          Object.entries(useChatDraftsStore.getState().drafts).flatMap(([sessionId, draft]) =>
            draft.provisional?.phase === "draft" && draft.provisional.ticketId === ticketId
              ? [sessionId]
              : [],
          ),
        );
        set((state) => {
          const provenanceIds = Object.entries(state.rehomedTicketBySession)
            .filter(([, sourceTicketId]) => sourceTicketId === ticketId)
            .map(([sessionId]) => sessionId);
          if (provenanceIds.length === 0 && abandonedDraftIds.size === 0) return state;

          const rehomedTicketBySession = { ...state.rehomedTicketBySession };
          for (const sessionId of provenanceIds) delete rehomedTicketBySession[sessionId];
          let openTabs = state.openTabs;
          let provisionalActive = state.provisionalActive;
          if (abandonedDraftIds.size > 0) {
            const keptTabs: Record<string, readonly string[]> = {};
            for (const [ownerId, tabs] of Object.entries(state.openTabs)) {
              const kept = tabs.filter((sessionId) => !abandonedDraftIds.has(sessionId));
              if (kept.length > 0) keptTabs[ownerId] = kept;
            }
            openTabs = keptTabs;
            provisionalActive = Object.fromEntries(
              Object.entries(state.provisionalActive).filter(
                ([, sessionId]) => !abandonedDraftIds.has(sessionId),
              ),
            );
          }
          return { rehomedTicketBySession, openTabs, provisionalActive };
        });
        for (const sessionId of abandonedDraftIds) {
          useChatDraftsStore.getState().discardProvisional(sessionId);
        }
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
          const provisionalActive = { ...state.provisionalActive };
          for (const ownerId of ownerIds) delete provisionalActive[ownerId];
          for (const sessionId of removedSessionIds) {
            delete sessions[sessionId];
            delete rehomedTicketBySession[sessionId];
          }
          return { openTabs: nextOpenTabs, sessions, rehomedTicketBySession, provisionalActive };
        });
        // This path means the owning project is gone, not merely that a tab was
        // closed or a Ticket left the live board. No surface remains from which
        // a provisional Draft could be recovered or promoted.
        for (const sessionId of removedSessionIds) {
          useChatDraftsStore.getState().discardProvisional(sessionId);
        }
      },
    };
  });
}

export const useChatSessionsStore = createChatSessionsStore();
