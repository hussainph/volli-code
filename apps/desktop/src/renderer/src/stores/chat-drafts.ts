/**
 * Half-typed chat messages, keyed by sessionId — and every message that has
 * left the box without anything durable taking it yet.
 *
 * The word “message” includes its files (VC-137): the staged attachment strip
 * and every held message's attachments persist here too, because a
 * half-composed prompt is words AND a screenshot, and surviving a tab switch
 * or a relaunch must not eat one half of it.
 *
 * The composer's `input` state used to live in `ChatPlane` itself — gone the
 * moment a tab switch unmounted it. A Session is durable and its half-typed
 * message is part of it (CLAUDE.md: "A Session is durable and owns identity ...
 * before any adapter attaches"), so the draft has to survive both a tab switch
 * and a relaunch, not just the first.
 *
 * {@link ChatDraft.held} is the same promise kept one step further on.
 * "Persist intent before delivery" means the box may empty the instant ⏎ is
 * pressed — it must, or the words you sent sit there for the length of Pi's
 * reply — but it may not be the ONLY copy that empties. A message crossing to
 * main, or waiting in the renderer's release queue, is words a person typed and
 * nothing has accepted; a reload in that window used to lose them with no
 * trace. So the box hands the message to `held` in the same write that clears
 * it, and only something durable — a delivered turn, or a ledger that already
 * records the intent — takes it back out.
 *
 * One blob under one `app_state` key, not a row per session. `app_state` has
 * no delete channel — `appStateStorage.removeItem` persists a permanent `""`
 * row (see `lib/app-state-storage.ts`), read back on every boot — so a
 * per-session key would accumulate one dead row per session forever with no
 * way to ever clean it up. A single blob makes that the same bounded write
 * this store already does for every other key, and `partialize` below is the
 * whole cleanup story: drop anything with neither text nor held message, keep
 * only the 50 most-recently-touched. There is no session→draft sweep (no
 * listener for "this session/ticket/project was deleted") to hook a per-row
 * eviction into, so the cap is what keeps an abandoned draft from lingering
 * indefinitely — it just isn't named as the *reason* a draft goes away.
 */
import {
  CHAT_DRAFTS_APP_STATE_KEY,
  isBlobLinkView,
  isPromptResource,
  isProvisionalChatDraftPhase,
  parseSessionModel,
  type BlobLinkView,
  type ModelSelection,
  type PromptResource,
  type ProvisionalChatDraftPhase,
} from "@volli/shared";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { appStateStorage } from "@renderer/lib/app-state-storage";

/** A draft never survives past this many most-recently-touched sessions. */
export const MAX_DRAFTS = 50;
/** The single app_state row that owns every Session draft and held message. */
export { CHAT_DRAFTS_APP_STATE_KEY };

/**
 * Where a message that left the box currently stands.
 *
 * - `sending` — a round trip is open on it. The surface draws nothing: the
 *   transcript is already showing the message, and a second copy under the
 *   composer would read as a message that failed to leave.
 * - `queued` — the Session's release queue holds it. The queue is renderer
 *   memory, so this is its only copy that outlives the window.
 * - `unsent` — nothing took it. It belongs back in front of the person who
 *   wrote it, as its own message rather than welded onto whatever they typed
 *   next.
 *
 * A renderer that has just booted has no round trip open and no release queue,
 * so hydration reads every held message back as `unsent` — see
 * {@link readPersistedDrafts}. That is what makes a crash mid-send show up as
 * words waiting rather than as words gone.
 */
export type HeldMessageState = "sending" | "queued" | "unsent";

export interface HeldMessage {
  id: string;
  text: string;
  /**
   * The skill bodies resolved for this message at submit (VC-49). Persisted
   * with the words because they are part of the same intent: a held message
   * re-sent after a relaunch must deliver what its `/skill` reference
   * resolved to when it was written, not lose the body silently.
   */
  resources?: readonly PromptResource[];
  /**
   * The files this message carried when it left the box (VC-137). Same rule as
   * `resources`: a queued or steered copy must release with exactly what was
   * attached at ⏎, and a relaunch must not silently drop a screenshot a
   * person already committed to the message. The links themselves live in
   * main, owned by the Session — this is the pointer the queue's renderer
   * memory cannot be.
   */
  attachments?: readonly BlobLinkView[];
  state: HeldMessageState;
}

