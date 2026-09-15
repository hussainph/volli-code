/**
 * The Doc tab's Activity feed cache: a ticket's events and comments, kept
 * across tab flips (VC-373).
 *
 * ── WHY IT EXISTS ─────────────────────────────────────────────────────────
 * The feed is rendered inside the Body tab (`ticket-body-panel.tsx`) and only
 * the ACTIVE tab renders (`ticket-detail.tsx`), so every Doc → file/chat → Doc
 * flip unmounted the feed and its local state went with it. The remount then
 * spent `tickets.events` + `comments.list` again to paint a list that had not
 * changed — two indexed reads per flip, on the one surface a person crosses
 * most while working a ticket.
 *
 * The data is cacheable because nothing moves it behind the renderer's back:
 * every mutation (this app's own composer, the CLI, an agent) either lands
 * through the feed's own refetch or arrives as a planning refresh
 * (`stores/board.ts` `lastPlanningChange`), the same signal the feed already
 * listened to. An entry therefore carries the planning VERSION it was read at,
 * and a mount paints from it only while that version still holds — a flip is
 * free, a change during the flip is not missed.
 *
 * ── WHY A VERSION AND NOT A LISTENER ──────────────────────────────────────
 * A change that arrives while the feed is UNMOUNTED cannot reach a component
 * effect, which is exactly the case a cache has to survive. Tagging entries
 * with the planning version lets a later mount answer "has anything happened
 * since I read this?" without holding a subscription of its own, and the
 * conservative direction of a version STOP is deliberate: a planning refresh
 * that provably targeted another ticket is folded in WITHOUT a refetch
 * (`noteVersion`, called from the mounted feed), while one whose scope cannot
 * be ruled out forces a single re-read the next time the feed is on screen.
 */
import { create } from "zustand";
import type { TicketComment, TicketEvent } from "@volli/shared";

/** One ticket's last landed activity, and the planning version it was read at. */
export interface TicketActivity {
  events: readonly TicketEvent[];
  comments: readonly TicketComment[];
  /** `lastPlanningChange.version` when this entry was read. */
  version: number;
}

interface TicketActivityState {
  /** ticketId → the feed's last landed read. */
  byTicket: Readonly<Record<string, TicketActivity>>;
  /**
   * Records what main answered with — the feed's own reads, and its optimistic
   * comment row while the authoritative re-read is in flight. Written whether
   * or not the ticket had an entry: this cache is filled by the feed itself,
   * not by a baseline fetch every consumer shares.
   */
  apply(ticketId: string, activity: TicketActivity): void;
  /**
   * Advances an existing entry to a NEWER planning version without re-reading
   * it, for a change that provably did not touch this ticket
   * (`planningChangeAffects`). Keeping the watermark current is what lets the
   * next remount tell "nothing I care about moved" from "something might
   * have". A ticket with no entry needs no watermark.
   */
  noteVersion(ticketId: string, version: number): void;
}

/** Factory so tests get isolated instances (the store module's own convention). */
export function createTicketActivityStore() {
  return create<TicketActivityState>()((set) => ({
    byTicket: {},

    apply(ticketId, activity) {
      set((state) => ({
        byTicket: { ...state.byTicket, [ticketId]: activity },
      }));
    },

    noteVersion(ticketId, version) {
      set((state) => {
        const entry = state.byTicket[ticketId];
        // No entry, or already current: nothing to advance. The no-op keeps
        // the entry's identity, so a subscriber does not re-render for a
        // version it already carried.
        if (entry === undefined || entry.version === version) return state;
        return {
          byTicket: {
            ...state.byTicket,
            [ticketId]: { events: entry.events, comments: entry.comments, version },
          },
        };
      });
    },
  }));
}

export const useTicketActivityStore = createTicketActivityStore();
