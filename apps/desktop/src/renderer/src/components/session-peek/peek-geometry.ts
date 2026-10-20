/**
 * VC-30 — where the peek's card goes.
 *
 * Ported from the lab's `session-peek/geometry.ts` with one production
 * departure (plan §1.3): the lab clamped to the lab shell's hard-coded 48/56 px
 * insets, because its chrome was a theme chip and a picker. Production passes
 * the REAL bounds — the scroll container the row lives in, and the window — so
 * the card is clamped to the span of the list it belongs to and never to a
 * number nobody can see.
 *
 * Two rules are the whole file:
 *
 *   • The card opens INWARD from whichever sidebar the row is in: the left
 *     nav's rows open right, the in-ticket rail's open left. One component,
 *     either side.
 *   • `maxHeight` is the room the container has, never the room below the row.
 *     A bottom-anchored row must not bootstrap the card into a tiny box: if
 *     `maxHeight` were derived from `top`, the first measure would see that
 *     clipped height and the card would never grow out of it. So the content
 *     gets the container's budget, and `top` is clamped from what was measured.
 */

/** The gap between a row and the card it opens. */
const PEEK_GAP = 8;
/** The clamp's breathing room at every edge of the window. */
const VIEWPORT_INSET = 8;
/**
 * The card's own lift above the row's top edge, so the header reads as
 * belonging to the row rather than sitting under it.
 */
const PEEK_LIFT = 6;
/** No container is ever treated as smaller than this — a card must be readable. */
const PEEK_MIN_HEIGHT = 120;

/** The card's width, which the sidebars do not get to choose. */
export const PEEK_CARD_WIDTH = 360;

export interface PeekPosition {
  readonly left: number;
  readonly top: number;
  readonly maxHeight: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function positionPeek(input: {
  row: Pick<DOMRect, "left" | "right" | "top">;
  /** The scroll container the row lives in — the card is clamped to its vertical span. */
  container: Pick<DOMRect, "top" | "bottom">;
  viewport: { width: number; height: number };
  /** `nav` opens right, `rail` opens left. */
  surface: "nav" | "rail";
  /** 0 before the first measure. */
  cardHeight: number;
  cardWidth: number;
}): PeekPosition {
  const { row, container, viewport, surface, cardHeight, cardWidth } = input;
  const width = Math.min(cardWidth, viewport.width - VIEWPORT_INSET * 2);
  // The container clamps the card, but a container that hangs off the window
  // cannot hand the card more room than the window has.
  const ceiling = Math.max(container.top, VIEWPORT_INSET);
  const floor = Math.min(container.bottom, viewport.height - VIEWPORT_INSET);
  const room = Math.max(PEEK_MIN_HEIGHT, floor - ceiling);
  const height = cardHeight === 0 ? room : Math.min(cardHeight, room);
  const rawLeft = surface === "nav" ? row.right + PEEK_GAP : row.left - width - PEEK_GAP;
  return {
    left: clamp(rawLeft, VIEWPORT_INSET, viewport.width - width - VIEWPORT_INSET),
    top: clamp(row.top - PEEK_LIFT, ceiling, ceiling + room - height),
    maxHeight: room,
  };
}
