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

/**
 * UI-zoom ladder for the whole app below the chrome band. 1 = native scale;
 * ⌘+/⌘-/⌘0 (see menu.ts) step along these fixed rungs rather than a continuous
 * factor, so every zoom level is a known, layout-tested value. Applied as CSS
 * `zoom` on the content row in app-shell.tsx.
 */
export const UI_SCALE_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;

const UI_SCALE_DEFAULT = 1;

/** Index of the ladder rung closest to `scale`. */
function nearestScaleIndex(scale: number): number {
  let nearest = 0;
  for (let i = 1; i < UI_SCALE_STEPS.length; i++) {
    if (Math.abs(UI_SCALE_STEPS[i]! - scale) < Math.abs(UI_SCALE_STEPS[nearest]! - scale)) {
      nearest = i;
    }
  }
  return nearest;
}

/**
 * Index of the rung to move to when stepping `delta` from `scale`. If `scale`
 * isn't exactly a rung (e.g. a stale persisted value from an older ladder), we
 * snap to the nearest rung first, then step — so a single ⌘+ always lands on a
 * defined rung rather than compounding an off-ladder value.
 */
function steppedScale(scale: number, delta: 1 | -1): number {
  const next = Math.min(UI_SCALE_STEPS.length - 1, Math.max(0, nearestScaleIndex(scale) + delta));
  return UI_SCALE_STEPS[next]!;
}

/**
 * A persisted scale, snapped to the ladder. `uiScale` is applied verbatim as
 * CSS `zoom` on the content row, so a corrupt value (`0`, NaN, a huge number)
 * would render the entire app below the chrome band invisible/unusable on
 * every launch — with the zoom-reset menu item unreachable by mouse.
 */
function sanitizeUiScale(scale: unknown): number {
  if (typeof scale !== "number" || !Number.isFinite(scale)) return UI_SCALE_DEFAULT;
  return UI_SCALE_STEPS[nearestScaleIndex(scale)]!;
}

/** A persisted sidebar width, put back inside the resize grip's own bounds. */
function sanitizeSidebarWidth(width: unknown): number {
  if (typeof width !== "number" || !Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return clampSidebarWidth(width);
}

interface UiState {
  sidebarWidth: number;
  uiScale: number;
  settingsOpen: boolean;
  setSidebarWidth(width: number): void;
  stepUiScale(delta: 1 | -1): void;
  resetUiScale(): void;
  setSettingsOpen(open: boolean): void;
}

type PersistedUiState = Pick<UiState, "sidebarWidth" | "uiScale">;

/** Factory so tests can supply an in-memory storage instead of localStorage. */
export function createUiStore(storage?: StateStorage) {
  return create<UiState>()(
    persist(
      (set) => ({
        sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
        uiScale: UI_SCALE_DEFAULT,
        settingsOpen: false,
        setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
        stepUiScale: (delta) => set((state) => ({ uiScale: steppedScale(state.uiScale, delta) })),
        resetUiScale: () => set({ uiScale: UI_SCALE_DEFAULT }),
        setSettingsOpen: (open) => set({ settingsOpen: open }),
      }),
      {
        name: "volli:ui",
        version: 1,
        storage: createJSONStorage(() => storage ?? localStorage),
        // A missing `uiScale` key (pre-zoom persisted state) just defaults to 1.
        partialize: (state): PersistedUiState => ({
          sidebarWidth: state.sidebarWidth,
          uiScale: state.uiScale,
        }),
        // Rehydrated values come from JSON a past build wrote — sanitize
        // rather than trust (see sanitizeUiScale; a raw `zoom: 0` bricks the UI).
        merge: (persisted, current) => {
          const stored =
            typeof persisted === "object" && persisted !== null
              ? (persisted as Partial<PersistedUiState>)
              : {};
          return {
            ...current,
            sidebarWidth: sanitizeSidebarWidth(stored.sidebarWidth),
            uiScale: sanitizeUiScale(stored.uiScale),
          };
        },
      },
    ),
  );
}

/** App-wide singleton; components import this directly. */
export const useUiStore = createUiStore();