/** What crosses into this store when a message leaves the box. */
export interface HeldMessageInput {
  id: string;
  text: string;
  resources?: readonly PromptResource[];
  attachments?: readonly BlobLinkView[];
}

export interface ProvisionalChatDraft {
  /** The project whose surface owns this not-yet-Session. */
  projectId: string;
  /** The Ticket it works, or null for a project's own chat. */
  ticketId: string | null;
  /** Stable across every promotion retry; its create command is derived from this id. */
  operationId: string;
  /** Optional create-time policy chosen by the opening surface. */
  skills?: readonly string[];
  title: string | null;
  model?: ModelSelection;
  /**
   * How far this Draft has got towards being a Session. Its vocabulary lives
   * in `@volli/shared` because main reads the same persisted envelope at boot
   * and must recognise exactly the same set — see
   * {@link ProvisionalChatDraftPhase}.
   */
  phase: ProvisionalChatDraftPhase;
}

export interface ChatDraft {
  text: string;
  /**
   * Present only while this identity names a Draft rather than a Session.
   * Empty provisional entries live in memory but are filtered from persistence;
   * once content exists this launch record is what makes relaunch promotion
   * retryable without changing either the tab id or the durable Session id.
   */
  provisional?: ProvisionalChatDraft;
  /**
   * The files staged on the message being written (VC-137) — the strip above
   * the box, persisted beside the words for the same reason they are: a
   * half-composed message is part of the Session, files and all, and a tab
   * switch or a relaunch must not eat one half of it. The bytes and links
   * live in main, owned by the Session; this is the list the strip draws.
   */
  attachments: readonly BlobLinkView[];
  /** Messages out of the box that nothing durable has taken. Oldest first. */
  held: readonly HeldMessage[];
  /** `Date.now()` at the most recent `setDraft` — the cap's eviction order. */
  touchedAt: number;
}

export interface ChatDraftsState {
  drafts: Readonly<Record<string, ChatDraft>>;
  /** Opens a renderer-local Draft under the UUID its eventual Session will use. */
  openProvisional(sessionId: string, provisional: Omit<ProvisionalChatDraft, "phase">): void;
  /**
   * Changes the title promotion will record, without creating a Session.
   *
   * Refused once the create has landed (`session-created`): the title is part
   * of the durable create intent, and the engine treats a replay carrying a
   * different intent as a conflict. From that moment a rename is a SESSION
   * rename, and the surfaces route it to that path rather than here — so no
   * gesture is dropped, it simply changes which door it takes.
   */
  setProvisionalTitle(sessionId: string, title: string): void;
  /**
   * Changes the model policy that promotion will record, without creating a
   * Session.
   *
   * Send freezes the choice — a create that lands before a later failure must
   * replay the same model even if Settings changed in between — so this
   * refuses once a first message is held under a resolved model, and the
   * composer's picker is stood down for that same window rather than
   * accepting a change it would have to discard.
   */
  setProvisionalModel(sessionId: string, model: ModelSelection): void;
  /** Records that create landed, so a failed Blob transfer can resume honestly. */
  markProvisionalSessionCreated(sessionId: string): void;
  /** Replaces ownerless attachment views with the Session links promotion created. */
  adoptLinkedAttachments(sessionId: string, attachments: readonly BlobLinkView[]): void;
  /** The Blob transfer landed; this identity is now an ordinary durable Session draft. */
  completePromotion(sessionId: string): void;
  /** Abandons an unpromoted Draft. A durable Session draft is never removed here. */
  discardProvisional(sessionId: string): void;
  /** Registers one file-import flight and returns its idempotent completion callback. */
  beginAttachmentImport(sessionId: string): () => void;
  /** Whether a file import has started but not committed its strip change yet. */
  hasAttachmentImports(sessionId: string): boolean;
  /**
   * Settles once the file imports feeding this Draft at call time have
   * committed their strip changes. Imports begun later belong to the next
   * composer message and cannot extend this barrier.
   */
  waitForAttachmentImports(sessionId: string): Promise<void>;
  /**
   * Serializes promotion per Draft. Concurrent sends share the exact Promise;
   * a failure retires it so a later send can retry from persisted metadata.
   */
  promote(
    sessionId: string,
    run: (provisional: ProvisionalChatDraft) => Promise<boolean>,
  ): Promise<boolean>;
  /** Sets (or overwrites) a session's draft text, stamping `touchedAt` to now. */
  setDraft(sessionId: string, text: string): void;
  /**
   * Sets (or overwrites) a session's staged attachment strip. The composer's
   * attach/remove gestures write through here, so the strip survives a tab
   * switch and a relaunch exactly as the words do — one list, one owner.
   */
  setDraftAttachments(sessionId: string, attachments: readonly BlobLinkView[]): void;
  /**
   * The box's message leaves the box — in one write, so no instant exists in
   * which this store is the only thing that held it and no longer does.
   *
   * Called the moment a message is dispatched rather than when delivery lands.
   * Pi's reply to a `message.submit` arrives when the whole TURN has finished —
   * the runtime awaits `agent.prompt`, so a 30-second answer is a 30-second
   * round trip — and a box that keeps what you sent until then is a box that
   * still holds your message while its reply streams in above it. What the box
   * must NOT do is forget it: the copy moves to {@link ChatDraft.held} and
   * stays there until delivery is somebody else's durable problem.
   */
  holdMessage(sessionId: string, message: HeldMessageInput): void;
  /**
   * Rewrites one held message while a pre-Send file import finishes. The
   * import began as part of that message, so its eventual Blob/ref must follow
   * the held copy rather than reappear in the newly emptied composer.
   */
  amendHeldMessage(
    sessionId: string,
    id: string,
    amend: (message: HeldMessage) => HeldMessage,
  ): void;
  /**
   * Starts an explicit steer from the displayed strip in one durable write.
   *
   * Queue-only neighbors gain `queued` copies in their current display order
   * before the target can leave the renderer queue. Existing held states stay
   * intact; only the target becomes `sending`. Unlike {@link holdMessage}, the
   * current composer text stays where it is because every row already left the
   * box earlier.
   */
  beginQueuedSteer(sessionId: string, visible: readonly HeldMessageInput[], targetId: string): void;
  /**
   * Re-states where a held message stands. Update-only: a Session closed while
   * its message was in flight has no draft left to write, and minting one would
   * spend a capped slot on a Session nothing can ever open again.
   */
  markHeld(sessionId: string, id: string, state: HeldMessageState): void;
  /**
   * Forgets a held message, because something else is now responsible for it —
   * a delivered turn, a ledger that already records the intent, or the person
   * who removed the row. Update-only, for {@link markHeld}'s reason.
   */
  dropHeld(sessionId: string, id: string): void;
}

