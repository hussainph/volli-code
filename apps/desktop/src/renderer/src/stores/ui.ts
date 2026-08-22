/**
 * App-wide (workspace-independent) UI state.
 *
 * "Persists app-wide" below means one thing throughout: through
 * {@link appStateStorage}, the `app_state` preload bridge onto main's SQLite —
 * never `localStorage`, which this renderer does not use for anything (see
 * CLAUDE.md). The distinction is not pedantry: a renderer-owned store would be
 * per-origin, so dev and packaged builds would each keep their own copy of every
 * chrome preference below, and none of it would survive as domain data.
 *
 * `sidebarWidth` — the full two-tier sidebar width (60px rail + resizable
 * panel) — persists so the grip position survives relaunch.
 * `railWidth` — the ticket-detail right rail's width, resizable via its own
 * left-edge grip (see rail-resize-handle.tsx) — persists app-wide by the same
 * reasoning: it's a global chrome preference, not per-workspace state.
 * `settingsOpen` is session-only: Settings is app-wide chrome (the sidebar
 * footer entry), not a per-workspace place, so it stays up across project
 * switches and closes when a nav page is picked. `newTicketOpen` is
 * session-only for the same reason: the global New-ticket dialog (board
 * header button + the "c" hotkey) is app-wide chrome, not per-workspace
 * state, so it never follows a project into persisted storage.
 *
 * `workspaceRailHidden` — whether the Slack-style project switcher is
 * visible — persists app-wide. (The key predates CONTEXT.md's "project"
 * ruling and stays as wire format; the copy on the toggle says project
 * switcher.) Hiding it returns its full width to the active workspace while
 * project keyboard shortcuts remain available.
 *
 * `sidebarPinned` — whether the summoned sidebar panel stands in the layout
 * (⌘B / the chrome-band trigger) rather than being summoned by the pointer at
 * the window's left edge. Persisted app-wide for the same reason as the two
 * above: it is a chrome preference, not a per-workspace place. A panel that
 * re-pinned itself on every launch would undo the choice the moment it mattered.
 * Missing or corrupt persisted state pins it — the visible default, and today's
 * behavior.
 *
 * It holds the user's OWN answer and only that. Fullscreen also unpins the
 * panel, but that is an inference read off a window mode, and it is kept in
 * app-shell's session-local state rather than written here: a quit taken while
 * still in fullscreen would otherwise leave `false` on disk and open the next
 * windowed launch with the panel gone and nothing to say the user never asked
 * for it. Durable storage answers "what did they choose", not "what was on
 * screen when the process died".
 *
 * `railCollapsed` — the ticket-detail right rail's collapsed state (the
 * chrome-bar ⌥⌘B toggle, VS-Code secondary-sidebar style) — persists app-wide
 * like the sidebar width: it's a global chrome preference, not per-workspace,
 * so every ticket you open honors the same choice.
 *
 * `homeRailMode` — which page HOME's rail shows (Now / Sessions), and
 * `homeEmptyVisual` — which drawing a Project Session's empty chat opens on
 * (Streak / Board / Venue, VC-55). Both persist app-wide for the same reason
 * `railMode` does, and both are their own key rather than a widening of the
 * ticket rail's: the two rails offer different pages, and a ticket's empty chat
 * has one visual to choose from, so there is nothing there to remember.
 *
 * `railMode` — which page the ticket rail shows (Now / Diffs / Files).
 * Persisted app-wide like `railCollapsed`. Every value a shipped build could
 * have written stays readable: `resolvePersistedRailMode` maps the retired
 * Sessions/Properties/Session pages, and the pre-icon-rail `detailsExpanded`
 * key, onto the page that absorbed them, and only the resolved page is written
 * back.
 *
 * `diffPresentation` — Monaco diff layout (inline vs side-by-side, CONCEPT #51).
 * Persisted app-wide like `railCollapsed` / `railMode`: it is global chrome, not
 * a per-ticket choice, so every diff tab honors the same presentation.
 *
 * `defaultExternalAppId` — a chosen external app, or explicit `null` for Ask
 * every time. It is app-wide chrome too; a successful Launch Services listing
 * resolves an app removed since the choice was saved back to asking.
 *
 * `terminalFocusTarget` — the terminal tab temporarily owning the app canvas,
 * whether a ticket owns it or the project does. It is deliberately session-only:
 * live PTYs do not survive relaunch, and entering a new app lifetime with its
 * chrome hidden around a missing session would strand the user in an invalid
 * view. The invariant "the target names a tab of the surface that is actually in
 * front" is enforced by whichever surface hosts it — for a ticket target, here
 * at the store layer via `clearTerminalFocusForTicket` /
 * `clearTerminalFocusUnlessTicket` so it doesn't hinge on a particular
 * ticket-detail view staying mounted; for a ticketless one, by `sessions-layer`,
 * which is the app's always-mounted owner of that surface and so needs no
 * store-layer twin. Either way app-shell (which hides all chrome while a target
 * is set) can never be stranded around a session that's gone.
 *
 * Per-workspace UI state (the active nav page) lives in stores/workspace.ts.
 */

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { isKnownExternalAppId } from "../../../external-app-ids";
import type { ExternalApp, ExternalAppId } from "../../../ipc/contract";
import {
  DEFAULT_EMPTY_VISUAL,
  sanitizeEmptyVisual,
  type EmptyVisual,
} from "@renderer/components/chat/empty-visual";
import {
  DEFAULT_HOME_RAIL_MODE,
  sanitizeHomeRailMode,
  type HomeRailMode,
} from "@renderer/components/home/home-rail-model";
import {
  DEFAULT_TICKET_RAIL_MODE,
  type TicketRailMode,
  resolvePersistedRailMode,
} from "@renderer/components/ticket/ticket-rail-model";
import { appStateStorage } from "@renderer/lib/app-state-storage";

