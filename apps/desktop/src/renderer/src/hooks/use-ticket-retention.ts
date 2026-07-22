import * as React from "react";
import type { TicketRetentionState } from "@volli/shared";

import { useLatestAsync } from "@renderer/hooks/use-latest-async";
import { planningChangeAffects, useBoardStore } from "@renderer/stores/board";

/**
 * Fetches a ticket's transient retention state (issue #76), refetching whenever
 * planning data is refreshed after a `data-changed` broadcast — the same
 * `lastPlanningChange` seam the Activity feed uses for reads not carried in the
 * board's hydrated ticket list. Every retention mutation (`keep`/`dismiss`/
 * `ttl-set`/`archive-clean`) broadcasts, so the surface re-reads without any
 * bespoke subscription here. A refresh that provably targets a DIFFERENT ticket
 * is skipped ({@link planningChangeAffects}); a global TTL change broadcasts
 * untargeted, so it still reaches every retention surface.
 *
 * A background read is silent on failure (the backend's rule — a read is not a
 * mutation, so no toast): a failed fetch leaves the last state in place rather
 * than clearing it. `enabled: false` (a ticket with no worktree branch, which
 * can never be archive-ready) skips the IPC entirely and reports `null`, so the
 * board only ever queries the handful of cards that could show a badge.
 */
export function useTicketRetention(
  ticketId: string,
  enabled: boolean,
): { state: TicketRetentionState | null; reload: () => void } {
  const [state, setState] = React.useState<TicketRetentionState | null>(null);
  const planningChange = useBoardStore((store) => store.lastPlanningChange);
  // Shared stale-guard (replaces this hook's hand-rolled requestIdRef): a later
  // reload — the synchronous `setState(null)` when `enabled` flips false, or a
  // superseding fetch — retires the earlier token, so its late/out-of-order
  // resolve drops itself. `reload` is called from the effects here AND externally
  // (WorktreeDoneFlowSection's post-mutation refetch), so the guard is shared.
  const fetchToken = useLatestAsync();

  const reload = React.useCallback(() => {
    const token = fetchToken.claim();
    if (!enabled) {
      setState(null);
      return;
    }
    void window.api.retention
      .state(ticketId)
      .then((result) => {
        if (!fetchToken.isCurrent(token)) return; // superseded — stale, drop it
        if (result.ok) setState(result.state);
        // Silent on failure: a background read never toasts; keep the last state.
      })
      .catch(() => {
        // Same — a rejected read must never surface as an error toast.
      });
  }, [ticketId, enabled, fetchToken]);

  // Initial load + re-eval when ticketId/enabled change (reload's identity tracks them).
  React.useEffect(() => {
    reload();
  }, [reload]);

  // Refetch on a relevant planning refresh only: untargeted, or one for THIS
  // ticket. The seen-version ref skips the mount duplicate the effect above covered.
  const seenVersion = React.useRef(planningChange.version);
  React.useEffect(() => {
    if (planningChange.version === seenVersion.current) return;
    seenVersion.current = planningChange.version;
    if (!planningChangeAffects(planningChange, ticketId)) return;
    reload();
  }, [planningChange, ticketId, reload]);

  return { state, reload };
}
