/**
 * UI state. `activeNav` is deliberately session-only; `sidebarWidth` — the
 * full two-tier sidebar width (68px rail + resizable panel) — persists to
 * localStorage so the grip position survives relaunch. Same interim-storage
 * caveat as the projects store: dev and packaged origins don't share data.
 */
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export type NavKey = "board" | "sessions" | "files" | "settings";

export const SIDEBAR_DEFAULT_WIDTH = 318;
export const SIDEBAR_MIN_WIDTH = 280;
export const SIDEBAR_MAX_WIDTH = 640;

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

interface UiState {
  activeNav: NavKey;
  sidebarWidth: number;
  setActiveNav(nav: NavKey): void;
  setSidebarWidth(width: number): void;
}

type PersistedUiState = Pick<UiState, "sidebarWidth">;

/** Factory so tests can supply an in-memory storage instead of localStorage. */
export function createUiStore(storage?: StateStorage) {
  return create<UiState>()(
    persist(
      (set) => ({
        activeNav: "board",
        sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
        setActiveNav: (nav) => set({ activeNav: nav }),
        setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
      }),
      {
        name: "volli:ui",
        version: 1,
        storage: createJSONStorage(() => storage ?? localStorage),
        partialize: (state): PersistedUiState => ({ sidebarWidth: state.sidebarWidth }),
      },
    ),
  );
}

/** App-wide singleton; components import this directly. */
export const useUiStore = createUiStore();
