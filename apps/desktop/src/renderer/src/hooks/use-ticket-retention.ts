import * as React from "react";
import type { TicketRetentionState } from "@volli/shared";

import { useBoardStore } from "@renderer/stores/board";

/**
 * Fetches a ticket's transient retention state (issue #76), refetching whenever
 * planning data is refreshed after a `data-changed` broadcast — the same
 * `planningDataVersion` seam the Activity feed uses for reads not carried in the
 * board's hydrated ticket list. Every retention mutation (`keep`/`dismiss`/
 * `ttl-set`/`archive-clean`) broadcasts, so the surface re-reads without any
 * bespoke subscription here.
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
  const planningDataVersion = useBoardStore((store) => store.planningDataVersion);

  const reload = React.useCallback(() => {
    if (!enabled) {
      setState(null);
      return;
    }
    void window.api.retention
      .state(ticketId)
      .then((result) => {
        if (result.ok) setState(result.state);
        // Silent on failure: a background read never toasts; keep the last state.
      })
      .catch(() => {
        // Same — a rejected read must never surface as an error toast.
      });
  }, [ticketId, enabled]);

  React.useEffect(() => {
    reload();
  }, [reload, planningDataVersion]);

  return { state, reload };
}