export const SIDEBAR_DEFAULT_WIDTH = 318;
export const SIDEBAR_MIN_WIDTH = 280;
export const SIDEBAR_MAX_WIDTH = 640;

export const RAIL_DEFAULT_WIDTH = 300;
// The rail's session rows / properties all wrap in min-w-0 + truncate, so they
// reflow gracefully; 240 is the floor where the "Sessions" header + status chip
// and the History search stay legible without crowding.
export const RAIL_MIN_WIDTH = 240;
export const RAIL_MAX_WIDTH = 560;

/** Monaco diff layout preference (CONCEPT #51). Default inline; optional side-by-side. */
export type DiffPresentation = "inline" | "side-by-side";

const DEFAULT_DIFF_PRESENTATION: DiffPresentation = "inline";

/** A chosen external app, or the explicit preference to ask on every open. */
export type DefaultExternalAppId = ExternalAppId | null;

const DEFAULT_EXTERNAL_APP_ID: DefaultExternalAppId = null;

/** Identity of the terminal tab temporarily owning the app canvas. */
export interface TerminalFocusTarget {
  projectId: string;
  /**
   * The ticket that owns the Session, or `null` for one of the project's
   * ticketless Sessions — Home hosts terminals too, and a PTY there
   * fills a canvas exactly as well as one under a ticket. Not "unknown": it is
   * the same durable fact `projectScope` carries, and it is what the two
   * `clearTerminalFocus*` guards below discriminate on.
   */
  ticketId: string | null;
  /** Root session/tab id; split-pane focus remains owned by the session store. */
  sessionId: string;
}

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function clampRailWidth(width: number): number {
  return Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, Math.round(width)));
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

/** A persisted details-rail width, put back inside its resize grip's bounds. */
function sanitizeRailWidth(width: unknown): number {
  if (typeof width !== "number" || !Number.isFinite(width)) return RAIL_DEFAULT_WIDTH;
  return clampRailWidth(width);
}

/** A persisted Monaco diff layout; unknown/missing values fall back to inline. */
function sanitizeDiffPresentation(presentation: unknown): DiffPresentation {
  return presentation === "inline" || presentation === "side-by-side"
    ? presentation
    : DEFAULT_DIFF_PRESENTATION;
}