type PersistedChatDraftsState = Pick<ChatDraftsState, "drafts">;

/** Whether Zustand's serialized partial state contains any Draft worth storing. */
function serializedDraftsAreEmpty(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      isPlainRecord(parsed) &&
      isPlainRecord(parsed.state) &&
      isPlainRecord(parsed.state.drafts) &&
      Object.keys(parsed.state.drafts).length === 0
    );
  } catch {
    /* v8 ignore next -- `persist` hands this the string it just serialized, so a parse failure needs a serializer this store does not install; a value it cannot read is still honestly not an empty-drafts blob. */
    return false;
  }
}

/**
 * Zustand calls its storage on every store write even when `partialize` removes
 * the only thing that changed. An empty provisional Draft therefore needs this
 * quiet edge: opening, focusing, renaming, choosing a model, or closing it must
 * remain renderer-only rather than UPSERTing an unchanged/empty app_state blob.
 *
 * Production storage is synchronous and cache-backed. The Promise allowance is
 * retained for StateStorage-compatible tests/adapters; those conservatively
 * write because their current value cannot be compared synchronously.
 */
function quietDraftStorage(storage: StateStorage): StateStorage {
  return {
    getItem: (name) => storage.getItem(name),
    setItem: (name, value) => {
      const current = storage.getItem(name);
      if (typeof current === "string" && current === value) return;
      if (current === null && serializedDraftsAreEmpty(value)) return;
      return storage.setItem(name, value);
    },
    /* v8 ignore next -- required by `StateStorage`; nothing clears this key, which is why the quiet edge above only has to reason about writes. */
    removeItem: (name) => storage.removeItem(name),
  };
}

/** True for a draft with nothing left in it — no text, no files, nothing held. */
export function isEmptyChatDraft(draft: ChatDraft): boolean {
  return (
    draft.text.trim().length === 0 && draft.attachments.length === 0 && draft.held.length === 0
  );
}

/** A sidebar/layout-visible Draft has content but is still not a Session. */
export function isVisibleProvisionalChatDraft(draft: ChatDraft): boolean {
  return draft.provisional !== undefined && !isEmptyChatDraft(draft);
}

