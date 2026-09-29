/**
 * VC-30 — whether a Session has unread work, and the one edge that creates it.
 *
 * UNREAD IS ITS OWN AXIS, not another activity state. A Session becomes unread
 * when a turn ends while it is not in front of the person, or when they say so;
 * it becomes read when it is opened, replied to, viewed, or said so. Nothing
 * about reading touches a Session's activity or its recency — a read receipt is
 * not work — which is why this state lives beside a listing row rather than
 * inside the ledger it would otherwise churn.
 *
 * Only main can decide the edge: it is the only process that sees every turn
 * boundary and the only one that honestly knows which window is focused and
 * what it is showing. What lives here is the vocabulary both processes read and
 * the two pure rules that decision is made from, so the renderer projects a
 * stamp instead of deciding anything about focus.
 */
import type { SessionProjection, SessionTurnOutcome } from "./session-ledger";

/** Whether a Session has unread work, and since when. Durable; see session_read_receipts. */
export interface SessionReadState {
  /** Epoch ms the Session became unread, or `null` when it is read. */
  readonly unreadSince: number | null;
}

/**
 * The resting answer: read. It draws nothing, which is what a row with no
 * receipt must render — an absent receipt is "nobody has left work here",
 * never "unknown, so mark it".
 */
export const SESSION_READ: SessionReadState = { unreadSince: null };

/**
 * A sparse/absent answer is the resting one — the `sessionProvenanceOf` idiom.
 * Every builder that holds no receipt reader keeps compiling and marks nothing.
 */
export function sessionReadStateOf(read: SessionReadState | undefined): SessionReadState {
  return read ?? SESSION_READ;
}

export function isSessionUnread(read: SessionReadState | undefined): boolean {
  return sessionReadStateOf(read).unreadSince !== null;
}

/** The two facts the unread edge is decided from. */
export interface SessionTurnPhase {
  readonly turnActive: boolean;
  readonly lastTurnOutcome: SessionTurnOutcome | null;
}

/**
 * Whether a turn ENDED between these two sightings. `previous === null` is a
 * first sighting and never an edge (the `run-attention.ts` discipline: a
 * process that just started must not mark yesterday's finished turns unread).
 *
 * The falling edge of `turnActive` is the ordinary answer, and it does not care
 * how the turn ended: completed, interrupted and failed are all a turn that is
 * over and a result nobody has read. A second, quieter case exists because
 * sightings are folded on a trailing timer rather than per event — a turn that
 * started AND ended between two of them leaves `turnActive` false on both
 * sides, and only the outcome moved. A new outcome with no live turn is that
 * turn's end. Two identical outcomes in a row are indistinguishable from one,
 * and this deliberately reports the one it can see rather than guessing.
 */
export function turnJustEnded(
  previous: SessionTurnPhase | null,
  current: SessionTurnPhase,
): boolean {
  if (previous === null) return false;
  if (current.turnActive) return false;
  if (previous.turnActive) return true;
  return current.lastTurnOutcome !== null && current.lastTurnOutcome !== previous.lastTurnOutcome;
}

export function sessionTurnPhaseOf(
  projection: Pick<SessionProjection, "turnActive" | "lastTurnOutcome">,
): SessionTurnPhase {
  return { turnActive: projection.turnActive, lastTurnOutcome: projection.lastTurnOutcome };
}
