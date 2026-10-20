/**
 * What one settled transcript message means for the Session's current state
 * (VC-315).
 *
 * A Client opens a Session with the projection and the newest window of its
 * transcript, never the whole log. Two things it draws used to be folds over
 * every message it held — the plan card ("the list as it stands now") and
 * `/copy`'s "the current turn's last reply" — and a window cannot answer
 * either when the answer sits above it. So the runtime reads those facts off
 * each message as it records it, writes them beside the reference
 * ({@link SessionTranscriptDigest}), and the projection folds them. The rules
 * stay the ones the Client used: {@link currentTodoList} for the plan,
 * {@link replyText} for the reply.
 */
import type { SessionTranscriptDigest } from "@volli/shared";
import type { UIMessage } from "ai";

import { currentTodoList } from "./session-todo";

/**
 * A message's prose as a reader would copy it, or `null` when it said nothing.
 *
 * Text parts only, joined by a blank line and trimmed: reasoning and tool
 * parts are not prose. A message whose text is all whitespace has not said
 * anything, the rule the transcript's own prose rendering follows.
 */
export function replyText(message: Pick<UIMessage, "parts">): string | null {
  const text = message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n")
    .trim();
  return text.length > 0 ? text : null;
}

/** The digest recorded beside one settled message's transcript reference. */
export function transcriptDigest(message: UIMessage): SessionTranscriptDigest {
  const todoList = currentTodoList([message]);
  return {
    role: message.role,
    ...(message.role === "assistant" && replyText(message) !== null
      ? { reply: true as const }
      : {}),
    ...(todoList === null ? {} : { todoList }),
  };
}
