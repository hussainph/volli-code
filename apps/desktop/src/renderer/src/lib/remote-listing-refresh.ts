/**
 * When a remote project's Session listing is read again (VC-713; HP § The
 * Session listing, "Attention without events").
 *
 * hostd pushes no events to a device yet (VC-664), so nothing tells this
 * window that a Session on a box started waiting on the person while the lid
 * was closed. The listing is re-read instead:
 *
 * - **on reconnect:** a Workspace's link comes back to ready (a wake, a
 *   network change and a relaunch all end here, since main reconnects every
 *   link on resume);
 * - **on window focus** (or the window becoming visible): every opened remote
 *   Workspace;
 * - **on wake as the renderer sees it:** the poll's own timer firing far later
 *   than it was due means the machine slept, so every Workspace is re-read
 *   without waiting for its link;
 * - **a poll** every {@link REMOTE_LISTING_POLL_MS} while a remote project is
 *   on screen: that project only, never one off screen, never while the window
 *   is hidden or the link is not ready.
 *
 * Every trigger for one Workspace inside {@link REMOTE_LISTING_DEBOUNCE_MS} of
 * its last read collapses into one trailing read at the window's end, so a
 * wake that also reconnects and refocuses reads once, then once more. At most
 * one read per Workspace is in flight: a trigger during one becomes a single
 * read after it settles (debounced the same way), never a timer that polls
 * the read in flight. A Workspace no longer opened is let go of
 * ({@link RemoteListingRefresh.prune}): its trailing read is cancelled.
 *
 * The scheduler owns its timers and its subscriptions, and `stop()` ends both
 * at once; a read that settles after `stop()` schedules nothing. What a read
 * writes, and guarding a late answer by identity, is the reader's (the
 * listing stores). It never opens a connection or a subscription: a read rides
 * the Workspace link the window already holds.
 */

/** How often the listing of a remote project on screen is re-read. */
export const REMOTE_LISTING_POLL_MS = 30_000;
/** Triggers for one Workspace within this of its last read collapse into one. */
export const REMOTE_LISTING_DEBOUNCE_MS = 5_000;
/** A poll tick this late (several intervals) means the machine slept. */
export const REMOTE_LISTING_WAKE_SLACK_MS = 2 * REMOTE_LISTING_POLL_MS;

type Unsubscribe = () => void;

