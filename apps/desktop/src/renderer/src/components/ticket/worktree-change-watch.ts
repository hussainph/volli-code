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
  pauseChangeSet(ticketId: string): Promise<Result>;
  resumeChangeSet(ticketId: string): Promise<Result>;
  unwatchChangeSet(ticketId: string): Promise<Result>;
  onChanged(callback: (event: WorktreeChangedEvent) => void): () => void;
  onWatchError(callback: (event: WorktreeWatchErrorEvent) => void): () => void;
}

/** Injectable window-focus seam; the renderer test project has no DOM. */
export interface WorktreeChangeWatchFocus {
  isFocused(): boolean;
  subscribe(callback: (focused: boolean) => void): () => void;
}

function browserWindowIsFocused(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible" && document.hasFocus();
}

const browserFocus: WorktreeChangeWatchFocus = {
  isFocused: browserWindowIsFocused,
  subscribe(callback) {
    if (typeof window === "undefined" || typeof document === "undefined") return () => {};
    const notify = () => callback(browserWindowIsFocused());
    window.addEventListener("focus", notify);
    window.addEventListener("blur", notify);
    document.addEventListener("visibilitychange", notify);
    return () => {
      window.removeEventListener("focus", notify);
      window.removeEventListener("blur", notify);
      document.removeEventListener("visibilitychange", notify);
    };
  },
};

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
  focus: WorktreeChangeWatchFocus = browserFocus,
): () => void {
  let cancelled = false;
  let watchReady = false;
  let desiredActive = focus.isFocused();
  // Main starts a new subscription active. Reconcile changes that arrived
  // while its async git-ignore snapshot was still loading after watch resolves.
  let appliedActive = true;
  let reconciling = false;

  const reconcileFocus = async (): Promise<void> => {
    if (reconciling || cancelled || !watchReady) return;
    reconciling = true;
    let failedTarget: boolean | null = null;
    try {
      while (desiredActive !== appliedActive) {
        const nextActive = desiredActive;
        let result: Result;
        try {
          result = await (nextActive
            ? api.resumeChangeSet(ticketId)
            : api.pauseChangeSet(ticketId));
        } catch (error: unknown) {
          failedTarget = nextActive;
          if (!cancelled) handlers.onWatchError(errorMessage(error));
          return;
        }
        if (cancelled) return;
        if (!result.ok) {
          failedTarget = nextActive;
          handlers.onWatchError(result.error);
          return;
        }
        appliedActive = nextActive;
      }
    } finally {
      reconciling = false;
      if (
        !cancelled &&
        watchReady &&
        desiredActive !== appliedActive &&
        desiredActive !== failedTarget
      ) {
        void reconcileFocus();
      }
    }
  };

  api.watchChangeSet(ticketId).then(
    (result) => {
      if (cancelled) return;
      if (!result.ok) {
        handlers.onWatchError(result.error);
        return;
      }
      watchReady = true;
      void reconcileFocus();
    },
    (error: unknown) => {
      if (cancelled) return;
      handlers.onWatchError(errorMessage(error));
    },
  );

  const unsubscribeFocus = focus.subscribe((focused) => {
    if (cancelled || desiredActive === focused) return;
    desiredActive = focused;
    void reconcileFocus();
  });

  const unsubscribeChanged = api.onChanged((event) => {
    if (event.ticketId !== ticketId || !desiredActive) return;
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
    unsubscribeFocus();
    unsubscribeChanged();
    unsubscribeError();
    void api.unwatchChangeSet(ticketId);
  };
}
