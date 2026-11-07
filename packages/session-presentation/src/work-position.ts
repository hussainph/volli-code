import {
  applyTranscriptDelta,
  type SessionStreamOverlay,
  type TranscriptOverlay,
} from "@volli/session-engine";
import type { UIMessage } from "ai";
import type { ChatSessionFrame } from "./transcript";

/** View identities only; none of these keys are persisted or minted as events. */
export function workPositionKey(
  part: UIMessage["parts"][number],
  messageId: string,
  index: number,
): string | null {
  return part.type === "dynamic-tool"
    ? `tool:${part.toolCallId}`
    : part.type === "reasoning"
      ? `reasoning:${messageId}:${index}`
      : null;
}
interface RemovedReasoning {
  messageId: string;
  key: string;
  position: number;
  viewKey: string;
  removedThrough: number;
}
export interface WorkPositionState {
  activityFirstOverlaySequence: ReadonlyMap<string, number>;
  activityViewKeys: ReadonlyMap<string, string>;
  /** Metadata-only, bounded handoffs between message.remove and settlement. */
  removedReasoning: readonly RemovedReasoning[];
}
export const EMPTY_WORK_POSITIONS: WorkPositionState = {
  activityFirstOverlaySequence: new Map(),
  activityViewKeys: new Map(),
  removedReasoning: [],
};
const MAX_HANDOFFS = 16;
const HANDOFF_LEDGER_WINDOW = 128;

/**
 * Keep work placement through the real translator's provisional -> entry id
 * transition. No prose equality, guessed timestamp or caller metadata is an
 * identity proof: correlation requires its frozen id forms plus the recorded
 * attachment/turn on the settled observation, with exactly one live handoff.
 * Missing/ambiguous evidence degrades to unknown placement, not a new fact.
 */
