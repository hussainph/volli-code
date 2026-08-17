import { readActivityDescriptor } from "@volli/shared";
import type { ListSessionEventsQuery, SessionEvent, TranscriptReference } from "@volli/shared";
import type { UIMessage } from "ai";

import type { SessionTranscriptArtifact } from "./transcript-artifacts";

/**
 * The last few things that happened in a Session, small enough to read.
 *
 * A transcript is the whole point of a structured Session and the wrong thing
 * to hand a caller in full: an orchestrator peeking at a long-running chat is
 * spending its OWN context to ask "is this alive, and what is it doing", and a
 * replay of every message answers that question by burying it. So this fold
 * keeps one line per message — role, the tool names it called, its words
 * truncated — and only for the tail the caller asked for.
 *
 * It reads the ledger, not the live runtime. Liveness here is a fact the
 * Session recorded, so a peek answers the same way for a Session whose executor
 * died mid-turn as for one nobody has attached to since a relaunch: history is
 * canonical, and a hung agent is exactly the case this exists to make visible.
 */
export interface SessionTranscriptTailEntry {
  /** When the message was recorded, in epoch milliseconds. */
  at: number;
  role: UIMessage["role"];
  /**
   * The message's own words: whitespace collapsed to single spaces and cut at
   * {@link TRANSCRIPT_TAIL_TEXT_LIMIT} with a trailing ellipsis. Empty when the
   * message was nothing but tool calls.
   *
   * Reasoning is deliberately left out. It is the longest part of a message and
   * the least useful for "what is it doing right now" — the words it said and
   * the tools it called answer that, and a peek that quoted reasoning would
   * cost the caller more context than the transcript it summarizes.
   */
  text: string;
  /** The harness's own names for the tool calls in this message, in order. */
  tools: readonly string[];
}

export interface SessionTranscriptTail {
  /** The last N messages, oldest first. */
  entries: readonly SessionTranscriptTailEntry[];
  /** How many transcript messages the Session has recorded over its whole life. */
  messages: number;
  /**
   * Tail messages whose artifact could not be read, counted rather than faked.
   * A missing artifact is a broken store, not an empty message, and inventing a
   * blank line for it would report silence where there were words.
   */
  unreadable: number;
  /** Turns started over the Session's whole life — which turn it is on now. */
  turns: number;
  /**
   * Messages recorded since the newest turn started: how deep into this turn
   * the agent is. A turn twenty messages deep and still going is the shape of
   * a loop; a turn one message deep that has not moved in an hour is a hang.
   */
  turnDepth: number;
}

export interface SessionTranscriptTailPorts {
  listEvents: (query: ListSessionEventsQuery) => Promise<readonly SessionEvent[]>;
  /**
   * Reads one durable transcript artifact. Absent means this composition holds
   * no artifact store, and the tail answers with its counts and no entries —
   * never with `unreadable`, which claims a store looked and failed.
   */
  readArtifact?: (reference: TranscriptReference) => Promise<SessionTranscriptArtifact>;
}

/** Where a message's words are cut. Long enough to be a sentence, short enough to be a line. */
export const TRANSCRIPT_TAIL_TEXT_LIMIT = 120;

/**
 * Folds a Session's durable history into {@link SessionTranscriptTail}.
 *
 * One unbounded event read, then at most `limit` artifact reads — the whole
 * history is walked (the counts are life-long facts) but only the tail costs a
 * file. That is the same shape as every other read of a Session here: folding
 * its events is what a projection already does.
 */
export async function readSessionTranscriptTail(
  ports: SessionTranscriptTailPorts,
  input: { sessionId: string; limit: number },
): Promise<SessionTranscriptTail> {
  const limit = Math.max(0, Math.trunc(input.limit));
  const events = await ports.listEvents({ sessionId: input.sessionId });
  const tail: { at: number; reference: TranscriptReference }[] = [];
  let messages = 0;
  let turns = 0;
  let turnDepth = 0;
  for (const event of events) {
    if (event.payload.kind === "turn.started") {
      turns += 1;
      turnDepth = 0;
    }
    const reference = transcriptReferenceFor(event);
    if (reference === null) continue;
    messages += 1;
    turnDepth += 1;
    tail.push({ at: event.occurredAt, reference });
    if (tail.length > limit) tail.shift();
  }
  const readArtifact = ports.readArtifact;
  if (readArtifact === undefined) return { entries: [], messages, unreadable: 0, turns, turnDepth };
  const entries: SessionTranscriptTailEntry[] = [];
  let unreadable = 0;
  for (const { at, reference } of tail) {
    // A store that cannot answer for one artifact must not cost the caller the
    // whole peek: the reason to run this command at all is that something is
    // wrong, and the activity counts beside it are still true.
    try {
      entries.push(tailEntry(at, (await readArtifact(reference)).message));
    } catch {
      unreadable += 1;
    }
  }
  return { entries, messages, unreadable, turns, turnDepth };
}

/**
 * The events that carry a transcript message: an observed one the adapter
 * referenced, and the two commands that record what a person said — a submitted
 * message and a resolved interaction both ARE transcript, and a tail that
 * skipped them would show an agent answering questions nobody asked.
 */
export function transcriptReferenceFor(event: SessionEvent): TranscriptReference | null {
  if (event.payload.kind === "transcript.referenced") return event.payload.reference;
  if (
    event.payload.kind === "command.recorded" &&
    (event.payload.command.intent.kind === "message.submit" ||
      event.payload.command.intent.kind === "interaction.resolve")
  ) {
    return event.payload.command.intent.reference;
  }
  return null;
}

function tailEntry(at: number, message: UIMessage): SessionTranscriptTailEntry {
  const words: string[] = [];
  const tools: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") words.push(part.text);
    // `dynamic-tool` is the shape every Volli adapter emits (the transcript's
    // own vocabulary), so it is the shape read here — matching the app's chat
    // surface, which recognizes exactly these parts too.
    if (part.type === "dynamic-tool") {
      tools.push(readActivityDescriptor(part.toolMetadata)?.nativeToolName ?? part.toolName);
    }
  }
  return { at, role: message.role, text: compactText(words.join(" ")), tools };
}

function compactText(text: string): string {
  const collapsed = text.replaceAll(/\s+/gu, " ").trim();
  return collapsed.length > TRANSCRIPT_TAIL_TEXT_LIMIT
    ? `${collapsed.slice(0, TRANSCRIPT_TAIL_TEXT_LIMIT)}…`
    : collapsed;
}
