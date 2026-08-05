/**
 * The chat transcript's durable state, folded forward from the Session stream.
 *
 * A Session stream is two arms — durable frames and transient overlay deltas —
 * and this is where the two meet: {@link appendFrames} is the whole fold, and
 * everything else here is either the state it produces or a rule that fold
 * relies on to stay correct across batches. No React, no transport; every
 * function is total over its arguments so the fold is testable without
 * mounting a session.
 */
import {
  applyTranscriptDelta,
  type SessionStreamOverlay,
  type TranscriptOverlay,
} from "@volli/session-engine";
import type { SessionEvent, SessionInteraction } from "@volli/shared";
import type { UIMessage } from "ai";

import { indexOpenedInteractions } from "@renderer/chat/interaction";
import {
  layerTranscriptOverlay,
  projectTranscriptMessages,
} from "@renderer/chat/message-projection";

export interface ChatSessionFrame {
  sessionId: string;
  sequence: number;
  event: SessionEvent;
  transcript: { message: UIMessage } | null;
}

/**
 * What the stream alone can say, kept between batches.
 *
 * Every fact this surface needs about a live turn is already in the frames it
 * is subscribed to, so this is folded forward as they arrive rather than
 * re-derived from the whole transcript on every render: `turnActive` used to be
 * a scan of all frames in the render body, and the ordered list used to be a
 * copy-and-sort of a Map per animation frame. All of it is now linear in the
 * batch.
 *
 * `messages` and `openedInteractions` joined it for the same reason and after
 * the same measurement mistake. Both were memoized on the frame list, and that
 * list is rebuilt on every batch — so the memo missed every time, and each miss
 * re-read *every frame the Session has ever committed*. Frames outgrew messages
 * badly: a streamed reply committed a transcript snapshot per chunk, several
 * per animation frame, and every one of them made both scans longer for the
 * rest of the Session. Folded, a batch costs the batch — and the flood itself
 * is gone now, since a message mid-word arrives as an overlay and commits
 * nothing.
 */
export interface ChatTranscriptState {
  frames: readonly ChatSessionFrame[];
  throughSequence: number;
  turnActive: boolean;
  /** Latest settled shape per message id, in the order the ids first spoke. */
  durableMessages: readonly UIMessage[];
  /**
   * The messages still being written, keyed by id in the order they first
   * spoke. Transient by construction: an entry exists only between a message's
   * first delta and the durable frame that settles it.
   */
  overlay: TranscriptOverlay;
  /**
   * The last durable transcript sequence applied per message id — the staleness
   * guard's whole state.
   *
   * An overlay carries the durable sequence it was emitted beside, and delivery
   * can reorder the two: a baseline emitted before a settle can arrive after
   * it, and applying it would resurrect a message that has already finished.
   * Comparing against what settled is what makes that harmless, and it is why
   * durable frames and overlays inside one batch can be applied in either order.
   */
  durableSequences: ReadonlyMap<string, number>;
  /** What the chat draws: the durable list with every live overlay laid over it. */
  messages: readonly UIMessage[];
  /** Every interaction this Session has opened, for the receipts they leave. */
  openedInteractions: ReadonlyMap<string, SessionInteraction>;
}

const EMPTY_INTERACTION_INDEX: ReadonlyMap<string, SessionInteraction> = new Map();
const EMPTY_OVERLAY: TranscriptOverlay = new Map();
const EMPTY_DURABLE_SEQUENCES: ReadonlyMap<string, number> = new Map();
export const EMPTY_TRANSCRIPT: ChatTranscriptState = {
  frames: [],
  throughSequence: 0,
  turnActive: false,
  durableMessages: [],
  overlay: EMPTY_OVERLAY,
  durableSequences: EMPTY_DURABLE_SEQUENCES,
  messages: [],
  openedInteractions: EMPTY_INTERACTION_INDEX,
};

/**
 * Adds one batch of frames and overlays, and carries everything derived from
 * them across it.
 *
 * Frames arrive in strict sequence order — the subscription drains its cursor
 * one step at a time, and the snapshot that seeds it is ordered too — so this
 * appends rather than merges, and drops anything at or below the cursor so a
 * replayed frame cannot double-count a turn boundary.
 *
 * The two arms are applied durable-first, and the staleness guard is what makes
 * that a choice rather than a requirement: an overlay from before the settle it
 * predates is dropped whichever way round the two are read.
 *
 * Exported for its tests: this is where the transcript's whole per-frame budget
 * now lives, and a fold is only worth having if it says exactly what the scan
 * it replaced said.
 */
