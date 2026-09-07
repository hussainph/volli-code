import type {
  BackgroundShellIdInput,
  BackgroundShellListResult,
  BackgroundShellState,
  BackgroundShellStateEvent,
  BackgroundShellTailResult,
  Result,
} from "../../../ipc/contract";
import { create } from "zustand";

/**
 * Renderer view of the frozen background shell preload bridge (VC-270).
 * Structural, on `BrowserApi`'s terms, so the island feed and the output
 * view can be tested without Electron. The production value is
 * `window.api.shells`.
 */
export interface ShellsApi {
  list(): Promise<BackgroundShellListResult>;
  tail(input: BackgroundShellIdInput): Promise<BackgroundShellTailResult>;
  kill(input: BackgroundShellIdInput): Promise<Result>;
  onShellState(callback: (event: BackgroundShellStateEvent) => void): () => void;
}

interface BackgroundShellsState {
  byId: Record<string, BackgroundShellState>;
  /** Whether the main-owned registry has been read once this app run. */
  hydrated: boolean;
  receive(shell: BackgroundShellState): void;
  receiveAll(shells: readonly BackgroundShellState[]): void;
  remove(shellId: string): void;
}

/**
 * Live background shell chrome, projected from main's BackgroundShellHost —
 * `browser-tabs.ts` for shells. Every Session's shells live here and the
 * island feed filters by Session; the store never holds output, which is a
 * separate, explicit tail read by the one view that shows it.
 */
export const useBackgroundShellsStore = create<BackgroundShellsState>((set) => ({
  byId: {},
  hydrated: false,
  receive(shell) {
    set((state) => ({ byId: { ...state.byId, [shell.shellId]: shell } }));
  },
  receiveAll(shells) {
    set(() => ({
      byId: Object.fromEntries(shells.map((shell) => [shell.shellId, shell])),
      hydrated: true,
    }));
  },
  remove(shellId) {
    set((state) => {
      if (!(shellId in state.byId)) return state;
      const byId = { ...state.byId };
      delete byId[shellId];
      return { byId };
    });
  },
}));

/** Reconciles the whole main-owned registry into the renderer view. */
export async function hydrateBackgroundShells(api: ShellsApi): Promise<BackgroundShellListResult> {
  const result = await api.list();
  if (result.ok) useBackgroundShellsStore.getState().receiveAll(result.shells);
  return result;
}

/** The app-lifetime push subscription that keeps shell state live. */
export function subscribeBackgroundShells(api: ShellsApi): () => void {
  return api.onShellState((event) => {
    if (event.shell !== undefined) useBackgroundShellsStore.getState().receive(event.shell);
    else useBackgroundShellsStore.getState().remove(event.removedShellId);
  });
}
