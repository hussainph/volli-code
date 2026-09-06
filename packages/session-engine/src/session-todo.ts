/**
 * "The list as it stands now", folded out of a Session's durable history (VC-6).
 *
 * Every version of the list is already kept: a finished `todo_write` call
 * becomes a durable transcript message like any other tool call, so history
 * holds the plan at every moment the Session had one. What history does NOT
 * hold is a pointer to the newest one, and that is the only thing anybody
 * actually wants to draw — the Activity Island's plan card and the ticket
 * comment a finished Session leaves behind both ask the same question.
 *
 * So this is a fold and not a store. There is no resident value to invalidate,
 * no write path to keep in step, and nothing to rebuild after a relaunch: the
 * transcript a Session replays on attach IS the input, so the answer after a
 * relaunch is the answer before it by construction. That is the cheapest
 * possible way to satisfy "survives a relaunch", and it is why no new durable
 * record was added for this.
 *
 * Latest wins, whole. A call replaces the list rather than amending it, so the
 * fold never merges two calls and there is no such thing as a partially
 * recovered plan.
 */

import { parseTodoList, readActivityDescriptor } from "@volli/shared";
import type {
  ListSessionEventsQuery,
  SessionEvent,
  SessionTodoList,
  TranscriptReference,
} from "@volli/shared";
import type { UIMessage } from "ai";

import type { SessionTranscriptArtifact } from "./transcript-artifacts";
import { transcriptReferenceFor } from "./transcript-tail";

/**
 * The newest todo list in these messages, or `null` if there is none.
 *
 * `null` and `[]` stay apart the whole way through: `null` is a Session that
 * has never written a list and therefore has no plan card and no ticket
 * comment, while `[]` is a Session that deliberately cleared one. Collapsing
 * them would revive a plan the model had just dropped.
 *
 * A FAILED call is skipped. It replaced nothing — the model's arguments were
 * recorded, but the tool never answered, so treating its input as the current
 * list would let a refused call overwrite a good plan.
 *
 * Reads the ACTIVITY DESCRIPTOR rather than the tool name, for the reason the
 * descriptor exists: `toolName` on the part is Volli's own envelope
 * (`volli.activity`) for every harness, and the harness-neutral fact — this
 * call was a plan — is the kind. A second harness spelling its todo tool
 * differently is then already handled.
 */
export function currentTodoList(messages: readonly UIMessage[]): SessionTodoList | null {
  let latest: SessionTodoList | null = null;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool") continue;
      if (part.state === "output-error") continue;
      if (readActivityDescriptor(part.toolMetadata)?.kind !== "plan") continue;
      const list = parseTodoList(part.input);
      if (list !== null) latest = list;
    }
  }
  return latest;
}

export interface SessionTodoPorts {
  listEvents: (query: ListSessionEventsQuery) => Promise<readonly SessionEvent[]>;
  /**
   * Reads one durable transcript artifact. Absent means this composition holds
   * no artifact store, and the answer is `null` — never an empty list, which
   * would claim the Session cleared a plan it may still be holding.
   */
  readArtifact?: (reference: TranscriptReference) => Promise<SessionTranscriptArtifact>;
}

/**
 * The Session's current todo list, read from the ledger rather than a runtime.
 *
 * For the caller that has a Session id and no transcript in hand — the desktop
 * main process, answering `session done` for a Session whose window may never
 * have been open. The renderer folds {@link currentTodoList} over the messages
 * it already holds instead; this is the same fold with a read in front of it.
 *
 * Walks history backwards and stops at the first list it finds, because latest
 * wins and the newest call is usually the last thing that happened. A Session
 * that never wrote one still costs a full walk, which is the honest price of
 * being sure there is nothing to say.
 *
 * An unreadable artifact is skipped rather than fatal. This runs on the way out
 * of a Session, beside a signal that has already been durably recorded, and a
 * broken blob store is not a reason to fail a verb that already succeeded.
 */
export async function readSessionTodoList(
  ports: SessionTodoPorts,
  input: { sessionId: string },
): Promise<SessionTodoList | null> {
  const readArtifact = ports.readArtifact;
  if (readArtifact === undefined) return null;
  const events = await ports.listEvents({ sessionId: input.sessionId });
  const references: TranscriptReference[] = [];
  for (const event of events) {
    const reference = transcriptReferenceFor(event);
    if (reference !== null) references.push(reference);
  }
  for (const reference of references.toReversed()) {
    let message: UIMessage;
    try {
      message = (await readArtifact(reference)).message;
    } catch {
      continue;
    }
    const list = currentTodoList([message]);
    if (list !== null) return list;
  }
  return null;
}
