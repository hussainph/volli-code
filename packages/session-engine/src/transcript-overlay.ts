import type { UIMessage } from "ai";

/**
 * The transient half of the transcript, and the pure fold over it.
 *
 * A durable `UIMessage` is a settled fact: it needs no addressing beyond its
 * own id, because it always arrives whole. A message still being written does.
 * The delta that grows it has to name the part it grows, and part *positions*
 * are not that name — projection elides parts (empty text between two tool
 * calls, reasoning that has no words yet, tool states with nothing to draw), so
 * a provider's part order and the projected order disagree routinely. So the
 * transient shape keys every part by the provider id it came from, and the
 * projection back to a `UIMessage` is exactly "drop the keys" — the shape every
 * durable consumer already reads.
 *
 * The fold is self-healing by construction. Its emitter owes two sequencing
 * rules — the first delta for a message id is a `reset`, and so is the first
 * one after that message settles durably — which lets this ignore any
 * non-`reset` delta for a message it holds no entry for. A fold that guessed
 * instead would invent a message out of a suffix, and the guess would outlive
 * the mistake that caused it.
 */

type TranscriptPart = UIMessage["parts"][number];

/** The parts a `part.append` can grow: both carry the provider's running text. */
type TextBearingPart = Extract<TranscriptPart, { type: "text" | "reasoning" }>;

export interface KeyedTranscriptPart {
  /**
   * The buffered part's provider id. Projection is 1:0..1 — one provider part
   * becomes one projected part or none — so a key needs no sub-index.
   */
  key: string;
  part: TranscriptPart;
}

export interface KeyedTranscriptMessage {
  id: string;
  role: UIMessage["role"];
  metadata?: unknown;
  parts: readonly KeyedTranscriptPart[];
}

export type TranscriptDelta =
  /** Baseline, and the escape hatch: whatever the emitter cannot express, it resets. */
  | { op: "reset"; message: KeyedTranscriptMessage }
  /**
   * `index` is the position in the **projected** keyed array after the op
   * applies — never a position in the provider's own part order.
   */
  | { op: "part.upsert"; key: string; index: number; part: TranscriptPart }
  | { op: "part.append"; key: string; text: string }
  | { op: "part.remove"; key: string }
  | { op: "metadata"; metadata: unknown }
  /** The provider deleted the message while it was still in flight. */
  | { op: "message.remove" };

/** One Session's in-flight messages, keyed by message id. */
export type TranscriptOverlay = ReadonlyMap<string, KeyedTranscriptMessage>;

/**
 * Folds one delta into an overlay, returning the next one.
 *
 * Total: every op has an answer for every state, and the answer for "no entry
 * yet" is always the overlay it was handed back unchanged.
 */
export function applyTranscriptDelta(
  overlay: TranscriptOverlay,
  messageId: string,
  delta: TranscriptDelta,
): TranscriptOverlay {
  if (delta.op === "reset") return withMessage(overlay, messageId, delta.message);
  const current = overlay.get(messageId);
  // The self-healing rule. A delta for a message with no entry lost its
  // baseline — to a subscriber that joined mid-message, to an evicted overlay,
  // or to an emitter that skipped its reset. Waiting costs the tail of one
  // message; guessing costs a message that never existed.
  if (!current) return overlay;
  switch (delta.op) {
    case "message.remove": {
      const next = new Map(overlay);
      next.delete(messageId);
      return next;
    }
    case "metadata":
      return withMessage(overlay, messageId, { ...current, metadata: delta.metadata });
    case "part.remove": {
      const parts = current.parts.filter((entry) => entry.key !== delta.key);
      if (parts.length === current.parts.length) return overlay;
      return withMessage(overlay, messageId, { ...current, parts });
    }
    case "part.append": {
      const index = current.parts.findIndex((entry) => entry.key === delta.key);
      if (index === -1) return overlay;
      const entry = current.parts[index];
      // A `part.append` naming a part that carries no text is a claim this fold
      // cannot honour — there is nothing to concatenate onto. The entry stays
      // exactly as it is and the emitter's next reset settles what it meant.
      if (!isTextBearing(entry.part)) return overlay;
      const parts = [...current.parts];
      parts[index] = {
        key: entry.key,
        part: { ...entry.part, text: `${entry.part.text}${delta.text}` },
      };
      return withMessage(overlay, messageId, { ...current, parts });
    }
    case "part.upsert": {
      // Remove-then-insert rather than replace-in-place: `index` describes where
      // the key ends up once the op has applied, which is the only position the
      // emitter can state without knowing what this fold currently holds.
      const parts = current.parts.filter((entry) => entry.key !== delta.key);
      parts.splice(Math.max(delta.index, 0), 0, { key: delta.key, part: delta.part });
      return withMessage(overlay, messageId, { ...current, parts });
    }
  }
}

/** The durable shape of a transient message: the same message without its keys. */
export function projectKeyedTranscriptMessage(message: KeyedTranscriptMessage): UIMessage {
  return {
    id: message.id,
    role: message.role,
    ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
    parts: message.parts.map((entry) => entry.part),
  };
}

function withMessage(
  overlay: TranscriptOverlay,
  messageId: string,
  message: KeyedTranscriptMessage,
): TranscriptOverlay {
  const next = new Map(overlay);
  next.set(messageId, message);
  return next;
}

function isTextBearing(part: TranscriptPart): part is TextBearingPart {
  return part.type === "text" || part.type === "reasoning";
}
