/**
 * The pure transitions of one Session's resident slice — the write-model half
 * of the Session Surface Model.
 *
 * Every store that satisfies {@link ChatSessionWrites} applies these same
 * transitions with these same guards: the desktop's zustand store delegates
 * here, and the package's own {@link createSurfaceStore} is nothing but these
 * functions behind a listener set. They are extracted (VC-169) so a second
 * Volli client inherits the rules below — the turn-epoch guard, the settle
 * handback, the identity-preserving no-ops — instead of re-learning the
 * incidents that produced them.
 *
 * Each function takes a slice and returns one. The batch and queue
 * transitions return THE SAME slice when a write had nothing for them,
 * because callers publish on identity: an unchanged slice is what keeps a
 * no-op write from repainting a chat.
 */
import type { SessionStreamCompactionProgress, SessionStreamOverlay } from "@volli/session-engine";
import type { SessionStreamQueue } from "@volli/session-engine";
import type { ChatSessionProjection } from "./client";

import {
  isWorking,
  settledLifecycle,
  type ChatSessionLifecycle,
  type ChatSessionSlice,
} from "./client";
import { queuedMessageFromHost } from "./session-model";
import {
  appendFrames,
  EMPTY_TRANSCRIPT,
  prependTranscriptHistory,
  seedTranscriptWindow,
  type ChatSessionFrame,
  type TranscriptWindow,
} from "./transcript";

/** A slice as a Session first appears: undescribed, empty, and `lifecycle` as seeded. */
export function seedSlice(lifecycle: ChatSessionLifecycle): ChatSessionSlice {
  return {
    projection: null,
    transcript: EMPTY_TRANSCRIPT,
    lifecycle,
    sessionError: null,
    queue: [],
  };
}

/** One folded stream batch: the transcript fold, then the lifecycle it settles to. */
export function foldStreamBatch(
  slice: ChatSessionSlice,
  frames: readonly ChatSessionFrame[],
  overlays: readonly SessionStreamOverlay[],
  progress: readonly SessionStreamCompactionProgress[] = [],
  clearLiveCompaction = false,
): ChatSessionSlice {
  const transcript = appendFrames(
    slice.transcript,
    frames,
    overlays,
    progress,
    clearLiveCompaction,
  );
  // `appendFrames` returns what it was handed when a batch had nothing
  // for it, and a fresh slice here would repaint the chat for nothing.
  if (transcript === slice.transcript) return slice;
  const next = { ...slice, transcript };
  return { ...next, lifecycle: settledLifecycle(slice, next) };
}

/**
 * A snapshot: its window of frames and the projection checkpoint they end at,
 * applied as one write so nothing reads the frames against an older projection.
 */
export function applySnapshotWindow(
  slice: ChatSessionSlice,
  window: TranscriptWindow,
  projection: ChatSessionProjection,
): ChatSessionSlice {
  const transcript = seedTranscriptWindow(slice.transcript, window, projection);
  // The queue is host-projected state, not transcript: the window bounds the
  // frames and leaves the follow-ups the projection carries untouched (VC-675).
  const next = {
    ...applyQueue(slice, projection.queue ?? [], projection.queueRevision ?? -1),
    transcript,
    projection,
  };
  return { ...next, lifecycle: settledLifecycle(slice, next) };
}

/**
 * Older history above the transcript (VC-315). Lifecycle is not consulted: a
 * page is the past, and it moves nothing about the turn running now.
 */
export function prependSliceHistory(
  slice: ChatSessionSlice,
  requested: number,
  page: TranscriptWindow,
): ChatSessionSlice {
  const transcript = prependTranscriptHistory(slice.transcript, requested, page);
  return transcript === slice.transcript ? slice : { ...slice, transcript };
}

/** A fresh durable projection, and the lifecycle it settles the slice to. */
export function applyProjection(
  slice: ChatSessionSlice,
  projection: ChatSessionProjection,
): ChatSessionSlice {
  const next = {
    ...applyQueue(slice, projection.queue ?? [], projection.queueRevision ?? -1),
    projection,
  };
  return { ...next, lifecycle: settledLifecycle(slice, next) };
}

/** An attachment attempt is in flight; nothing derives lifecycle until it lands. */
export function markAttaching(slice: ChatSessionSlice): ChatSessionSlice {
  return { ...slice, lifecycle: "starting", sessionError: null };
}

/**
 * The harness took a message — optimistically, and only while the stream has
 * said nothing since it left. `turnEpoch` is the transcript's count at submit.
 */
export function markDelivered(slice: ChatSessionSlice, turnEpoch: number): ChatSessionSlice {
  return {
    ...slice,
    // An unchanged epoch means the stream has said nothing about turns
    // since the message left, so the optimistic "a turn is running" is
    // the only reading there is. A moved one means it has spoken — and it
    // outranks a reply that, with Pi, arrives after the turn it started
    // has already ended.
    lifecycle: slice.transcript.turnEpoch === turnEpoch || isWorking(slice) ? "working" : "ready",
    sessionError: null,
  };
}

/** A failure latched onto the slice, or `null` to clear one. */
export function settleSlice(slice: ChatSessionSlice, error: string | null): ChatSessionSlice {
  return error === null
    ? // Clearing hands the Session back to its stream. What replaces a
      // failure is what the frames already say, not a guess — and while
      // `error` stood, nothing was deriving lifecycle at all.
      {
        ...slice,
        lifecycle: isWorking(slice) ? "working" : "ready",
        sessionError: null,
      }
    : { ...slice, lifecycle: "error", sessionError: error };
}

/** Queue revisions are independent of transcript sequence; stale snapshots cannot undo mutations. */
export function applyQueue(
  slice: ChatSessionSlice,
  queue: SessionStreamQueue["queue"],
  revision: number,
): ChatSessionSlice {
  if (revision <= (slice.queueRevision ?? -1)) return slice;
  return { ...slice, queue: queue.map(queuedMessageFromHost), queueRevision: revision };
}

/**
 * An optimistic retitle, ahead of the stream. A slice the stream has not
 * described is returned unchanged — there is no title to correct yet, and
 * inventing a projection around one would put a Session on screen that
 * nothing has described.
 */
export function retitleSlice(slice: ChatSessionSlice, title: string): ChatSessionSlice {
  return slice.projection === null
    ? slice
    : {
        ...slice,
        projection: {
          ...slice.projection,
          session: { ...slice.projection.session, title },
        },
      };
}
