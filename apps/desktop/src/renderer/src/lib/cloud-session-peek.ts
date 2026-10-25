/** A hover peek reads the same bounded cloud history as a chat, without adopting or watching it. */
import { chatSessionFrame } from "@volli/session-presentation";
import { transcriptTailEntry } from "@volli/session-engine";
import { SESSION_PEEK_ENTRIES, type SessionPeekContent } from "@volli/shared";
import type { ChatSessionRpc } from "@volli/session-presentation";
import { transcriptReferenceOf } from "./cloud-session-view";

export async function readCloudSessionPeek(
  sessionId: string,
  snapshot: ChatSessionRpc["session"]["snapshot"]["query"],
): Promise<SessionPeekContent> {
  const answer = await snapshot({ sessionId });
  const frames = answer.frames.flatMap((value) => {
    const frame = chatSessionFrame(value);
    return frame === null ? [] : [frame];
  });
  const entries = frames
    .flatMap((frame) =>
      frame.transcript === null
        ? []
        : [
            transcriptTailEntry(
              frame.event?.occurredAt ?? answer.projection.lastActivityAt,
              frame.transcript.message,
              2_000,
            ),
          ],
    )
    .slice(-SESSION_PEEK_ENTRIES);
  return {
    sessionId,
    entries,
    question: answer.projection.interactions.active[0] ?? null,
    // A bounded read must not present the tail's counts as lifelong totals.
    turns: null,
    turnDepth: null,
    unreadable: frames.filter(
      (frame) =>
        frame.event !== null &&
        transcriptReferenceOf(frame.event) !== null &&
        frame.transcript === null,
    ).length,
    lastActivityAt: answer.projection.lastActivityAt,
  };
}