export function foldWorkPositions(
  prior: WorkPositionState,
  before: TranscriptOverlay,
  after: TranscriptOverlay,
  overlays: readonly SessionStreamOverlay[],
  frames: readonly ChatSessionFrame[],
  durableMessages: readonly UIMessage[],
  throughSequence: number,
): WorkPositionState {
  if (
    frames.length === 0 &&
    overlays.every(
      (emission) => emission.delta.op === "part.append" || emission.delta.op === "metadata",
    )
  )
    return prior;
  const positions = new Map(prior.activityFirstOverlaySequence);
  const viewKeys = new Map(prior.activityViewKeys);
  let pending = [...prior.removedReasoning];
  let scratch = before;
  const candidates = new Map<string, RemovedReasoning>();
  const capture = (overlay: TranscriptOverlay, messageId: string, removedThrough: number) => {
    const message = overlay.get(messageId);
    if (!message) return null;
    const thoughts = message.parts.flatMap((entry, index) =>
      entry.part.type === "reasoning"
        ? [{ key: workPositionKey(entry.part, messageId, index)! }]
        : [],
    );
    if (thoughts.length !== 1) return null;
    const key = thoughts[0]!.key;
    const position = positions.get(key);
    if (position === undefined) return null;
    return { messageId, key, position, viewKey: viewKeys.get(key) ?? key, removedThrough };
  };
  for (const item of pending) candidates.set(item.messageId, item);
  for (const id of before.keys()) {
    const candidate = capture(before, id, 0);
    if (candidate) candidates.set(id, candidate);
  }
  for (const emission of overlays) {
    if (emission.delta.op === "reset") {
      const prefix = /^(.*:)(?:0|[1-9]\d*)$/.exec(emission.messageId)?.[1];
      if (prefix) {
        for (const [id, candidate] of candidates) {
          if (
            id === emission.messageId ||
            !id.startsWith(prefix) ||
            !/^(?:0|[1-9]\d*)$/.test(id.slice(prefix.length))
          )
            continue;
          // A newer provisional stream retires tool-only withdrawals. Keep
          // the old handoff only if this same batch contains its preceding
          // settlement; durable-first batching must not erase that transition.
          const settling = frames.some((frame) => {
            const payload = frame.event?.payload;
            const message = frame.transcript?.message;
            if (
              payload?.kind !== "transcript.referenced" ||
              !message ||
              payload.attachmentId === null ||
              payload.turnId === null
            )
              return false;
            const marker = `:${payload.attachmentId}:entry:`;
            const at = message.id.indexOf(marker);
            return (
              at > 0 &&
              `${message.id.slice(0, at)}:${payload.attachmentId}:${payload.turnId}:` === prefix &&
              frame.sequence > candidate.removedThrough &&
              frame.sequence <= emission.throughSequence
            );
          });
          if (!settling) candidates.delete(id);
        }
        pending = pending.filter((item) => candidates.has(item.messageId));
      }
    }
    const entries =
      emission.delta.op === "reset"
        ? emission.delta.message.parts.map((entry, index) => ({ part: entry.part, index }))
        : emission.delta.op === "part.upsert"
          ? [{ part: emission.delta.part, index: emission.delta.index }]
          : [];
    for (const { part, index } of entries) {
      const key = workPositionKey(part, emission.messageId, index);
      if (key !== null)
        positions.set(
          key,
          Math.min(positions.get(key) ?? emission.throughSequence, emission.throughSequence),
        );
    }
    if (emission.delta.op === "message.remove") {
      const candidate = capture(scratch, emission.messageId, emission.throughSequence);
      if (candidate) {
        candidates.set(candidate.messageId, candidate);
        pending = [
          ...pending.filter((item) => item.messageId !== candidate.messageId),
          candidate,
        ].slice(-MAX_HANDOFFS);
      }
    }
    scratch = applyTranscriptDelta(scratch, emission.messageId, emission.delta);
    const current = capture(scratch, emission.messageId, emission.throughSequence);
    if (current) candidates.set(current.messageId, current);
  }
  for (const frame of frames) {
    const payload = frame.event?.payload;
    const message = frame.transcript?.message;
    if (
      payload?.kind !== "transcript.referenced" ||
      message?.role !== "assistant" ||
      payload.attachmentId === null ||
      payload.turnId === null
    )
      continue;
    const marker = `:${payload.attachmentId}:entry:`;
    const markerAt = message.id.indexOf(marker);
    if (markerAt < 1 || message.id.slice(markerAt + marker.length).length === 0) continue;
    const prefix = `${message.id.slice(0, markerAt)}:${payload.attachmentId}:${payload.turnId}:`;
    const matching = [...candidates.values()].filter(
      (item) =>
        item.messageId.startsWith(prefix) &&
        /^\d+$/.test(item.messageId.slice(prefix.length)) &&
        item.removedThrough < frame.sequence,
    );
    const thoughts = message.parts.flatMap((part, index) =>
      part.type === "reasoning" ? [{ key: workPositionKey(part, message.id, index)! }] : [],
    );
    if (matching.length !== 1 || thoughts.length !== 1) continue;
    const candidate = matching[0]!;
    const key = thoughts[0]!.key;
    positions.set(key, candidate.position);
    viewKeys.set(key, candidate.viewKey);
    candidates.delete(candidate.messageId);
    pending = pending.filter((item) => item.messageId !== candidate.messageId);
  }
  // A remove with no eventual settled reasoning must not retain arbitrary old
  // message/index keys. Only bounded metadata handoffs survive removal; a turn
  // close or a bounded advance of the ledger also retires those handoffs.
  pending = pending
    .filter(
      (item) =>
        throughSequence - item.removedThrough <= HANDOFF_LEDGER_WINDOW &&
        !frames.some((frame) => {
          const payload = frame.event?.payload;
          if (payload?.kind === "attachment.closed")
            return item.messageId.includes(`:${payload.attachmentId}:`);
          if (payload?.kind === "attachment.failed")
            return item.messageId.includes(`:${payload.attachment.id}:`);
          return (
            (payload?.kind === "turn.completed" || payload?.kind === "turn.interrupted") &&
            item.messageId.includes(`:${payload.attachmentId}:${payload.turnId}:`)
          );
        }),
    )
    .slice(-MAX_HANDOFFS);
  const reachable = new Set<string>();
  for (const message of durableMessages)
    message.parts.forEach((part, index) => {
      const key = workPositionKey(part, message.id, index);
      if (key !== null) reachable.add(key);
    });
  for (const message of after.values())
    message.parts.forEach((entry, index) => {
      const key = workPositionKey(entry.part, message.id, index);
      if (key !== null) reachable.add(key);
    });
  for (const key of positions.keys()) if (!reachable.has(key)) positions.delete(key);
  for (const key of viewKeys.keys()) if (!reachable.has(key)) viewKeys.delete(key);
  const samePositions =
    positions.size === prior.activityFirstOverlaySequence.size &&
    [...positions].every(([key, value]) => prior.activityFirstOverlaySequence.get(key) === value);
  const sameKeys =
    viewKeys.size === prior.activityViewKeys.size &&
    [...viewKeys].every(([key, value]) => prior.activityViewKeys.get(key) === value);
  const samePending =
    pending.length === prior.removedReasoning.length &&
    pending.every((item, index) => item === prior.removedReasoning[index]);
  return samePositions && sameKeys && samePending
    ? prior
    : {
        activityFirstOverlaySequence: samePositions
          ? prior.activityFirstOverlaySequence
          : positions,
        activityViewKeys: sameKeys ? prior.activityViewKeys : viewKeys,
        removedReasoning: samePending ? prior.removedReasoning : pending,
      };
}
