/**
 * The one place a `SessionActivityState` becomes a status dot's state, and the
 * words that state is said in.
 *
 * It exists because the mapping lived wherever a row did. The sidebar's Active
 * band wrote its own inline ternary, Home's rail had a private `chatState`,
 * and each was one review away from disagreeing with the other about the same
 * Session — the shotgun-surgery shape: adding a state meant finding every
 * switch by hand and hoping the search caught them all. `ui/status-dot.tsx`
 * already owns what a state LOOKS like; this owns what a Session's activity
 * IS as a dot state, so a surface states the activity and decides nothing.
 */

import type { SessionActivityState } from "@volli/shared";

import type { StatusDotState } from "./status-dot";

/**
 * Activity → dot state, for every surface that draws a Session row from its
 * activity (the sidebar's bands, Home's rail).
 *
 * Three decisions, made once:
 *
 *  - **Attention outranks everything.** A Session with an unresolved prompt is
 *    `waiting` however else its plumbing is doing — the amber dot is the one
 *    mark that asks for a person, and no quieter state gets to bury it.
 *  - **`interrupted` survives.** It is the one activity that says the last
 *    turn DIED rather than ended, it is durable — it reads the same after a
 *    relaunch as before one (VC-324) — and collapsing it into a resting idle
 *    is exactly the confusion this module exists to make impossible.
 *  - **Everything else rests at `idle`.** The dot's job in a resting row is to
 *    not compete; the finer resting words (`parked`, `stopped`, `exited`) are
 *    the ticket rail's column to name, where the label rides the dot.
 *
 * Not an identity map on purpose: `SessionActivityState` and
 * `StatusDotState` overlap without being equal, and the three decisions above
 * are exactly the delta. A new activity state fails to compile here until
 * someone has decided which of the three families it belongs to.
 */
export function sessionActivityDotState(
  activity: SessionActivityState,
  opts: { attention?: boolean } = {},
): StatusDotState {
  if (opts.attention) return "waiting";
  switch (activity) {
    case "working":
      return "working";
    case "waiting":
      return "waiting";
    case "interrupted":
      return "interrupted";
    case "idle":
    case "parked":
    case "exited":
    case "stopped":
      return "idle";
  }
}

/**
 * Whether an activity state describes work someone could still go back to
 * (VC-406).
 *
 * THE QUESTION IS NOT "IS SOMETHING ATTACHED". Both rosters used to split their
 * live rows from their record on whether a tab or a structured attachment was
 * open, and for a chat Session that is the wrong fact entirely: a Session is
 * durable and outlives every attachment it has ever had, so closing its tab
 * ends nothing. The row that made the error visible is the `waiting` one — a
 * Session blocked on a permission prompt, folded under an "Earlier" caret
 * because nothing happened to be attached to it.
 *
 * Two states are over, and they are over for different reasons: `stopped` is a
 * decision somebody made (VC-86) and `exited` is a process that is gone.
 * Everything else — including `interrupted`, whose last turn DIED without
 * anyone deciding that (VC-324) — is a Session to go back to.
 *
 * A terminal needs more than this and gets it at the caller: a PTY dies with
 * its tab and with the app, so `session-history.ts` asks about the pane as well.
 */
export function sessionActivityIsLive(activity: SessionActivityState): boolean {
  return activity !== "stopped" && activity !== "exited";
}

/**
 * How loudly a state asks for a person, lowest number first (VC-406).
 *
 * A roster is read top-down, so the order of its rows is the order a reader
 * meets them, and recency alone answers the wrong question: a Session blocked
 * on a permission prompt is the one row a person has to act on, and sorting it
 * under three chattier neighbours because they printed more recently is the
 * roster failing at its one job. Recency stays the tiebreak WITHIN a rank, so
 * the column is still chronological wherever nothing is asking.
 *
 * Spelled here rather than in either roster because both draw it — Home's own
 * and the Ticket rail's — and two copies of a precedence is how one surface
 * silently keeps sorting `interrupted` with the quiet rows after the other
 * stops. Exhaustive over {@link StatusDotState} for the reason
 * `STATUS_DOT_TONE` is: a new state fails to compile until someone has decided
 * how urgently it reads.
 */
const STATUS_DOT_ATTENTION_RANK: Record<StatusDotState, number> = {
  // Asking for a person, declared rather than inferred. Nothing outranks it.
  waiting: 0,
  // Something broke: the plumbing failed, or the last turn died without anyone
  // ending it (VC-324). Not asking, but not something to scroll past either.
  error: 1,
  interrupted: 1,
  // Busy, and busy on its own behalf.
  working: 2,
  setup: 2,
  // Alive and quiet. One rank, because the differences between them
  // (attached/connecting/between turns/SIGSTOP'd) are facts the row's own words
  // carry and none of them changes who should read the row first.
  ready: 3,
  starting: 3,
  idle: 3,
  parked: 3,
  // Over. These do not appear in a live roster at all — they are what the
  // record under it holds — but the rank is total so a caller cannot reach an
  // undefined by passing one.
  exited: 4,
  stopped: 4,
};

/** {@link STATUS_DOT_ATTENTION_RANK}, as the comparator input a roster sorts on. */
export function sessionAttentionRank(state: StatusDotState): number {
  return STATUS_DOT_ATTENTION_RANK[state];
}

/**
 * The activity vocabulary, in words. One copy, because "Working" and
 * "Interrupted" are facts about the Session, not about the surface — a row
 * that says "Interrupted" in the sidebar may not say "Died" in the rail.
 */
export const SESSION_ACTIVITY_LABEL: Record<SessionActivityState, string> = {
  working: "Working",
  waiting: "Waiting for you",
  idle: "Idle",
  parked: "Parked",
  exited: "Exited",
  stopped: "Stopped",
  interrupted: "Interrupted",
};
