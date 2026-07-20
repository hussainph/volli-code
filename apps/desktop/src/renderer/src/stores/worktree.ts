/**
 * Transient worktree-ensure phase tracking (docs/plans/worktree-support.md).
 * Mirrors main's `volli:worktree-phase` pushes into a small per-ticket record so
 * the ticket-detail UI (the session status chip, the pre-boot "starting"
 * affordance, and the Details rail's failed-notice + retry) can render the live
 * ensure pipeline without polling `api.worktree.state`. NEVER persisted — main
 * doesn't persist phases either (ipc.ts), so a fresh app session starts empty
 * and rehydrates as pushes land while tickets boot.
 */
import { create } from "zustand";
import type { WorktreePhase } from "@volli/shared";

interface WorktreeState {
  /** ticketId → last-seen ensure phase. */
  phases: Record<string, WorktreePhase>;
  /**
   * Records the ticket's latest phase. A `ready` (or any terminal) phase is
   * kept rather than cleared — timing a fade-out isn't worth the complexity,
   * and a stale `ready`/`failed` is harmless once the ticket's sessions are the
   * source of truth for what's actually running.
   */
  setPhase(ticketId: string, phase: WorktreePhase): void;
}

/** Factory so tests get isolated instances (sessions.ts's convention). */
export function createWorktreeStore() {
  return create<WorktreeState>()((set) => ({
    phases: {},

    setPhase(ticketId, phase) {
      set((state) => {
        if (state.phases[ticketId] === phase) return state;
        return { phases: { ...state.phases, [ticketId]: phase } };
      });
    },
  }));
}

export const useWorktreeStore = createWorktreeStore();

/** The ticket's last-known ensure phase, or `null` if none has streamed yet this session. */
export function phaseFor(
  phases: Record<string, WorktreePhase>,
  ticketId: string,
): WorktreePhase | null {
  return phases[ticketId] ?? null;
}

/**
 * Wires the single `api.worktree.onPhase` subscription into the store. Mount
 * once from an always-mounted site — `SessionsLayer` already owns the
 * equivalent terminal `onData`/`onExit`/`onParkState` fan-out for the same
 * reason (it's the one component alive for the whole session regardless of
 * nav), and `lib/boot.ts` is out of scope here. Returns the unsubscribe
 * function for the caller's effect cleanup.
 */
export function subscribeWorktreePhases(): () => void {
  return window.api.worktree.onPhase((event) => {
    useWorktreeStore.getState().setPhase(event.ticketId, event.phase);
  });
}
