/**
 * VC-30 (D7) — the held Session order: a band that keeps still.
 *
 * The shipped bands sort by recency on every build, so a working Session climbs
 * on each tool call and a click target moves several times a minute. Held, a
 * band keeps each row where it is, and a row moves for exactly two reasons:
 *
 *   • a new QUESTION floats to the very top, because a Session waiting on the
 *     person is the one row they must not have to hunt for;
 *   • a new TURN (resting → working, which a person usually caused) or a first
 *     appearance goes to the top too, but lands under the questions still open,
 *     so a busy Session cannot push one out of first place.
 *
 * Everything else — a tool call, a finished turn, an ANSWER, a read — leaves a
 * row where it is. An answered question stays pinned where it floated: it does
 * not step down under another one still asked, because the person just acted on
 * it. The float is positional, not a sort, which is what makes that true.
 *
 * Ported from `lab/session-peek/sidebar-live.ts`, where the rule was played
 * against the shipped listing builder over a few minutes of a working
 * afternoon. The lab's `QuestionRule` parameter is gone: floating a new
 * question is the decision (D7), and "hold" was only ever the comparison.
 *
 * Pure and surface-free. Each band applies it to its own membership — the left
 * sidebar's Active band and a ticket rail hold their own commits — and WHEN a
 * band is free to move (nothing moves while a pointer is in a sidebar or a peek
 * is open) belongs to the store that calls this, not here.
 */

/**
 * The three phases the held order reads. Everything that is neither asking nor
 * busy is at rest — named so it does not read as an activity state, which is a
 * different vocabulary with more answers than this rule can use.
 */
export type SessionOrderPhase = "waiting" | "working" | "resting";

export interface SessionOrderMember {
  readonly id: string;
  readonly phase: SessionOrderPhase;
}

/** The order a held band last committed to, and the phase each row was in then. */
export interface HeldSessionOrder {
  readonly order: readonly string[];
  readonly phases: Readonly<Record<string, SessionOrderPhase>>;
}

/**
 * Where each row goes, given where the band last committed and what changed
 * since. `members` is this build's membership in the shipped order.
 *
 *   1. With nothing committed, the shipped order: a held band starts where the
 *      shipped one would (questions first).
 *   2. Rows still present keep their committed places — an answered question
 *      included: an answer moves nothing.
 *   3. A row that has just started asking goes to the very top.
 *   4. A row new to the band, or that went resting → working since the commit,
 *      goes to the top as well, just under the lowest question still open so it
 *      cannot push one down. Several land in the shipped order, newest first.
 */
export function heldOrderTarget(
  held: HeldSessionOrder | null,
  members: readonly SessionOrderMember[],
): readonly string[] {
  if (held === null) return members.map((member) => member.id);
  const phase = new Map(members.map((member) => [member.id, member.phase]));
  const asked = members
    .filter((member) => member.phase === "waiting" && held.phases[member.id] !== "waiting")
    .map((member) => member.id);
  const askedSet = new Set(asked);
  const lifted = members
    .filter((member) => {
      if (askedSet.has(member.id)) return false;
      const before = held.phases[member.id];
      return before === undefined || (before === "resting" && member.phase === "working");
    })
    .map((member) => member.id);
  const moved = new Set([...asked, ...lifted]);
  const kept = [...asked, ...held.order.filter((id) => phase.has(id) && !moved.has(id))];
  const under = kept.findLastIndex((id) => phase.get(id) === "waiting") + 1;
  return [...kept.slice(0, under), ...lifted, ...kept.slice(under)];
}

/** What a band commits to: the order it drew, and the phase every member was in when it did. */
export function commitHeldOrder(
  order: readonly string[],
  members: readonly SessionOrderMember[],
): HeldSessionOrder {
  return {
    order,
    phases: Object.fromEntries(members.map((member) => [member.id, member.phase])),
  };
}

/**
 * What a HELD band draws: exactly the committed rows in the committed order —
 * including one the clock or a read would now retire, so nothing leaves from
 * under the pointer — with anything genuinely new appended at the bottom, where
 * adding it moves no row a person could be aiming at.
 */
export function frozenHeldOrder(
  held: HeldSessionOrder,
  memberIds: readonly string[],
): readonly string[] {
  const committed = new Set(held.order);
  return [...held.order, ...memberIds.filter((id) => !committed.has(id))];
}

/** Whether committing `b` would change anything a band has already drawn. */
export function sameHeldOrder(a: HeldSessionOrder | null, b: HeldSessionOrder): boolean {
  if (a === null || a.order.length !== b.order.length) return false;
  if (a.order.some((id, index) => id !== b.order[index])) return false;
  return a.order.every((id) => a.phases[id] === b.phases[id]);
}

/**
 * Applies an id order to rows, keeping unknown rows in their own relative order
 * at the end. An order names a band's membership; a caller's rows can be a
 * subset of it (a ticket rail) or hold one the order has not heard of yet, and
 * neither is a reason to drop a row from the screen.
 */
export function applyHeldOrder<T extends { readonly id: string }>(
  order: readonly string[],
  rows: readonly T[],
): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const placed: T[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    const row = byId.get(id);
    if (row === undefined || seen.has(id)) continue;
    seen.add(id);
    placed.push(row);
  }
  return [...placed, ...rows.filter((row) => !seen.has(row.id))];
}
