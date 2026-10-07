/**
 * Remote projects whose host does not offer this window its board (VC-711):
 * an older host that grants no `board.read`, or one that does not know the
 * Workspace. Such a project has no row (a row comes from its board's
 * snapshot), so this is where it is said, in the host's name: Settings →
 * Hosts lists it with the reason and a way to try again. Kept in memory, per
 * window; nothing durable.
 */
import { create } from "zustand";

export interface RemoteBoardAvailabilityState {
  /** Project id → why its board is not available here, in the host's name. */
  readonly unavailable: Readonly<Record<string, string>>;
  /** Asks the follower to open each named project's board again (set by `followRemoteProjects`). */
  readonly retry: ((projectId: string) => void) | null;
  setUnavailable(projectId: string, reason: string | null): void;
  setRetry(retry: ((projectId: string) => void) | null): void;
}

export function createRemoteBoardAvailabilityStore() {
  return create<RemoteBoardAvailabilityState>()((set, get) => ({
    unavailable: {},
    retry: null,
    setUnavailable(projectId, reason) {
      const current = get().unavailable;
      if ((current[projectId] ?? null) === reason) return;
      const next = { ...current };
      if (reason === null) delete next[projectId];
      else next[projectId] = reason;
      set({ unavailable: next });
    },
    setRetry(retry) {
      set({ retry });
    },
  }));
}

export const useRemoteBoardAvailabilityStore = createRemoteBoardAvailabilityStore();

/** What a remote project's board-less host says, in its name. */
export function boardUnavailableOn(hostName: string): string {
  return `The board isn’t available on ${hostName} — update it to use it here`;
}
