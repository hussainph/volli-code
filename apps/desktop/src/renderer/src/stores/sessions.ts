/**
 * The unified terminal-session store: ONE resident model for both project
 * scratch sessions (CONTEXT.md's "Scratch session") and ticket-scoped sessions
 * (ticket-detail-mvp decision #19). Every tab carries a {@link SessionScope}
 * discriminator; the always-mounted sessions layer reads it to route each live
 * terminal to its surface (the Sessions page for scratch, a rect-synced overlay
 * over the ticket plane for ticket sessions). Both scopes get the full split
 * tree, activity tracking, and rename.
 *
 * A split leaf is the ownership boundary: exactly one renderer engine and one
 * main-process PTY session. Layout nodes own geometry only. This mirrors
 * Ghostty/cmux, where a split inserts a fresh terminal surface instead of
 * asking one renderer instance to paint the same PTY into another canvas.
 *
 * Containers live in `byOwner`, keyed by the scope's OWNER id — a projectId for
 * scratch, a ticketId for ticket sessions (distinct UUID spaces, so one flat
 * map never collides). Cross-cutting, sessionId-addressed actions (markExited,
 * bumpOutput, renameSession) route through the `sessionOwner` index so the
 * per-chunk hot path stays O(1).
 */
import { create } from "zustand";
import type { SessionActivityState } from "@volli/shared";

export type TerminalSplitDirection = "vertical" | "horizontal";

/**
 * What a session is scoped to, stamped on every tab. `scratch` runs at the
 * project's main checkout with no board involvement; `ticket` is ticket-scoped
 * (env-injected PTY in main) and hosts in the ticket detail's tab plane. Both
 * carry `projectId` so a split can re-boot its PTY (cwd + optional ticket env)
 * without another lookup.
 */
export type SessionScope =
  | { kind: "scratch"; projectId: string }
  | { kind: "ticket"; projectId: string; ticketId: string };

/** The container key for a scope: projectId for scratch, ticketId for ticket. */
export function ownerKey(scope: SessionScope): string {
  return scope.kind === "scratch" ? scope.projectId : scope.ticketId;
}

/** A project's scratch-session scope. */
export function scratchScope(projectId: string): SessionScope {
  return { kind: "scratch", projectId };
}

/** A ticket's session scope. */
export function ticketScope(projectId: string, ticketId: string): SessionScope {
  return { kind: "ticket", projectId, ticketId };
}

export interface SessionPane {
  kind: "pane";
  sessionId: string;
  /** null while the pane's PTY is live; the shell's exit code once exited. */
  exitCode: number | null;
}

export interface SessionSplit {
  kind: "split";
  /** Stable identity for resizing this layout node. */
  id: string;
  /** vertical = left/right; horizontal = top/bottom (restty/Ghostty naming). */
  direction: TerminalSplitDirection;
  ratio: number;
  first: SessionLayout;
  second: SessionLayout;
}

export type SessionLayout = SessionPane | SessionSplit;

export interface SessionTab {
  /** The root pane's session id is also the stable tab id and the durable record id. */
  sessionId: string;
  title: string;
  /** Where this session lives (scratch vs ticket) — the layer routes rendering off this. */
  scope: SessionScope;
  layout: SessionLayout;
  activePaneId: string;
}

export interface SessionContainer {
  tabs: SessionTab[];
  activeSessionId: string | null;
}

/** Output within this window reads as `working`; quiet-but-live reads as `idle`. */
const WORKING_WINDOW_MS = 10_000;
/** Coalesce output bumps: at most one `lastOutputAt` write per session per second. */
const OUTPUT_THROTTLE_MS = 1_000;

/**
 * Honest PTY-derived session status (ticket-detail-mvp decision #5): `working`
 * when output landed within ~10s, `idle` when live but quiet, `exited` once the
 * shell is gone. Pure so the derivation is unit-tested independent of the clock;
 * hook-driven states (waiting-for-input, …) reuse this vocabulary later.
 */
