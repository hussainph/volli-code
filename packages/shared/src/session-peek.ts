/**
 * VC-30 — what a peek card is allowed to show, and the one line it leads with.
 *
 * A peek is a READ: one fold of a Session's durable tail, pulled on demand, with
 * no subscription and no adoption. What it shows is exactly what the Session
 * recorded — the last few messages, the tool names in them, and the question it
 * is asking if it is asking one. Nothing here summarises with prose it invented:
 * a card that paraphrased an agent would be a second, quieter transcript nobody
 * could check.
 *
 * The entry shape is the engine's transcript tail (`readSessionTranscriptTail`)
 * as it crosses to the renderer, declared here rather than imported because
 * `@volli/shared` sits UNDER `@volli/session-engine` in the dependency graph —
 * the engine reads this package, never the reverse. Keep the two aligned by
 * shape: `at`, `role`, whitespace-collapsed `text` cut at the engine's
 * `TRANSCRIPT_TAIL_TEXT_LIMIT`, and the harness's own tool names.
 */
import type { RendererSessionInteraction } from "./session-event-codec";

/**
 * How many tail messages one peek asks for. Small on purpose: the card is a
 * glance at what a Session is doing, and the conversation is one press away.
 */
export const SESSION_PEEK_ENTRIES = 6;

export interface SessionPeekEntry {
  /** When the message was recorded, in epoch milliseconds. */
  readonly at: number;
  readonly role: "user" | "assistant" | "system";
  /** Whitespace-collapsed, cut at TRANSCRIPT_TAIL_TEXT_LIMIT. Empty for a tools-only message. */
  readonly text: string;
  readonly tools: readonly string[];
}

export interface SessionPeekContent {
  readonly sessionId: string;
  /** Oldest first. */
  readonly entries: readonly SessionPeekEntry[];
  /** The open question, scrubbed; `null` when nothing is being asked. */
  readonly question: RendererSessionInteraction | null;
  readonly turns: number;
  readonly turnDepth: number;
  /** Tail messages whose artifact could not be read — counted, never faked. */
  readonly unreadable: number;
  readonly lastActivityAt: number;
}

/**
 * The card's summary line: the newest assistant text in the tail, else the
 * newest tool names as "Ran read_file, edit_file", else null. Never invents
 * prose.
 *
 * Assistant words come first because they are the Session's own answer to "what
 * is going on"; a tools-only tail (an agent mid-search, which is most of a live
 * turn) gets the names it called, which say the same thing in the vocabulary
 * that is actually on record. A tail with neither — an empty Session, or one
 * whose artifacts could not be read — gets nothing, and the card says so with
 * the counts beside it rather than with a sentence.
 */
export function peekSummaryOf(entries: readonly SessionPeekEntry[]): string | null {
  const spoken = entries.findLast((entry) => entry.role === "assistant" && entry.text !== "");
  if (spoken !== undefined) return spoken.text;
  const ran = entries.findLast((entry) => entry.tools.length > 0);
  return ran === undefined ? null : `Ran ${ran.tools.join(", ")}`;
}
