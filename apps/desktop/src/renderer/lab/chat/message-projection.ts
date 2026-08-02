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
    if (frame.transcript)
      latestByMessageId.set(frame.transcript.message.id, frame.transcript.message);
  }
  return [...latestByMessageId.values()];
}