/**
 * A persisted preference may only name an app this build knows how to launch.
 * A later successful Launch Services listing reconciles an uninstalled known
 * app through `reconcileDefaultExternalApp` below.
 */
function sanitizeDefaultExternalAppId(appId: unknown): DefaultExternalAppId {
  return isKnownExternalAppId(appId) ? appId : DEFAULT_EXTERNAL_APP_ID;
}

interface UiState {
  sidebarWidth: number;
  /** Ticket-detail right rail width; resizable via its grip, persisted app-wide. */
  railWidth: number;
  uiScale: number;
  settingsOpen: boolean;
  /**
   * Which category Settings should open on, or null for its own default.
   *
   * Session-only beside `settingsOpen`, and read once per opening: the shell
   * takes it as an INITIAL category and owns the selection from there, so
   * navigating inside Settings never writes back here. Set by a surface that
   * already knows where it is sending someone — the chat blocker naming a
   * provider that needs signing in knows the answer is Model Access, and making
   * the user land on General and go find it would be withholding it.
   */
  settingsCategory: string | null;
  /**
   * A provider the opener wants signed in to, alongside `settingsCategory`.
   *
   * Set by a chat blocker that already knows WHICH provider is blocking typing,
   * taken by the Model Access pane, which auto-starts (or offers) that
   * provider's sign-in — the "straight to sign-in" half of first-run onboarding
   * (VC-53).
   *
   * Unlike the category it travels with, this one is SPENT on arrival
   * ({@link UiState.consumeSettingsSignIn}), and spending it is the contract
   * rather than bookkeeping. The shell unmounts a pane when you switch
   * category, so a request still standing here starts a provider's browser auth
   * flow again every time you walk back past Model Access — an external act
   * nobody asked for the second time. One press, one launch.
   */
  settingsSignInProviderId: string | null;
  /** Session-only — never persisted; see module doc. */
  newTicketOpen: boolean;
  /** Project switcher rail hidden? Persisted app-wide (see module doc). */
  workspaceRailHidden: boolean;
  /** Sidebar panel docked rather than summoned on hover? Persisted app-wide (see module doc). */
  sidebarPinned: boolean;
  /** Ticket-detail right rail collapsed? Persisted app-wide (see module doc). */
  railCollapsed: boolean;
  /** Active ticket-rail page. Persisted app-wide (see module doc). */
  railMode: TicketRailMode;
  /** Active Home-rail page. Persisted app-wide (see module doc). */
  homeRailMode: HomeRailMode;
  /** Which drawing a Project Session's empty chat opens on. Persisted app-wide. */
  homeEmptyVisual: EmptyVisual;
  /** Monaco diff presentation. Persisted app-wide (see module doc). */
  diffPresentation: DiffPresentation;
  /** Chosen external app, or explicit Ask every time. Persisted app-wide. */
  defaultExternalAppId: DefaultExternalAppId;
  /** Session-only terminal focus target; never persisted. */
  terminalFocusTarget: TerminalFocusTarget | null;
  setSidebarWidth(width: number): void;
  setRailWidth(width: number): void;
  stepUiScale(delta: 1 | -1): void;
  /**
   * Sets zoom to one rung of {@link UI_SCALE_STEPS}, snapping anything else.
   *
   * The snap is not politeness: `uiScale` is applied verbatim as CSS `zoom`,
   * so an off-ladder value is an untested layout and a corrupt one (`0`, NaN)
   * renders the entire app below the chrome band invisible — with the
   * zoom-reset menu item unreachable by mouse.
   */
  setUiScale(scale: number): void;
  resetUiScale(): void;
  setSettingsOpen(open: boolean, category?: string, signInProviderId?: string): void;
  /**
   * Spend the deep-linked sign-in request: the Model Access pane calls this as
   * it takes {@link UiState.settingsSignInProviderId}, so its next mount arrives
   * asking for nothing.
   *
   * Leaves `settingsCategory` alone. That one is read by the shell once per
   * opening and never re-read, and re-reading it would cost a selected rail row
   * anyway — not an auth flow.
   */
  consumeSettingsSignIn(): void;
  setNewTicketOpen(open: boolean): void;
  toggleWorkspaceRailHidden(): void;
  setWorkspaceRailHidden(hidden: boolean): void;
  setSidebarPinned(pinned: boolean): void;
  toggleRailCollapsed(): void;
  setRailCollapsed(collapsed: boolean): void;
  setRailMode(mode: TicketRailMode): void;
  setHomeRailMode(mode: HomeRailMode): void;
  setHomeEmptyVisual(visual: EmptyVisual): void;
  setDiffPresentation(presentation: DiffPresentation): void;
  setDefaultExternalAppId(appId: DefaultExternalAppId): void;
  /**
   * Reconcile the persisted choice against a successful Launch Services list.
   * A failed listing says nothing about what is installed, so callers only use
   * this after an `{ ok: true }` result.
   */
  reconcileDefaultExternalApp(apps: readonly ExternalApp[]): void;
  setTerminalFocusTarget(target: TerminalFocusTarget | null): void;
  /**
   * Clear the focus target if it belongs to `ticketId` — used when that ticket's
   * detail view is torn down (or the ticket is closed back to the board): the
   * PTY it named is leaving the canvas, so ordinary chrome must return.
   */
  clearTerminalFocusForTicket(ticketId: string): void;
  /**
   * Enforce that the focus target names a tab of the currently open ticket:
   * clear it unless it belongs to `ticketId`. Callers invoke this whenever the
   * open ticket changes, so a target left over from a previous ticket can't
   * strand app-shell with all chrome hidden — the guarantee no longer depends on
   * a specific ticket-detail instance staying mounted to notice the change.
   *
   * A ticketless target (`ticketId: null`) is cleared too, and that is right
   * rather than incidental: a ticket has just come to the front, so a terminal
   * on one of Home's own Session tabs is by definition no longer the thing on
   * screen.
   */
  clearTerminalFocusUnlessTicket(ticketId: string): void;
}

