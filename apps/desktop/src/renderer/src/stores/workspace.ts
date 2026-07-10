/**
 * Per-workspace UI state, keyed by project id. Holds whatever should survive
 * switching to another project and back — starting with the active nav page,
 * so ten workspace switches later you land on exactly the page you left, not
 * whichever page the last workspace was showing.
 *
 * Deliberately session-only (no `persist`): nav resetting to Board on relaunch
 * is a settled decision (see ui.ts's history) and now applies per workspace.
 */
import { create } from "zustand";

export type NavKey = "board" | "sessions" | "files" | "settings";

export const DEFAULT_NAV: NavKey = "board";

interface WorkspaceState {
  navByProject: Record<string, NavKey>;
  setNav(projectId: string, nav: NavKey): void;
  /** Drop a removed project's entries so re-adding it starts fresh. */
  forget(projectId: string): void;
}

/** Factory so tests get isolated instances. */
export function createWorkspaceStore() {
  return create<WorkspaceState>()((set) => ({
    navByProject: {},

    setNav(projectId, nav) {
      set((state) => ({ navByProject: { ...state.navByProject, [projectId]: nav } }));
    },

    forget(projectId) {
      set((state) => {
        if (!(projectId in state.navByProject)) return state;
        const navByProject = { ...state.navByProject };
        delete navByProject[projectId];
        return { navByProject };
      });
    },
  }));
}

/** App-wide singleton; components import this directly. */
export const useWorkspaceStore = createWorkspaceStore();
