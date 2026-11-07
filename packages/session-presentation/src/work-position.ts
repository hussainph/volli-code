import type { SessionStreamOverlay, TranscriptOverlay } from "@volli/session-engine";
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
  /** Kept empty: the existing wire cannot prove a provisional-to-entry alias. */
  activityViewKeys: ReadonlyMap<string, string>;
  /** No unlinked withdrawn thought is retained as a potential future owner. */
  removedReasoning: readonly RemovedReasoning[];
}
export const EMPTY_WORK_POSITIONS: WorkPositionState = {
  activityFirstOverlaySequence: new Map(),
  activityViewKeys: new Map(),
  removedReasoning: [],
};

/**
 * Retain actual observed positions only while their exact view identity is
 * reachable. Tool call ids survive settlement; provisional reasoning message
 * ids do not. The wire has no recorded link to the eventual entry id: matching
 * attachment/turn, time, prefix, ordinal or prose cannot prove that identity.
 *
 * In particular, message.remove may mean a tool-only withdrawal, followed by a
 * wholly different settled thought with no reset. Do not retain handoffs or
 * adopt their positions at all. This also prevents adoption across lifecycle
 * barriers or arbitrary ledger gaps. Such settled reasoning keeps its recorded
 * position and unknown duration, with full original content available.
 */
export function foldWorkPositions(
  prior: WorkPositionState,
  after: TranscriptOverlay,
  overlays: readonly SessionStreamOverlay[],
  frames: readonly ChatSessionFrame[],
  durableMessages: readonly UIMessage[],
): WorkPositionState {
  if (
    frames.length === 0 &&
    prior.activityViewKeys.size === 0 &&
    prior.removedReasoning.length === 0 &&
    overlays.every(
      (emission) => emission.delta.op === "part.append" || emission.delta.op === "metadata",
    )
  ) return prior;
  const positions = new Map(prior.activityFirstOverlaySequence);
  // Revoke unsupported lineage if an already-resident view predates this fix.
  for (const key of prior.activityViewKeys.keys()) positions.delete(key);
  for (const emission of overlays) {
    const entries = emission.delta.op === "reset"
      ? emission.delta.message.parts.map((entry, index) => ({ part: entry.part, index }))
      : emission.delta.op === "part.upsert"
        ? [{ part: emission.delta.part, index: emission.delta.index }]
        : [];
    for (const { part, index } of entries) {
      const key = workPositionKey(part, emission.messageId, index);
      if (key !== null) positions.set(key, Math.min(positions.get(key) ?? emission.throughSequence, emission.throughSequence));
    }
  }
  const reachable = new Set<string>();
  for (const message of durableMessages) message.parts.forEach((part, index) => {
    const key = workPositionKey(part, message.id, index);
    if (key !== null) reachable.add(key);
  });
  for (const message of after.values()) message.parts.forEach((entry, index) => {
    const key = workPositionKey(entry.part, message.id, index);
    if (key !== null) reachable.add(key);
  });
  for (const key of positions.keys()) if (!reachable.has(key)) positions.delete(key);
  const samePositions = positions.size === prior.activityFirstOverlaySequence.size &&
    [...positions].every(([key, value]) => prior.activityFirstOverlaySequence.get(key) === value);
  return samePositions && prior.activityViewKeys.size === 0 && prior.removedReasoning.length === 0
    ? prior
    : {
        activityFirstOverlaySequence: samePositions ? prior.activityFirstOverlaySequence : positions,
        activityViewKeys: EMPTY_WORK_POSITIONS.activityViewKeys,
        removedReasoning: EMPTY_WORK_POSITIONS.removedReasoning,
      };
}
