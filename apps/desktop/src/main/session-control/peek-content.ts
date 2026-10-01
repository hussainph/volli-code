/**
 * What a peek card is allowed to show, folded once per glance (VC-30).
 *
 * ── WHY THIS IS A PULL AND NOT A SUBSCRIPTION ─────────────────────────────
 * A peek is a READ. Hovering a row must not adopt the Session, must not open a
 * stream, or start background summary work —
 * somebody sweeping the pointer down a sidebar would otherwise attach and
 * detach a dozen executors. So the card asks for one fold and draws it, and
 * only an explicit intent (pinning it to answer a question) adopts the Session
 * through the door that already exists. The hover read may ask the process-wide
 * utility summarizer for one budgeted refinement; no agent-loop event does.
 *
 * ── WHY IT IS THE CLI's FOLD ──────────────────────────────────────────────
 * `readSessionTranscriptTail` is the same read `volli session peek` has shipped
 * since VC-79: the last few messages, whitespace-collapsed and cut, with the
 * counts a caller needs to tell a loop from a hang. Re-implementing a tail fold
 * here would be a second opinion about the same transcript, and the first time
 * the two disagreed the card would be quietly wrong about what an agent said.
 * This module is the JOIN, not a fold: the engine's tail plus the projection's
 * open question, shaped for the renderer.
 *
 * ── WHAT THE RENDERER MAY SEE ─────────────────────────────────────────────
 * The question crosses as a {@link RendererSessionInteraction} through
 * `scrubSessionInteraction`, which blanks the runtime's `native` correlation —
 * the renderer answers by `SessionInteraction.id` and cannot see or forge the
 * harness's own handle. Nothing else about the attachment crosses.
 *
 * Unreadable tail messages are COUNTED rather than faked, all the way through:
 * a missing artifact is a broken store, and a card that drew a blank line for
 * it would report silence where there were words.
 */
import { readSessionTranscriptTail } from "@volli/session-engine";
import type { SessionTranscriptArtifact } from "@volli/session-engine";
import { scrubSessionInteraction, SESSION_PEEK_ENTRIES } from "@volli/shared";
import type {
  ListSessionEventsQuery,
  SessionEvent,
  SessionPeekContent,
  SessionPeekEntry,
  SessionProjection,
  TranscriptReference,
} from "@volli/shared";

export interface SessionPeekContentPorts {
  listEvents: (query: ListSessionEventsQuery) => Promise<readonly SessionEvent[]>;
  /**
   * Reads one durable transcript artifact. Absent means this composition holds
   * no artifact store, and the peek answers with its counts and no entries —
   * never with `unreadable`, which claims a store looked and failed. The tail
   * fold owns that distinction; this only passes the port through.
   */
  readArtifact?: (reference: TranscriptReference) => Promise<SessionTranscriptArtifact>;
  getSession: (input: { sessionId: string }) => Promise<SessionProjection | null>;
  /** Called only by the renderer's actual hover read, never the CLI or agent loop. */
  summarize?: (sessionId: string, entries: readonly SessionPeekEntry[]) => Promise<string | null>;
}

/** Enough prose to summarize meaningfully; the CLI keeps its own 120-character default. */
export const PEEK_EXCERPT_CHARS = 2_000;
/** Local reads only: tools must not immediately evict the prose a summary needs. */
export const PEEK_SUMMARY_WINDOW_ENTRIES = 32;

/**
 * One fold of a Session for one peek: its tail, its open question, and the
 * counts beside them. `null` means no such Session — a row the listing still
 * holds for a Session the ledger no longer has.
 *
 * The card holds {@link SESSION_PEEK_ENTRIES}. When refining, a separately
 * bounded local window looks further back for prose through tool-only messages.
 * The summarizer still sends only a few spoken excerpts, never tool payloads.
 * Both depths are the app's, not the caller's.
 */
export async function readSessionPeekContent(
  ports: SessionPeekContentPorts,
  input: { sessionId: string },
): Promise<SessionPeekContent | null> {
  const projection = await ports.getSession({ sessionId: input.sessionId });
  if (projection === null) return null;
  const tail = await readSessionTranscriptTail(
    {
      listEvents: ports.listEvents,
      ...(ports.readArtifact === undefined ? {} : { readArtifact: ports.readArtifact }),
    },
    {
      sessionId: input.sessionId,
      limit: ports.summarize === undefined ? SESSION_PEEK_ENTRIES : PEEK_SUMMARY_WINDOW_ENTRIES,
      textLimit: PEEK_EXCERPT_CHARS,
    },
  );
  // `interactions.active[0]` is the app's one answer to "which question is this
  // Session asking" — `sessionNotificationItem` picks the same one, so the card
  // and the alert that sent somebody to it are talking about the same question.
  const question = projection.interactions.active[0];
  const summary = await ports.summarize?.(input.sessionId, tail.entries);
  return {
    sessionId: input.sessionId,
    ...(summary === undefined ? {} : { summary }),
    entries: tail.entries.slice(-SESSION_PEEK_ENTRIES).map((entry): SessionPeekEntry => ({
      at: entry.at,
      role: entry.role,
      text: entry.text,
      tools: entry.tools,
    })),
    question: question === undefined ? null : scrubSessionInteraction(question),
    turns: tail.turns,
    turnDepth: tail.turnDepth,
    unreadable: tail.unreadable,
    lastActivityAt: projection.lastActivityAt,
  };
}
