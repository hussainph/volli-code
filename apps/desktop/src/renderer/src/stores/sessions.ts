/**
 * Per-workspace terminal tabs and app-owned split trees.
 *
 * A split leaf is the ownership boundary: exactly one renderer engine and one
 * main-process PTY session. Layout nodes own geometry only. This mirrors
 * Ghostty/cmux, where a split inserts a fresh terminal surface instead of
 * asking one renderer instance to paint the same PTY into another canvas.
 */
import { create } from "zustand";

export type TerminalSplitDirection = "vertical" | "horizontal";

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
  /** The root pane's session id is also the stable tab id. */
  sessionId: string;
  title: string;
  layout: SessionLayout;
  activePaneId: string;
}

export interface ProjectSessions {
  tabs: SessionTab[];
  activeSessionId: string | null;
  /** Monotonic title counter — closed tab numbers are never reused. */
  nextTabNumber: number;
}

interface SessionsState {
  byProject: Record<string, ProjectSessions>;
  /** Projects with any terminal-create (tab or split leaf) in flight. */
  startingProjects: Record<string, true>;
  addSession(projectId: string, sessionId: string): void;
  /** Insert a fresh PTY/engine as a sibling of sourcePaneId. */
  addSplit(
    projectId: string,
    tabId: string,
    sourcePaneId: string,
    sessionId: string,
    direction: TerminalSplitDirection,
  ): void;
  closeSession(projectId: string, tabId: string): void;
  closePane(projectId: string, tabId: string, sessionId: string): void;
  setActiveSession(projectId: string, tabId: string): void;
  setActivePane(projectId: string, tabId: string, sessionId: string): void;
  setSplitRatio(projectId: string, tabId: string, splitId: string, ratio: number): void;
  markExited(sessionId: string, exitCode: number): void;
  setStarting(projectId: string, starting: boolean): void;
  forgetProject(projectId: string): void;
}

const EMPTY_PROJECT: ProjectSessions = { tabs: [], activeSessionId: null, nextTabNumber: 1 };

export function sessionPanes(layout: SessionLayout): SessionPane[] {
  return layout.kind === "pane"
    ? [layout]
    : [...sessionPanes(layout.first), ...sessionPanes(layout.second)];
}

export function findSessionPane(layout: SessionLayout, sessionId: string): SessionPane | null {
  if (layout.kind === "pane") return layout.sessionId === sessionId ? layout : null;
  return findSessionPane(layout.first, sessionId) ?? findSessionPane(layout.second, sessionId);
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

/** Factory so tests get isolated instances. */
export function createSessionsStore() {
  return create<SessionsState>()((set) => ({
    byProject: {},
    startingProjects: {},

    addSession(projectId, sessionId) {
      set((state) => {
        const current = state.byProject[projectId] ?? EMPTY_PROJECT;
        if (current.tabs.some((tab) => findSessionPane(tab.layout, sessionId) !== null)) {
          return state;
        }
        const tab: SessionTab = {
          sessionId,
          title: `Terminal ${current.nextTabNumber}`,
          layout: { kind: "pane", sessionId, exitCode: null },
          activePaneId: sessionId,
        };
        return {
          byProject: {
            ...state.byProject,
            [projectId]: {
              tabs: [...current.tabs, tab],
              activeSessionId: sessionId,
              nextTabNumber: current.nextTabNumber + 1,
            },
          },
        };
      });
    },

    addSplit(projectId, tabId, sourcePaneId, sessionId, direction) {
      set((state) => {
        const current = state.byProject[projectId];
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
          byProject: { ...state.byProject, [projectId]: { ...current, tabs } },
        };
      });
    },

    closeSession(projectId, tabId) {
      set((state) => {
        const current = state.byProject[projectId];
        if (current === undefined) return state;
        const removedIndex = current.tabs.findIndex((tab) => tab.sessionId === tabId);
        if (removedIndex === -1) return state;
        const tabs = current.tabs.filter((tab) => tab.sessionId !== tabId);
        let activeSessionId = current.activeSessionId;
        if (activeSessionId === tabId) {
          activeSessionId =
            tabs.length === 0 ? null : tabs[Math.min(removedIndex, tabs.length - 1)]!.sessionId;
        }
        return {
          byProject: { ...state.byProject, [projectId]: { ...current, tabs, activeSessionId } },
        };
      });
    },

    closePane(projectId, tabId, sessionId) {
      set((state) => {
        const current = state.byProject[projectId];
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
        return { byProject: { ...state.byProject, [projectId]: { ...current, tabs } } };
      });
    },

    setActiveSession(projectId, tabId) {
      set((state) => {
        const current = state.byProject[projectId];
        if (current === undefined || !current.tabs.some((tab) => tab.sessionId === tabId)) {
          return state;
        }
        return {
          byProject: {
            ...state.byProject,
            [projectId]: { ...current, activeSessionId: tabId },
          },
        };
      });
    },

    setActivePane(projectId, tabId, sessionId) {
      set((state) => {
        const current = state.byProject[projectId];
        if (current === undefined) return state;
        const tabIndex = current.tabs.findIndex((tab) => tab.sessionId === tabId);
        const tab = current.tabs[tabIndex];
        if (tab === undefined || findSessionPane(tab.layout, sessionId) === null) return state;
        if (tab.activePaneId === sessionId) return state;
        const tabs = current.tabs.slice();
        tabs[tabIndex] = { ...tab, activePaneId: sessionId };
        return { byProject: { ...state.byProject, [projectId]: { ...current, tabs } } };
      });
    },

    setSplitRatio(projectId, tabId, splitId, ratio) {
      set((state) => {
        const current = state.byProject[projectId];
        if (current === undefined) return state;
        const tabIndex = current.tabs.findIndex((tab) => tab.sessionId === tabId);
        const tab = current.tabs[tabIndex];
        if (tab === undefined) return state;
        const clamped = Math.min(0.9, Math.max(0.1, ratio));
        const layout = updateSplitRatio(tab.layout, splitId, clamped);
        if (layout === tab.layout) return state;
        const tabs = current.tabs.slice();
        tabs[tabIndex] = { ...tab, layout };
        return { byProject: { ...state.byProject, [projectId]: { ...current, tabs } } };
      });
    },

    markExited(sessionId, exitCode) {
      set((state) => {
        for (const [projectId, current] of Object.entries(state.byProject)) {
          const tabIndex = current.tabs.findIndex(
            (tab) => findSessionPane(tab.layout, sessionId) !== null,
          );
          const tab = current.tabs[tabIndex];
          if (tab === undefined) continue;
          const tabs = current.tabs.slice();
          tabs[tabIndex] = { ...tab, layout: updateExitCode(tab.layout, sessionId, exitCode) };
          return { byProject: { ...state.byProject, [projectId]: { ...current, tabs } } };
        }
        return state;
      });
    },

    setStarting(projectId, starting) {
      set((state) => {
        const isStarting = projectId in state.startingProjects;
        if (starting === isStarting) return state;
        const startingProjects = { ...state.startingProjects };
        if (starting) startingProjects[projectId] = true;
        else delete startingProjects[projectId];
        return { startingProjects };
      });
    },

    forgetProject(projectId) {
      set((state) => {
        const hasSessions = projectId in state.byProject;
        const hasStarting = projectId in state.startingProjects;
        if (!hasSessions && !hasStarting) return state;
        const byProject = { ...state.byProject };
        delete byProject[projectId];
        const startingProjects = { ...state.startingProjects };
        delete startingProjects[projectId];
        return { byProject, startingProjects };
      });
    },
  }));
}

export const useSessionsStore = createSessionsStore();
