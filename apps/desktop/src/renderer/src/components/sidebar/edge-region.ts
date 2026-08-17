/**
 * The pointer-intent GEOMETRY of the edge reveal — which rule owns a sample —
 * extracted from `edge-reveal.ts` so the precedence order lives under the
 * coverage gate. The pattern is the repo's own: pure `.ts` beside the view
 * glue that consumes it (`listing.ts`, `ui/tab-focus.ts`), because the gate
 * includes pure modules by path and a file that also holds a hook can never
 * be on that list. The timers, phases, and listeners stay in the hook.
 */

export interface Point {
  x: number;
  y: number;
}

/** The grace corridor around an open panel, in viewport px. */
export const SAFE_PAD_X = 32;
export const SAFE_PAD_Y = 16;

function within(rect: DOMRect | null, point: Point, padX = 0, padY = 0): boolean {
  if (rect === null) return false;
  return (
    point.x >= rect.left - padX &&
    point.x <= rect.right + padX &&
    point.y >= rect.top - padY &&
    point.y <= rect.bottom + padY
  );
}

/** Which rule owns a pointer sample. The order IS the precedence. */
export type EdgeRegion = "trigger" | "band" | "safe" | "zone" | "outside";

export interface EdgeRects {
  /** The chrome band — the whole 36px row. */
  band: DOMRect | null;
  /** The sidebar trigger inside it, carved out of the band's suppression. */
  trigger: DOMRect | null;
  /** The arming strip. */
  zone: DOMRect | null;
  /** The panel's rect while it is VISIBLE, or null — the caller resolves visibility. */
  panel: DOMRect | null;
}

/**
 * The geometry half of the hook's `evaluate`, pure so the precedence — the
 * part VC-57 changed — is pinned by tests that need no DOM. Trigger before
 * band is the whole carve-out: a sample on the trigger is inside the band too,
 * and classifying it as "band" is what used to make hovering the sidebar's own
 * control CLOSE the sidebar. "Safe" before "zone" keeps the grace corridor's
 * answer when an open panel overlaps the strip.
 */
export function edgeRegion(point: Point, rects: EdgeRects): EdgeRegion {
  if (within(rects.trigger, point)) return "trigger";
  if (within(rects.band, point)) return "band";
  if (within(rects.panel, point, SAFE_PAD_X, SAFE_PAD_Y)) return "safe";
  if (within(rects.zone, point)) return "zone";
  return "outside";
}
