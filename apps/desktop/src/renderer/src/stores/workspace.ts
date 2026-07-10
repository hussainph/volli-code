/**
 * Per-workspace UI state, keyed by project id. Holds whatever should survive
 * switching to another project and back — the active nav page, and any future
 * per-workspace UI memory — so ten workspace switches later you land exactly
 * where you left each project.
 *
 * One `WorkspaceUiState` record per project (not parallel per-field maps), so
 * everything a workspace remembers lives and dies together: `forget` stays a
 * single delete no matter how many fields the record grows.
 *
 * Deliberately session-only (no `persist`): nav resetting to Board on relaunch
 * is a settled decision (see ui.ts's history) and now applies per workspace.
 */
import { create } from "zustand";

export type NavKey = "board" | "sessions" | "files" | "settings";

export interface WorkspaceUiState {
  nav: NavKey;
}

export const DEFAULT_WORKSPACE_UI: WorkspaceUiState = {
  nav: "board",
};

interface WorkspaceState {
  byProject: Record<string, WorkspaceUiState>;
  setNav(projectId: string, nav: NavKey): void;
  /** Drop a removed project's record so re-adding it starts fresh. */
  forget(projectId: string): void;
}

/** The project's record merged with `changes` — spread into `set()`. */
function patchWorkspace(
  state: WorkspaceState,
  projectId: string,
  changes: Partial<WorkspaceUiState>,
): Pick<WorkspaceState, "byProject"> {
  const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
  return { byProject: { ...state.byProject, [projectId]: { ...current, ...changes } } };
}

/** Factory so tests get isolated instances. */
export function createWorkspaceStore() {
  return create<WorkspaceState>()((set) => ({
    byProject: {},

    setNav(projectId, nav) {
      set((state) => patchWorkspace(state, projectId, { nav }));
    },

    forget(projectId) {
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
export const useWorkspaceStore = createWorkspaceStore();
