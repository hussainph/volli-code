/**
 * Which drawing an empty chat opens on, and — more importantly — which drawings
 * its scope is even allowed to offer (VC-55).
 *
 * THE MENU IS THE SIGNAL. Nothing on a chat surface names the kind of Session
 * you are in, because a label is read once and then stops being read. What is
 * drawn instead is data that is only legible at ONE scope: a Home chat opens on
 * a field of many — every Session ever run, the whole board — and a ticket chat
 * opens on one thing's state. Many-against-one is read before anything is read,
 * and it keeps working after it has been learnt.
 *
 * So the set of visuals a scope offers is short on purpose for a ticket. That
 * is the point of it, not an omission to be filled in later: a ticket has no
 * board of its own and no practice history of its own, and offering it a
 * Streak would be offering it a chart of somebody else's subject.
 *
 * Pure, so the rule is one function two surfaces read rather than a condition
 * spelled twice — the drawing chooses through {@link resolveEmptyVisual}, and
 * the picker offers exactly {@link visualsForScope}.
 */

/** A Session's scope, as the empty state cares about it. */
export type ChatScope = "project" | "ticket";

/** The drawings an empty chat can open on. */
export type EmptyVisual = "streak" | "board" | "venue";

/** The picker's words. Nouns — the drawing is its own explanation. */
export const EMPTY_VISUAL_LABELS: Record<EmptyVisual, string> = {
  streak: "Streak",
  board: "Board",
  venue: "Venue",
};

/**
 * A menu, typed as never-empty. Every scope draws SOMETHING, so its head is
 * always a legal answer — which is what lets {@link resolveEmptyVisual} fall
 * back without inventing a case that cannot happen.
 */
type VisualMenu = readonly [EmptyVisual, ...EmptyVisual[]];

/**
 * A Project Session's menu, in the order it is offered. Streak leads because it
 * is the default and because it is the widest field the app can draw.
 */
const PROJECT_VISUALS: VisualMenu = ["streak", "board", "venue"];

/** A Ticket Session's menu. One entry, and its shortness is the identity signal. */
const TICKET_VISUALS: VisualMenu = ["venue"];

/** What this scope may draw. */
export function visualsForScope(scope: ChatScope): VisualMenu {
  return scope === "project" ? PROJECT_VISUALS : TICKET_VISUALS;
}

/**
 * The drawing this scope opens on, given the user's stored choice.
 *
 * The choice is stored app-wide and there is only one of it, so a stored
 * `"streak"` reaching a ticket is ordinary rather than corrupt — it is the Home
 * preference being asked a question it does not answer. The scope's own head
 * wins in that case, which is also what makes the ticket surface impossible to
 * misconfigure into drawing a chart it cannot fill.
 */
export function resolveEmptyVisual(scope: ChatScope, chosen: EmptyVisual): EmptyVisual {
  const offered = visualsForScope(scope);
  return offered.includes(chosen) ? chosen : offered[0];
}

/** The default an unconfigured app opens Home on. */
export const DEFAULT_EMPTY_VISUAL: EmptyVisual = "streak";

/**
 * Validate a rehydrated visual choice. Persisted JSON a past build wrote can
 * hold anything, including the name of a visual this build no longer draws.
 */
export function sanitizeEmptyVisual(raw: unknown): EmptyVisual {
  return raw === "streak" || raw === "board" || raw === "venue" ? raw : DEFAULT_EMPTY_VISUAL;
}
