/**
 * App-wide (workspace-independent) UI state. `sidebarWidth` — the full
 * two-tier sidebar width (60px rail + resizable panel) — persists to
 * localStorage so the grip position survives relaunch. Same interim-storage
 * caveat as the projects store: dev and packaged origins don't share data.
 * `settingsOpen` is session-only: Settings is app-wide chrome (the sidebar
 * footer entry), not a per-workspace place, so it stays up across project
 * switches and closes when a nav page is picked.
 *
 * Per-workspace UI state (the active nav page) lives in stores/workspace.ts.
 */
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export const SIDEBAR_DEFAULT_WIDTH = 318;
export const SIDEBAR_MIN_WIDTH = 280;
export const SIDEBAR_MAX_WIDTH = 640;

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

interface UiState {
  sidebarWidth: number;
  settingsOpen: boolean;
  setSidebarWidth(width: number): void;
  setSettingsOpen(open: boolean): void;
}

type PersistedUiState = Pick<UiState, "sidebarWidth">;

/** Factory so tests can supply an in-memory storage instead of localStorage. */
export function createUiStore(storage?: StateStorage) {
  return create<UiState>()(
    persist(
      (set) => ({
        sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
        settingsOpen: false,
        setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
        setSettingsOpen: (open) => set({ settingsOpen: open }),
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