export function sessionActivityState(
  lastOutputAt: number | null,
  exited: boolean,
  now: number,
): SessionActivityState {
  if (exited) return "exited";
  if (lastOutputAt !== null && now - lastOutputAt <= WORKING_WINDOW_MS) return "working";
  return "idle";
}

interface SessionsState {
  /** Session containers keyed by owner id (projectId for scratch, ticketId for ticket). */
  byOwner: Record<string, SessionContainer>;
  /** sessionId → owning container key; the O(1) routing index for the hot path and rename. */
  sessionOwner: Record<string, string>;
  /** sessionId → last PTY-output time (ms) — feeds the working/idle derivation for all sessions. */
  lastOutputAt: Record<string, number>;
  /** Owner ids with a terminal-create (tab or split leaf) in flight — disables their "New session". */
  starting: Record<string, true>;
  /**
   * Adds a fresh single-pane tab titled `title`. Main seeds every tab title on
   * the durable record (`Session N` for ticket sessions, `Terminal N` for
   * scratch) and the sole product caller always forwards it, so the title is
   * required here — no store-side fallback counter.
   */
  addSession(scope: SessionScope, sessionId: string, title: string): void;
  /** Insert a fresh PTY/engine as a sibling of sourcePaneId. */
  addSplit(
    ownerId: string,
    tabId: string,
    sourcePaneId: string,
    sessionId: string,
    direction: TerminalSplitDirection,
  ): void;
  closeSession(ownerId: string, tabId: string): void;
  closePane(ownerId: string, tabId: string, sessionId: string): void;
  setActiveSession(ownerId: string, tabId: string): void;
  setActivePane(ownerId: string, tabId: string, sessionId: string): void;
  setSplitRatio(ownerId: string, tabId: string, splitId: string, ratio: number): void;
  /** Optimistically retitle a tab (its persistence + revert-on-failure lives in session-lifecycle). */
  renameSession(sessionId: string, title: string): void;
  markExited(sessionId: string, exitCode: number): void;
  bumpOutput(sessionId: string, now: number): void;
  setStarting(ownerId: string, starting: boolean): void;
  forgetOwner(ownerId: string): void;
}

const EMPTY_CONTAINER: SessionContainer = { tabs: [], activeSessionId: null };

export function sessionPanes(layout: SessionLayout): SessionPane[] {
  return layout.kind === "pane"
    ? [layout]
    : [...sessionPanes(layout.first), ...sessionPanes(layout.second)];
}

export function findSessionPane(layout: SessionLayout, sessionId: string): SessionPane | null {
  if (layout.kind === "pane") return layout.sessionId === sessionId ? layout : null;
  return findSessionPane(layout.first, sessionId) ?? findSessionPane(layout.second, sessionId);
}

/** The owning container key + tab for a tab's root sessionId, or null. Reads across every owner. */
export function findTabBySessionId(
  byOwner: Record<string, SessionContainer>,
  sessionId: string,
): { ownerId: string; tab: SessionTab } | null {
  for (const [ownerId, container] of Object.entries(byOwner)) {
    const tab = container.tabs.find((candidate) => candidate.sessionId === sessionId);
    if (tab !== undefined) return { ownerId, tab };
  }
  return null;
}

function replacePaneWithSplit(
  layout: SessionLayout,
  sourcePaneId: string,
  sessionId: string,
  direction: TerminalSplitDirection,
): SessionLayout {
  if (layout.kind === "pane") {
    if (layout.sessionId !== sourcePaneId) return layout;
    return {
      kind: "split",
      id: sessionId,
      direction,
      ratio: 0.5,
      first: layout,
      second: { kind: "pane", sessionId, exitCode: null },
    };
  }
  const first = replacePaneWithSplit(layout.first, sourcePaneId, sessionId, direction);
  if (first !== layout.first) return { ...layout, first };
  const second = replacePaneWithSplit(layout.second, sourcePaneId, sessionId, direction);
  return second === layout.second ? layout : { ...layout, second };
}

