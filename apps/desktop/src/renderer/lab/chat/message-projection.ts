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
 * Asked per role because the two are rendered by different code: a user message
 * is prose only, and the assistant path owns every other shape. This is the
 * seam an attachment part would be added at, on the day one can be sent.
 */
function speaks(message: UIMessage): boolean {
  if (message.role === "user") {
    return message.parts.some(
      (part) => part.type === "text" || part.type === "data-interaction-resolution",
    );
  }
  return message.parts.some(
    (part) => part.type === "text" || part.type === "reasoning" || part.type === "dynamic-tool",
  );
}
