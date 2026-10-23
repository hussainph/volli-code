/**
 * What ends a headless Browser Tab's life besides its owner Session (VC-238
 * §6).
 *
 * A headless tab is in no strip and no tab order, so nobody but main can close
 * it — which makes every path that ends one load-bearing rather than tidy. The
 * Session's own attachment end is the port's (`dispose`); the other is here: an
 * archived Ticket has no Session left to drive its tabs and no surface left
 * that could show them, so its headless tabs would otherwise be invisible live
 * WebContentsViews for the rest of the launch.
 *
 * A function over the wake seam rather than a closure inside `index.ts`'s
 * bootstrap, so the rule is reachable by a test: which event closes tabs, and
 * that a Ticket Event of any other kind closes none.
 */
import type { TicketWake } from "@volli/host-core/board";

export interface HeadlessTabCloser {
  clearAgentPartition(scope: { projectId: string; ticketId: string | null }): Promise<void>;
}

/**
 * Closes an archived Ticket's headless agent tabs and clears its unused
 * partition. Previewed or promoted tabs are the person's and retain storage.
 * Returns the unsubscribe; cleanup failures are logged by the host.
 */
export function closeHeadlessTabsOnTicketArchive(
  host: HeadlessTabCloser,
  subscribe: (listener: (wake: TicketWake) => void) => () => void,
): () => void {
  return subscribe((wake) => {
    if (wake.event.payload.kind !== "archived") return;
    void host.clearAgentPartition({ projectId: wake.projectId, ticketId: wake.event.ticketId });
  });
}
