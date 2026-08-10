/**
 * What crosses the Session RPC edge, read defensively.
 *
 * Every value here arrived as JSON — a stream emission or a mutation result —
 * so nothing downstream of this module may assume it is well-formed. The
 * transcript fold in {@link "./transcript"} is total only over well-formed
 * deltas; this is the last place a malformed one can still just be dropped
 * rather than drawn, or thrown from inside a React state updater.
 */
import type { SessionStreamOverlay, TranscriptDelta } from "@volli/session-engine";
import type { SessionEvent } from "@volli/shared";
import type { UIMessage } from "ai";

import type { ChatSessionFrame } from "@renderer/chat/transcript";

export function chatSessionFrame(value: unknown): ChatSessionFrame | null {
  if (
    !isRecord(value) ||
    typeof value.sessionId !== "string" ||
    typeof value.sequence !== "number" ||
    !isRecord(value.event) ||
    !isRecord(value.event.payload)
  ) {
    return null;
  }
  const transcript = chatTranscript(value.transcript);
  if (transcript === undefined) return null;
  return {
    sessionId: value.sessionId,
    sequence: value.sequence,
    event: value.event as unknown as SessionEvent,
    transcript,
  };
}

/**
 * The transient arm of the stream, told apart from the durable one by shape.
 *
 * The durable frame carries no `kind` of its own and is validated by its
 * `sequence`, so the two arms cannot be confused for each other — which is the
 * point of leaving the durable arm bare. Read structurally because this crosses
 * the RPC edge as JSON, and validated per op because the fold downstream is
 * total over well-formed deltas and says nothing about malformed ones: an
 * append with no text would concatenate the word "undefined" into the answer.
 *
 * Exported for its tests: this is the only check standing between whatever
 * arrives on the wire and a fold that assumes well-formed input, and every op
 * it lets through is one nothing downstream looks at again.
 */
export function chatSessionOverlay(value: unknown): SessionStreamOverlay | null {
  if (
    !isRecord(value) ||
    value.kind !== "overlay" ||
    typeof value.sessionId !== "string" ||
    typeof value.throughSequence !== "number" ||
    typeof value.messageId !== "string"
  ) {
    return null;
  }
  const delta = chatTranscriptDelta(value.delta);
  if (!delta) return null;
  return {
    kind: "overlay",
    sessionId: value.sessionId,
    throughSequence: value.throughSequence,
    messageId: value.messageId,
    delta,
  };
}

function chatTranscriptDelta(value: unknown): TranscriptDelta | null {
  if (!isRecord(value)) return null;
  switch (value.op) {
    case "reset":
      return isRecord(value.message) &&
        typeof value.message.id === "string" &&
        isTranscriptRole(value.message.role) &&
        isKeyedPartArray(value.message.parts)
        ? (value as unknown as TranscriptDelta)
        : null;
    case "part.upsert":
      return typeof value.key === "string" &&
        typeof value.index === "number" &&
        isRecord(value.part)
        ? (value as unknown as TranscriptDelta)
        : null;
    case "part.append":
      return typeof value.key === "string" && typeof value.text === "string"
        ? (value as unknown as TranscriptDelta)
        : null;
    case "part.remove":
      return typeof value.key === "string" ? (value as unknown as TranscriptDelta) : null;
    // `metadata` is opaque by contract, and `message.remove` carries nothing:
    // both are fully described by their op.
    case "metadata":
    case "message.remove":
      return value as unknown as TranscriptDelta;
    default:
      return null;
  }
}

function chatTranscript(value: unknown): ChatSessionFrame["transcript"] | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !isRecord(value.message)) return undefined;
  const message = value.message;
  if (
    typeof message.id !== "string" ||
    !isTranscriptRole(message.role) ||
    !isMessagePartArray(message.parts)
  ) {
    return undefined;
  }
  return { message: message as unknown as UIMessage };
}

function isTranscriptRole(value: unknown): value is "user" | "assistant" | "system" {
  return value === "user" || value === "assistant" || value === "system";
}

function isMessagePartArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isRecord);
}

/**
 * A `reset`'s parts, checked entry by entry rather than only as an array.
 *
 * `reset` is the one op that hands the fold a whole message instead of an edit
 * to one it already holds, so it is the one op whose payload nothing downstream
 * re-checks: `applyTranscriptDelta` stores the baseline as given, and
 * `projectKeyedTranscriptMessage` maps straight over `entry.part` to build the
 * `UIMessage` the chat draws. An entry that is `null` throws there, and one that
 * is merely missing `part` projects to `undefined` and reaches
 * `message-projection.ts`, where `speaks()` reads `part.type` off it — inside a
 * React state updater, which takes the whole chat surface down with it rather
 * than losing one message. `Array.isArray` alone lets both through, so the
 * shape is settled here, where a malformed delta can still just be dropped.
 */
function isKeyedPartArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => isRecord(entry) && typeof entry.key === "string" && isRecord(entry.part))
  );
}

/**
 * The refusal a resolved mutation can still be carrying.
 *
 * A command that reaches a harness earns a delivery receipt, and `rejected` is
 * one of its arms: the round trip succeeded and the harness said no. Read
 * structurally because this crosses the RPC edge as JSON and because only some
 * of the commands sent here carry a receipt at all — a shape without one is not
 * a refusal. Null means nothing refused it.
 */
export function rejectedReceipt(result: unknown): string | null {
  if (!isRecord(result) || !isRecord(result.receipt)) return null;
  const receipt = result.receipt;
  if (receipt.status !== "rejected") return null;
  if (typeof receipt.detail === "string" && receipt.detail.length > 0) return receipt.detail;
  return typeof receipt.code === "string" ? receipt.code : "rejected";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
