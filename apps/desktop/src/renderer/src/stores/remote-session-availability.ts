/**
 * Remote projects whose host grants this window no Session features (VC-713,
 * review B3): an older host that predates `sessions.listing`. The rail, Home
 * and the ticket panel say so in the host's name instead of a generic
 * failure, and nothing re-reads the listing until the project's link changes
 * (a new welcome may grant it). Kept in memory, per window; nothing durable.
 * With `cloud` off nothing is ever set.
 */
import { create } from "zustand";

export interface RemoteSessionAvailabilityState {
  /** Project id → why its Sessions are not available here, in the host's name. */
  readonly unavailable: Readonly<Record<string, string>>;
  setUnavailable(projectId: string, reason: string | null): void;
}

export function createRemoteSessionAvailabilityStore() {
  return create<RemoteSessionAvailabilityState>()((set, get) => ({
    unavailable: {},
    setUnavailable(projectId, reason) {
      const current = get().unavailable;
      if ((current[projectId] ?? null) === reason) return;
      const next = { ...current };
      if (reason === null) delete next[projectId];
      else next[projectId] = reason;
      set({ unavailable: next });
    },
  }));
}

export const useRemoteSessionAvailabilityStore = createRemoteSessionAvailabilityStore();

/** Why a project's Sessions are not available here, or `null` when they are (or it is This Mac's). */
export function useRemoteSessionsUnavailable(projectId: string | null): string | null {
  return useRemoteSessionAvailabilityStore((state) =>
    projectId === null ? null : (state.unavailable[projectId] ?? null),
  );
}