/**
 * The counterpart: a Draft nobody has typed into yet.
 *
 * This is the state that must stay entirely renderer-local — out of the
 * persisted envelope, out of the workspace's tab order and pane assignments,
 * out of the sidebar. Every surface asks the same question, so they ask it
 * through one function rather than each re-deriving "provisional AND empty".
 * `undefined` for an identity with no Draft at all: a durable Session's tab is
 * neither visible-provisional nor empty-provisional.
 */
export function isEmptyProvisionalChatDraft(draft: ChatDraft | undefined): boolean {
  return draft?.provisional !== undefined && isEmptyChatDraft(draft);
}

/** True for a value that is a plain object (not null, not an array). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a hydrated held message with the fields this store actually reads. */
function isHeldMessage(value: unknown): value is { id: string; text: string } {
  return isPlainRecord(value) && typeof value.id === "string" && typeof value.text === "string";
}

/**
 * A hydrated held message's resources, or nothing. Read defensively like the
 * rest of the blob: a malformed entry drops the resources rather than the
 * message — the words are the person's, the resources are re-derivable.
 */
function readHeldResources(value: unknown): readonly PromptResource[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const resources = value.filter(isPromptResource).map(({ name, text }) => ({ name, text }));
  return resources.length > 0 ? resources : undefined;
}

/**
 * A hydrated held message's attachments, or nothing. Read defensively like the
 * rest of the blob: a malformed entry drops the files rather than the message —
 * the words are the person's, and a link main no longer has would only fail to
 * detach when the row is removed.
 */
function readHeldAttachments(value: unknown): readonly BlobLinkView[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments = value.filter(isBlobLinkView);
  return attachments.length > 0 ? attachments : undefined;
}

/**
 * A hydrated draft's held messages, every one of them read back as `unsent`.
 *
 * The stored `state` is deliberately not trusted: it describes this renderer's
 * relationship to the message — a round trip it has open, a queue it holds —
 * and a renderer reading this has neither. Anything still held at boot is by
 * definition a message nothing took.
 */
function readHeldMessages(value: unknown): HeldMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isHeldMessage(entry)) return [];
    const resources = readHeldResources((entry as Record<string, unknown>).resources);
    const attachments = readHeldAttachments((entry as Record<string, unknown>).attachments);
    return [
      {
        id: entry.id,
        text: entry.text,
        ...(resources === undefined ? {} : { resources }),
        ...(attachments === undefined ? {} : { attachments }),
        state: "unsent" as const,
      },
    ];
  });
}

/** A hydrated draft's attachment strip — malformed entries dropped, never fatal. */
function readDraftAttachments(value: unknown): readonly BlobLinkView[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isBlobLinkView);
}

/** True for a hydrated draft entry with the fields this store actually reads. */
function readProvisionalChatDraft(value: unknown): ProvisionalChatDraft | undefined {
  if (!isPlainRecord(value)) return undefined;
  const { projectId, ticketId, operationId, title, phase } = value;
  if (
    typeof projectId !== "string" ||
    projectId.length === 0 ||
    (ticketId !== null && typeof ticketId !== "string") ||
    (typeof ticketId === "string" && ticketId.length === 0) ||
    typeof operationId !== "string" ||
    operationId.length === 0 ||
    (title !== null && typeof title !== "string") ||
    !isProvisionalChatDraftPhase(phase)
  ) {
    return undefined;
  }
  const skills = Array.isArray(value.skills)
    ? value.skills.filter((skill): skill is string => typeof skill === "string" && skill.length > 0)
    : [];
  const model = parseSessionModel(value.model);
  return {
    projectId,
    ticketId,
    operationId,
    title,
    phase,
    ...(skills.length > 0 ? { skills } : {}),
    ...(model === null ? {} : { model }),
  };
}

function isChatDraft(value: unknown): value is {
  text: string;
  touchedAt: number;
  attachments?: unknown;
  held?: unknown;
  provisional?: unknown;
} {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.text === "string" &&
    typeof value.touchedAt === "number" &&
    Number.isFinite(value.touchedAt)
  );
}

/**
 * Accept only well-shaped draft entries from storage. A bad blob must not
 * poison live state — `sanitizeDrafts` later calls `.trim()` on `text`, and a
 * `null` text would throw on the next persist.
 */
