/**
 * Per-workspace terminal sessions, keyed by project id. Each project owns an
 * ordered list of tabs and its own active tab, so switching workspaces
 * restores the same terminal you left running in each one.
 *
 * Deliberately session-only (no `persist`): a tab maps to a live PTY in the
 * main process, and PTYs die with the app — a rehydrated tab pointing at a
 * dead sessionId would be a lie. The renderer's terminal layer owns the live
 * engine/PTY lifecycle; this store is the pure, observable record of which
 * tabs exist and which is focused.
 */
import { create } from "zustand";

/** One terminal tab. `exitCode` flips non-null once its PTY has exited. */
export interface SessionTab {
  sessionId: string;
  title: string;
  /** null while the PTY is live; the shell's exit code once it has exited. */
  exitCode: number | null;
}

export interface ProjectSessions {
  tabs: SessionTab[];
  activeSessionId: string | null;
}

interface SessionsState {
  byProject: Record<string, ProjectSessions>;
  /** Append a tab for a freshly-created PTY session and focus it. */
  addSession(projectId: string, sessionId: string, title: string): void;
  /** Remove a tab, selecting a neighbor like the project rail does. */
  closeSession(projectId: string, sessionId: string): void;
  setActiveSession(projectId: string, sessionId: string): void;
  renameSession(projectId: string, sessionId: string, title: string): void;
  /** Record a PTY exit on whichever project owns the session. */
  markExited(sessionId: string, exitCode: number): void;
  /** Drop every session for a removed project. */
  forgetProject(projectId: string): void;
}

const EMPTY_PROJECT: ProjectSessions = { tabs: [], activeSessionId: null };

/** Factory so tests get isolated instances. */
export function createSessionsStore() {
  return create<SessionsState>()((set) => ({
    byProject: {},

    addSession(projectId, sessionId, title) {
      set((state) => {
        const current = state.byProject[projectId] ?? EMPTY_PROJECT;
        if (current.tabs.some((tab) => tab.sessionId === sessionId)) return state;
        const tab: SessionTab = { sessionId, title, exitCode: null };
        return {
          byProject: {
            ...state.byProject,
            [projectId]: { tabs: [...current.tabs, tab], activeSessionId: sessionId },
          },
        };
      });
    },

    closeSession(projectId, sessionId) {
      set((state) => {
        const current = state.byProject[projectId];
        if (current === undefined) return state;
        const removedIndex = current.tabs.findIndex((tab) => tab.sessionId === sessionId);
        if (removedIndex === -1) return state;

        const tabs = current.tabs.filter((tab) => tab.sessionId !== sessionId);
        // Closing a background tab never moves focus.
        let activeSessionId = current.activeSessionId;
        if (activeSessionId === sessionId) {
          activeSessionId =
            tabs.length === 0 ? null : tabs[Math.min(removedIndex, tabs.length - 1)]!.sessionId;
        }
        return { byProject: { ...state.byProject, [projectId]: { tabs, activeSessionId } } };
      });
    },

    setActiveSession(projectId, sessionId) {
      set((state) => {
        const current = state.byProject[projectId];
        if (current === undefined || !current.tabs.some((tab) => tab.sessionId === sessionId)) {
          return state;
        }
        return {
          byProject: {
            ...state.byProject,
            [projectId]: { ...current, activeSessionId: sessionId },
          },
        };
      });
    },

    renameSession(projectId, sessionId, title) {
      set((state) => {
        const current = state.byProject[projectId];
        if (current === undefined || !current.tabs.some((tab) => tab.sessionId === sessionId)) {
          return state;
        }
        const tabs = current.tabs.map((tab) =>
          tab.sessionId === sessionId ? { ...tab, title } : tab,
        );
        return { byProject: { ...state.byProject, [projectId]: { ...current, tabs } } };
      });
    },

    markExited(sessionId, exitCode) {
      set((state) => {
        const projectId = Object.keys(state.byProject).find((id) =>
          state.byProject[id]!.tabs.some((tab) => tab.sessionId === sessionId),
        );
        if (projectId === undefined) return state;
        const current = state.byProject[projectId]!;
        const tabs = current.tabs.map((tab) =>
          tab.sessionId === sessionId ? { ...tab, exitCode } : tab,
        );
        return { byProject: { ...state.byProject, [projectId]: { ...current, tabs } } };
      });
    },

    forgetProject(projectId) {
      set((state) => {
        if (!(projectId in state.byProject)) return state;
        const byProject = { ...state.byProject };
        delete byProject[projectId];
        return { byProject };
      });
    },
  }));
}

/** App-wide singleton; components import this directly. */
export const useSessionsStore = createSessionsStore();
