/**
 * Half-typed chat messages, keyed by sessionId — and every message that has
 * left the box without anything durable taking it yet.
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
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { appStateStorage } from "@renderer/lib/app-state-storage";

/** A draft never survives past this many most-recently-touched sessions. */
export const MAX_DRAFTS = 50;

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
  state: HeldMessageState;
}

export interface ChatDraft {
  text: string;
  /** Messages out of the box that nothing durable has taken. Oldest first. */
  held: readonly HeldMessage[];
  /** `Date.now()` at the most recent `setDraft` — the cap's eviction order. */
  touchedAt: number;
}

interface ChatDraftsState {
  drafts: Readonly<Record<string, ChatDraft>>;
  /** Sets (or overwrites) a session's draft text, stamping `touchedAt` to now. */
  setDraft(sessionId: string, text: string): void;
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
  holdMessage(sessionId: string, message: { id: string; text: string }): void;
  /**
   * Starts an explicit steer from the displayed strip in one durable write.
   *
   * Queue-only neighbors gain `queued` copies in their current display order
   * before the target can leave the renderer queue. Existing held states stay
   * intact; only the target becomes `sending`. Unlike {@link holdMessage}, the
   * current composer text stays where it is because every row already left the
   * box earlier.
   */
  beginQueuedSteer(
    sessionId: string,
    visible: readonly { id: string; text: string }[],
    targetId: string,
  ): void;
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

/** True for a draft with nothing left in it — no text, nothing held. */
function isEmptyDraft(draft: ChatDraft): boolean {
  return draft.text.trim().length === 0 && draft.held.length === 0;
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
 * A hydrated draft's held messages, every one of them read back as `unsent`.
 *
 * The stored `state` is deliberately not trusted: it describes this renderer's
 * relationship to the message — a round trip it has open, a queue it holds —
 * and a renderer reading this has neither. Anything still held at boot is by
 * definition a message nothing took.
 */
function readHeldMessages(value: unknown): HeldMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isHeldMessage(entry) ? [{ id: entry.id, text: entry.text, state: "unsent" as const }] : [],
  );
}

/** True for a hydrated draft entry with the fields this store actually reads. */
function isChatDraft(value: unknown): value is { text: string; touchedAt: number; held?: unknown } {
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
    drafts[sessionId] = {
      text: entry.text,
      held: readHeldMessages(entry.held),
      touchedAt: entry.touchedAt,
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
 */
function sanitizeDrafts(drafts: Readonly<Record<string, ChatDraft>>): Record<string, ChatDraft> {
  const kept = Object.entries(drafts).filter(([, draft]) => !isEmptyDraft(draft));
  kept.sort(([, a], [, b]) => b.touchedAt - a.touchedAt);
  return Object.fromEntries(kept.slice(0, MAX_DRAFTS));
}

/** The draft a session already has, or the empty one every action starts from. */
function draftFor(drafts: Readonly<Record<string, ChatDraft>>, sessionId: string): ChatDraft {
  return drafts[sessionId] ?? { text: "", held: [], touchedAt: 0 };
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
  return create<ChatDraftsState>()(
    persist(
      (set) => {
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
          setDraft: (sessionId, text) =>
            set((state) => ({
              drafts: {
                ...state.drafts,
                [sessionId]: { ...draftFor(state.drafts, sessionId), text, touchedAt: Date.now() },
              },
            })),
          holdMessage: (sessionId, message) =>
            set((state) => {
              const draft = draftFor(state.drafts, sessionId);
              return {
                drafts: {
                  ...state.drafts,
                  [sessionId]: {
                    text: "",
                    held: [...draft.held, { ...message, state: "sending" }],
                    touchedAt: Date.now(),
                  },
                },
              };
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
        name: "volli:chat-drafts",
        version: 1,
        storage: createJSONStorage(() => storage ?? appStateStorage),
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
