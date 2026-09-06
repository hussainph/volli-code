import type { ListSessionEventsQuery, SessionEvent, TranscriptReference } from "@volli/shared";

import type { SessionTranscriptArtifact } from "./transcript-artifacts";

/**
 * A Session's answer: how its latest turn ended, and the last thing it said.
 *
 * The one read behind two doors (VC-9). A Subagent Session's whole contract is
 * "your last message is your answer", and both the parent that delegated to it
 * and the `volli session answer` verb ask the same two questions of its
 * ledger — did the turn finish, and what did it say last. Folded from durable
 * history rather than asked of a live runtime, so a child that finished before
 * a relaunch answers exactly as one still attached does.
 *
 * Unlike the transcript tail, the message is returned IN FULL: the tail is a
 * glance ("is it alive, what is it doing"), and this is the deliverable.
 */
export type SessionAnswerState =
  /** No turn has started; nothing was asked of it yet. */
  | "not-started"
  /** A turn is open — the answer, if any, is not final. */
  | "running"
  | "completed"
  | "interrupted"
  | "stopped"
  | "failed";

export interface SessionAnswer {
  state: SessionAnswerState;
  /**
   * The last assistant message's text, in full — or null when there is none,
   * or when the store could not read it (`unreadable` says which).
   */
  text: string | null;
  /** True when the last assistant artifact exists but could not be read. */
  unreadable: boolean;
  /** Turns started over the Session's whole life. */
  turns: number;
}

export interface SessionAnswerPorts {
  listEvents: (query: ListSessionEventsQuery) => Promise<readonly SessionEvent[]>;
  /** Absent means no artifact store in this composition: the state is still answered. */
  readArtifact?: (reference: TranscriptReference) => Promise<SessionTranscriptArtifact>;
}

/** The fold alone, for a caller that already holds the events. */
export function foldSessionAnswerState(events: readonly SessionEvent[]): {
  state: SessionAnswerState;
  turns: number;
} {
  let state: SessionAnswerState = "not-started";
  let turns = 0;
  for (const event of events) {
    switch (event.payload.kind) {
      case "turn.started":
        turns += 1;
        state = "running";
        break;
      case "turn.completed":
        state = "completed";
        break;
      case "turn.interrupted":
        state = "interrupted";
        break;
      case "session.stopped":
        state = "stopped";
        break;
      case "attachment.failed":
        if (state === "running") state = "failed";
        break;
      case "attachment.closed":
        // A turn still open when its attachment closed never completes: the
        // relaunch (or crash) that closed it is what ended the turn. A close
        // that calls itself `completed` mid-turn still ended a turn that had
        // not — the turn is what this reads, not the attachment.
        if (state === "running") {
          state = event.payload.outcome === "failed" ? "failed" : "interrupted";
        }
        break;
      default:
        break;
    }
  }
  return { state, turns };
}

export async function readSessionAnswer(
  ports: SessionAnswerPorts,
  input: { sessionId: string },
): Promise<SessionAnswer> {
  const events = await ports.listEvents({ sessionId: input.sessionId });
  const { state, turns } = foldSessionAnswerState(events);
  const readArtifact = ports.readArtifact;
  if (readArtifact === undefined) return { state, text: null, unreadable: false, turns };
  // Newest first: the last assistant message is the answer, and a user message
  // recorded after it (a steer, a follow-up) does not replace it.
  for (const event of events.toReversed()) {
    if (event.payload.kind !== "transcript.referenced") continue;
    let artifact: SessionTranscriptArtifact;
    try {
      artifact = await readArtifact(event.payload.reference);
    } catch {
      // An older message is a worse answer than none: say this one is
      // unreadable rather than hand back the message before it.
      return { state, text: null, unreadable: true, turns };
    }
    if (artifact.message.role !== "assistant") continue;
    const text = artifact.message.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim();
    return { state, text: text.length > 0 ? text : null, unreadable: false, turns };
  }
  return { state, text: null, unreadable: false, turns };
}
