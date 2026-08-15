/**
 * The renderer half of the ticket-worktree filesystem watch (CONCEPT #47):
 * start a watch for one ticket, forward its debounced `worktree-changed`
 * events, and tear both down together.
 *
 * Extracted from the panels that use it because the subscription's ordering is
 * where the bugs live, and the renderer test project runs without a DOM — a
 * plain function over an injected api surface is testable; a `useEffect` body
 * is not.
 */
import { errorMessage } from "@volli/shared";
import type {
  Result,
  WorktreeChangedEvent,
  WorktreeWatchErrorEvent,
} from "../../../../ipc/contract";

/** The `window.api.worktree` subset a subscription needs — injected so tests drive it. */
export interface WorktreeChangeWatchApi {
  watchChangeSet(ticketId: string): Promise<Result>;
  unwatchChangeSet(ticketId: string): Promise<Result>;
  onChanged(callback: (event: WorktreeChangedEvent) => void): () => void;
  onWatchError(callback: (event: WorktreeWatchErrorEvent) => void): () => void;
}

export interface WorktreeChangeWatchHandlers {
  /** A debounced filesystem change landed for this ticket. Refresh only — never open a tab. */
  onChanged(): void;
  /**
   * The watch could not be established, or faulted after the fact. Either way
   * no further `onChanged` will arrive for this ticket until something
   * re-subscribes, so the caller must say so rather than look up-to-date.
   */
  onWatchError(message: string): void;
}

/**
 * Subscribes to `ticketId`'s worktree changes and returns the teardown.
 *
 * The teardown is the ONLY path that unwatches. An in-flight `watchChangeSet`
 * that resolves after teardown must just stand down: main keys watches by
 * `(window, ticketId)`, so a late unwatch from a torn-down subscription would
 * kill the watch a REMOUNT had already established under the same key, leaving
 * a live panel subscribed to an event nothing will ever send again.
 */
export function subscribeWorktreeChanges(
  api: WorktreeChangeWatchApi,
  ticketId: string,
  handlers: WorktreeChangeWatchHandlers,
): () => void {
  let cancelled = false;

  api.watchChangeSet(ticketId).then(
    (result) => {
      if (cancelled) return;
      if (!result.ok) handlers.onWatchError(result.error);
    },
    (error: unknown) => {
      if (cancelled) return;
      handlers.onWatchError(errorMessage(error));
    },
  );

  const unsubscribeChanged = api.onChanged((event) => {
    if (event.ticketId !== ticketId) return;
    handlers.onChanged();
  });

  const unsubscribeError = api.onWatchError((event) => {
    if (event.ticketId !== ticketId) return;
    // Main has already torn its side down; ours is now inert.
    cancelled = true;
    handlers.onWatchError(event.error);
  });

  return () => {
    cancelled = true;
    unsubscribeChanged();
    unsubscribeError();
    void api.unwatchChangeSet(ticketId);
  };
}