function readPersistedDrafts(value: unknown): Record<string, ChatDraft> {
  if (!isPlainRecord(value)) return {};
  const drafts: Record<string, ChatDraft> = {};
  for (const [sessionId, entry] of Object.entries(value)) {
    if (!isChatDraft(entry)) continue;
    const provisional = readProvisionalChatDraft(entry.provisional);
    drafts[sessionId] = {
      text: entry.text,
      attachments: readDraftAttachments(entry.attachments),
      held: readHeldMessages(entry.held),
      touchedAt: entry.touchedAt,
      ...(provisional === undefined ? {} : { provisional }),
    };
  }
  return drafts;
}

/**
 * The persisted shape: drafts holding neither text nor a message dropped,
 * capped at the {@link MAX_DRAFTS} most-recently-touched. Applied at persist
 * time only — live state keeps a draft that's mid-edit-to-blank until it's
 * actually written out, so retyping over a just-cleared box doesn't fight the
 * store.
 *
 * A PROVISIONAL Draft is exempt from the cap (VC-358). The cap exists because
 * a durable Session's unsent words are recoverable in the sense that matters:
 * the Session is still there, still listed, still openable, and the box is
 * merely empty. A provisional Draft is the only handle on its identity — and
 * once it is `session-created`, the only handle on a durable Session row and
 * the held first message that has not reached a queue. Dropping one to make
 * room for a text draft would strand both. They are bounded by open tabs
 * rather than by this number, which is why exempting them cannot grow the
 * envelope without bound.
 */
function sanitizeDrafts(drafts: Readonly<Record<string, ChatDraft>>): Record<string, ChatDraft> {
  const kept = Object.entries(drafts).filter(([, draft]) => !isEmptyChatDraft(draft));
  kept.sort(([, a], [, b]) => b.touchedAt - a.touchedAt);
  const capped: [string, ChatDraft][] = [];
  let durable = 0;
  for (const entry of kept) {
    if (entry[1].provisional !== undefined) capped.push(entry);
    else if (durable < MAX_DRAFTS) {
      durable += 1;
      capped.push(entry);
    }
  }
  return Object.fromEntries(capped);
}

/** The draft a session already has, or the empty one every action starts from. */
function draftFor(drafts: Readonly<Record<string, ChatDraft>>, sessionId: string): ChatDraft {
  return drafts[sessionId] ?? { text: "", attachments: [], held: [], touchedAt: 0 };
}

/**
 * Factory so tests can supply an in-memory storage instead of the real
 * app_state bridge — mirrors `createUiStore` (see stores/ui.ts) exactly,
 * including the `skipHydration` reasoning: a real boot round-trips through
 * main before this store can rehydrate (`lib/boot.ts` seeds the cache, then
 * calls `useChatDraftsStore.persist.rehydrate()` explicitly), whereas an
 * injected test storage is synchronous, so tests keep today's implicit-
 * hydrate-on-create behavior.
 */
