/**
 * App-wide (workspace-independent) UI state. `sidebarWidth` — the full
 * two-tier sidebar width (60px rail + resizable panel) — persists to
 * localStorage so the grip position survives relaunch. Same interim-storage
 * caveat as the projects store: dev and packaged origins don't share data.
 * `settingsOpen` is session-only: Settings is app-wide chrome (the sidebar
 * footer entry), not a per-workspace place, so it stays up across project
 * switches and closes when a nav page is picked. `newTicketOpen` is
 * session-only for the same reason: the global New-ticket dialog (board
 * header button + the "c" hotkey) is app-wide chrome, not per-workspace
 * state, so it never follows a project into persisted storage.
 *
 * `workspaceRailHidden` — whether the Slack-style project/workspace switcher
 * is visible — persists app-wide. Hiding it returns its full width to the
 * active workspace while project keyboard shortcuts remain available.
 *
 * `railCollapsed` — the ticket-detail right rail's collapsed state (the
 * chrome-bar ⌥⌘B toggle, VS-Code secondary-sidebar style) — persists app-wide
 * like the sidebar width: it's a global chrome preference, not per-workspace,
 * so every ticket you open honors the same choice.
 *
 * `detailsExpanded` — whether the right rail's bottom "Details" section (status/
 * priority/labels/worktree) is open. Sessions dominate the rail; Details is a
 * collapsed-by-default drawer pinned beneath them, and its open/closed choice
 * persists app-wide by the same reasoning as `railCollapsed`.
 *
 * `terminalFocusTarget` — the ticket terminal tab temporarily owning the app
 * canvas. It is deliberately session-only: live PTYs do not survive relaunch,
 * and entering a new app lifetime with its chrome hidden around a missing
 * session would strand the user in an invalid view.
 *
 * Per-workspace UI state (the active nav page) lives in stores/workspace.ts.
 */
import { DEFAULT_HARNESS_ID, type HarnessId, isHarnessId } from "@volli/shared";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { appStateStorage } from "@renderer/lib/app-state-storage";

export const SIDEBAR_DEFAULT_WIDTH = 318;
export const SIDEBAR_MIN_WIDTH = 280;
export const SIDEBAR_MAX_WIDTH = 640;

/** Identity of the ticket terminal tab temporarily owning the app canvas. */
export interface TerminalFocusTarget {
  projectId: string;
  ticketId: string;
  /** Root session/tab id; split-pane focus remains owned by the session store. */
  sessionId: string;
}

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
  /** Session-only — never persisted; see module doc. */
  newTicketOpen: boolean;
  /** Project/workspace switcher rail hidden? Persisted app-wide (see module doc). */
  workspaceRailHidden: boolean;
  /** Ticket-detail right rail collapsed? Persisted app-wide (see module doc). */
  railCollapsed: boolean;
  /** Ticket-detail rail "Details" drawer expanded? Persisted app-wide (see module doc). */
  detailsExpanded: boolean;
  /** Session-only terminal focus target; never persisted. */
  terminalFocusTarget: TerminalFocusTarget | null;
  /**
   * The harness the New-ticket composer's "Create & start" last kicked off with.
   * Persisted app-wide (like the chrome preferences above) so the primary action
   * remembers your agent across restarts; sanitized through {@link isHarnessId}
   * on rehydrate, defaulting to {@link DEFAULT_HARNESS_ID}.
   */
  lastHarnessId: HarnessId;
  setSidebarWidth(width: number): void;
  stepUiScale(delta: 1 | -1): void;
  resetUiScale(): void;
  setSettingsOpen(open: boolean): void;
  setNewTicketOpen(open: boolean): void;
  toggleWorkspaceRailHidden(): void;
  setWorkspaceRailHidden(hidden: boolean): void;
  toggleRailCollapsed(): void;
  setRailCollapsed(collapsed: boolean): void;
  toggleDetailsExpanded(): void;
  setDetailsExpanded(expanded: boolean): void;
  setTerminalFocusTarget(target: TerminalFocusTarget | null): void;
  setLastHarnessId(harnessId: HarnessId): void;
}

