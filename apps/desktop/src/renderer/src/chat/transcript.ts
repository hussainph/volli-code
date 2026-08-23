/**
 * The chat transcript's durable state, folded forward from the Session stream.
 *
 * A Session stream has one durable arm and two live ones — transcript deltas
 * and compaction progress — and this is where they meet: {@link appendFrames}
 * is the whole fold, and
 * everything else here is either the state it produces or a rule that fold
 * relies on to stay correct across batches. No React, no transport; every
 * function is total over its arguments so the fold is testable without
 * mounting a session.
 */
import {
  applyTranscriptDelta,
  type SessionStreamCompactionProgress,
  type SessionStreamOverlay,
  type TranscriptOverlay,
} from "@volli/session-engine";
import type {
  CompactionReason,
  RendererSessionEvent,
  RendererSessionEventPayload,
  RendererSessionInteraction,
} from "@volli/shared";
import type { UIMessage } from "ai";

import { indexOpenedInteractions } from "@renderer/chat/interaction";
import {
  layerTranscriptOverlay,
  projectTranscriptMessages,
  speaksInTranscript,
} from "@renderer/chat/message-projection";

export interface ChatSessionFrame {
  sessionId: string;
  sequence: number;
  /**
   * The renderer-safe event, or null for a kind this build does not know — a
   * writer newer than the reader. The envelope survives because its sequence
   * must still advance the fold's cursor; the fold reads nothing from it.
   */
  event: RendererSessionEvent | null;
  transcript: { message: UIMessage } | null;
}

/**
 * One compaction, pinned to where in the conversation it happened.
 *
 * Two arms, because the ledger has two and they are not one fact with an
 * outcome: a compaction that happened divides the transcript and has a count
 * behind it, and one that failed divides nothing and has only the executor's
 * own words. Both are folded, because a failure that leaves no mark on screen is
 * exactly the silence the durable event was added to break.
 *
 * `afterMessageId` is the anchor, and it is a message id rather than a position
 * because positions move: the durable list only ever grows at its end, but where
 * a given message sits in the list a surface is drawing depends on what has been
 * laid over it. The id is what the transcript can still find. `null` means the
 * Session had said nothing yet.
 *
 * `tokensAfter` rides the durable event and is deliberately not folded. Nothing
 * has measured the compacted context and nothing can until the model next
 * answers on it — `chat/compaction-boundary.ts` owns that decision and the
 * reasoning, and a field carried here would be an invitation to draw it.
 */
export type TranscriptCompaction = {
  /** The frame's sequence: its identity here, and the row's React key. */
  sequence: number;
  reason: CompactionReason;
  afterMessageId: string | null;
} & (
  | { outcome: "compacted"; tokensBefore: number }
  /** The executor's sanitized diagnostic; empty when it had nothing to say. */
  | { outcome: "failed"; detail: string }
);

