/**
 * A tab strip's ARRANGEMENT — the order a person put their tabs in (VC-189,
 * plan §4.3).
 *
 * Both strips compose their tabs by concatenating kind groups (Home: Board →
 * terminals → chats → files; a ticket workspace: Body → files → diffs →
 * sessions → chats), and every one of those groups is built from a different
 * live source. So arrangement cannot be stored *in* the groups: dragging a file
 * tab in front of a chat tab has no representation there at all. It is stored
 * beside them instead, as one ordered list of tab ids per surface — an OVERLAY.
 * Compose the descriptors exactly as before, then sort them by the overlay.
 *
 * THE OVERLAY NAMES IDS, AND IDS ONLY, and it never has to be true. An id it
 * carries need not exist right now, and a tab that exists need not be named:
 *
 *  - {@link arrangeTabs} ignores ids it does not find and appends tabs it was
 *    not told about, so an overlay can be older than the strip it arranges.
 *  - {@link sanitizeTabOrder} checks SHAPE and nothing else. It never prunes
 *    against the live strip, because a Session that has not hydrated yet looks
 *    exactly like a Session that is gone, and only one of those may lose its
 *    place (`home-tabs.ts` states the same rule for the active tab).
 *
 * That is deliberately the property VC-105 (Home remembers its whole strip
 * across relaunch) needs: it restores Sessions asynchronously against the
 * project's durable listing, so the arrangement has to survive a window in
 * which half the tabs it names are not on screen. This is the one tab-order
 * model — VC-105 extends it by persisting the ids that ARE Sessions and
 * adopting them back, not by building a second list.
 */

/** Tab ids in the order the person arranged them. Ids may name nothing. */
export type TabOrder = readonly string[];

/** No arrangement: the strip stands in composed (kind-group) order. */
export const EMPTY_TAB_ORDER: TabOrder = [];

/** The one fact {@link arrangeTabs} needs about a tab descriptor. */
export interface OrderedTab {
  readonly id: string;
}

/**
 * Sort composed tab descriptors by `order`.
 *
 * `fixedLeading` is how many tabs at the head of the composed list are
 * PERMANENT — 1 for both strips today (Home's Board tab, a ticket's Body tab).
 * They are sliced off before anything is sorted, which is what makes "the
 * permanent tab does not move, and nothing lands before it" a property of the
 * model rather than a rule the drag surface has to remember. The strip's other
 * half of the same statement is that those tabs are never registered as
 * sortable at all.
 *
 * Tabs the overlay does not name keep their composed order and follow the ones
 * it does — a newly opened tab joins the end of the strip rather than jumping
 * into a slot the person never gave it.
 */
export function arrangeTabs<T extends OrderedTab>(
  tabs: readonly T[],
  order: TabOrder,
  fixedLeading = 0,
): readonly T[] {
  if (order.length === 0) return tabs;
  const rank = new Map(order.map((id, index) => [id, index]));
  const movable = tabs.slice(fixedLeading);
  const arranged = movable
    .filter((tab) => rank.has(tab.id))
    // Array#sort is stable, and both operands are known to `rank` here.
    .toSorted((left, right) => rank.get(left.id)! - rank.get(right.id)!);
  if (arranged.length === 0) return tabs;
  return [
    ...tabs.slice(0, fixedLeading),
    ...arranged,
    ...movable.filter((tab) => !rank.has(tab.id)),
  ];
}

/**
 * The overlay after `movedId` lands at `toIndex` among `ids` — a drop, as
 * arithmetic.
 *
 * `ids` is the strip as it stands (its movable half, in drawn order), so the
 * result names every tab that is currently open and nothing else. A drag is the
 * one act that rewrites the whole arrangement, which is also what keeps the
 * overlay from growing without bound as tabs come and go.
 *
 * Returns its input by identity when the drop changed nothing.
 */
export function movedTabOrder(ids: TabOrder, movedId: string, toIndex: number): TabOrder {
  const from = ids.indexOf(movedId);
  if (from === -1) return ids;
  const to = Math.min(Math.max(toIndex, 0), ids.length - 1);
  if (from === to) return ids;
  const next = ids.filter((id) => id !== movedId);
  next.splice(to, 0, movedId);
  return next;
}

/**
 * Validate a rehydrated overlay from a possibly-older build: strings only,
 * first mention wins, everything else dropped. Shape only — see the module doc
 * for why this may not ask whether an id still names a tab.
 */
export function sanitizeTabOrder(raw: unknown): TabOrder {
  if (!Array.isArray(raw)) return EMPTY_TAB_ORDER;
  const ids = raw.filter((id): id is string => typeof id === "string" && id.length > 0);
  // A duplicate is one tab written twice; the later mention is what
  // `arrangeTabs` would ignore anyway, so collapse it here instead.
  const unique = [...new Set(ids)];
  return unique.length === 0 ? EMPTY_TAB_ORDER : unique;
}
