import type { PeekSurface } from "./session-peek-wireframe-model";

const PEEK_GAP = 8;
/** The clamp's breathing room at every edge of the window. */
const VIEWPORT_INSET = 8;

export interface PeekPosition {
  readonly left: number;
  readonly top: number;
  readonly maxHeight: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Measure against the viewport budget, not the free space below the row. */
export function positionPeek(
  rowRect: Pick<DOMRect, "left" | "right" | "top">,
  surface: PeekSurface,
  cardHeight: number,
  bounds: { width: number; height: number },
  cardWidth: number,
): PeekPosition {
  // The lab shell keeps a theme chip at the top and a picker at the bottom.
  const topInset = 48;
  const bottomInset = 56;
  const width = Math.min(cardWidth, bounds.width - VIEWPORT_INSET * 2);
  const room = Math.max(120, bounds.height - topInset - bottomInset);
  const height = cardHeight === 0 ? room : Math.min(cardHeight, room);
  // Inward from whichever side the row is on: the nav's rows open right, the
  // in-ticket rail's open left, and the card is the same component either way.
  const rawLeft = surface === "nav" ? rowRect.right + PEEK_GAP : rowRect.left - width - PEEK_GAP;
  const top = clamp(rowRect.top - 6, topInset, bounds.height - height - bottomInset);
  return {
    left: clamp(rawLeft, VIEWPORT_INSET, bounds.width - width - VIEWPORT_INSET),
    top,
    // A bottom-anchored row must not bootstrap the card into a tiny box: if
    // maxHeight depends on top, the observer only ever sees that clipped height.
    // Let the content use the viewport budget, then clamp top from its measured size.
    maxHeight: room,
  };
}