/** A live compaction marker, deliberately smaller than the transient transport arm. */
export interface LiveTranscriptCompaction {
  throughSequence: number;
  reason: CompactionReason;
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
  /**
   * How many turn boundaries this Session has crossed.
   *
   * `turnActive` alone cannot say that a turn happened, only that one is open
   * now, and a batch is not one frame: a turn that opens and closes inside a
   * single fold — a fast refusal, a 50ms occluded-window batch, a reconnect
   * replaying what was missed — leaves the flag exactly where it found it. The
   * count is what tells that batch apart from one that said nothing about turns
   * at all, and `settledLifecycle` needs the difference: without it, a Session
   * optimistically marked busy by a delivered message never learns that the turn
   * it was waiting on has already been and gone.
   */
  turnEpoch: number;
  /** Latest settled shape per message id, in the order the ids first spoke. */
  durableMessages: readonly UIMessage[];
  /**
   * The messages still being written, keyed by id in the order they first
   * spoke. Transient by construction: an entry exists only between a message's
   * first delta and the durable frame that settles it.
   */
  overlay: TranscriptOverlay;
  /**
   * The context summary currently running, or null once it finishes. Unlike a
   * boundary, this is never history: an interrupted attachment must not revive
   * it when the transcript is re-read.
   */
  liveCompaction: LiveTranscriptCompaction | null;
  /**
   * The newest durable compaction outcome. It rejects a delayed live marker
   * that would otherwise redraw a spinner beneath the boundary that settled it.
   */
  lastCompactionSequence: number;
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
  openedInteractions: ReadonlyMap<string, RendererSessionInteraction>;
  /**
   * The skills this Session was started with — the names off its durable
   * `prompt-resources` input event. The system prompt those resources landed
   * in is not a transcript message, so this fold is how the transcript still
   * shows the injection happened: the chat surface draws the names above the
   * conversation. At most one such event exists per Session (the record is
   * written once, ahead of the first attachment), so the fold is last-write-
   * wins over a list that never actually changes.
   */
  promptResources: readonly string[];
  /**
   * Every compaction this Session has been through, oldest first.
   *
   * Folded rather than scanned for the reason everything else here is: the
   * anchor a boundary needs is *which message had been said when it happened*,
   * and only a pass in frame order knows that. Rebuilt from the whole frame
   * list it would cost the Session's length on every settled reply, for a fact
   * that moves once or twice in a long conversation.
   */
  compactions: readonly TranscriptCompaction[];
}