function removePane(layout: SessionLayout, sessionId: string): SessionLayout | null {
  if (layout.kind === "pane") return layout.sessionId === sessionId ? null : layout;
  const first = removePane(layout.first, sessionId);
  const second = removePane(layout.second, sessionId);
  if (first === null) return second;
  if (second === null) return first;
  if (first === layout.first && second === layout.second) return layout;
  return { ...layout, first, second };
}

function updateSplitRatio(layout: SessionLayout, splitId: string, ratio: number): SessionLayout {
  if (layout.kind === "pane") return layout;
  if (layout.id === splitId) return { ...layout, ratio };
  const first = updateSplitRatio(layout.first, splitId, ratio);
  const second = updateSplitRatio(layout.second, splitId, ratio);
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second };
}

function updateExitCode(layout: SessionLayout, sessionId: string, exitCode: number): SessionLayout {
  if (layout.kind === "pane") {
    return layout.sessionId === sessionId ? { ...layout, exitCode } : layout;
  }
  const first = updateExitCode(layout.first, sessionId, exitCode);
  const second = updateExitCode(layout.second, sessionId, exitCode);
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second };
}

/** Drop every one of a tab's pane sessions from the routing + activity indexes. */
function forgetTabIndexes(
  sessionOwner: Record<string, string>,
  lastOutputAt: Record<string, number>,
  tab: SessionTab,
): void {
  for (const pane of sessionPanes(tab.layout)) {
    delete sessionOwner[pane.sessionId];
    delete lastOutputAt[pane.sessionId];
  }
  // Also clear the tab-root routing entry: `closePane` deliberately RETAINS
  // `sessionOwner[tab.sessionId]` when the root pane is closed (the id stays the
  // tab's stable identity for rename/routing), so the root id may no longer be
  // among the current panes above — drop it explicitly on tab teardown.
  delete sessionOwner[tab.sessionId];
  delete lastOutputAt[tab.sessionId];
}

