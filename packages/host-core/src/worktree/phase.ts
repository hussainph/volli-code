/**
 * In-memory phase registry (worktree-support §2). The `ensure` pipeline's
 * transient phase (`creating → copying → setting-up → ready | failed`) lives
 * here, keyed by ticket id, and is broadcast to the renderer via the injected
 * `onPhase` callback on EVERY transition. NEVER persisted — on boot, truth is
 * recomputed from disk (`getState`), so this map starts empty each launch.
 *
 * The map is module-level on purpose: `ensure` (which writes phases) and
 * `getState` (which reads them) are separate entrypoints that must observe the
 * same process-wide registry. Tests reset it via {@link resetPhasesForTest}.
 */
import type { WorktreePhase } from "./types";

const phases = new Map<string, WorktreePhase>();

/** Records `phase` for `ticketId` and fires `onPhase` — call on every transition. */
export function setPhase(
  ticketId: string,
  phase: WorktreePhase,
  onPhase?: (ticketId: string, phase: WorktreePhase) => void,
): void {
  phases.set(ticketId, phase);
  onPhase?.(ticketId, phase);
}

/** The current transient phase for `ticketId`, or `null` when none is in flight. */
export function getPhase(ticketId: string): WorktreePhase | null {
  return phases.get(ticketId) ?? null;
}

/** Forgets a ticket's phase (e.g. after a successful `remove`). */
export function clearPhase(ticketId: string): void {
  phases.delete(ticketId);
}

/** Test-only: empties the registry so suites don't leak phases into each other. */
export function resetPhasesForTest(): void {
  phases.clear();
}
