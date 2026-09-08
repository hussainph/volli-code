/**
 * "Open that Session AT that question" — the seam between a clicked
 * notification and the chat plane that eventually shows it (VC-295 round 2).
 *
 * ── WHY IT IS NOT A PROP, AND NOT STORE STATE ─────────────────────────────
 * Clicking an alert asks for two things at once: put this Session in front, and
 * land on the question it named. The first is a store action that already
 * exists; the second has nowhere durable to live — which card is in front is
 * not workspace state, it is a one-shot instruction to whichever plane is about
 * to mount. Parking it in a store would mean persisting it, then remembering to
 * clear it so the card does not jump again days later.
 *
 * So it is a request with a single pending slot, consumed once by whoever gets
 * there first — the same shape, and for the same reasons, as
 * `editor/reveal-line.ts`.
 *
 * THE RACE IS THE POINT. A click can land in either order:
 *
 *  - the Session is not open — the plane mounts and claims the request when it
 *    is ready;
 *  - the Session is already open — no mount happens, so the live plane is told
 *    through {@link onSessionItemReveal} and claims the same slot.
 *
 * ── WHAT A REVEAL IS, AND IS NOT ──────────────────────────────────────────
 * It selects. It never answers, withdraws, or re-asks: the alert is a pointer
 * to durable state, and the card the plane puts in front is the LIVE one. An
 * item that has since resolved simply is not in the list, the plane shows
 * whatever is, and the click's own toast explains the absence.
 */
import type { SessionNotificationItem } from "@volli/shared";

/** The one outstanding request, if any. */
let pending: { sessionId: string; item: SessionNotificationItem } | null = null;

const listeners = new Map<string, Set<() => void>>();

/**
 * Ask for `sessionId` to be shown at `item`.
 *
 * One slot, latest wins: somebody clicking two alerts in a row means the
 * second, and an unclaimed older request must never surface later as a card
 * that jumps for no reason anybody can see.
 */
export function requestSessionItemReveal(sessionId: string, item: SessionNotificationItem): void {
  pending = { sessionId, item };
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

/** Claims the pending request for `sessionId`, or `null` when there is none for it. */
export function takeSessionItemReveal(sessionId: string): SessionNotificationItem | null {
  if (pending === null || pending.sessionId !== sessionId) return null;
  const { item } = pending;
  pending = null;
  return item;
}

/** Subscribes a mounted plane to later requests for `sessionId`; the returned call unsubscribes. */
export function onSessionItemReveal(sessionId: string, listener: () => void): () => void {
  const set = listeners.get(sessionId) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(sessionId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(sessionId);
  };
}

/**
 * The open questions, with the revealed one first.
 *
 * The plane draws ONE card above the composer, and which one is
 * `footInteraction`'s choice over this order — so putting the named question at
 * the head is the whole of "select that question" without teaching the card
 * stack anything about notifications.
 *
 * Returns the input array unchanged whenever there is nothing to do, so a plane
 * re-rendering on every token does not rebuild a list (and re-key a card) for a
 * reveal that changed nothing.
 */
export function preferRevealedInteraction<T extends { id: string }>(
  interactions: readonly T[],
  interactionId: string | null,
): readonly T[] {
  if (interactionId === null) return interactions;
  const index = interactions.findIndex((interaction) => interaction.id === interactionId);
  if (index <= 0) return interactions;
  const revealed = interactions[index]!;
  return [revealed, ...interactions.filter((interaction) => interaction !== revealed)];
}