type PersistedUiState = Pick<
  UiState,
  | "sidebarWidth"
  | "railWidth"
  | "uiScale"
  | "workspaceRailHidden"
  | "sidebarPinned"
  | "railCollapsed"
  | "railMode"
  | "homeRailMode"
  | "homeEmptyVisual"
  | "diffPresentation"
  | "defaultExternalAppId"
> & {
  /** Legacy pre-icon-rail key; read on merge only, never written again. */
  detailsExpanded?: boolean;
};

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
        railWidth: RAIL_DEFAULT_WIDTH,
        uiScale: UI_SCALE_DEFAULT,
        settingsOpen: false,
        settingsCategory: null,
        settingsSignInProviderId: null,
        newTicketOpen: false,
        workspaceRailHidden: false,
        sidebarPinned: true,
        railCollapsed: false,
        railMode: DEFAULT_TICKET_RAIL_MODE,
        homeRailMode: DEFAULT_HOME_RAIL_MODE,
        homeEmptyVisual: DEFAULT_EMPTY_VISUAL,
        diffPresentation: DEFAULT_DIFF_PRESENTATION,
        defaultExternalAppId: DEFAULT_EXTERNAL_APP_ID,
        terminalFocusTarget: null,
        setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
        setRailWidth: (width) => set({ railWidth: clampRailWidth(width) }),
        stepUiScale: (delta) => set((state) => ({ uiScale: steppedScale(state.uiScale, delta) })),
        setUiScale: (scale) => set({ uiScale: sanitizeUiScale(scale) }),
        resetUiScale: () => set({ uiScale: UI_SCALE_DEFAULT }),
        setSettingsOpen: (open, category, signInProviderId) =>
          set({
            settingsOpen: open,
            settingsCategory: category ?? null,
            settingsSignInProviderId: signInProviderId ?? null,
          }),
        consumeSettingsSignIn: () => set({ settingsSignInProviderId: null }),
        setNewTicketOpen: (open) => set({ newTicketOpen: open }),
        toggleWorkspaceRailHidden: () =>
          set((state) => ({ workspaceRailHidden: !state.workspaceRailHidden })),
        setWorkspaceRailHidden: (hidden) => set({ workspaceRailHidden: hidden }),
        setSidebarPinned: (pinned) => set({ sidebarPinned: pinned }),
        toggleRailCollapsed: () => set((state) => ({ railCollapsed: !state.railCollapsed })),
        setRailCollapsed: (collapsed) => set({ railCollapsed: collapsed }),
        setRailMode: (mode) => set({ railMode: mode }),
        setHomeRailMode: (mode) => set({ homeRailMode: mode }),
        setHomeEmptyVisual: (visual) => set({ homeEmptyVisual: visual }),
        setDiffPresentation: (presentation) => set({ diffPresentation: presentation }),
        setDefaultExternalAppId: (appId) => set({ defaultExternalAppId: appId }),
        reconcileDefaultExternalApp: (apps) =>
          set((state) =>
            state.defaultExternalAppId !== null &&
            !apps.some((app) => app.id === state.defaultExternalAppId)
              ? { defaultExternalAppId: DEFAULT_EXTERNAL_APP_ID }
              : {},
          ),
        setTerminalFocusTarget: (target) => set({ terminalFocusTarget: target }),
        clearTerminalFocusForTicket: (ticketId) =>
          set((state) =>
            state.terminalFocusTarget?.ticketId === ticketId ? { terminalFocusTarget: null } : {},
          ),
        clearTerminalFocusUnlessTicket: (ticketId) =>
          set((state) =>
            state.terminalFocusTarget !== null && state.terminalFocusTarget.ticketId !== ticketId
              ? { terminalFocusTarget: null }
              : {},
          ),
      }),
      {
        name: "volli:ui",
        version: 1,
        storage: createJSONStorage(() => storage ?? appStateStorage),
        skipHydration: storage === undefined,
        // A missing `uiScale` key (pre-zoom persisted state) just defaults to 1.
        partialize: (state): PersistedUiState => ({
          sidebarWidth: state.sidebarWidth,
          railWidth: state.railWidth,
          uiScale: state.uiScale,
          workspaceRailHidden: state.workspaceRailHidden,
          sidebarPinned: state.sidebarPinned,
          railCollapsed: state.railCollapsed,
          railMode: state.railMode,
          homeRailMode: state.homeRailMode,
          homeEmptyVisual: state.homeEmptyVisual,
          diffPresentation: state.diffPresentation,
          defaultExternalAppId: state.defaultExternalAppId,
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
            railWidth: sanitizeRailWidth(stored.railWidth),
            uiScale: sanitizeUiScale(stored.uiScale),
            // Missing/corrupt state from an older build keeps the switcher
            // visible so projects never become unexpectedly undiscoverable.
            workspaceRailHidden: stored.workspaceRailHidden === true,
            // The opposite default to the line above, for the same reason:
            // anything other than an explicit `false` leaves the panel standing,
            // so a missing key or corrupt JSON can never open the app on a
            // sidebar the reader has to know to summon.
            sidebarPinned: stored.sidebarPinned !== false,
            // Any non-`true` persisted value (missing key, corrupt JSON) means
            // the rail stays expanded — the safe, visible default.
            railCollapsed: stored.railCollapsed === true,
            // Prefer a page this build still offers; otherwise land a retired
            // page (or the legacy Details drawer) on the one that absorbed it.
            railMode: resolvePersistedRailMode({
              railMode: stored.railMode,
              detailsExpanded: stored.detailsExpanded,
            }),
            // Same discipline for Home's two: a page or a visual this build no
            // longer offers lands on the one it opens with.
            homeRailMode: sanitizeHomeRailMode(stored.homeRailMode),
            homeEmptyVisual: sanitizeEmptyVisual(stored.homeEmptyVisual),
            // Missing/unknown presentation (older build, corrupt JSON) keeps
            // the CONCEPT #51 default of inline.
            diffPresentation: sanitizeDiffPresentation(stored.diffPresentation),
            defaultExternalAppId: sanitizeDefaultExternalAppId(stored.defaultExternalAppId),
          };
        },
      },
    ),
  );
}

/** App-wide singleton; components import this directly. */
export const useUiStore = createUiStore();