export function createChatDraftsStore(storage?: StateStorage) {
  /** In-flight work is process-local; only its stable operation id belongs in persistence. */
  const promotions = new Map<string, Promise<boolean>>();
  const attachmentImports = new Map<string, Set<Promise<void>>>();
  // A close can unmount the composer while its async file import still owns
  // callbacks. Keep those callbacks from recreating the Draft they belonged to.
  const abandonedImports = new Set<string>();
  return create<ChatDraftsState>()(
    persist(
      (set, get) => {
        /** Rewrites one existing draft's held list, or does nothing at all. */
        const reviseHeld = (
          sessionId: string,
          revise: (held: readonly HeldMessage[]) => readonly HeldMessage[],
        ): void => {
          set((state) => {
            const draft = state.drafts[sessionId];
            if (draft === undefined) return {};
            const held = revise(draft.held);
            if (held === draft.held) return {};
            return { drafts: { ...state.drafts, [sessionId]: { ...draft, held } } };
          });
        };

        return {
          drafts: {},
          openProvisional: (sessionId, provisional) =>
            set((state) => {
              abandonedImports.delete(sessionId);
              if (state.drafts[sessionId]?.provisional !== undefined) return {};
              return {
                drafts: {
                  ...state.drafts,
                  [sessionId]: {
                    ...draftFor(state.drafts, sessionId),
                    provisional: { ...provisional, phase: "draft" },
                  },
                },
              };
            }),
          setProvisionalTitle: (sessionId, title) =>
            set((state) => {
              const draft = state.drafts[sessionId];
              // Only the create intent is frozen, and it freezes when the
              // create LANDS — not when Send is pressed. Until then this is
              // still the Draft's own title and may be edited freely.
              if (draft?.provisional?.phase !== "draft") return {};
              return {
                drafts: {
                  ...state.drafts,
                  [sessionId]: {
                    ...draft,
                    provisional: { ...draft.provisional, title },
                    touchedAt: Date.now(),
                  },
                },
              };
            }),
          setProvisionalModel: (sessionId, model) =>
            set((state) => {
              const draft = state.drafts[sessionId];
              if (
                draft?.provisional?.phase !== "draft" ||
                (draft.held.length > 0 && draft.provisional.model !== undefined)
              ) {
                return {};
              }
              return {
                drafts: {
                  ...state.drafts,
                  [sessionId]: {
                    ...draft,
                    provisional: { ...draft.provisional, model },
                    touchedAt: Date.now(),
                  },
                },
              };
            }),
          markProvisionalSessionCreated: (sessionId) =>
            set((state) => {
              const draft = state.drafts[sessionId];
              if (
                draft?.provisional === undefined ||
                draft.provisional.phase === "session-created"
              ) {
                return {};
              }
              return {
                drafts: {
                  ...state.drafts,
                  [sessionId]: {
                    ...draft,
                    provisional: { ...draft.provisional, phase: "session-created" },
                  },
                },
              };
            }),
          adoptLinkedAttachments: (sessionId, attachments) =>
            set((state) => {
              const draft = state.drafts[sessionId];
              if (draft === undefined || attachments.length === 0) return {};
              const byHash = new Map(
                attachments.map((attachment) => [attachment.blobHash, attachment]),
              );
              // A strip is always a list; a held message's files are not, and
              // only that difference is optional. Keeping the optionality at the
              // one call site that has it leaves no empty-list fallback here for
              // a reader to wonder about.
              const adopt = (current: readonly BlobLinkView[]) =>
                current.map((attachment) => byHash.get(attachment.blobHash) ?? attachment);
              return {
                drafts: {
                  ...state.drafts,
                  [sessionId]: {
                    ...draft,
                    attachments: adopt(draft.attachments),
                    held: draft.held.map((message) => {
                      const current = message.attachments;
                      return current === undefined
                        ? message
                        : Object.assign({}, message, { attachments: adopt(current) });
                    }),
                  },
                },
              };
            }),
          completePromotion: (sessionId) =>
            set((state) => {
              const draft = state.drafts[sessionId];
              if (draft?.provisional === undefined) return {};
              const { provisional: _provisional, ...durableDraft } = draft;
              return { drafts: { ...state.drafts, [sessionId]: durableDraft } };
            }),
          discardProvisional: (sessionId) =>
            set((state) => {
              if (state.drafts[sessionId]?.provisional === undefined) return {};
              if (attachmentImports.has(sessionId)) abandonedImports.add(sessionId);
              const drafts = { ...state.drafts };
              delete drafts[sessionId];
              return { drafts };
            }),
          beginAttachmentImport(sessionId) {
            const flights = attachmentImports.get(sessionId) ?? new Set<Promise<void>>();
            let resolveFlight!: () => void;
            const flight = new Promise<void>((resolve) => {
              resolveFlight = resolve;
            });
            flights.add(flight);
            attachmentImports.set(sessionId, flights);
            let finished = false;
            return () => {
              if (finished) return;
              finished = true;
              const current = attachmentImports.get(sessionId);
              current?.delete(flight);
              if (current?.size === 0) attachmentImports.delete(sessionId);
              resolveFlight();
              if (!attachmentImports.has(sessionId)) abandonedImports.delete(sessionId);
            };
          },
          hasAttachmentImports: (sessionId) => (attachmentImports.get(sessionId)?.size ?? 0) > 0,
          waitForAttachmentImports(sessionId) {
            const flights = attachmentImports.get(sessionId);
            return flights === undefined ? Promise.resolve() : Promise.all(flights).then(() => {});
          },
          promote(sessionId, run) {
            const current = promotions.get(sessionId);
            if (current !== undefined) return current;
            const provisional = get().drafts[sessionId]?.provisional;
            if (provisional === undefined) return Promise.resolve(true);
            const flight = run(provisional).finally(() => {
              /* v8 ignore next -- a second promotion returns the flight above rather than starting one, so the only entry this can find is its own; the check is what keeps that true if that ever changes. */
              if (promotions.get(sessionId) === flight) promotions.delete(sessionId);
            });
            promotions.set(sessionId, flight);
            return flight;
          },
          setDraft: (sessionId, text) => {
            if (abandonedImports.has(sessionId)) return;
            set((state) => ({
              drafts: {
                ...state.drafts,
                [sessionId]: { ...draftFor(state.drafts, sessionId), text, touchedAt: Date.now() },
              },
            }));
          },
          setDraftAttachments: (sessionId, attachments) => {
            if (abandonedImports.has(sessionId)) return;
            set((state) => ({
              drafts: {
                ...state.drafts,
                [sessionId]: {
                  ...draftFor(state.drafts, sessionId),
                  attachments,
                  touchedAt: Date.now(),
                },
              },
            }));
          },
          holdMessage: (sessionId, message) =>
            set((state) => {
              const draft = draftFor(state.drafts, sessionId);
              return {
                drafts: {
                  ...state.drafts,
                  [sessionId]: {
                    // The strip stays as it is: only the FILES the message
                    // took move with it (passed in `message.attachments`), and
                    // the caller clears those from the strip in the same write
                    // window. An answer typed beside an open question holds no
                    // files — its hold must not eat the ones still staged for
                    // the next real message.
                    ...draft,
                    text: "",
                    held: [
                      ...draft.held,
                      {
                        ...message,
                        ...(message.attachments === undefined || message.attachments.length === 0
                          ? {}
                          : { attachments: message.attachments }),
                        state: "sending" as const,
                      },
                    ],
                    touchedAt: Date.now(),
                  },
                },
              };
            }),
          amendHeldMessage: (sessionId, id, amend) =>
            reviseHeld(sessionId, (held) => {
              const index = held.findIndex((message) => message.id === id);
              if (index < 0) return held;
              const next = [...held];
              next[index] = amend(held[index]!);
              return next;
            }),
          beginQueuedSteer: (sessionId, visible, targetId) =>
            set((state) => {
              const draft = draftFor(state.drafts, sessionId);
              const visibleById = new Map(visible.map((entry) => [entry.id, entry]));
              const existingIds = new Set(draft.held.map((entry) => entry.id));
              // Existing held chronology wins, including a hidden `sending`
              // entry whose refusal may make it visible again later.
              const held: HeldMessage[] = draft.held.map((entry) => {
                const displayed = visibleById.get(entry.id);
                if (displayed === undefined) return entry;
                return {
                  ...entry,
                  text: displayed.text,
                  // The row is also what `beginQueuedSteer` persists back, so
                  // the files riding the displayed copy must survive the
                  // round trip — the same rule `resources` follows (VC-49).
                  ...(displayed.attachments === undefined || displayed.attachments.length === 0
                    ? {}
                    : { attachments: displayed.attachments }),
                  state: entry.id === targetId ? "sending" : entry.state,
                };
              });
              // What is missing is queue-only, already ordered by the strip.
              for (const entry of visible) {
                if (existingIds.has(entry.id)) continue;
                held.push({ ...entry, state: entry.id === targetId ? "sending" : "queued" });
              }
              return {
                drafts: {
                  ...state.drafts,
                  [sessionId]: { ...draft, held, touchedAt: Date.now() },
                },
              };
            }),
          markHeld: (sessionId, id, state) =>
            reviseHeld(sessionId, (held) => {
              const found = held.find((entry) => entry.id === id);
              if (found === undefined || found.state === state) return held;
              return held.map((entry) => (entry.id === id ? { ...entry, state } : entry));
            }),
          dropHeld: (sessionId, id) =>
            reviseHeld(sessionId, (held) => {
              const remaining = held.filter((entry) => entry.id !== id);
              return remaining.length === held.length ? held : remaining;
            }),
        };
      },
      {
        name: CHAT_DRAFTS_APP_STATE_KEY,
        version: 1,
        storage: createJSONStorage(() => quietDraftStorage(storage ?? appStateStorage)),
        skipHydration: storage === undefined,
        partialize: (state): PersistedChatDraftsState => ({
          drafts: sanitizeDrafts(state.drafts),
        }),
        merge: (persisted, current) => {
          const stored = isPlainRecord(persisted) ? persisted : {};
          return { ...current, drafts: readPersistedDrafts(stored.drafts) };
        },
      },
    ),
  );
}

/** App-wide singleton; components import this directly. */
export const useChatDraftsStore = createChatDraftsStore();