/** The facts and events the scheduler reads. Production wires these to the window and stores. */
export interface RemoteListingRefreshPorts {
  /** Every remote Workspace opened in this window. */
  workspaces(): readonly string[];
  /** The remote Workspaces whose rail, Home or ticket panel is on screen. */
  visible(): readonly string[];
  /** Whether a Workspace's link can serve a read now. */
  ready(workspaceId: string): boolean;
  /** Whether the window is visible at all. */
  windowVisible(): boolean;
  /** Reads one Workspace's listing again. A failure is the reader's to report. */
  refresh(workspaceId: string): Promise<void>;
  /** A Workspace's link went back to ready. */
  onReconnect(listener: (workspaceId: string) => void): Unsubscribe;
  /** The window gained focus or became visible. */
  onFocus(listener: () => void): Unsubscribe;
  readonly clock: {
    now(): number;
    setTimeout(run: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

export interface RemoteListingRefresh {
  /** Reads every opened remote Workspace that is ready (debounced). */
  refreshAll(): void;
  /**
   * Lets go of every Workspace no longer opened: its trailing timer is
   * cancelled and nothing more is read for it. An owner calls this when the
   * set it answers `workspaces()` from changes (a project forgotten, a host
   * gone); a read for a Workspace no longer opened is never started anyway.
   */
  prune(): void;
  /** Ends every timer and subscription now. Idempotent. */
  stop(): void;
}

interface WorkspaceTimes {
  lastStarted: number;
  inFlight: boolean;
  /** A trigger arrived while a read was in flight: read once more after it settles. */
  pending: boolean;
  trailing: unknown;
}

export function startRemoteListingRefresh(ports: RemoteListingRefreshPorts): RemoteListingRefresh {
  const { clock } = ports;
  const times = new Map<string, WorkspaceTimes>();
  let stopped = false;
  let pollHandle: unknown;
  let pollDue = clock.now() + REMOTE_LISTING_POLL_MS;

  const opened = (workspaceId: string): boolean => ports.workspaces().includes(workspaceId);

  const timesOf = (workspaceId: string): WorkspaceTimes => {
    let entry = times.get(workspaceId);
    if (entry === undefined) {
      entry = { lastStarted: -Infinity, inFlight: false, pending: false, trailing: null };
      times.set(workspaceId, entry);
    }
    return entry;
  };

  /** Drops a Workspace: its trailing timer, its pending read, its times. */
  const forget = (workspaceId: string): void => {
    const entry = times.get(workspaceId);
    if (entry === undefined) return;
    if (entry.trailing !== null) clock.clearTimeout(entry.trailing);
    entry.trailing = null;
    entry.pending = false;
    times.delete(workspaceId);
  };

  const run = (workspaceId: string, entry: WorkspaceTimes): void => {
    entry.lastStarted = clock.now();
    entry.inFlight = true;
    void ports
      .refresh(workspaceId)
      .catch(() => undefined)
      .finally(() => {
        entry.inFlight = false;
        // A stopped scheduler, or a Workspace let go of meanwhile, reads nothing more.
        if (stopped || times.get(workspaceId) !== entry || !entry.pending) return;
        entry.pending = false;
        trigger(workspaceId);
      });
  };

  /**
   * One read now; or, inside the debounce window, one trailing read at its
   * end; or, while a read is in flight, one more read after it settles. A
   * trailing timer always waits a positive time, so a slow read can never
   * turn this into a loop.
   */
  function trigger(workspaceId: string): void {
    if (stopped) return;
    if (!opened(workspaceId)) {
      forget(workspaceId);
      return;
    }
    if (!ports.ready(workspaceId)) return;
    const entry = timesOf(workspaceId);
    if (entry.inFlight) {
      entry.pending = true;
      return;
    }
    const since = clock.now() - entry.lastStarted;
    if (since >= REMOTE_LISTING_DEBOUNCE_MS) {
      run(workspaceId, entry);
      return;
    }
    if (entry.trailing !== null) return;
    // `stop()` and `forget()` clear this timer, so it never fires after either.
    entry.trailing = clock.setTimeout(() => {
      entry.trailing = null;
      trigger(workspaceId);
    }, REMOTE_LISTING_DEBOUNCE_MS - since);
  }

  const refreshAll = (): void => {
    for (const workspaceId of ports.workspaces()) trigger(workspaceId);
  };

  const schedulePoll = (): void => {
    pollDue = clock.now() + REMOTE_LISTING_POLL_MS;
    pollHandle = clock.setTimeout(poll, REMOTE_LISTING_POLL_MS);
  };

  // `stop()` clears this timer, so it never fires after it.
  function poll(): void {
    const late = clock.now() - pollDue;
    if (late > REMOTE_LISTING_WAKE_SLACK_MS) {
      // The machine slept through the poll: every Workspace, the moment its
      // link can answer (a link still reconnecting is read by `onReconnect`).
      refreshAll();
    } else if (ports.windowVisible()) {
      const open = new Set(ports.workspaces());
      for (const workspaceId of ports.visible()) if (open.has(workspaceId)) trigger(workspaceId);
    }
    schedulePoll();
  }

  // A link this window never opened is not its to read: `trigger` says so.
  const unsubscribeReconnect = ports.onReconnect(trigger);
  const unsubscribeFocus = ports.onFocus(refreshAll);
  schedulePoll();

  return {
    refreshAll,
    prune() {
      for (const workspaceId of times.keys()) if (!opened(workspaceId)) forget(workspaceId);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribeReconnect();
      unsubscribeFocus();
      clock.clearTimeout(pollHandle);
      for (const workspaceId of times.keys()) forget(workspaceId);
    },
  };
}
