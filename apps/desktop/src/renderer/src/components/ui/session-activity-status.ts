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