/** Factory so tests get isolated instances. */
export function createSessionsStore() {
  return create<SessionsState>()((set) => ({
    byOwner: {},
    sessionOwner: {},
    lastOutputAt: {},
    starting: {},

    addSession(scope, sessionId, title) {
      set((state) => {
        const id = ownerKey(scope);
        const current = state.byOwner[id] ?? EMPTY_CONTAINER;
        if (current.tabs.some((tab) => findSessionPane(tab.layout, sessionId) !== null)) {
          return state;
        }
        const tab: SessionTab = {
          sessionId,
          title,
          scope,
          layout: { kind: "pane", sessionId, exitCode: null },
          activePaneId: sessionId,
        };
        return {
          byOwner: {
            ...state.byOwner,
            [id]: { tabs: [...current.tabs, tab], activeSessionId: sessionId },
          },
          sessionOwner: { ...state.sessionOwner, [sessionId]: id },
        };
      });
    },

    addSplit(ownerId, tabId, sourcePaneId, sessionId, direction) {
      set((state) => {
        const current = state.byOwner[ownerId];
        if (current === undefined) return state;
        if (current.tabs.some((tab) => findSessionPane(tab.layout, sessionId) !== null)) {
          return state;
        }
        const tabIndex = current.tabs.findIndex((tab) => tab.sessionId === tabId);
        const tab = current.tabs[tabIndex];
        if (tab === undefined || findSessionPane(tab.layout, sourcePaneId) === null) return state;
        const layout = replacePaneWithSplit(tab.layout, sourcePaneId, sessionId, direction);
        const tabs = current.tabs.slice();
        tabs[tabIndex] = { ...tab, layout, activePaneId: sessionId };
        return {
          byOwner: { ...state.byOwner, [ownerId]: { ...current, tabs } },
          sessionOwner: { ...state.sessionOwner, [sessionId]: ownerId },
        };
      });
    },

    closeSession(ownerId, tabId) {
      set((state) => {
        const current = state.byOwner[ownerId];
        if (current === undefined) return state;
        const removedIndex = current.tabs.findIndex((tab) => tab.sessionId === tabId);
        if (removedIndex === -1) return state;
        const removed = current.tabs[removedIndex]!;
        const tabs = current.tabs.filter((tab) => tab.sessionId !== tabId);
        let activeSessionId = current.activeSessionId;
        if (activeSessionId === tabId) {
          activeSessionId =
            tabs.length === 0 ? null : tabs[Math.min(removedIndex, tabs.length - 1)]!.sessionId;
        }
        const sessionOwner = { ...state.sessionOwner };
        const lastOutputAt = { ...state.lastOutputAt };
        forgetTabIndexes(sessionOwner, lastOutputAt, removed);
        return {
          byOwner: { ...state.byOwner, [ownerId]: { ...current, tabs, activeSessionId } },
          sessionOwner,
          lastOutputAt,
        };
      });
    },

    closePane(ownerId, tabId, sessionId) {
      set((state) => {
        const current = state.byOwner[ownerId];
        if (current === undefined) return state;
        const tabIndex = current.tabs.findIndex((tab) => tab.sessionId === tabId);
        const tab = current.tabs[tabIndex];
        if (tab === undefined) return state;
        const before = sessionPanes(tab.layout);
        const removedIndex = before.findIndex((pane) => pane.sessionId === sessionId);
        if (removedIndex === -1 || before.length <= 1) return state;
        // A known leaf in a 2+ pane tree cannot remove the whole tree.
        const layout = removePane(tab.layout, sessionId)!;
        const remaining = sessionPanes(layout);
        const activePaneId =
          tab.activePaneId === sessionId
            ? remaining[Math.min(removedIndex, remaining.length - 1)]!.sessionId
            : tab.activePaneId;
        const tabs = current.tabs.slice();
        tabs[tabIndex] = { ...tab, layout, activePaneId };
        const sessionOwner = { ...state.sessionOwner };
        const lastOutputAt = { ...state.lastOutputAt };
        // `lastOutputAt` is keyed per-pane, so the closed pane's entry always
        // goes — it can no longer produce output.
        delete lastOutputAt[sessionId];
        // `sessionOwner` routes rename/exit lookups. Asymmetry: when the closed
        // pane IS the tab root (sessionId === tabId), the tab keeps that id as
        // its stable identity — rename/routing still resolve through it — so we
        // must NOT drop its routing entry here, or a later rename would silently
        // no-op while the DB write lands (UI/SQLite titles diverge). Only a
        // non-root pane's entry is dropped now; the retained root entry is
        // cleared by `forgetTabIndexes` when the whole tab closes.
        if (sessionId !== tabId) delete sessionOwner[sessionId];
        return {
          byOwner: { ...state.byOwner, [ownerId]: { ...current, tabs } },
          sessionOwner,
          lastOutputAt,
        };
      });
    },

    setActiveSession(ownerId, tabId) {
      set((state) => {
        const current = state.byOwner[ownerId];
        if (current === undefined || !current.tabs.some((tab) => tab.sessionId === tabId)) {
          return state;
        }
        return {
          byOwner: { ...state.byOwner, [ownerId]: { ...current, activeSessionId: tabId } },
        };
      });
    },

    setActivePane(ownerId, tabId, sessionId) {
      set((state) => {
        const current = state.byOwner[ownerId];
        if (current === undefined) return state;
        const tabIndex = current.tabs.findIndex((tab) => tab.sessionId === tabId);
        const tab = current.tabs[tabIndex];
        if (tab === undefined || findSessionPane(tab.layout, sessionId) === null) return state;
        if (tab.activePaneId === sessionId) return state;
        const tabs = current.tabs.slice();
        tabs[tabIndex] = { ...tab, activePaneId: sessionId };
        return { byOwner: { ...state.byOwner, [ownerId]: { ...current, tabs } } };
      });
    },

    setSplitRatio(ownerId, tabId, splitId, ratio) {
      set((state) => {
        const current = state.byOwner[ownerId];
        if (current === undefined) return state;
        const tabIndex = current.tabs.findIndex((tab) => tab.sessionId === tabId);
        const tab = current.tabs[tabIndex];
        if (tab === undefined) return state;
        const clamped = Math.min(0.9, Math.max(0.1, ratio));
        const layout = updateSplitRatio(tab.layout, splitId, clamped);
        if (layout === tab.layout) return state;
        const tabs = current.tabs.slice();
        tabs[tabIndex] = { ...tab, layout };
        return { byOwner: { ...state.byOwner, [ownerId]: { ...current, tabs } } };
      });
    },

    renameSession(sessionId, title) {
      set((state) => {
        const ownerId = state.sessionOwner[sessionId];
        if (ownerId === undefined) return state;
        const current = state.byOwner[ownerId];
        if (current === undefined) return state;
        const tabIndex = current.tabs.findIndex((tab) => tab.sessionId === sessionId);
        const tab = current.tabs[tabIndex];
        if (tab === undefined || tab.title === title) return state;
        const tabs = current.tabs.slice();
        tabs[tabIndex] = { ...tab, title };
        return { byOwner: { ...state.byOwner, [ownerId]: { ...current, tabs } } };
      });
    },

    markExited(sessionId, exitCode) {
      set((state) => {
        const ownerId = state.sessionOwner[sessionId];
        if (ownerId === undefined) return state;
        const current = state.byOwner[ownerId];
        if (current === undefined) return state;
        const tabIndex = current.tabs.findIndex(
          (tab) => findSessionPane(tab.layout, sessionId) !== null,
        );
        const tab = current.tabs[tabIndex];
        if (tab === undefined) return state;
        const tabs = current.tabs.slice();
        tabs[tabIndex] = { ...tab, layout: updateExitCode(tab.layout, sessionId, exitCode) };
        return { byOwner: { ...state.byOwner, [ownerId]: { ...current, tabs } } };
      });
    },

    bumpOutput(sessionId, now) {
      set((state) => {
        // Hot path: runs for EVERY chunk of EVERY live session. The O(1)
        // ownership lookup gates first (an unknown/closed session early-returns
        // for free), then the ≥1s throttle, and only then a state write.
        if (!(sessionId in state.sessionOwner)) return state;
        const last = state.lastOutputAt[sessionId] ?? 0;
        if (now - last < OUTPUT_THROTTLE_MS) return state;
        return { lastOutputAt: { ...state.lastOutputAt, [sessionId]: now } };
      });
    },

    setStarting(ownerId, starting) {
      set((state) => {
        const isStarting = ownerId in state.starting;
        if (starting === isStarting) return state;
        const next = { ...state.starting };
        if (starting) next[ownerId] = true;
        else delete next[ownerId];
        return { starting: next };
      });
    },

    forgetOwner(ownerId) {
      set((state) => {
        const current = state.byOwner[ownerId];
        const hadStarting = ownerId in state.starting;
        if (current === undefined && !hadStarting) return state;
        const byOwner = { ...state.byOwner };
        delete byOwner[ownerId];
        const starting = { ...state.starting };
        delete starting[ownerId];
        const sessionOwner = { ...state.sessionOwner };
        const lastOutputAt = { ...state.lastOutputAt };
        for (const tab of current?.tabs ?? []) {
          forgetTabIndexes(sessionOwner, lastOutputAt, tab);
        }
        return { byOwner, starting, sessionOwner, lastOutputAt };
      });
    },
  }));
}

export const useSessionsStore = createSessionsStore();