type PersistedUiState = Pick<
  UiState,
  | "sidebarWidth"
  | "uiScale"
  | "workspaceRailHidden"
  | "railCollapsed"
  | "detailsExpanded"
  | "lastHarnessId"
>;

/**
 * Factory so tests can supply an in-memory storage instead of the real
 * app_state bridge. `skipHydration` only applies to the real singleton (no
 * `storage` injected): a real boot round-trips through main before the store
 * can rehydrate (`lib/boot.ts` seeds the cache, then calls
 * `useUiStore.persist.rehydrate()` explicitly), whereas an injected test
 * storage is synchronous, so tests keep today's implicit-hydrate-on-create
 * behavior.
 */
export function createUiStore(storage?: StateStorage) {
  return create<UiState>()(
    persist(
      (set) => ({
        sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
        uiScale: UI_SCALE_DEFAULT,
        settingsOpen: false,
        newTicketOpen: false,
        workspaceRailHidden: false,
        railCollapsed: false,
        detailsExpanded: false,
        terminalFocusTarget: null,
        lastHarnessId: DEFAULT_HARNESS_ID,
        setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
        stepUiScale: (delta) => set((state) => ({ uiScale: steppedScale(state.uiScale, delta) })),
        resetUiScale: () => set({ uiScale: UI_SCALE_DEFAULT }),
        setSettingsOpen: (open) => set({ settingsOpen: open }),
        setNewTicketOpen: (open) => set({ newTicketOpen: open }),
        toggleWorkspaceRailHidden: () =>
          set((state) => ({ workspaceRailHidden: !state.workspaceRailHidden })),
        setWorkspaceRailHidden: (hidden) => set({ workspaceRailHidden: hidden }),
        toggleRailCollapsed: () => set((state) => ({ railCollapsed: !state.railCollapsed })),
        setRailCollapsed: (collapsed) => set({ railCollapsed: collapsed }),
        toggleDetailsExpanded: () => set((state) => ({ detailsExpanded: !state.detailsExpanded })),
        setDetailsExpanded: (expanded) => set({ detailsExpanded: expanded }),
        setTerminalFocusTarget: (target) => set({ terminalFocusTarget: target }),
        setLastHarnessId: (harnessId) => set({ lastHarnessId: harnessId }),
      }),
      {
        name: "volli:ui",
        version: 1,
        storage: createJSONStorage(() => storage ?? appStateStorage),
        skipHydration: storage === undefined,
        // A missing `uiScale` key (pre-zoom persisted state) just defaults to 1.
        partialize: (state): PersistedUiState => ({
          sidebarWidth: state.sidebarWidth,
          uiScale: state.uiScale,
          workspaceRailHidden: state.workspaceRailHidden,
          railCollapsed: state.railCollapsed,
          detailsExpanded: state.detailsExpanded,
          lastHarnessId: state.lastHarnessId,
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
            // Missing/corrupt state from an older build keeps the switcher
            // visible so projects never become unexpectedly undiscoverable.
            workspaceRailHidden: stored.workspaceRailHidden === true,
            // Any non-`true` persisted value (missing key, corrupt JSON) means
            // the rail stays expanded — the safe, visible default.
            railCollapsed: stored.railCollapsed === true,
            // Details drawer defaults closed; only an explicit `true` opens it.
            detailsExpanded: stored.detailsExpanded === true,
            // A missing/unknown persisted harness (older build, corrupt JSON,
            // or a since-removed custom id) falls back to the first-class default.
            lastHarnessId: isHarnessId(stored.lastHarnessId)
              ? stored.lastHarnessId
              : DEFAULT_HARNESS_ID,
          };
        },
      },
    ),
  );
}

/** App-wide singleton; components import this directly. */
export const useUiStore = createUiStore();
