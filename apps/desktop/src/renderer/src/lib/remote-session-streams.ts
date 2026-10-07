/**
 * A remote Workspace's Session streams, within the link's subscription budget
 * (VC-713; review amendment AM1).
 *
 * hostd allows four open streams per Workspace connection, and one Workspace
 * link carries the board's change feed, possibly the host's log, and one
 * stream per followed Session. A window that followed every resident chat
 * would be refused the fifth (`subscription-limit`) and draw that chat as
 * lost. So a remote Session's stream is opened only while the Session is on
 * screen, at most {@link REMOTE_SESSION_STREAM_SLOTS} at a time per
 * Workspace, and is closed again when it leaves.
 *
 * It sits between the chat core and the Workspace's typed client, as the
 * `subscribe` the core already calls, so the core is unchanged:
 *
 * - **Parked.** A Session that is not on screen, or that found no free slot,
 *   holds no stream. The core has already read its snapshot, so the view is
 *   the Session as it last stood, never blank; the listing (re-read on its own
 *   schedule) says whether it is waiting on the person.
 * - **Live.** On screen with a slot, the stream opens from the last event this
 *   wrapper delivered (or the core's own cursor), so nothing is skipped and
 *   nothing repeats. A cursor the host can no longer resume from answers
 *   `subscription-resnapshot-required`, which reaches the core as it always
 *   does: it re-reads the snapshot and subscribes again.
 * - **Refused a slot** (`subscription-limit`, another surface holding the
 *   link's streams): the stream parks and tries again after a backoff, or as
 *   soon as a slot here frees. Never a blank view, never an error band.
 *
 * Every stream and timer has an owner: the core's `unsubscribe()` ends its
 * stream and its retry at once, and {@link RemoteSessionStreams.dispose} ends
 * every one. Any other failure passes through to the core untouched.
 */
import { readHostError } from "@volli/host-protocol";
import type { ChatStreamCursor } from "@volli/session-presentation";

/** Session streams one Workspace link may hold open at once (of hostd's four). */
export const REMOTE_SESSION_STREAM_SLOTS = 2;
/** How long a stream refused a slot waits before it asks again, step by step. */
export const REMOTE_STREAM_RETRY_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000];

/** One stream emission as the core receives it. */
export interface StreamEvent {
  id: string;
  data: unknown;
}

export interface StreamHandlers {
  onStarted(): void;
  onData(event: StreamEvent): void;
  onError(error: unknown): void;
  onComplete(): void;
}

/** A Session stream door: the typed client's `session.subscribe(Queue)`, structurally. */
export interface SessionStreamSource {
  subscribe(input: ChatStreamCursor, handlers: StreamHandlers): { unsubscribe(): void };
}

export interface RemoteSessionStreams {
  /** The door the core subscribes through, for this Workspace. */
  wrap(source: SessionStreamSource): SessionStreamSource;
  /**
   * A surface shows, or stops showing, a Session. Counted, so two panes on
   * one Session keep it live until both let go. Returns the release.
   */
  show(sessionId: string): () => void;
  /** Ends every stream and timer now. */
  dispose(): void;
}

interface Entry {
  readonly sessionId: string;
  readonly source: SessionStreamSource;
  readonly handlers: StreamHandlers;
  cursor: ChatStreamCursor;
  /** The open stream's identity: set while live, so a late callback from an older one is ignored. */
  token: object | null;
  live: { unsubscribe(): void } | null;
  /** Refused a slot: waiting for this retry before asking again. */
  retry: unknown;
  attempts: number;
  ended: boolean;
}

/** Closes an entry's stream, if it has one; it waits, parked, to be opened again. */
function park(entry: Entry): void {
  const live = entry.live;
  entry.token = null;
  entry.live = null;
  live?.unsubscribe();
}

export function createRemoteSessionStreams(options: {
  slots?: number;
  clock: { setTimeout(run: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
}): RemoteSessionStreams {
  const slots = options.slots ?? REMOTE_SESSION_STREAM_SLOTS;
  const { clock } = options;
  const entries = new Set<Entry>();
  const shown = new Map<string, number>();
  let disposed = false;

  const liveCount = (): number => [...entries].filter((entry) => entry.token !== null).length;

  const open = (entry: Entry): void => {
    // The identity is set before subscribing, so a source that answers
    // synchronously is recognised, and one that ended synchronously is not
    // mistaken for live afterwards.
    const token = {};
    entry.token = token;
    const owns = () => entry.token === token && !entry.ended;
    // An ended stream is let go of too: a no-op for one that finished, and
    // nothing left open for one that only said so.
    const ended = () => {
      const finished = entry.live;
      entry.token = null;
      entry.live = null;
      finished?.unsubscribe();
    };
    const live = entry.source.subscribe(entry.cursor, {
      // The core heard `started` when it subscribed; a reopen is not news.
      onStarted: () => {},
      onData: (event) => {
        if (!owns()) return;
        entry.attempts = 0;
        // Resume after what was delivered, whichever stream delivered it.
        entry.cursor = { ...entry.cursor, lastEventId: event.id };
        entry.handlers.onData(event);
      },
      onError: (failure) => {
        if (!owns()) return;
        ended();
        if (readHostError(failure).reason === "subscription-limit") {
          // Another surface holds the link's streams: wait, then ask again.
          const wait =
            REMOTE_STREAM_RETRY_MS[Math.min(entry.attempts, REMOTE_STREAM_RETRY_MS.length - 1)]!;
          entry.attempts += 1;
          entry.retry = clock.setTimeout(() => {
            entry.retry = null;
            rebalance();
          }, wait);
          return;
        }
        entry.ended = true;
        entries.delete(entry);
        entry.handlers.onError(failure);
        rebalance();
      },
      onComplete: () => {
        if (!owns()) return;
        ended();
        entry.ended = true;
        entries.delete(entry);
        entry.handlers.onComplete();
        rebalance();
      },
    });
    if (entry.token === token) entry.live = live;
    else live.unsubscribe();
  };

  /** Parks what is off screen, then opens what is on screen while slots remain, oldest first. */
  function rebalance(): void {
    if (disposed) return;
    for (const entry of entries) {
      if (entry.token !== null && !shown.has(entry.sessionId)) park(entry);
    }
    for (const entry of entries) {
      if (liveCount() >= slots) break;
      if (entry.token !== null || entry.retry !== null || !shown.has(entry.sessionId)) continue;
      open(entry);
    }
  }

  return {
    wrap(source) {
      return {
        subscribe(input, handlers) {
          const entry: Entry = {
            sessionId: input.sessionId,
            source,
            handlers,
            cursor: input,
            token: null,
            live: null,
            retry: null,
            attempts: 0,
            ended: false,
          };
          entries.add(entry);
          // Parked or live, the stream stands: the core's snapshot is on screen.
          handlers.onStarted();
          rebalance();
          return {
            unsubscribe() {
              if (entry.ended) return;
              entry.ended = true;
              entries.delete(entry);
              if (entry.retry !== null) clock.clearTimeout(entry.retry);
              entry.retry = null;
              park(entry);
              rebalance();
            },
          };
        },
      };
    },

    show(sessionId) {
      shown.set(sessionId, (shown.get(sessionId) ?? 0) + 1);
      rebalance();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = shown.get(sessionId)! - 1;
        if (count === 0) shown.delete(sessionId);
        else shown.set(sessionId, count);
        rebalance();
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of entries) {
        entry.ended = true;
        if (entry.retry !== null) clock.clearTimeout(entry.retry);
        entry.retry = null;
        park(entry);
      }
      entries.clear();
      shown.clear();
    },
  };
}
