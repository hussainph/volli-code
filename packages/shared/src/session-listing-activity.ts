/**
 * What a Session's listing row says it is doing (`activity`) and, when it is
 * waiting, on what (`waitingOn`): the one rule every listing reads, written
 * once so the local chat row (`chatSessionRecord` in host-core) and the cloud
 * listing row (`convex/` `syncListing`) cannot drift apart.
 *
 * Both are read from the durable fold's facts plus one process fact the fold
 * cannot hold: whether an executor is bound to the Session right now. Locally
 * that is this process's binding; on the cloud ledger it is the fold's open
 * attachment. Composes {@link sessionAwaitsUser} and
 * {@link sessionEndedInterrupted} rather than restating either.
 */

import type { ChatSessionRecord, ChatWaitingReason } from "./session";
import {
  sessionAwaitsUser,
  sessionEndedInterrupted,
  type SESSION_USER_BLOCKING_ATTENTION_KINDS,
  type SessionAttentionKind,
  type SessionAttentionProjection,
  type SessionInteractionProjection,
  type SessionProjection,
} from "./session-ledger";

/**
 * The fold facts the rule reads. A {@link SessionProjection} is one; so is the
 * cloud fold's view, whose interactions carry only the active ones.
 */
export interface SessionListingActivityFacts {
  readonly stopped: SessionProjection["stopped"];
  readonly turnActive: boolean;
  readonly lastTurnOutcome: SessionProjection["lastTurnOutcome"];
  readonly lastTurnStopDetail?: SessionProjection["lastTurnStopDetail"];
  readonly attention: SessionAttentionProjection;
  readonly interactions: Pick<SessionInteractionProjection, "active">;
}

/**
 * Stopped outranks everything (VC-86): a Session whose work was deliberately
 * ended cannot be helped by answering its stale question and is not "working"
 * however the turn flag was left — the stop fact is the newer truth, and a
 * fresh attachment explicitly clears it when work genuinely resumes.
 *
 * Waiting outranks working, because an agent that has asked a question is still
 * inside an open turn: a row that said "working" there would hide the one thing
 * the user could actually do about it.
 *
 * Working then needs an executor binding as well as the turn, so a durable
 * turn and open attachment that survived relaunch read as what they are —
 * nothing running — instead of a Session that spins forever.
 *
 * Interrupted (VC-324) is asked LAST of the four, and only of a Session that
 * is none of them: `stopped` > `waiting` > `working` > `interrupted` > `idle`.
 *  - A stopped Session stays `stopped` even though its turn was interrupted on
 *    the way down — the stop is the newer truth AND names who did it, which is
 *    strictly more than the interruption says.
 *  - A Session that resumed and is working says `working`; the predicate agrees
 *    on its own, because a fresh `turn.started` resets the outcome it reads.
 *  - Everything left is a Session that is quiet — and `interrupted` is the half
 *    of that quiet whose turn DIED, which is exactly what `idle` used to hide.
 *
 * Transport Attentions still fold into `idle` for a person's row (see
 * `WAITING_ON_BY_ATTENTION`): nobody is being asked to do anything. What
 * changed is that the row no longer calls a dead turn quiet.
 */
export function sessionListingActivity(
  facts: SessionListingActivityFacts,
  executorBound: boolean,
): ChatSessionRecord["activity"] {
  if (facts.stopped !== null) return "stopped";
  // The predicate reads only the active interactions.
  if (
    sessionAwaitsUser({
      attention: facts.attention,
      interactions: { active: facts.interactions.active, resolved: [] },
    })
  ) {
    return "waiting";
  }
  if (facts.turnActive && executorBound) return "working";
  if (sessionEndedInterrupted(facts)) return "interrupted";
  return "idle";
}

/**
 * The user-blocking Attention kinds, in the coarser vocabulary a row can say.
 * Only the three `SESSION_USER_BLOCKING_ATTENTION_KINDS` appear: the rest of
 * the Attention vocabulary is the world blocking the agent, which no row
 * should ask a person to go fix.
 */
const WAITING_ON_BY_ATTENTION: Readonly<Partial<Record<SessionAttentionKind, ChatWaitingReason>>> =
  {
    input_required: "question",
    permission_required: "permission",
    auth_required: "auth",
    // `satisfies` against the shared list is the completeness pin: a fourth
    // user-blocking kind added there fails to compile here until it is given a
    // word, rather than silently reading as "not waiting".
  } satisfies Record<(typeof SESSION_USER_BLOCKING_ATTENTION_KINDS)[number], ChatWaitingReason>;

/**
 * What the Session is waiting on, in the same order {@link sessionAwaitsUser}
 * decides THAT it is waiting: an open Interaction is a question already asked
 * and outranks any Attention, then the first user-blocking Attention speaks.
 *
 * Reads the same two fold fields as `sessionAwaitsUser` in the same
 * precedence, so `activity === "waiting"` and `waitingOn !== null` cannot come
 * apart — one saying a human is needed while the other has nothing to tell them
 * to do is exactly the drift the shared predicate exists to prevent.
 */
export function sessionListingWaitingOn(
  facts: Pick<SessionListingActivityFacts, "stopped" | "attention" | "interactions">,
): ChatWaitingReason | null {
  // A stopped Session is not waiting on anyone — the reason must go with the
  // state, or a row would say "Stopped" while handing the reader an errand.
  if (facts.stopped !== null) return null;
  if (facts.interactions.active.length > 0) return "question";
  for (const attention of facts.attention.active) {
    const reason = WAITING_ON_BY_ATTENTION[attention.kind];
    if (reason !== undefined) return reason;
  }
  return null;
}