const EMPTY_INTERACTION_INDEX: ReadonlyMap<string, RendererSessionInteraction> = new Map();
const EMPTY_OVERLAY: TranscriptOverlay = new Map();
const EMPTY_DURABLE_SEQUENCES: ReadonlyMap<string, number> = new Map();
const EMPTY_PROMPT_RESOURCES: readonly string[] = [];
const EMPTY_COMPACTIONS: readonly TranscriptCompaction[] = [];
export const EMPTY_TRANSCRIPT: ChatTranscriptState = {
  frames: [],
  throughSequence: 0,
  turnActive: false,
  turnEpoch: 0,
  durableMessages: [],
  overlay: EMPTY_OVERLAY,
  liveCompaction: null,
  lastCompactionSequence: 0,
  durableSequences: EMPTY_DURABLE_SEQUENCES,
  messages: [],
  openedInteractions: EMPTY_INTERACTION_INDEX,
  promptResources: EMPTY_PROMPT_RESOURCES,
  compactions: EMPTY_COMPACTIONS,
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
  progress: readonly SessionStreamCompactionProgress[] = [],
  clearLiveCompaction = false,
): ChatTranscriptState {
  const fresh = batch.filter((frame) => frame.sequence > state.throughSequence);
  const last = fresh.at(-1);
  if (!last && overlays.length === 0 && progress.length === 0 && !clearLiveCompaction) return state;

  let turnActive = state.turnActive;
  let turnEpoch = state.turnEpoch;
  let overlay = state.overlay;
  let liveCompaction = clearLiveCompaction ? null : state.liveCompaction;
  let lastCompactionSequence = state.lastCompactionSequence;
  let promptResources = state.promptResources;
  // Collected, then appended once, and null while nothing has landed — which is
  // the whole of it: a batch that carried no compaction must hand back the very
  // array it was given, or the surface above re-weaves every turn on screen for
  // a fact that did not move.
  let landed: TranscriptCompaction[] | null = null;
  // What the transcript had said when the next compaction lands. The batch
  // starts wherever the last one left off — the durable list only ever grows at
  // its end, so its last entry IS the newest thing on screen — and moves inside
  // the loop, because a batch can carry a reply and the compaction that
  // followed it, and a boundary drawn at the batch's edge would sit in the
  // wrong place for one of them.
  let anchorId = state.durableMessages.at(-1)?.id ?? null;
  // Copied once, and only if something settles. A history replay hands this
  // every transcript frame the Session ever committed in a single batch, and
  // copying per frame would make seeding an old Session quadratic in its own
  // length — the exact cost the delta contract exists to remove.
  let settled: Map<string, number> | null = null;
  for (const frame of fresh) {
    const kind = frame.event?.payload.kind;
    if (kind === "turn.started" || kind === "turn.completed" || kind === "turn.interrupted") {
      turnActive = kind === "turn.started";
      turnEpoch += 1;
    }
    // Read off the same optional `frame.event` the turn fold above uses: the
    // renderer-safe form carries no event for a frame whose payload did not
    // survive the scrub.
    const payload = frame.event?.payload;
    if (payload?.kind === "session.input.recorded" && payload.input.kind === "prompt-resources") {
      promptResources = payload.input.resources.map((resource) => resource.name);
    }
    const compaction = compactionFrame(payload, frame.sequence, anchorId);
    if (compaction !== null) {
      (landed ??= []).push(compaction);
      lastCompactionSequence = frame.sequence;
      if (liveCompaction !== null && liveCompaction.throughSequence <= lastCompactionSequence) {
        liveCompaction = null;
      }
    }
    if (payload?.kind === "attachment.closed") liveCompaction = null;
    const settledMessage = frame.transcript?.message;
    if (settledMessage === undefined) continue;
    // A message with nothing to draw takes no position, so it is not somewhere a
    // boundary can be drawn after either — one rule, asked rather than restated.
    if (speaksInTranscript(settledMessage)) anchorId = settledMessage.id;
    const settledId = settledMessage.id;
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
  for (const emission of progress) {
    if (emission.state === "finished") {
      if (liveCompaction !== null && emission.throughSequence >= liveCompaction.throughSequence) {
        liveCompaction = null;
      }
      continue;
    }
    // A start always carries the sequence before its eventual durable outcome.
    // An older one that arrives after that outcome cannot become live again.
    if (emission.throughSequence < lastCompactionSequence) continue;
    if (
      liveCompaction === null ||
      liveCompaction.throughSequence !== emission.throughSequence ||
      liveCompaction.reason !== emission.reason
    ) {
      liveCompaction = { throughSequence: emission.throughSequence, reason: emission.reason };
    }
  }
  // A batch of nothing but stale or orphaned transient state folds to the state
  // it was handed, and a fresh object here would repaint the transcript for
  // nothing.
  if (
    !last &&
    overlay === state.overlay &&
    liveCompaction === state.liveCompaction &&
    lastCompactionSequence === state.lastCompactionSequence
  ) {
    return state;
  }

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
    turnEpoch,
    durableMessages,
    overlay,
    liveCompaction,
    lastCompactionSequence,
    durableSequences,
    messages:
      durableMessages === state.durableMessages && overlay === state.overlay
        ? state.messages
        : layerTranscriptOverlay(durableMessages, overlay),
    openedInteractions:
      opened.size === 0
        ? state.openedInteractions
        : new Map([...state.openedInteractions, ...opened]),
    promptResources,
    compactions: landed === null ? state.compactions : [...state.compactions, ...landed],
  };
}

/**
 * The two ledger facts a compaction leaves, read as one row — or nothing at all,
 * which is what every other frame is to this question.
 *
 * Named rather than inlined so the two arms are one decision: they share an
 * anchor and a sequence, and the only thing that differs between them is the
 * evidence each actually has.
 */
function compactionFrame(
  payload: RendererSessionEventPayload | undefined,
  sequence: number,
  afterMessageId: string | null,
): TranscriptCompaction | null {
  if (payload?.kind === "context.compacted") {
    return {
      sequence,
      reason: payload.reason,
      afterMessageId,
      outcome: "compacted",
      tokensBefore: payload.tokensBefore,
    };
  }
  if (payload?.kind === "context.compaction_failed") {
    return {
      sequence,
      reason: payload.reason,
      afterMessageId,
      outcome: "failed",
      detail: payload.detail,
    };
  }
  return null;
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
  // A kind this build does not know may well have moved the projection — the
  // server that folded it is the newer writer — so the honest answer for a
  // null event is to go and ask.
  if (frame.event === null) return true;
  return frame.event.payload.kind !== "transcript.referenced";
}