export function appendFrames(
  state: ChatTranscriptState,
  batch: readonly ChatSessionFrame[],
  overlays: readonly SessionStreamOverlay[] = [],
): ChatTranscriptState {
  const fresh = batch.filter((frame) => frame.sequence > state.throughSequence);
  const last = fresh.at(-1);
  if (!last && overlays.length === 0) return state;

  let turnActive = state.turnActive;
  let overlay = state.overlay;
  // Copied once, and only if something settles. A history replay hands this
  // every transcript frame the Session ever committed in a single batch, and
  // copying per frame would make seeding an old Session quadratic in its own
  // length — the exact cost the delta contract exists to remove.
  let settled: Map<string, number> | null = null;
  for (const frame of fresh) {
    if (frame.event.payload.kind === "turn.started") turnActive = true;
    else if (frame.event.payload.kind === "turn.completed") turnActive = false;
    const settledId = frame.transcript?.message.id;
    if (settledId === undefined) continue;
    // The settle point: the message is durable now, so the transient entry goes
    // and the sequence it settled at is what the guard below compares against.
    // Same words on both sides when the emitter is honest, so nothing jumps.
    settled ??= new Map(state.durableSequences);
    settled.set(settledId, frame.sequence);
    if (overlay.has(settledId)) overlay = withoutOverlayMessage(overlay, settledId);
  }
  const durableSequences: ReadonlyMap<string, number> = settled ?? state.durableSequences;
  for (const emission of overlays) {
    const settledAt = durableSequences.get(emission.messageId);
    // The staleness guard, and the only rule this fold owns: everything else
    // about a delta is `applyTranscriptDelta`'s, including its self-healing
    // answer to a non-reset delta for a message it holds no entry for.
    if (settledAt !== undefined && emission.throughSequence < settledAt) continue;
    overlay = applyTranscriptDelta(overlay, emission.messageId, emission.delta);
  }
  // A batch of nothing but stale or orphaned overlays folds to the state it was
  // handed, and a fresh object here would repaint the transcript for nothing.
  if (!last && overlay === state.overlay) return state;

  // These keep their previous identity when the batch had nothing for them,
  // which is the other half of the point: a batch of pure tool traffic must not
  // hand the plane a new message list to re-group and re-segment.
  const opened = indexOpenedInteractions(fresh);
  const durableMessages = mergeTranscriptMessages(
    state.durableMessages,
    projectTranscriptMessages(fresh),
  );
  return {
    frames: last ? [...state.frames, ...fresh] : state.frames,
    throughSequence: last ? last.sequence : state.throughSequence,
    turnActive,
    durableMessages,
    overlay,
    durableSequences,
    messages:
      durableMessages === state.durableMessages && overlay === state.overlay
        ? state.messages
        : layerTranscriptOverlay(durableMessages, overlay),
    openedInteractions:
      opened.size === 0
        ? state.openedInteractions
        : new Map([...state.openedInteractions, ...opened]),
  };
}

function withoutOverlayMessage(overlay: TranscriptOverlay, messageId: string): TranscriptOverlay {
  const next = new Map(overlay);
  next.delete(messageId);
  return next;
}

/**
 * One batch of projected messages, folded into the ones already on screen.
 *
 * The rule is {@link projectTranscriptMessages}'s own, held across batches
 * rather than re-derived from the start: transcript events are immutable
 * snapshots, so a message id keeps the position it first spoke at and shows its
 * latest shape. Searching from the tail because that is where a streaming
 * snapshot always lands — a re-emitted message from further back costs the walk
 * it would have cost anyway.
 */
export function mergeTranscriptMessages(
  current: readonly UIMessage[],
  projected: readonly UIMessage[],
): readonly UIMessage[] {
  if (projected.length === 0) return current;
  const merged = [...current];
  for (const message of projected) {
    const at = merged.findLastIndex((held) => held.id === message.id);
    if (at < 0) merged.push(message);
    else merged[at] = message;
  }
  return merged;
}

/**
 * Whether a frame can move what this surface reads off the projection.
 *
 * Everything except a transcript reference. The flood this was built to hold
 * back — a snapshot per chunk, several per animation frame — is typed away
 * rather than filtered now: a message mid-word arrives as an overlay, which
 * never reaches this function and never asks for a projection. What is left is
 * the settle point, and it still carries a message this surface already has in
 * `frames`. Every other fact is rare and changes something read off the
 * projection (the live executor, an open interaction, an attention, a turn
 * boundary), so it earns its round trip.
 */
export function movesProjection(frame: ChatSessionFrame): boolean {
  return frame.event.payload.kind !== "transcript.referenced";
}
