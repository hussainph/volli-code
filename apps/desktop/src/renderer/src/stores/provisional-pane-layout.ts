import { create } from "zustand";

import { useChatSessionsStore } from "./chat-sessions";

export interface ProvisionalPanePlacement {
  paneId: string;
  /** The Draft is in front in this pane, independently of surface focus. */
  front: boolean;
}

export type ProvisionalPanePlacements = ReadonlyMap<string, ProvisionalPanePlacement>;
export const EMPTY_PROVISIONAL_PANE_PLACEMENTS: ProvisionalPanePlacements = new Map();

interface ProvisionalPaneLayoutState {
  /** Renderer-only tab locations: selection never owns their lifetime. */
  byOwner: ReadonlyMap<string, ProvisionalPanePlacements>;
  place(ownerId: string, sessionId: string, paneId: string): void;
  deactivatePanes(ownerId: string, paneIds: ReadonlySet<string>): void;
  remove(ownerId: string, sessionId: string): void;
  retainOpenTabs(openTabs: Readonly<Record<string, readonly string[]>>): void;
}

export function createProvisionalPaneLayoutStore() {
  return create<ProvisionalPaneLayoutState>()((set) => ({
    byOwner: new Map(),
    place(ownerId, sessionId, paneId) {
      set((state) => {
        const existing = state.byOwner.get(ownerId) ?? EMPTY_PROVISIONAL_PANE_PLACEMENTS;
        const before = existing.get(sessionId);
        if (before?.paneId === paneId && before.front) return state;
        const placements = new Map(existing);
        for (const [id, placement] of existing) {
          if (placement.paneId === paneId && placement.front) {
            placements.set(id, { ...placement, front: false });
          }
        }
        placements.set(sessionId, { paneId, front: true });
        return { byOwner: new Map(state.byOwner).set(ownerId, placements) };
      });
    },
    deactivatePanes(ownerId, paneIds) {
      set((state) => {
        const existing = state.byOwner.get(ownerId) ?? EMPTY_PROVISIONAL_PANE_PLACEMENTS;
        let placements: Map<string, ProvisionalPanePlacement> | undefined;
        for (const [id, placement] of existing) {
          if (!paneIds.has(placement.paneId) || !placement.front) continue;
          placements ??= new Map(existing);
          placements.set(id, { ...placement, front: false });
        }
        return placements === undefined
          ? state
          : { byOwner: new Map(state.byOwner).set(ownerId, placements) };
      });
    },
    remove(ownerId, sessionId) {
      set((state) => {
        const existing = state.byOwner.get(ownerId);
        if (existing === undefined || !existing.has(sessionId)) return state;
        const placements = new Map(existing);
        placements.delete(sessionId);
        const byOwner = new Map(state.byOwner);
        if (placements.size === 0) byOwner.delete(ownerId);
        else byOwner.set(ownerId, placements);
        return { byOwner };
      });
    },
    retainOpenTabs(openTabs) {
      set((state) => {
        let byOwner: Map<string, ProvisionalPanePlacements> | undefined;
        for (const [ownerId, existing] of state.byOwner) {
          const tabs = openTabs[ownerId] ?? [];
          const placements = new Map([...existing].filter(([id]) => tabs.includes(id)));
          if (placements.size === existing.size) continue;
          byOwner ??= new Map(state.byOwner);
          if (placements.size === 0) byOwner.delete(ownerId);
          else byOwner.set(ownerId, placements);
        }
        return byOwner === undefined ? state : { byOwner };
      });
    },
  }));
}

export const useProvisionalPaneLayoutStore = createProvisionalPaneLayoutStore();

// Closing/re-homing a tab or forgetting an owner retires its placement even
// while its surface is unmounted. Merely selecting a browser does not.
useChatSessionsStore.subscribe((state, previous) => {
  if (state.openTabs === previous.openTabs) return;
  useProvisionalPaneLayoutStore.getState().retainOpenTabs(state.openTabs);
});
