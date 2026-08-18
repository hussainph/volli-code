import { projectKeyedTranscriptMessage, type TranscriptOverlay } from "@volli/session-engine";
import type { UIMessage } from "ai";

export interface TranscriptMessageFrame {
  transcript: { message: UIMessage } | null;
}

/**
 * Transcript events are immutable snapshots. A native adapter may therefore
 * commit several snapshots for one provider message while it streams; the chat
 * keeps the original conversation position and paints only its latest shape.
 */
export function projectTranscriptMessages(
  frames: readonly TranscriptMessageFrame[],
): readonly UIMessage[] {
  const latestByMessageId = new Map<string, UIMessage>();
  for (const frame of frames) {
    if (frame.transcript && speaks(frame.transcript.message))
      latestByMessageId.set(frame.transcript.message.id, frame.transcript.message);
  }
  return [...latestByMessageId.values()];
}

/**
 * The durable transcript with every in-flight message laid over it.
 *
 * A settled message is a fact and holds a position; a message mid-word is view
 * state and holds none, so the two live in different places and meet here. The
 * durable list owns order — a message that has settled once keeps the position
 * it first spoke at even while a later overlay entry rewrites its contents —
 * and a message that exists *only* in the overlay has no position to keep yet,
 * so it renders after everything durable, in the order the overlay first heard
 * of it, and takes its real place the moment its settle frame lands.
 *
 * `speaks` gates the overlay projection for the same reason it gates the
 * durable one, and the fallback is what makes it one rule rather than two: an
 * emitter leads a message with a baseline `reset` that can carry nothing
 * drawable yet, and rendering that would open an empty bubble in front of the
 * first word. So the rendered message is the overlay while the overlay has
 * something to draw, else the durable latest, else no row at all.
 */
export function layerTranscriptOverlay(
  durable: readonly UIMessage[],
  overlay: TranscriptOverlay,
): readonly UIMessage[] {
  if (overlay.size === 0) return durable;
  // Consumed as it is laid down, so what remains is exactly the set with no
  // durable position — still in the overlay's own insertion order.
  const pending = new Map(overlay);
  const layered = durable.map((message) => {
    const entry = pending.get(message.id);
    if (!entry) return message;
    pending.delete(message.id);
    const projected = projectKeyedTranscriptMessage(entry);
    return speaks(projected) ? projected : message;
  });
  for (const entry of pending.values()) {
    const projected = projectKeyedTranscriptMessage(entry);
    if (speaks(projected)) layered.push(projected);
  }
  return layered;
}

/**
 * Whether a durable message has anything the transcript can draw.
 *
 * Not everything a Session commits to its history is a line of conversation.
 * Answering an interaction writes one — a `user` message whose only part is the
 * resolution data — and the chat drew each of those as an ordinary user turn,
 * so approving three tool calls left three empty bubbles standing where the
 * approvals happened. A message with nothing to render is not a turn.
 *
 * It is not nothing, though: it is durable, it carries what was chosen, and it
 * already sits at the point in the conversation where the decision was taken.
 * So it passes here and the transcript draws it as the one-line receipt it is,
 * rather than as prose it does not have.
 *
 * Asked per role because the two are rendered by different code: a user
 * message is prose and attachment thumbs, and the assistant path owns every
 * other shape. `file` counts as drawable (VC-50): a message that is nothing
 * but a dropped screenshot is a real turn, and the transcript draws its thumb
 * where prose would have been.
 */
function speaks(message: UIMessage): boolean {
  if (message.role === "user") {
    return message.parts.some(
      (part) =>
        part.type === "text" || part.type === "file" || part.type === "data-interaction-resolution",
    );
  }
  return message.parts.some(
    (part) => part.type === "text" || part.type === "reasoning" || part.type === "dynamic-tool",
  );
}
