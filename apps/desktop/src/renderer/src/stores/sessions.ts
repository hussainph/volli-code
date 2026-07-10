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
  /** Monotonic title counter — never reset or reused, so closing "Terminal 1"
   *  and opening again yields "Terminal 3", not a duplicate "Terminal 2". */
  nextTabNumber: number;
}

interface SessionsState {
  byProject: Record<string, ProjectSessions>;
  /** Projects with a terminal-create currently in flight. Lives in the store
   *  (not a component ref) so any surface — the sessions tab strip today,
   *  the ticket board later — can observe "a session is being created for
   *  project X" without reaching into SessionsLayer's internals. */
  startingProjects: Record<string, true>;
  /** Append a tab for a freshly-created PTY session, title it, and focus it. */
  addSession(projectId: string, sessionId: string): void;
  /** Remove a tab, selecting a neighbor like the project rail does. */
  closeSession(projectId: string, sessionId: string): void;
  setActiveSession(projectId: string, sessionId: string): void;
  /** Record a PTY exit on whichever project owns the session. */
  markExited(sessionId: string, exitCode: number): void;
  /** Mark whether a terminal-create is in flight for a project. Idempotent:
   *  callers bracket an async create with `true` then `false`/`finally`
   *  without checking current state first. */
  setStarting(projectId: string, starting: boolean): void;
  /** Drop every session for a removed project. */
  forgetProject(projectId: string): void;
}

const EMPTY_PROJECT: ProjectSessions = { tabs: [], activeSessionId: null, nextTabNumber: 1 };

/** Factory so tests get isolated instances. */
export function createSessionsStore() {
  return create<SessionsState>()((set) => ({
    byProject: {},
    startingProjects: {},

    addSession(projectId, sessionId) {
      set((state) => {
        const current = state.byProject[projectId] ?? EMPTY_PROJECT;
        if (current.tabs.some((tab) => tab.sessionId === sessionId)) return state;
        const tab: SessionTab = {
          sessionId,
          title: `Terminal ${current.nextTabNumber}`,
          exitCode: null,
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
        return {
          byProject: { ...state.byProject, [projectId]: { ...current, tabs, activeSessionId } },
        };
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

    setStarting(projectId, starting) {
      set((state) => {
        const isStarting = projectId in state.startingProjects;
        if (starting === isStarting) return state;
        const startingProjects = { ...state.startingProjects };
        if (starting) {
          startingProjects[projectId] = true;
        } else {
          delete startingProjects[projectId];
        }
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

/** App-wide singleton; components import this directly. */
export const useSessionsStore = createSessionsStore();
