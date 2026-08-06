/**
 * Half-typed chat messages, keyed by sessionId. The composer's `input` state
 * used to live in `ChatPlane` itself — gone the moment a tab switch unmounted
 * it. A Session is durable and its half-typed message is part of it (CLAUDE.md:
 * "A Session is durable and owns identity ... before any adapter attaches"),
 * so the draft has to survive both a tab switch and a relaunch, not just the
 * first.
 *
 * One blob under one `app_state` key, not a row per session. `app_state` has
 * no delete channel — `appStateStorage.removeItem` persists a permanent `""`
 * row (see `lib/app-state-storage.ts`), read back on every boot — so a
 * per-session key would accumulate one dead row per session forever with no
 * way to ever clean it up. A single blob makes that the same bounded write
 * this store already does for every other key, and `partialize` below is the
 * whole cleanup story: drop anything blank, keep only the 50 most-recently-
 * touched. There is no session→draft sweep (no listener for "this session/
 * ticket/project was deleted") to hook a per-row eviction into, so the cap is
 * what keeps an abandoned draft from lingering indefinitely — it just isn't
 * named as the *reason* a draft goes away.
 */
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { appStateStorage } from "@renderer/lib/app-state-storage";

/** A draft never survives past this many most-recently-touched sessions. */
export const MAX_DRAFTS = 50;

export interface ChatDraft {
  text: string;
  /** `Date.now()` at the most recent `setDraft` — the cap's eviction order. */
  touchedAt: number;
}

interface ChatDraftsState {
  drafts: Readonly<Record<string, ChatDraft>>;
  /** Sets (or overwrites) a session's draft text, stamping `touchedAt` to now. */
  setDraft(sessionId: string, text: string): void;
  /** Removes a session's draft outright — called once a message actually sends. */
  clearDraft(sessionId: string): void;
}

type PersistedChatDraftsState = Pick<ChatDraftsState, "drafts">;

/** True for a draft whose text is empty or whitespace-only — never worth persisting. */
function isBlankDraft(draft: ChatDraft): boolean {
  return draft.text.trim().length === 0;
}

/**
 * The persisted shape: blank/whitespace-only drafts dropped, capped at the
 * {@link MAX_DRAFTS} most-recently-touched. Applied at persist time only —
 * live state keeps a draft that's mid-edit-to-blank until it's actually
 * written out, so retyping over a just-cleared box doesn't fight the store.
 */
function sanitizeDrafts(drafts: Readonly<Record<string, ChatDraft>>): Record<string, ChatDraft> {
  const kept = Object.entries(drafts).filter(([, draft]) => !isBlankDraft(draft));
  kept.sort(([, a], [, b]) => b.touchedAt - a.touchedAt);
  return Object.fromEntries(kept.slice(0, MAX_DRAFTS));
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
      (set) => ({
        drafts: {},
        setDraft: (sessionId, text) =>
          set((state) => ({
            drafts: { ...state.drafts, [sessionId]: { text, touchedAt: Date.now() } },
          })),
        clearDraft: (sessionId) =>
          set((state) => {
            if (!(sessionId in state.drafts)) return {};
            const next = { ...state.drafts };
            delete next[sessionId];
            return { drafts: next };
          }),
      }),
      {
        name: "volli:chat-drafts",
        version: 1,
        storage: createJSONStorage(() => storage ?? appStateStorage),
        skipHydration: storage === undefined,
        partialize: (state): PersistedChatDraftsState => ({
          drafts: sanitizeDrafts(state.drafts),
        }),
        merge: (persisted, current) => {
          const stored =
            typeof persisted === "object" && persisted !== null
              ? (persisted as Partial<PersistedChatDraftsState>)
              : {};
          return {
            ...current,
            drafts:
              typeof stored.drafts === "object" && stored.drafts !== null ? stored.drafts : {},
          };
        },
      },
    ),
  );
}

/** App-wide singleton; components import this directly. */
export const useChatDraftsStore = createChatDraftsStore();
