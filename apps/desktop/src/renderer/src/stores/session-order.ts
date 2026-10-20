/**
 * VC-30 (D7) — the held Session order, as renderer state the sidebars share.
 *
 * `@volli/shared/session-order.ts` owns WHERE each row goes; this owns WHEN a
 * surface is free to move it, and remembers what each surface last committed
 * to. Nothing else belongs here: the rule is pure and tested there, and this
 * store is the small amount of state a pure rule cannot hold — a last commit,
 * and a count of the reasons the band must presently keep still.
 *
 * KEYED BY SURFACE, NOT BY PROJECT. One project-keyed commit cannot be shared
 * by two callers with different member sets: the ticket rail holds a subset of
 * the left band's membership, so a rail commit would overwrite the band's
 * order on every build — and a rail whose left sidebar is hidden would never
 * commit at all. So each surface commits under its own key (the left band
 * under `project:<projectId>`, a ticket rail under `ticket:<ticketId>`)
 * through the same rules, and the same events produce the same lifts on both.
 *
 * THE HOLD IS GLOBAL. A pointer in either sidebar, or any open peek, freezes
 * EVERY key: the reason moves wait is that the thing under the pointer must
 * not move, and a person pointing at one surface can see the other. Holds
 * nest, because several reasons can be true at once (a pointer in the rail
 * while a peek from the band is open); the band moves again when the last one
 * is released, and every pending move lands then, in one step and without
 * animation.
 *
 * COMMITS HAPPEN IN AN EFFECT, never during render: a commit is a store write,
 * and writing to a shared store while another component renders is how one
 * band's build tears another's. {@link useHeldSessionOrder} therefore draws
 * from the last commit and schedules the next one, which is also what makes a
 * release land the pending moves — the release changes `holds`, every
 * subscribed band re-renders, and its effect commits what it may now move.
 */
import { create } from "zustand";
import { useEffect } from "react";
import {
  commitHeldOrder,
  frozenHeldOrder,
  heldOrderTarget,
  sameHeldOrder,
  type HeldSessionOrder,
  type SessionOrderMember,
} from "@volli/shared";

/**
 * The left band's surface key. Written once, because the two sidebars address
 * the same store and a key spelled by hand at each call site is how one
 * surface starts reading an order the other never committed to.
 */
export function projectBandOrderKey(projectId: string): string {
  return `project:${projectId}`;
}

/** A ticket rail's surface key — its own, for the reason above the store records. */
export function ticketRailOrderKey(ticketId: string): string {
  return `ticket:${ticketId}`;
}

export interface SessionOrderState {
  /** Surface key → the order that surface last committed to. */
  held: Readonly<Record<string, HeldSessionOrder>>;
  /**
   * How many reasons there are to keep still right now — a pointer inside a
   * sidebar, an open peek. `> 0` freezes every key (D7).
   */
  holds: number;
  /**
   * Takes a hold; call the returned function to release it. The release is
   * idempotent per caller, so a surface that both leaves and unmounts releases
   * once rather than freeing a hold somebody else is still holding.
   */
  hold(): () => void;
  /**
   * Commits the order `key` should draw from now on. A no-op while anything is
   * held, and a no-op when the commit would change nothing a surface has
   * already drawn — so an idle band is not a stream of identical writes.
   */
  commit(key: string, members: readonly SessionOrderMember[]): void;
  /** What `key` should draw now: the target when free, the frozen order while held. */
  orderFor(key: string, members: readonly SessionOrderMember[]): readonly string[];
}

/**
 * The one reading of "held", used by the store's own `orderFor` and by the
 * hook's render so the two can never disagree. A key that has never committed
 * has nothing to freeze, so it draws the target even while held.
 */
function orderOf(
  held: HeldSessionOrder | undefined,
  holds: number,
  members: readonly SessionOrderMember[],
): readonly string[] {
  if (holds > 0 && held !== undefined) {
    return frozenHeldOrder(
      held,
      members.map((member) => member.id),
    );
  }
  return heldOrderTarget(held ?? null, members);
}

/** Factory so tests get isolated instances (`stores/sessions.ts`'s convention). */
export function createSessionOrderStore() {
  return create<SessionOrderState>()((set, get) => ({
    held: {},
    holds: 0,

    hold() {
      set((state) => ({ holds: state.holds + 1 }));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        set((state) => ({ holds: state.holds - 1 }));
      };
    },

    commit(key, members) {
      const state = get();
      if (state.holds > 0) return;
      const previous = state.held[key];
      const next = commitHeldOrder(heldOrderTarget(previous ?? null, members), members);
      if (sameHeldOrder(previous ?? null, next)) return;
      set({ held: { ...state.held, [key]: next } });
    },

    orderFor(key, members) {
      const state = get();
      return orderOf(state.held[key], state.holds, members);
    },
  }));
}

export const useSessionOrderStore = createSessionOrderStore();

/**
 * A surface's own hook: draws the last commit, freezes while anything is held,
 * and commits the next order once it is free to move. Returns row ids in the
 * order the surface should draw them — apply it to rows with `applyHeldOrder`.
 */
export function useHeldSessionOrder(
  key: string,
  members: readonly SessionOrderMember[],
): readonly string[] {
  const held = useSessionOrderStore((state) => state.held[key]);
  const holds = useSessionOrderStore((state) => state.holds);
  const commit = useSessionOrderStore((state) => state.commit);
  // No dependency list on purpose: `members` is rebuilt by its surface on
  // every build, so the honest trigger is "this band just drew again". The
  // commit is a no-op unless it would change something, which is what keeps
  // the resulting state write from re-entering.
  useEffect(() => {
    commit(key, members);
  });
  return orderOf(held, holds, members);
}
