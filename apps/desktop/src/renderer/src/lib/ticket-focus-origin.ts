/**
 * Where a keyboard journey into a ticket STARTED, and which card or row should
 * hold focus when it comes back (VC-419).
 *
 * Pressing Enter on a board card or a list row opens the ticket, and the
 * surface the key was pressed on is then unmounted whole — `home-surface.tsx`
 * swaps the board for the detail view, and the board is rebuilt from scratch on
 * the way back. A DOM node captured on the way in is therefore worthless on the
 * way out: the element that comes back is a different object, and it may not
 * come back at all (the column window mounts a slice, a filter hides cards, the
 * ticket itself can be archived while it is open).
 *
 * So the origin is recorded as IDENTITY plus the neighbourhood it sat in, and
 * this module answers the one question the DOM cannot: given the ids the board
 * is showing NOW, which ticket inherits the focus? That decision is pure and
 * lives here, beside the board's other pure rules, so the cases that matter —
 * the origin survived, it was filtered out, it was deleted, its whole column is
 * gone — are asserted directly rather than through a rendered board.
 */

/** The card or row a keyboard open left from. */
export interface TicketFocusOrigin {
  /** The project whose board this origin belongs to; a different board ignores it. */
  projectId: string;
  /** The ticket whose card or row held focus. */
  ticketId: string;
  /**
   * The ticket ids the origin's own column or list section was showing, in
   * drawn order, at the moment of the keypress. Only what was mounted — which
   * is what "the neighbours" means for someone looking at the screen.
   */
  siblingIds: readonly string[];
  /** The origin's place in {@link siblingIds}; `-1` when it was not among them. */
  index: number;
}

/**
 * The ticket that should take focus on return, or `null` when nothing sensible
 * can.
 *
 * The origin itself wins whenever the board still shows it — whether or not it
 * is currently MOUNTED, since an unmounted card can be scrolled back into its
 * column's window (the caller's half of this, see `use-ticket-focus-handoff`).
 *
 * When it is gone — archived, deleted, or filtered out while the ticket was
 * open — focus goes to the neighbour that took its place, searching FORWARD
 * first: the row that slid up into the vacated line is the one a reader's eye
 * is already on. Only if nothing follows does it walk back, which is what makes
 * deleting the last card of a column land on the new last card rather than
 * nowhere. A `null` answer (an emptied column, an origin from a board that no
 * longer holds any of it) leaves focus alone rather than inventing a place.
 */
export function restoreFocusTarget(
  origin: TicketFocusOrigin,
  shownIds: readonly string[],
): string | null {
  const shown = new Set(shownIds);
  if (shown.has(origin.ticketId)) return origin.ticketId;

  // An origin that was never among its recorded siblings has no neighbourhood
  // to search; `index` is clamped so a stale record cannot read out of bounds.
  const start = origin.index < 0 ? origin.siblingIds.indexOf(origin.ticketId) : origin.index;
  if (start < 0) return null;

  for (let i = start + 1; i < origin.siblingIds.length; i++) {
    const candidate = origin.siblingIds[i];
    if (candidate !== undefined && candidate !== origin.ticketId && shown.has(candidate)) {
      return candidate;
    }
  }
  for (let i = Math.min(start, origin.siblingIds.length) - 1; i >= 0; i--) {
    const candidate = origin.siblingIds[i];
    if (candidate !== undefined && candidate !== origin.ticketId && shown.has(candidate)) {
      return candidate;
    }
  }
  return null;
}
