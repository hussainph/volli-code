/**
 * A framework-free {@link ChatSessionStore}: the slice map, the
 * {@link ChatSessionWrites} over the session-slice transitions, and a plain
 * listener set. No zustand, no React — this is the store a client without the
 * desktop's policy (tab strips, starting flags, create/adopt orchestration)
 * hands to {@link ChatSessionClient}, and the one the package's own tests run
 * the client against.
 *
 * Listeners are notified synchronously after each write, as zustand does. The walk
 * itself differs from zustand's live-set iteration only at the margins —
 * see `announce`.
 */
import type {
  ChatSessionLifecycle,
  ChatSessionSlice,
  ChatSessionStore,
  ChatSessionWrites,
} from "./client";
import {
  applyProjection,
  applyQueue,
  applySnapshotWindow,
  foldStreamBatch,
  markAttaching,
  markDelivered,
  prependSliceHistory,
  seedSlice,
  settleSlice,
} from "./session-slice";

/** Host projection writes and the local slice lifecycle. */
export interface SurfaceSessions extends ChatSessionWrites {
  /** Seeds the slice a client writes into. A Session already seeded is left alone. */
  seed(sessionId: string, lifecycle: ChatSessionLifecycle): void;
  /** Drops the slice. The durable Session is untouched — this surface just stops holding it. */
  remove(sessionId: string): void;
}

export interface SessionSurfaceStore extends ChatSessionStore {
  getState(): SurfaceSessions;
}

export function createSurfaceStore(): SessionSurfaceStore {
  let state: SurfaceSessions;
  const listeners = new Set<() => void>();
  // A snapshot walk, for the registry's reason: a listener unsubscribing
  // itself mid-walk must not skip its neighbour. Two marginal departures
  // from zustand's live-set forEach follow, neither observable through
  // ChatSessionClient (its listener only re-reads state behind a guard): a
  // listener some OTHER listener unsubscribed mid-walk still runs once, and
  // one subscribed mid-walk waits for the next write.
  const announce = (): void => {
    const watchers = [...listeners];
    for (const listener of watchers) listener();
  };
  const swap = (sessions: Readonly<Record<string, ChatSessionSlice>>): void => {
    state = { ...state, sessions };
    announce();
  };
  /**
   * The slices written inside a {@link SurfaceSessions.batch}, published
   * together when it returns — one map copy and one announcement however many
   * Sessions the frame touched (VC-515). `null` outside a batch.
   */
  let staged: Map<string, ChatSessionSlice> | null = null;
  /**
   * Every per-slice write lands through here, so one addressed to a Session
   * that is gone is a no-op rather than a resurrected slice — and an
   * identity-preserving transition publishes nothing.
   */
  const update = (
    sessionId: string,
    change: (slice: ChatSessionSlice) => ChatSessionSlice,
  ): void => {
    const slice = staged?.get(sessionId) ?? state.sessions[sessionId];
    if (slice === undefined) return;
    const next = change(slice);
    if (next === slice) return;
    if (staged !== null) staged.set(sessionId, next);
    else swap({ ...state.sessions, [sessionId]: next });
  };

  const batch = (run: () => void): void => {
    if (staged !== null) {
      run();
      return;
    }
    const writes = new Map<string, ChatSessionSlice>();
    staged = writes;
    try {
      run();
    } finally {
      staged = null;
      let sessions: Record<string, ChatSessionSlice> | null = null;
      // `remove` forgets a staged write, so every one left names a live slice.
      for (const [sessionId, slice] of writes) {
        sessions ??= { ...state.sessions };
        sessions[sessionId] = slice;
      }
      if (sessions !== null) swap(sessions);
    }
  };

  state = {
    sessions: {},
    batch,
    applyStream(sessionId, frames, overlays, progress = [], clearLiveCompaction = false) {
      update(sessionId, (slice) =>
        foldStreamBatch(slice, frames, overlays, progress, clearLiveCompaction),
      );
    },
    applySnapshot(sessionId, window, projection) {
      update(sessionId, (slice) => applySnapshotWindow(slice, window, projection));
    },
    prependHistory(sessionId, requested, page) {
      update(sessionId, (slice) => prependSliceHistory(slice, requested, page));
    },
    setProjection(sessionId, projection) {
      update(sessionId, (slice) => applyProjection(slice, projection));
    },
    attaching(sessionId) {
      update(sessionId, markAttaching);
    },
    delivered(sessionId, turnEpoch) {
      update(sessionId, (slice) => markDelivered(slice, turnEpoch));
    },
    settle(sessionId, error) {
      update(sessionId, (slice) => settleSlice(slice, error));
    },
    setQueue(sessionId, queue, revision) {
      update(sessionId, (slice) => applyQueue(slice, queue, revision));
    },
    seed(sessionId, lifecycle) {
      if (state.sessions[sessionId] !== undefined) return;
      swap({ ...state.sessions, [sessionId]: seedSlice(lifecycle) });
    },
    remove(sessionId) {
      staged?.delete(sessionId);
      if (state.sessions[sessionId] === undefined) return;
      const sessions = { ...state.sessions };
      delete sessions[sessionId];
      swap(sessions);
    },
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
