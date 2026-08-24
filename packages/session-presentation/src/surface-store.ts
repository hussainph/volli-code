/**
 * A framework-free {@link ChatSessionStore}: the slice map, the
 * {@link ChatSessionWrites} over the session-slice transitions, and a plain
 * listener set. No zustand, no React — this is the store a client without the
 * desktop's policy (tab strips, starting flags, create/adopt orchestration)
 * hands to {@link ChatSessionClient}, and the one the package's own tests run
 * the client against.
 *
 * Listeners are notified SYNCHRONOUSLY after each write that changed state,
 * exactly as zustand notifies: the client's queue-release loop hangs off
 * `subscribe` from its constructor, and a store that batched or deferred
 * would strand a queued message behind the very write that made it
 * releasable.
 */
import type {
  ChatSessionLifecycle,
  ChatSessionSlice,
  ChatSessionStore,
  ChatSessionWrites,
} from "./client";
import {
  applyProjection,
  dequeueSlice,
  enqueueSlice,
  foldStreamBatch,
  markAttaching,
  markDelivered,
  seedSlice,
  settleSlice,
} from "./session-slice";
import type { QueuedMessage } from "./session-model";

/** The writes, plus the queue door and the slice lifecycle the writes assume. */
export interface SurfaceSessions extends ChatSessionWrites {
  enqueue(sessionId: string, message: QueuedMessage): void;
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
  // itself mid-walk must not skip its neighbour.
  const announce = (): void => {
    const watchers = [...listeners];
    for (const listener of watchers) listener();
  };
  const swap = (sessions: Readonly<Record<string, ChatSessionSlice>>): void => {
    state = { ...state, sessions };
    announce();
  };
  /**
   * Every per-slice write lands through here, so one addressed to a Session
   * that is gone is a no-op rather than a resurrected slice — and an
   * identity-preserving transition publishes nothing.
   */
  const update = (
    sessionId: string,
    change: (slice: ChatSessionSlice) => ChatSessionSlice,
  ): void => {
    const slice = state.sessions[sessionId];
    if (slice === undefined) return;
    const next = change(slice);
    if (next === slice) return;
    swap({ ...state.sessions, [sessionId]: next });
  };

  state = {
    sessions: {},
    applyStream(sessionId, frames, overlays, progress = [], clearLiveCompaction = false) {
      update(sessionId, (slice) =>
        foldStreamBatch(slice, frames, overlays, progress, clearLiveCompaction),
      );
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
    enqueue(sessionId, message) {
      update(sessionId, (slice) => enqueueSlice(slice, message));
    },
    dequeue(sessionId, id) {
      update(sessionId, (slice) => dequeueSlice(slice, id));
    },
    seed(sessionId, lifecycle) {
      if (state.sessions[sessionId] !== undefined) return;
      swap({ ...state.sessions, [sessionId]: seedSlice(lifecycle) });
    },
    remove(sessionId) {
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
